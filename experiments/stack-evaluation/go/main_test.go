package main

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func fresh(t *testing.T) *engine {
	t.Helper()
	dir := t.TempDir()
	fixture := filepath.Join(dir, "fixture.json")
	tasks := []task{{ID: "task-00000", Title: "Synthetic task 00000", Source: "Synthetic", Hash: hash("Synthetic"), Revision: 1}, {ID: "task-00001", Title: "Synthetic task 00001", Source: "Second synthetic", Hash: hash("Second synthetic"), Revision: 1}}
	b, _ := json.Marshal(map[string]any{"version": 1, "now": int64(2000000000), "tasks": tasks})
	if err := os.WriteFile(fixture, b, 0600); err != nil {
		t.Fatal(err)
	}
	e, err := openEngine(config{DB: filepath.Join(dir, "state.db"), Fixture: fixture, Test: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { e.close() })
	return e
}
func invoke(e *engine, op string, args map[string]any) (any, error) {
	if args == nil {
		args = map[string]any{}
	}
	args["op"] = op
	b, _ := json.Marshal(args)
	var req map[string]json.RawMessage
	_ = json.Unmarshal(b, &req)
	return e.call(req)
}
func callOK(t *testing.T, e *engine, op string, args map[string]any) any {
	t.Helper()
	v, err := invoke(e, op, args)
	if err != nil {
		t.Fatalf("%s: %v", op, err)
	}
	return v
}
func callErr(t *testing.T, e *engine, op string, args map[string]any, want string) {
	t.Helper()
	_, err := invoke(e, op, args)
	if err == nil || err.Error() != want {
		t.Fatalf("%s: got %v want %s", op, err, want)
	}
}
func start(t *testing.T, e *engine, id string) run {
	return callOK(t, e, "start", map[string]any{"task_id": "task-00000", "request_id": id}).(run)
}
func approve(t *testing.T, e *engine, r run) {
	t.Helper()
	callOK(t, e, "approve", map[string]any{"run_id": r.ID, "revision": r.Revision, "source_hash": r.Hash, "expires_at": int64(2000001000)})
}

func TestDuplicateRequestAndTaskExclusion(t *testing.T) {
	e := fresh(t)
	r := start(t, e, "request-1")
	same := start(t, e, "request-1")
	if r.ID != same.ID {
		t.Fatal("request replay changed ID")
	}
	callErr(t, e, "start", map[string]any{"task_id": "task-00001", "request_id": "request-1"}, "REQUEST_CONFLICT")
	callErr(t, e, "start", map[string]any{"task_id": "task-00000", "request_id": "request-2"}, "ACTIVE_RUN")
}

func TestSQLiteRuntimePragmas(t *testing.T) {
	e := fresh(t)
	var version, journal string
	var synchronous, foreign, busy int
	if err := e.db.QueryRow("SELECT sqlite_version()").Scan(&version); err != nil {
		t.Fatal(err)
	}
	if err := e.db.QueryRow("PRAGMA journal_mode").Scan(&journal); err != nil {
		t.Fatal(err)
	}
	if err := e.db.QueryRow("PRAGMA synchronous").Scan(&synchronous); err != nil {
		t.Fatal(err)
	}
	if err := e.db.QueryRow("PRAGMA foreign_keys").Scan(&foreign); err != nil {
		t.Fatal(err)
	}
	if err := e.db.QueryRow("PRAGMA busy_timeout").Scan(&busy); err != nil {
		t.Fatal(err)
	}
	if journal != "wal" || synchronous != 2 || foreign != 1 || busy != 1000 {
		t.Fatalf("journal=%s synchronous=%d fk=%d busy=%d", journal, synchronous, foreign, busy)
	}
	t.Logf("SQLite runtime %s; WAL; synchronous FULL; foreign keys ON; busy timeout %dms", version, busy)
}

func TestControllerLeaseRejectsSecondOwnerBeforeEpochChange(t *testing.T) {
	e := fresh(t)
	epoch := e.epoch
	second, err := openEngine(e.cfg)
	if err == nil {
		second.close()
		t.Fatal("second live controller accepted")
	}
	var current int64
	if er := e.db.QueryRow("SELECT CAST(value AS INTEGER) FROM metadata WHERE key='epoch'").Scan(&current); er != nil {
		t.Fatal(er)
	}
	if current != epoch {
		t.Fatal("rejected startup mutated epoch")
	}
	callOK(t, e, "list", nil)
}

func TestControllerLeaseRejectsHardlinkAlias(t *testing.T) {
	e := fresh(t)
	alias := filepath.Join(filepath.Dir(e.cfg.DB), "alias.db")
	if err := os.Link(e.cfg.DB, alias); err != nil {
		t.Fatal(err)
	}
	c := e.cfg
	c.DB = alias
	second, err := openEngine(c)
	if err == nil {
		second.close()
		t.Fatal("hardlink alias accepted")
	}
}

func TestControllerLeaseResolvesSymlinkAlias(t *testing.T) {
	e := fresh(t)
	alias := filepath.Join(filepath.Dir(e.cfg.DB), "symlink.db")
	if err := os.Symlink(e.cfg.DB, alias); err != nil {
		t.Skip("OS symlink capability unavailable")
	}
	c := e.cfg
	c.DB = alias
	second, err := openEngine(c)
	if err == nil {
		second.close()
		t.Fatal("symlink alias accepted")
	}
}

func TestCurrentEpochFenceRejectsStaleController(t *testing.T) {
	e := fresh(t)
	if _, err := e.db.Exec("UPDATE metadata SET value=CAST(value AS INTEGER)+1 WHERE key='epoch'"); err != nil {
		t.Fatal(err)
	}
	callErr(t, e, "start", map[string]any{"task_id": "task-00000", "request_id": "stale-controller"}, "STALE_CONTROLLER")
	if len(e.children) != 0 {
		t.Fatal("stale owner launched helper")
	}
}

func TestPostLaunchPIDPersistenceFailureStopsNativeJob(t *testing.T) {
	helper := os.Getenv("IRIS_COMPARE_HELPER")
	python := os.Getenv("IRIS_COMPARE_PYTHON")
	if helper == "" || python == "" {
		t.Skip("explicit common helper/Python required")
	}
	e := fresh(t)
	e.cfg.Helper = helper
	e.cfg.Python = python
	r := start(t, e, "pid-save-failure")
	approve(t, e, r)
	callOK(t, e, "enqueue", map[string]any{"run_id": r.ID})
	_, err := e.db.Exec("CREATE TRIGGER fail_pid BEFORE UPDATE OF pid ON runs WHEN NEW.pid > 0 BEGIN SELECT RAISE(ABORT,'injected'); END")
	if err != nil {
		t.Fatal(err)
	}
	callErr(t, e, "dispatch", map[string]any{"run_id": r.ID, "mode": "slow"}, "STORAGE")
	p := e.children[r.ID]
	if p == nil {
		t.Fatal("native child ownership absent")
	}
	if active, er := p.owned.active(); er != nil || active != 0 {
		t.Fatalf("native job remains active: %d %v", active, er)
	}
	got := callOK(t, e, "status", map[string]any{"run_id": r.ID}).(run)
	if got.State != "unknown" {
		t.Fatalf("state=%s", got.State)
	}
	stopped := callOK(t, e, "stop", map[string]any{"run_id": r.ID}).(run)
	if stopped.State != "unknown" {
		t.Fatal("uncertain outcome erased")
	}
	callErr(t, e, "start", map[string]any{"task_id": r.Task, "request_id": "unsafe-after-save-failure"}, "ACTIVE_RUN")
}
func TestConcurrentStartsHaveSingleOwner(t *testing.T) {
	e := fresh(t)
	var wg sync.WaitGroup
	var mu sync.Mutex
	success := 0
	for _, id := range []string{"race-1", "race-2", "race-3", "race-4"} {
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			_, err := invoke(e, "start", map[string]any{"task_id": "task-00000", "request_id": id})
			if err == nil {
				mu.Lock()
				success++
				mu.Unlock()
			} else if err.Error() != "ACTIVE_RUN" {
				t.Error(err)
			}
		}(id)
	}
	wg.Wait()
	if success != 1 {
		t.Fatalf("owners=%d", success)
	}
}
func TestRevocationExpiryAndRevisionBlockDispatch(t *testing.T) {
	for _, which := range []string{"revoke", "expiry", "revision"} {
		t.Run(which, func(t *testing.T) {
			e := fresh(t)
			r := start(t, e, "guard")
			approve(t, e, r)
			callOK(t, e, "enqueue", map[string]any{"run_id": r.ID})
			want := "STATE"
			switch which {
			case "revoke":
				callOK(t, e, "revoke", map[string]any{"run_id": r.ID})
			case "expiry":
				callOK(t, e, "advance", map[string]any{"seconds": 1000})
				want = "STALE_APPROVAL"
			case "revision":
				callOK(t, e, "revise", map[string]any{"task_id": r.Task, "source": "Changed synthetic"})
			}
			callErr(t, e, "dispatch", map[string]any{"run_id": r.ID, "mode": "success"}, want)
			if len(e.children) != 0 {
				t.Fatal("launched despite revoked/stale approval")
			}
			if _, err := os.Stat(r.Events); !os.IsNotExist(err) {
				t.Fatal("unexpected helper output")
			}
		})
	}
}
func TestStaleApprovalAndLateResult(t *testing.T) {
	e := fresh(t)
	r := start(t, e, "stale")
	callErr(t, e, "approve", map[string]any{"run_id": r.ID, "revision": 2, "source_hash": r.Hash, "expires_at": int64(2000001000)}, "STALE_APPROVAL")
	callErr(t, e, "result", map[string]any{"run_id": r.ID, "revision": r.Revision, "source_hash": r.Hash, "epoch": r.Epoch + 1, "attempt": 1}, "STALE_RESULT")
	got := callOK(t, e, "status", map[string]any{"run_id": r.ID}).(run)
	if got.State != "waiting" {
		t.Fatal("late result mutated state")
	}
}
func TestIntentFailuresNeverLaunch(t *testing.T) {
	for _, fault := range []string{"intent_full", "busy"} {
		t.Run(fault, func(t *testing.T) {
			e := fresh(t)
			r := start(t, e, "blocked")
			approve(t, e, r)
			callOK(t, e, "enqueue", map[string]any{"run_id": r.ID})
			callOK(t, e, "fault", map[string]any{"kind": fault})
			callErr(t, e, "dispatch", map[string]any{"run_id": r.ID, "mode": "success"}, "STORAGE")
			if len(e.children) != 0 {
				t.Fatal("process launched")
			}
			got := callOK(t, e, "status", map[string]any{"run_id": r.ID}).(run)
			if got.State != "queued" {
				t.Fatal("failed intent changed state")
			}
		})
	}
}
func TestRestartInvalidatesGrantAndUnknownBlocksReplacement(t *testing.T) {
	e := fresh(t)
	r := start(t, e, "restart")
	approve(t, e, r)
	callOK(t, e, "enqueue", map[string]any{"run_id": r.ID})
	if _, err := e.db.Exec("UPDATE runs SET state='running' WHERE id=?", r.ID); err != nil {
		t.Fatal(err)
	}
	if err := e.close(); err != nil {
		t.Fatal(err)
	}
	next, err := openEngine(e.cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer next.close()
	got := callOK(t, next, "status", map[string]any{"run_id": r.ID}).(run)
	if got.State != "unknown" {
		t.Fatal(got.State)
	}
	callErr(t, next, "start", map[string]any{"task_id": r.Task, "request_id": "replacement"}, "ACTIVE_RUN")
	callErr(t, next, "dispatch", map[string]any{"run_id": r.ID, "mode": "success"}, "STATE")
}
func TestSnapshotAndRestoreHold(t *testing.T) {
	e := fresh(t)
	r := start(t, e, "snapshot")
	approve(t, e, r)
	target := filepath.Join(filepath.Dir(e.cfg.DB), "backup.db")
	callOK(t, e, "snapshot", map[string]any{"path": target})
	callErr(t, e, "snapshot", map[string]any{"path": target}, "INVALID")
	callErr(t, e, "snapshot", map[string]any{"path": filepath.Join(filepath.Dir(e.cfg.DB), "..", "outside.db")}, "INVALID")
	c := e.cfg
	c.DB = target
	c.Restored = true
	restored, err := openEngine(c)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.close()
	callErr(t, restored, "start", map[string]any{"task_id": r.Task, "request_id": "restored"}, "RESTORE_HOLD")
	callOK(t, restored, "detail", map[string]any{"task_id": r.Task})
	if err := restored.close(); err != nil {
		t.Fatal(err)
	}
	c.Restored = false
	reopened, err := openEngine(c)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.close()
	callErr(t, reopened, "start", map[string]any{"task_id": r.Task, "request_id": "still-held"}, "RESTORE_HOLD")
}
func TestUnknownFieldAndNormalModeFaultControl(t *testing.T) {
	e := fresh(t)
	callErr(t, e, "start", map[string]any{"task_id": "task-00000", "request_id": "x", "command": "unapproved"}, "INVALID")
	e.cfg.Test = false
	callErr(t, e, "fault", map[string]any{"kind": "busy"}, "INVALID")
	callErr(t, e, "advance", map[string]any{"seconds": 1}, "INVALID")
}
func TestHTTPGuards(t *testing.T) {
	e := fresh(t)
	h := e.handler("synthetic-token-for-test", 12345)
	for _, test := range []struct {
		name, host, origin, auth, body string
		want                           int
	}{{"valid", "127.0.0.1:12345", "", "Bearer synthetic-token-for-test", `{"op":"list"}`, 200}, {"host", "attacker.invalid", "", "Bearer synthetic-token-for-test", `{"op":"list"}`, 403}, {"origin", "127.0.0.1:12345", "http://attacker.invalid", "Bearer synthetic-token-for-test", `{"op":"list"}`, 403}, {"auth", "127.0.0.1:12345", "", "Bearer wrong", `{"op":"list"}`, 403}, {"json", "127.0.0.1:12345", "", "Bearer synthetic-token-for-test", `{"op":"list"} {}`, 400}, {"oversized", "127.0.0.1:12345", "", "Bearer synthetic-token-for-test", strings.Repeat("x", 65537), 400}} {
		t.Run(test.name, func(t *testing.T) {
			r := httptest.NewRequest("POST", "http://127.0.0.1:12345/api", strings.NewReader(test.body))
			r.Host = test.host
			r.Header.Set("Origin", test.origin)
			r.Header.Set("Authorization", test.auth)
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != test.want {
				t.Fatalf("got %d want %d: %s", w.Code, test.want, w.Body.String())
			}
			if w.Header().Get("Access-Control-Allow-Origin") != "" {
				t.Fatal("unexpected CORS")
			}
		})
	}
}

func TestSharedHelperLifecycle(t *testing.T) {
	helper := os.Getenv("IRIS_COMPARE_HELPER")
	python := os.Getenv("IRIS_COMPARE_PYTHON")
	if helper == "" || python == "" {
		t.Skip("explicit common helper/Python required")
	}
	for _, mode := range []string{"success", "slow", "orphan", "result_full"} {
		t.Run(mode, func(t *testing.T) {
			e := fresh(t)
			e.cfg.Helper = helper
			e.cfg.Python = python
			r := start(t, e, "helper-"+mode)
			approve(t, e, r)
			callOK(t, e, "enqueue", map[string]any{"run_id": r.ID})
			launchMode := mode
			if mode == "result_full" {
				launchMode = "success"
				callOK(t, e, "fault", map[string]any{"kind": "result_full"})
			}
			r = callOK(t, e, "dispatch", map[string]any{"run_id": r.ID, "mode": launchMode}).(run)
			t.Cleanup(func() { e.mu.Lock(); defer e.mu.Unlock(); e.stopChildren(r) })
			deadline := time.Now().Add(5 * time.Second)
			if mode == "slow" {
				for time.Now().Before(deadline) {
					evs, _ := events(r)
					seen := false
					for _, ev := range evs {
						if ev.Kind == "descendant" {
							seen = true
						}
					}
					if seen {
						break
					}
					time.Sleep(10 * time.Millisecond)
				}
				got := callOK(t, e, "stop", map[string]any{"run_id": r.ID}).(run)
				if got.State != "stopped" {
					t.Fatalf("stop=%s", got.State)
				}
				return
			}
			var got run
			for time.Now().Before(deadline) {
				got = callOK(t, e, "status", map[string]any{"run_id": r.ID}).(run)
				if got.State != "running" {
					break
				}
				time.Sleep(10 * time.Millisecond)
			}
			want := "completed"
			if mode == "orphan" {
				want = "stop_unconfirmed"
			}
			if mode == "result_full" {
				want = "unknown"
			}
			if got.State != want {
				t.Fatalf("got %s want %s", got.State, want)
			}
			if mode == "result_full" {
				stopped := callOK(t, e, "stop", map[string]any{"run_id": r.ID}).(run)
				if stopped.State != "unknown" {
					t.Fatalf("unknown outcome erased by stop: %s", stopped.State)
				}
				callErr(t, e, "start", map[string]any{"task_id": r.Task, "request_id": "unknown-replacement"}, "ACTIVE_RUN")
			}
			if mode == "orphan" {
				callErr(t, e, "start", map[string]any{"task_id": r.Task, "request_id": "unsafe-replacement"}, "ACTIVE_RUN")
				stopped := callOK(t, e, "stop", map[string]any{"run_id": r.ID}).(run)
				if stopped.State != "stopped" {
					t.Fatalf("orphan cleanup=%s", stopped.State)
				}
			}
		})
	}
}
