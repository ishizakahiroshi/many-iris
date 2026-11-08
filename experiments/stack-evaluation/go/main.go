// Synthetic comparison candidate. Never use this server with real records.
package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"modernc.org/sqlite"
)

type config struct {
	DB, Fixture, Helper, Python, UI string
	Port                            int
	Test, Restored                  bool
}
type task struct {
	ID       string `json:"id"`
	Title    string `json:"title"`
	Source   string `json:"source"`
	Hash     string `json:"source_hash"`
	Revision int64  `json:"revision"`
}
type run struct {
	ID       string `json:"run_id"`
	Task     string `json:"task_id"`
	State    string `json:"state"`
	Epoch    int64  `json:"epoch"`
	Attempt  int64  `json:"attempt"`
	Revision int64  `json:"revision"`
	Hash     string `json:"source_hash"`
	Expiry   int64  `json:"expires_at"`
	PID      int    `json:"pid"`
	Events   string `json:"events_path"`
	Mode     string `json:"mode"`
}
type child struct {
	owned     *ownedJob
	done      chan struct{}
	exitErr   error
	uncertain bool
}
type engine struct {
	mu       sync.Mutex
	db       *sql.DB
	cfg      config
	epoch    int64
	children map[string]*child
	lease    *controllerLease
}
type domain string

func (d domain) Error() string { return string(d) }

var idRE = regexp.MustCompile(`^[A-Za-z0-9_-]{1,80}$`)

func must(err error) {
	if err != nil {
		log.Fatal("candidate initialization failed")
	}
}
func main() {
	log.SetOutput(os.Stderr)
	log.SetFlags(0)
	c := config{}
	flag.StringVar(&c.DB, "db", "", "synthetic DB")
	flag.StringVar(&c.Fixture, "fixture", "", "synthetic fixture")
	flag.StringVar(&c.Helper, "helper", "", "fixed shared helper")
	flag.StringVar(&c.Python, "python", "", "helper Python executable")
	flag.StringVar(&c.UI, "ui", "", "shared UI file")
	flag.IntVar(&c.Port, "port", 0, "loopback port")
	flag.BoolVar(&c.Test, "test-mode", false, "synthetic test controls")
	flag.BoolVar(&c.Restored, "restored", false, "restore execution hold")
	flag.Parse()
	for _, p := range []string{c.DB, c.Fixture, c.Helper, c.Python, c.UI} {
		if p == "" {
			log.Fatal("missing required path")
		}
	}
	var auth struct {
		Token string `json:"token"`
	}
	scan := bufio.NewScanner(io.LimitReader(os.Stdin, 65537))
	if !scan.Scan() || json.Unmarshal(scan.Bytes(), &auth) != nil || len(auth.Token) < 16 || len(auth.Token) > 512 {
		log.Fatal("invalid launch authorization")
	}
	e, err := openEngine(c)
	must(err)
	defer e.close()
	ln, err := net.Listen("tcp4", fmt.Sprintf("127.0.0.1:%d", c.Port))
	must(err)
	port := ln.Addr().(*net.TCPAddr).Port
	var version string
	must(e.db.QueryRow("select sqlite_version()").Scan(&version))
	ready := map[string]any{"language": "go", "port": port, "pid": os.Getpid(), "sqlite_version": version}
	must(json.NewEncoder(os.Stdout).Encode(ready))
	s := &http.Server{Handler: e.handler(auth.Token, port), ReadHeaderTimeout: 3 * time.Second, ReadTimeout: 5 * time.Second, WriteTimeout: 10 * time.Second, IdleTimeout: 10 * time.Second, MaxHeaderBytes: 16384}
	err = s.Serve(ln)
	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Print("server stopped")
	}
}

func openEngine(c config) (*engine, error) {
	if err := os.MkdirAll(filepath.Dir(c.DB), 0700); err != nil {
		return nil, err
	}
	canonical, err := canonicalDB(c.DB)
	if err != nil {
		return nil, err
	}
	c.DB = canonical
	lease, err := acquireControllerLease(c.DB)
	if err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", c.DB)
	if err != nil {
		lease.Close()
		return nil, err
	}
	db.SetMaxOpenConns(1)
	var pending *sql.Tx
	fail := func(err error) (*engine, error) {
		if pending != nil {
			pending.Rollback()
		}
		db.Close()
		lease.Close()
		return nil, err
	}
	for _, s := range []string{"PRAGMA journal_mode=WAL", "PRAGMA synchronous=FULL", "PRAGMA foreign_keys=ON", "PRAGMA busy_timeout=1000"} {
		if _, err = db.Exec(s); err != nil {
			return fail(err)
		}
	}
	_, err = db.Exec(`CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,title TEXT NOT NULL,source TEXT NOT NULL,source_hash TEXT NOT NULL,revision INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),request_id TEXT NOT NULL UNIQUE,state TEXT NOT NULL,epoch INTEGER NOT NULL,attempt INTEGER NOT NULL,revision INTEGER NOT NULL,source_hash TEXT NOT NULL,expires_at INTEGER NOT NULL,pid INTEGER NOT NULL,events_path TEXT NOT NULL,mode TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_task ON runs(task_id) WHERE state NOT IN ('completed','stopped','rejected');`)
	if err != nil {
		return fail(err)
	}
	tx, err := db.Begin()
	if err != nil {
		return fail(err)
	}
	pending = tx
	defer tx.Rollback()
	var count int
	if err = tx.QueryRow("SELECT count(*) FROM metadata WHERE key='schema_version'").Scan(&count); err != nil {
		return fail(err)
	}
	if count == 0 {
		data, er := os.ReadFile(c.Fixture)
		if er != nil {
			return fail(er)
		}
		var fixture struct {
			Version int    `json:"version"`
			Now     int64  `json:"now"`
			Tasks   []task `json:"tasks"`
		}
		if er = json.Unmarshal(data, &fixture); er != nil || fixture.Version != 1 {
			return fail(errors.New("invalid fixture"))
		}
		for _, t := range fixture.Tasks {
			if !idRE.MatchString(t.ID) || t.Revision != 1 || hash(t.Source) != t.Hash {
				return fail(errors.New("invalid fixture"))
			}
			if _, er = tx.Exec("INSERT INTO tasks VALUES(?,?,?,?,?)", t.ID, t.Title, t.Source, t.Hash, t.Revision); er != nil {
				return fail(er)
			}
		}
		for k, v := range map[string]string{"schema_version": "1", "epoch": "0", "now": strconv.FormatInt(fixture.Now, 10), "execution_enabled": "1", "fault": "none"} {
			if _, er = tx.Exec("INSERT INTO metadata VALUES(?,?)", k, v); er != nil {
				return fail(er)
			}
		}
	}
	var schema string
	if err = tx.QueryRow("SELECT value FROM metadata WHERE key='schema_version'").Scan(&schema); err != nil || schema != "1" {
		return fail(errors.New("unsupported schema"))
	}
	_, err = tx.Exec("UPDATE metadata SET value=CAST(value AS INTEGER)+1 WHERE key='epoch'")
	if err != nil {
		return fail(err)
	}
	_, err = tx.Exec("UPDATE runs SET state=CASE WHEN state IN ('running','stopping') THEN 'unknown' ELSE 'waiting' END,expires_at=0 WHERE state IN ('running','stopping','approved','queued')")
	if err != nil {
		return fail(err)
	}
	if c.Restored {
		if _, err = tx.Exec("UPDATE metadata SET value='0' WHERE key='execution_enabled'"); err != nil {
			return fail(err)
		}
	}
	var epoch int64
	if err = tx.QueryRow("SELECT CAST(value AS INTEGER) FROM metadata WHERE key='epoch'").Scan(&epoch); err != nil {
		return fail(err)
	}
	if err = tx.Commit(); err != nil {
		return fail(err)
	}
	return &engine{db: db, cfg: c, epoch: epoch, children: map[string]*child{}, lease: lease}, nil
}

func (e *engine) close() error {
	for _, p := range e.children {
		p.owned.close()
		<-p.done
	}
	err := e.db.Close()
	if e.lease != nil {
		if er := e.lease.Close(); err == nil {
			err = er
		}
		e.lease = nil
	}
	return err
}

func canonicalDB(path string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	if resolved, er := filepath.EvalSymlinks(abs); er == nil {
		return resolved, nil
	} else if !errors.Is(er, os.ErrNotExist) {
		return "", er
	}
	parent, err := filepath.EvalSymlinks(filepath.Dir(abs))
	if err != nil {
		return "", err
	}
	return filepath.Join(parent, filepath.Base(abs)), nil
}

func hash(s string) string { h := sha256.Sum256([]byte(s)); return hex.EncodeToString(h[:]) }
func getTask(tx *sql.Tx, id string) (task, error) {
	var t task
	err := tx.QueryRow("SELECT id,title,source,source_hash,revision FROM tasks WHERE id=?", id).Scan(&t.ID, &t.Title, &t.Source, &t.Hash, &t.Revision)
	if errors.Is(err, sql.ErrNoRows) {
		return t, domain("NOT_FOUND")
	}
	return t, err
}
func getRun(tx *sql.Tx, id string) (run, error) {
	var r run
	err := tx.QueryRow("SELECT id,task_id,state,epoch,attempt,revision,source_hash,expires_at,pid,events_path,mode FROM runs WHERE id=?", id).Scan(&r.ID, &r.Task, &r.State, &r.Epoch, &r.Attempt, &r.Revision, &r.Hash, &r.Expiry, &r.PID, &r.Events, &r.Mode)
	if errors.Is(err, sql.ErrNoRows) {
		return r, domain("NOT_FOUND")
	}
	return r, err
}
func saveRun(tx *sql.Tx, r run) error {
	_, err := tx.Exec("UPDATE runs SET state=?,epoch=?,attempt=?,revision=?,source_hash=?,expires_at=?,pid=?,events_path=?,mode=? WHERE id=?", r.State, r.Epoch, r.Attempt, r.Revision, r.Hash, r.Expiry, r.PID, r.Events, r.Mode, r.ID)
	return err
}
func meta(tx *sql.Tx, k string) (string, error) {
	var v string
	err := tx.QueryRow("SELECT value FROM metadata WHERE key=?", k).Scan(&v)
	return v, err
}
func hashOK(s string) bool {
	if len(s) != 64 {
		return false
	}
	_, err := hex.DecodeString(s)
	return err == nil
}

func (e *engine) handler(token string, port int) http.Handler {
	host := fmt.Sprintf("127.0.0.1:%d", port)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		respond := func(code int, v any) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(code)
			_ = json.NewEncoder(w).Encode(v)
		}
		fail := func(code int, s string) { respond(code, map[string]any{"ok": false, "error": s}) }
		if r.Host != host {
			fail(403, "INVALID")
			return
		}
		if o := r.Header.Get("Origin"); o != "" && o != "http://"+host {
			fail(403, "INVALID")
			return
		}
		if r.Method == http.MethodGet && r.URL.Path == "/health" {
			respond(200, map[string]bool{"ok": true})
			return
		}
		if r.Method == http.MethodGet && r.URL.Path == "/" {
			b, err := os.ReadFile(e.cfg.UI)
			if err != nil {
				fail(500, "STORAGE")
				return
			}
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = w.Write(b)
			return
		}
		if r.Method != http.MethodPost || r.URL.Path != "/api" {
			fail(404, "INVALID")
			return
		}
		if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+token)) != 1 {
			fail(403, "AUTH")
			return
		}
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 65536))
		if err != nil {
			fail(400, "INVALID")
			return
		}
		var req map[string]json.RawMessage
		dec := json.NewDecoder(bytes.NewReader(body))
		if dec.Decode(&req) != nil || req == nil {
			fail(400, "INVALID")
			return
		}
		var extra any
		if dec.Decode(&extra) != io.EOF {
			fail(400, "INVALID")
			return
		}
		result, err := e.call(req)
		if err != nil {
			var d domain
			if errors.As(err, &d) {
				fail(409, string(d))
			} else {
				fail(500, "STORAGE")
			}
			return
		}
		respond(200, map[string]any{"ok": true, "data": result})
	})
}

var fields = map[string][]string{
	"list": {"offset", "limit"}, "detail": {"task_id"}, "start": {"task_id", "request_id"},
	"approve": {"run_id", "revision", "source_hash", "expires_at"}, "reject": {"run_id"}, "revoke": {"run_id"}, "enqueue": {"run_id"},
	"dispatch": {"run_id", "mode"}, "status": {"run_id"}, "result": {"run_id", "epoch", "attempt", "revision", "source_hash"}, "stop": {"run_id"},
	"snapshot": {"path"}, "advance": {"seconds"}, "revise": {"task_id", "source"}, "fault": {"kind"},
}

func stringArg(req map[string]json.RawMessage, k string) (string, error) {
	var v string
	if b, ok := req[k]; !ok || len(b) == 0 || b[0] != '"' || json.Unmarshal(b, &v) != nil {
		return "", domain("INVALID")
	}
	return v, nil
}
func intArg(req map[string]json.RawMessage, k string) (int64, error) {
	var v int64
	if b, ok := req[k]; !ok || bytes.Equal(bytes.TrimSpace(b), []byte("null")) || json.Unmarshal(b, &v) != nil {
		return 0, domain("INVALID")
	}
	return v, nil
}
func allowedState(s string, states ...string) bool {
	for _, v := range states {
		if s == v {
			return true
		}
	}
	return false
}

func (e *engine) call(req map[string]json.RawMessage) (any, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	op, err := stringArg(req, "op")
	if err != nil {
		return nil, err
	}
	allowed, ok := fields[op]
	if !ok {
		return nil, domain("INVALID")
	}
	for k := range req {
		if k == "op" {
			continue
		}
		found := false
		for _, f := range allowed {
			if f == k {
				found = true
			}
		}
		if !found {
			return nil, domain("INVALID")
		}
	}
	for _, k := range allowed {
		if _, ok := req[k]; !ok {
			if op == "list" {
				continue
			}
			if op == "dispatch" && k == "mode" {
				continue
			}
			return nil, domain("INVALID")
		}
	}
	for _, k := range []string{"run_id", "task_id", "request_id"} {
		if _, ok := req[k]; ok {
			s, er := stringArg(req, k)
			if er != nil || !idRE.MatchString(s) {
				return nil, domain("INVALID")
			}
		}
	}
	if allowedState(op, "result", "snapshot", "advance", "revise", "fault") && !e.cfg.Test {
		return nil, domain("INVALID")
	}
	tx, err := e.db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	enabled, err := meta(tx, "execution_enabled")
	if err != nil {
		return nil, err
	}
	currentEpoch, err := meta(tx, "epoch")
	if err != nil {
		return nil, err
	}
	if currentEpoch != strconv.FormatInt(e.epoch, 10) {
		return nil, domain("STALE_CONTROLLER")
	}
	if enabled != "1" && !allowedState(op, "list", "detail", "status", "snapshot") {
		return nil, domain("RESTORE_HOLD")
	}
	finish := func(v any) (any, error) {
		if er := tx.Commit(); er != nil {
			return nil, er
		}
		return v, nil
	}
	if op == "list" {
		offset, limit := int64(0), int64(50)
		if _, ok = req["offset"]; ok {
			offset, err = intArg(req, "offset")
			if err != nil {
				return nil, err
			}
		}
		if _, ok = req["limit"]; ok {
			limit, err = intArg(req, "limit")
			if err != nil {
				return nil, err
			}
		}
		if offset < 0 || limit < 1 || limit > 100 {
			return nil, domain("INVALID")
		}
		var n int
		err = tx.QueryRow("SELECT count(*) FROM tasks").Scan(&n)
		if err != nil {
			return nil, err
		}
		rows, er := tx.Query("SELECT id,title,revision FROM tasks ORDER BY id LIMIT ? OFFSET ?", limit, offset)
		if er != nil {
			return nil, er
		}
		items := []map[string]any{}
		for rows.Next() {
			var id, title string
			var rev int64
			if er = rows.Scan(&id, &title, &rev); er != nil {
				rows.Close()
				return nil, er
			}
			items = append(items, map[string]any{"id": id, "title": title, "revision": rev})
		}
		er = rows.Err()
		rows.Close()
		if er != nil {
			return nil, er
		}
		return finish(map[string]any{"tasks": items, "total": n})
	}
	if op == "detail" {
		id, _ := stringArg(req, "task_id")
		t, er := getTask(tx, id)
		if er != nil {
			return nil, er
		}
		return finish(t)
	}
	if op == "advance" {
		n, er := intArg(req, "seconds")
		if er != nil || n < 0 || n > 86400 {
			return nil, domain("INVALID")
		}
		_, er = tx.Exec("UPDATE metadata SET value=CAST(value AS INTEGER)+? WHERE key='now'", n)
		if er != nil {
			return nil, er
		}
		return finish(map[string]any{"advanced": n})
	}
	if op == "fault" {
		kind, er := stringArg(req, "kind")
		if er != nil || !allowedState(kind, "none", "intent_full", "result_full", "busy") {
			return nil, domain("INVALID")
		}
		_, er = tx.Exec("UPDATE metadata SET value=? WHERE key='fault'", kind)
		if er != nil {
			return nil, er
		}
		return finish(map[string]any{"kind": kind})
	}
	if op == "revise" {
		id, _ := stringArg(req, "task_id")
		source, er := stringArg(req, "source")
		if er != nil {
			return nil, er
		}
		if _, er = getTask(tx, id); er != nil {
			return nil, er
		}
		_, er = tx.Exec("UPDATE tasks SET source=?,source_hash=?,revision=revision+1 WHERE id=?", source, hash(source), id)
		if er != nil {
			return nil, er
		}
		_, er = tx.Exec("UPDATE runs SET state='waiting',expires_at=0 WHERE task_id=? AND state IN ('approved','queued')", id)
		if er != nil {
			return nil, er
		}
		t, er := getTask(tx, id)
		if er != nil {
			return nil, er
		}
		return finish(t)
	}
	if op == "snapshot" {
		p, er := stringArg(req, "path")
		if er != nil {
			return nil, er
		}
		target, er := filepath.Abs(p)
		if er != nil {
			return nil, domain("INVALID")
		}
		parent, _ := filepath.Abs(filepath.Dir(e.cfg.DB))
		if strings.Contains(p, "..") || !strings.EqualFold(filepath.Dir(target), parent) || strings.EqualFold(target, e.cfg.DB) {
			return nil, domain("INVALID")
		}
		if _, er = os.Lstat(target); !errors.Is(er, os.ErrNotExist) {
			return nil, domain("INVALID")
		}
		if er = tx.Commit(); er != nil {
			return nil, er
		}
		// Reserve a new destination before entering SQLite's online backup API.
		reserved, reserveErr := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if reserveErr != nil {
			return nil, domain("INVALID")
		}
		if er = reserved.Close(); er != nil {
			return nil, er
		}
		conn, connErr := e.db.Conn(context.Background())
		if connErr != nil {
			return nil, connErr
		}
		defer conn.Close()
		er = conn.Raw(func(raw any) error {
			provider, ok := raw.(interface {
				NewBackup(string) (*sqlite.Backup, error)
			})
			if !ok {
				return errors.New("online backup unavailable")
			}
			backup, backupErr := provider.NewBackup(target)
			if backupErr != nil {
				return backupErr
			}
			_, stepErr := backup.Step(-1)
			finishErr := backup.Finish()
			if stepErr != nil {
				return stepErr
			}
			return finishErr
		})
		if er != nil {
			return nil, er
		}
		return map[string]any{"path": target}, nil
	}
	if op == "start" {
		id, _ := stringArg(req, "task_id")
		request, _ := stringArg(req, "request_id")
		existing, er := getRun(tx, request)
		if er == nil {
			if existing.Task != id {
				return nil, domain("REQUEST_CONFLICT")
			}
			return finish(existing)
		}
		if !errors.Is(er, domain("NOT_FOUND")) {
			return nil, er
		}
		t, er := getTask(tx, id)
		if er != nil {
			return nil, er
		}
		var active int
		if er = tx.QueryRow("SELECT count(*) FROM runs WHERE task_id=? AND state NOT IN ('completed','stopped','rejected')", id).Scan(&active); er != nil {
			return nil, er
		}
		if active != 0 {
			return nil, domain("ACTIVE_RUN")
		}
		r := run{ID: request, Task: id, State: "waiting", Epoch: e.epoch, Attempt: 1, Revision: t.Revision, Hash: t.Hash, Events: filepath.Join(filepath.Dir(e.cfg.DB), request+".events.jsonl")}
		_, er = tx.Exec("INSERT INTO runs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", r.ID, r.Task, r.ID, r.State, r.Epoch, r.Attempt, r.Revision, r.Hash, 0, 0, r.Events, "")
		if er != nil {
			return nil, er
		}
		return finish(r)
	}
	id, _ := stringArg(req, "run_id")
	r, err := getRun(tx, id)
	if err != nil {
		return nil, err
	}
	t, err := getTask(tx, r.Task)
	if err != nil {
		return nil, err
	}
	nowRaw, err := meta(tx, "now")
	if err != nil {
		return nil, err
	}
	now, err := strconv.ParseInt(nowRaw, 10, 64)
	if err != nil {
		return nil, err
	}
	grantValid := func() bool {
		return r.Epoch == e.epoch && r.Expiry > now && r.Revision == t.Revision && r.Hash == t.Hash
	}
	switch op {
	case "approve":
		if r.State != "waiting" {
			return nil, domain("STATE")
		}
		rev, er := intArg(req, "revision")
		if er != nil {
			return nil, er
		}
		h, er := stringArg(req, "source_hash")
		if er != nil || !hashOK(h) {
			return nil, domain("INVALID")
		}
		expiry, er := intArg(req, "expires_at")
		if er != nil {
			return nil, er
		}
		if rev != t.Revision || h != t.Hash || expiry <= now {
			return nil, domain("STALE_APPROVAL")
		}
		r.Revision = rev
		r.Hash = h
		r.Expiry = expiry
		r.Epoch = e.epoch
		r.State = "approved"
	case "reject":
		if !allowedState(r.State, "waiting", "approved", "queued") {
			return nil, domain("STATE")
		}
		r.State = "rejected"
		r.Expiry = 0
	case "revoke":
		if !allowedState(r.State, "approved", "queued") {
			return nil, domain("STATE")
		}
		r.State = "waiting"
		r.Expiry = 0
	case "enqueue":
		if r.State != "approved" {
			return nil, domain("STATE")
		}
		if !grantValid() {
			return nil, domain("STALE_APPROVAL")
		}
		r.State = "queued"
	case "dispatch":
		if r.State != "queued" {
			return nil, domain("STATE")
		}
		if !grantValid() {
			return nil, domain("STALE_APPROVAL")
		}
		mode := "success"
		if _, ok = req["mode"]; ok {
			mode, err = stringArg(req, "mode")
			if err != nil {
				return nil, err
			}
		}
		if !allowedState(mode, "success", "slow", "orphan") || (!e.cfg.Test && mode != "success") {
			return nil, domain("INVALID")
		}
		fault, er := meta(tx, "fault")
		if er != nil {
			return nil, er
		}
		if fault == "intent_full" || fault == "busy" {
			return nil, domain("STORAGE")
		}
		// Durable launch intent precedes every process side effect.
		r.State = "running"
		r.Mode = mode
		if er = saveRun(tx, r); er != nil {
			return nil, er
		}
		if er = tx.Commit(); er != nil {
			return nil, er
		}
		if _, er = os.Lstat(r.Events); !errors.Is(er, os.ErrNotExist) {
			_, _ = e.db.Exec("UPDATE runs SET state='unknown' WHERE id=?", r.ID)
			return nil, domain("STORAGE")
		}
		owned, launchErr := startOwned([]string{e.cfg.Python, e.cfg.Helper, "--events", r.Events, "--mode", mode, "--run-id", r.ID, "--epoch", strconv.FormatInt(r.Epoch, 10), "--attempt", strconv.FormatInt(r.Attempt, 10)})
		if launchErr != nil {
			_, _ = e.db.Exec("UPDATE runs SET state='unknown' WHERE id=?", r.ID)
			return nil, domain("STORAGE")
		}
		p := &child{owned: owned, done: make(chan struct{})}
		e.children[r.ID] = p
		r.PID = int(owned.pid)
		go func() { p.exitErr = owned.wait(); close(p.done) }()
		if _, er = e.db.Exec("UPDATE runs SET pid=? WHERE id=?", r.PID, r.ID); er != nil {
			// Own the native Job independently of PID persistence. A failed save
			// must not leave an untracked helper running or erase outcome uncertainty.
			p.uncertain = true
			_ = owned.terminate()
			_, _ = e.db.Exec("UPDATE runs SET state='unknown' WHERE id=?", r.ID)
			return nil, domain("STORAGE")
		}
		return r, nil
	case "status":
		if r.State == "running" {
			r, err = e.poll(tx, r, t)
			if err != nil {
				return nil, err
			}
		}
	case "result":
		for k, want := range map[string]int64{"epoch": r.Epoch, "attempt": r.Attempt, "revision": r.Revision} {
			got, er := intArg(req, k)
			if er != nil {
				return nil, er
			}
			if got != want {
				return nil, domain("STALE_RESULT")
			}
		}
		h, er := stringArg(req, "source_hash")
		if er != nil {
			return nil, er
		}
		if h != r.Hash || r.Epoch != e.epoch || r.Revision != t.Revision || r.Hash != t.Hash || r.State != "running" {
			return nil, domain("STALE_RESULT")
		}
		// Injection never bypasses actual helper termination/evidence.
		r, err = e.poll(tx, r, t)
		if err != nil {
			return nil, err
		}
		if r.State != "completed" {
			return nil, domain("STATE")
		}
	case "stop":
		if allowedState(r.State, "completed", "stopped", "rejected") {
			return finish(r)
		}
		if allowedState(r.State, "waiting", "approved", "queued") {
			r.State = "stopped"
			r.Expiry = 0
			break
		}
		// Process cessation does not reconcile an unknown external outcome.
		wasUnknown := r.State == "unknown" || (e.children[r.ID] != nil && e.children[r.ID].uncertain)
		// Preserve an unconfirmed state before termination, including unknown runs.
		r.State = "stop_unconfirmed"
		r.Expiry = 0
		if err = saveRun(tx, r); err != nil {
			return nil, err
		}
		if err = tx.Commit(); err != nil {
			return nil, err
		}
		allGone := e.stopChildren(r)
		if allGone {
			r.State = "stopped"
		}
		if wasUnknown {
			r.State = "unknown"
		}
		_, err = e.db.Exec("UPDATE runs SET state=?,expires_at=0 WHERE id=?", r.State, r.ID)
		return r, err
	default:
		return nil, domain("INVALID")
	}
	if err = saveRun(tx, r); err != nil {
		return nil, err
	}
	return finish(r)
}

type event struct {
	Kind    string `json:"kind"`
	Run     string `json:"run_id"`
	Epoch   int64  `json:"epoch"`
	Attempt int64  `json:"attempt"`
	PID     int    `json:"pid"`
	Child   int    `json:"child_pid"`
}

func events(r run) ([]event, error) {
	data, err := os.ReadFile(r.Events)
	if err != nil {
		return nil, err
	}
	var out []event
	lines := bytes.Split(data, []byte("\n"))
	for i, line := range lines {
		if len(line) == 0 {
			continue
		}
		var ev event
		if json.Unmarshal(line, &ev) != nil {
			if i == len(lines)-1 {
				break
			}
			return nil, errors.New("invalid events")
		}
		if ev.Run != r.ID || ev.Epoch != r.Epoch || ev.Attempt != r.Attempt {
			return nil, errors.New("event binding")
		}
		out = append(out, ev)
	}
	return out, nil
}
func (e *engine) poll(tx *sql.Tx, r run, t task) (run, error) {
	p := e.children[r.ID]
	if p == nil {
		r.State = "unknown"
		return r, nil
	}
	if p.uncertain {
		r.State = "unknown"
		return r, nil
	}
	select {
	case <-p.done:
	default:
		return r, nil
	}
	active, activeErr := p.owned.active()
	if activeErr != nil {
		r.State = "unknown"
		return r, nil
	}
	observed, err := events(r)
	if err != nil {
		r.State = "unknown"
		return r, nil
	}
	complete := false
	for _, ev := range observed {
		if ev.Kind == "descendant" && processAlive(ev.Child) {
			r.State = "stop_unconfirmed"
			return r, nil
		}
		if ev.Kind == "completed" && ev.PID == r.PID {
			complete = true
		}
	}
	fault, err := meta(tx, "fault")
	if err != nil {
		return r, err
	}
	if fault == "result_full" {
		r.State = "unknown"
		return r, nil
	}
	if active != 0 {
		if complete && p.exitErr == nil {
			return r, nil
		} // Native accounting can lag parent wait.
		r.State = "stop_unconfirmed"
		return r, nil
	}
	if p.exitErr == nil && complete && r.Epoch == e.epoch && r.Revision == t.Revision && r.Hash == t.Hash && fault != "result_full" {
		r.State = "completed"
	} else {
		r.State = "unknown"
	}
	return r, nil
}
func (e *engine) stopChildren(r run) bool {
	p := e.children[r.ID]
	if p == nil {
		return false
	}
	return p.owned.terminate()
}
