//! The board over HTTP: the real binary on a loopback port, plain sockets.
//! Synthetic values only (example.com hosts, made-up names).
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::TcpStream,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};

const BIN: &str = env!("CARGO_BIN_EXE_many-iris");

struct Server {
    child: Child,
    addr: String,
    dir: tempfile::TempDir,
    ready: Value,
}
impl Server {
    fn start(dir: tempfile::TempDir, extra: &[&str]) -> Server {
        let db = dir.path().join("iris.sqlite3");
        let stop = dir.path().join("stop");
        let mut child = Command::new(BIN)
            .args([
                "--db",
                db.to_str().unwrap(),
                "--port",
                "0",
                "--shutdown-file",
                stop.to_str().unwrap(),
            ])
            .args(extra)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut line = String::new();
            let _ = BufReader::new(stdout).read_line(&mut line);
            let _ = tx.send(line);
        });
        let line = rx
            .recv_timeout(Duration::from_secs(30))
            .expect("the server did not report that it is ready");
        let ready: Value = serde_json::from_str(line.trim()).expect("ready line is JSON");
        let addr = ready["url"]
            .as_str()
            .unwrap()
            .trim_start_matches("http://")
            .to_owned();
        Server {
            child,
            addr,
            dir,
            ready,
        }
    }
    fn path(&self, name: &str) -> PathBuf {
        self.dir.path().join(name)
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        let _ = std::fs::write(self.dir.path().join("stop"), b"");
        let deadline = Instant::now() + Duration::from_secs(8);
        while Instant::now() < deadline {
            if matches!(self.child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

struct Resp {
    status: u16,
    headers: Vec<(String, String)>,
    body: String,
}
impl Resp {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
    fn json(&self) -> Value {
        serde_json::from_str(&self.body).unwrap_or_else(|_| panic!("not JSON: {}", self.body))
    }
}
fn http(addr: &str, method: &str, path: &str, headers: &[(&str, &str)], body: &str) -> Resp {
    let mut request = format!("{method} {path} HTTP/1.1\r\n");
    if !headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("host")) {
        request.push_str(&format!("Host: {addr}\r\n"));
    }
    for (k, v) in headers {
        request.push_str(&format!("{k}: {v}\r\n"));
    }
    request.push_str(&format!(
        "Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    ));
    let mut stream = TcpStream::connect(addr).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(15)))
        .unwrap();
    stream.write_all(request.as_bytes()).unwrap();
    let mut raw = Vec::new();
    let _ = stream.read_to_end(&mut raw);
    let text = String::from_utf8_lossy(&raw).into_owned();
    let (head, body) = text.split_once("\r\n\r\n").expect("an HTTP response");
    let mut lines = head.lines();
    let status = lines
        .next()
        .unwrap()
        .split(' ')
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    let headers = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_owned(), v.trim().to_owned()))
        .collect();
    Resp {
        status,
        headers,
        body: body.to_owned(),
    }
}

fn issue_key(dir: &Path, actor: &str) -> String {
    let output = Command::new(BIN)
        .args(["--board-add-writer", actor, "--board-writers"])
        .arg(dir.join("writers.json"))
        .arg("--board-token-out")
        .arg(dir.join(format!("{actor}.key")))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    std::fs::read_to_string(dir.join(format!("{actor}.key"))).unwrap()
}
fn board_server(extra: &[&str], actors: &[&str]) -> (Server, Vec<String>) {
    let dir = tempfile::tempdir().unwrap();
    let keys: Vec<String> = actors.iter().map(|a| issue_key(dir.path(), a)).collect();
    let writers = dir.path().join("writers.json");
    let mut args = vec!["--board-writers", writers.to_str().unwrap()];
    args.extend_from_slice(extra);
    let server = Server::start(dir, &args);
    (server, keys)
}

fn mcp_headers<'a>(token: &'a str, name: &'a str) -> Vec<(&'a str, &'a str)> {
    vec![
        ("Authorization", token),
        ("MCP-Protocol-Version", "2026-07-28"),
        ("Mcp-Method", "tools/call"),
        ("Mcp-Name", name),
        ("Accept", "application/json, text/event-stream"),
        ("Content-Type", "application/json"),
    ]
}
/// A tools/call with the given key. Returns the HTTP response.
fn call_with(server: &Server, extra: &[(&str, &str)], key: &str, tool: &str, args: Value) -> Resp {
    let body = many_iris::mcp::request(1, "tools/call", json!({"name": tool, "arguments": args}));
    let bearer = format!("Bearer {key}");
    let mut headers = mcp_headers(&bearer, tool);
    headers.extend_from_slice(extra);
    http(
        &server.addr,
        "POST",
        "/board/mcp",
        &headers,
        &body.to_string(),
    )
}
fn call(server: &Server, key: &str, tool: &str, args: Value) -> Value {
    let r = call_with(server, &[], key, tool, args);
    assert_eq!(r.status, 200, "{}", r.body);
    r.json()["result"].clone()
}
fn error_code(result: &Value) -> String {
    assert_eq!(result["isError"], true, "{result}");
    result["structuredContent"]["error"]["code"]
        .as_str()
        .unwrap()
        .to_owned()
}
fn item(id: &str) -> Value {
    json!({"item_id": id, "project": "example-project", "kind": "plan", "title": "An example plan", "state": "planned"})
}
/// The key a person signs in with, then the session token for `/api/board`.
fn ui_token(server: &Server, origin: &str, host: Option<&str>) -> String {
    let key = std::fs::read_to_string(server.path("iris.ui.key")).unwrap();
    let mut headers = vec![("Content-Type", "application/json"), ("Origin", origin)];
    if let Some(host) = host {
        headers.push(("Host", host));
    }
    let r = http(
        &server.addr,
        "POST",
        "/session",
        &headers,
        &json!({"key": key}).to_string(),
    );
    assert_eq!(r.status, 200, "{}", r.body);
    let cookie = r.header("set-cookie").unwrap().to_owned();
    cookie
        .split_once('=')
        .unwrap()
        .1
        .split(';')
        .next()
        .unwrap()
        .to_owned()
}

#[test]
fn without_board_writers_the_board_does_not_exist() {
    let server = Server::start(tempfile::tempdir().unwrap(), &[]);
    assert!(
        server.ready.get("board").is_none(),
        "a plain start prints what it always printed"
    );
    let post = http(
        &server.addr,
        "POST",
        "/board/mcp",
        &mcp_headers("Bearer anything", "board_list"),
        "{}",
    );
    assert_eq!(post.status, 404);
    assert_eq!(post.json()["code"], "BOARD_DISABLED");
    assert_eq!(http(&server.addr, "GET", "/board", &[], "").status, 404);
    assert_eq!(http(&server.addr, "GET", "/api/board", &[], "").status, 404);
    // The existing pages are untouched.
    assert_eq!(http(&server.addr, "GET", "/", &[], "").status, 200);
    assert_eq!(http(&server.addr, "GET", "/health", &[], "").status, 200);
}

#[test]
fn only_a_valid_enabled_key_gets_in() {
    let (server, keys) = board_server(&[], &["alice"]);
    let key = &keys[0];
    assert_eq!(server.ready["board"], true);
    let no_key = http(
        &server.addr,
        "POST",
        "/board/mcp",
        &mcp_headers("", "board_list")[1..],
        "{}",
    );
    assert_eq!(no_key.status, 401);
    let shouted = format!("Bearer {}", key.to_uppercase());
    for wrong in ["Bearer wrong-key", "Bearer ", "Basic abc", shouted.as_str()] {
        let r = http(
            &server.addr,
            "POST",
            "/board/mcp",
            &mcp_headers(wrong, "board_list"),
            "{}",
        );
        assert_eq!(r.status, 401, "{wrong}");
    }
    // A hash of the key is not the key.
    let stored = std::fs::read_to_string(server.path("writers.json")).unwrap();
    assert!(!stored.contains(key.as_str()));
    // The ordinary MCP key and the person's UI key are not board keys.
    let mcp_key = std::fs::read_to_string(server.path("iris.mcp.token")).unwrap();
    let ui_key = std::fs::read_to_string(server.path("iris.ui.key")).unwrap();
    for other in [mcp_key, ui_key] {
        let r = http(
            &server.addr,
            "POST",
            "/board/mcp",
            &mcp_headers(&format!("Bearer {other}"), "board_list"),
            "{}",
        );
        assert_eq!(r.status, 401);
    }
    // Reads need the key too.
    let ok = call_with(&server, &[], key, "board_list", json!({}));
    assert_eq!(ok.status, 200);
    assert_eq!(ok.json()["result"]["isError"], false);

    // Switching a writer off takes effect without a restart, and back on again.
    let path = server.path("writers.json");
    let original = std::fs::read_to_string(&path).unwrap();
    let mut writers: Value = serde_json::from_str(&original).unwrap();
    writers["writers"][0]["enabled"] = json!(false);
    std::fs::write(&path, writers.to_string()).unwrap();
    let off = call_with(&server, &[], key, "board_list", json!({}));
    assert_eq!(off.status, 403);
    assert_eq!(off.json()["code"], "WRITER_DISABLED");
    std::fs::write(&path, "{ not valid").unwrap();
    assert_eq!(
        call_with(&server, &[], key, "board_list", json!({})).status,
        503
    );
    std::fs::write(&path, original).unwrap();
    assert_eq!(
        call_with(&server, &[], key, "board_list", json!({})).status,
        200
    );
}

#[test]
fn the_actor_comes_from_the_key_never_from_the_request() {
    let (server, keys) = board_server(&[], &["alice", "bob"]);
    // A body that names someone else is refused outright.
    let spoof = call_with(
        &server,
        &[],
        &keys[0],
        "board_upsert_item",
        with(item("p1"), json!({"actor": "bob"})),
    );
    assert_eq!(spoof.json()["error"]["code"], -32602);
    let spoof = call_with(
        &server,
        &[],
        &keys[0],
        "board_upsert_item",
        with(item("p1"), json!({"updated_by": "bob"})),
    );
    assert_eq!(spoof.json()["error"]["code"], -32602);
    let listed = call(&server, &keys[0], "board_list", json!({}));
    assert!(
        listed["structuredContent"]["items"]
            .as_array()
            .unwrap()
            .is_empty()
    );

    // The client name the caller announces and extra headers change nothing.
    let mut body = many_iris::mcp::request(
        7,
        "tools/call",
        json!({"name": "board_upsert_item", "arguments": item("p1")}),
    );
    body["params"]["_meta"]["io.modelcontextprotocol/clientInfo"] =
        json!({"name": "bob", "version": "1"});
    let bearer = format!("Bearer {}", keys[0]);
    let mut headers = mcp_headers(&bearer, "board_upsert_item");
    headers.extend_from_slice(&[("X-Actor", "bob"), ("X-Forwarded-User", "bob")]);
    let r = http(
        &server.addr,
        "POST",
        "/board/mcp",
        &headers,
        &body.to_string(),
    );
    assert_eq!(
        r.json()["result"]["structuredContent"]["item"]["updated_by"],
        "alice"
    );

    let by_bob = call(
        &server,
        &keys[1],
        "board_upsert_item",
        json!({"item_id": "p1", "state": "in_progress"}),
    );
    assert_eq!(by_bob["structuredContent"]["item"]["updated_by"], "bob");
    let note = call(
        &server,
        &keys[0],
        "board_add_event",
        json!({"item_id": "p1", "kind": "note", "text": "hello"}),
    );
    assert_eq!(note["structuredContent"]["event"]["actor"], "alice");
    let spoofed_event = call_with(
        &server,
        &[],
        &keys[0],
        "board_add_event",
        json!({"item_id": "p1", "kind": "note", "text": "x", "actor": "bob"}),
    );
    assert_eq!(spoofed_event.json()["error"]["code"], -32602);

    let listed = call(&server, &keys[0], "board_list", json!({}));
    let events = listed["structuredContent"]["events"].as_array().unwrap();
    let actors: Vec<_> = events
        .iter()
        .map(|e| (e["kind"].as_str().unwrap(), e["actor"].as_str().unwrap()))
        .collect();
    assert_eq!(actors, vec![("state_change", "bob"), ("note", "alice")]);
}
fn with(mut base: Value, extra: Value) -> Value {
    for (k, v) in extra.as_object().unwrap() {
        base[k] = v.clone();
    }
    base
}

#[test]
fn the_three_tools_work_end_to_end_and_report_their_errors() {
    let (server, keys) = board_server(&[], &["alice"]);
    let key = &keys[0];
    let listing = http(
        &server.addr,
        "POST",
        "/board/mcp",
        &mcp_headers(&format!("Bearer {key}"), "tools/list")
            .into_iter()
            .map(|(k, v)| {
                if k == "Mcp-Method" {
                    (k, "tools/list")
                } else {
                    (k, v)
                }
            })
            .filter(|(k, _)| *k != "Mcp-Name")
            .collect::<Vec<_>>(),
        &many_iris::mcp::request(2, "tools/list", json!({})).to_string(),
    );
    assert_eq!(listing.status, 200, "{}", listing.body);
    let names: Vec<_> = listing.json()["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(
        names,
        ["board_upsert_item", "board_add_event", "board_list"]
    );

    let created = call(&server, key, "board_upsert_item", item("plan-1"));
    assert_eq!(created["structuredContent"]["item"]["revision"], 1);
    let conflict = call(
        &server,
        key,
        "board_upsert_item",
        json!({"item_id": "plan-1", "title": "Changed", "expected_revision": 9}),
    );
    assert_eq!(error_code(&conflict), "REVISION_CONFLICT");
    let bad_ref = call(
        &server,
        key,
        "board_upsert_item",
        json!({"item_id": "plan-1", "source_ref": "/etc/passwd"}),
    );
    assert_eq!(error_code(&bad_ref), "INVALID");
    let child = call(
        &server,
        key,
        "board_upsert_item",
        with(
            item("task-1"),
            json!({"kind": "task", "parent_id": "plan-1"}),
        ),
    );
    assert_eq!(child["isError"], false);
    let cycle = call(
        &server,
        key,
        "board_upsert_item",
        json!({"item_id": "plan-1", "parent_id": "task-1"}),
    );
    assert_eq!(error_code(&cycle), "CYCLE");
    let missing = call(
        &server,
        key,
        "board_add_event",
        json!({"item_id": "nope", "kind": "note", "text": "x"}),
    );
    assert_eq!(error_code(&missing), "NOT_FOUND");
    call(
        &server,
        key,
        "board_add_event",
        json!({"item_id": "task-1", "kind": "session_start", "text": "started"}),
    );
    let since = call(
        &server,
        key,
        "board_list",
        json!({"project": "example-project", "since_seq": 0}),
    );
    assert_eq!(
        since["structuredContent"]["events"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let last = since["structuredContent"]["next_since_seq"]
        .as_u64()
        .unwrap();
    let none = call(&server, key, "board_list", json!({"since_seq": last}));
    assert!(
        none["structuredContent"]["events"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let other = call(
        &server,
        key,
        "board_list",
        json!({"project": "another-project"}),
    );
    assert!(
        other["structuredContent"]["items"]
            .as_array()
            .unwrap()
            .is_empty()
    );

    // The HTTP side of the protocol is checked as on /mcp.
    let bearer = format!("Bearer {key}");
    let mut headers = mcp_headers(&bearer, "board_list");
    headers.retain(|(k, _)| *k != "MCP-Protocol-Version");
    let body = many_iris::mcp::request(
        3,
        "tools/call",
        json!({"name": "board_list", "arguments": {}}),
    );
    assert_eq!(
        http(
            &server.addr,
            "POST",
            "/board/mcp",
            &headers,
            &body.to_string()
        )
        .status,
        400
    );
    let mut headers = mcp_headers(&bearer, "board_list");
    headers.retain(|(k, _)| *k != "Content-Type");
    headers.push(("Content-Type", "text/plain"));
    assert_eq!(
        http(
            &server.addr,
            "POST",
            "/board/mcp",
            &headers,
            &body.to_string()
        )
        .status,
        415
    );
    assert_eq!(http(&server.addr, "GET", "/board/mcp", &[], "").status, 405);
}

#[test]
fn the_page_and_its_data_need_the_person_ui_key_not_a_writer_key() {
    let (server, keys) = board_server(&[], &["alice"]);
    call(&server, &keys[0], "board_upsert_item", item("plan-1"));
    call(
        &server,
        &keys[0],
        "board_add_event",
        json!({"item_id": "plan-1", "kind": "note", "text": "a visible note"}),
    );

    assert_eq!(http(&server.addr, "GET", "/api/board", &[], "").status, 401);
    let with_writer_key = http(
        &server.addr,
        "GET",
        "/api/board",
        &[("Authorization", &format!("Bearer {}", keys[0]))],
        "",
    );
    assert_eq!(
        with_writer_key.status, 401,
        "a writer key must not read the person's data route"
    );

    let origin = format!("http://{}", server.addr);
    let token = ui_token(&server, &origin, None);
    let data = http(
        &server.addr,
        "GET",
        "/api/board",
        &[("Authorization", &format!("Bearer {token}"))],
        "",
    );
    assert_eq!(data.status, 200);
    let data = data.json();
    assert_eq!(data["items"][0]["item_id"], "plan-1");
    assert_eq!(data["items"][0]["last_event"]["text"], "a visible note");
    assert_eq!(data["events"][0]["text"], "a visible note");
    assert!(data["generated_at"].is_number());

    // The person's session token is not a writer key either.
    let r = http(
        &server.addr,
        "POST",
        "/board/mcp",
        &mcp_headers(&format!("Bearer {token}"), "board_list"),
        "{}",
    );
    assert_eq!(r.status, 401);

    // /board shows the sign-in page without a session, and the board with one.
    let signed_out = http(&server.addr, "GET", "/board", &[], "");
    assert_eq!(signed_out.status, 200);
    assert!(signed_out.body.contains("login.js"));
    assert!(!signed_out.body.contains(&token));
    let page = http(
        &server.addr,
        "GET",
        "/board",
        &[("Authorization", &format!("Bearer {token}"))],
        "",
    );
    assert_eq!(page.status, 200);
    assert!(page.body.contains("/board.js"));
    assert!(
        page.body.contains(&token),
        "the session token is placed in the page for its own script"
    );
    assert!(
        page.header("content-security-policy")
            .unwrap()
            .contains("script-src 'self'")
    );
    assert_eq!(http(&server.addr, "GET", "/board.js", &[], "").status, 200);
    assert_eq!(http(&server.addr, "GET", "/board.css", &[], "").status, 200);
    // No write verb reaches the page routes.
    assert_eq!(
        http(
            &server.addr,
            "POST",
            "/api/board",
            &[
                ("Authorization", &format!("Bearer {token}")),
                ("Content-Type", "application/json")
            ],
            "{}"
        )
        .status,
        404
    );
}

#[test]
fn a_public_origin_is_accepted_only_when_it_is_configured() {
    // Not configured: only the loopback host and origin pass, as before.
    let (server, keys) = board_server(&[], &["alice"]);
    let r = call_with(
        &server,
        &[("Host", "board.example.com")],
        &keys[0],
        "board_list",
        json!({}),
    );
    assert_eq!(r.status, 403);
    assert_eq!(r.json()["code"], "HOST");
    let r = call_with(
        &server,
        &[("Origin", "https://board.example.com")],
        &keys[0],
        "board_list",
        json!({}),
    );
    assert_eq!(r.status, 403);
    assert_eq!(r.json()["code"], "ORIGIN");
    drop(server);

    let (server, keys) = board_server(
        &["--public-origin", "https://board.example.com"],
        &["alice"],
    );
    assert_eq!(server.ready["public_origin"], "https://board.example.com");
    let key = &keys[0];
    // The loopback host still works.
    assert_eq!(
        call_with(&server, &[], key, "board_list", json!({})).status,
        200
    );
    // The public Host, the public Origin, and both together.
    assert_eq!(
        call_with(
            &server,
            &[("Host", "board.example.com")],
            key,
            "board_list",
            json!({})
        )
        .status,
        200
    );
    assert_eq!(
        call_with(
            &server,
            &[("Origin", "https://board.example.com")],
            key,
            "board_list",
            json!({})
        )
        .status,
        200
    );
    assert_eq!(
        call_with(
            &server,
            &[
                ("Host", "Board.Example.com"),
                ("Origin", "https://board.example.com")
            ],
            key,
            "board_list",
            json!({})
        )
        .status,
        200
    );
    // Anything else is still refused.
    for (host, origin, expect) in [
        ("other.example.com", None, "HOST"),
        ("board.example.com.evil.example.net", None, "HOST"),
        ("board.example.com:8443", None, "HOST"),
        (
            "board.example.com",
            Some("https://other.example.com"),
            "ORIGIN",
        ),
        (
            "board.example.com",
            Some("http://board.example.com"),
            "ORIGIN",
        ),
        ("board.example.com", Some("null"), "ORIGIN"),
    ] {
        let mut extra = vec![("Host", host)];
        if let Some(origin) = origin {
            extra.push(("Origin", origin));
        }
        let r = call_with(&server, &extra, key, "board_list", json!({}));
        assert_eq!(
            (r.status, r.json()["code"].as_str().unwrap().to_owned()),
            (403, expect.to_owned()),
            "{host} {origin:?}"
        );
    }
    // A key is still required on the public host.
    let r = http(
        &server.addr,
        "POST",
        "/board/mcp",
        &[
            ("Host", "board.example.com"),
            ("Content-Type", "application/json"),
        ],
        "{}",
    );
    assert_eq!(r.status, 401);

    // What the public host may reach is the board and its sign-in, nothing else.
    for (method, path) in [
        ("POST", "/api/action"),
        ("POST", "/mcp"),
        ("GET", "/api/state"),
        ("GET", "/"),
        ("GET", "/app.js"),
    ] {
        let r = http(
            &server.addr,
            method,
            path,
            &[
                ("Host", "board.example.com"),
                ("Content-Type", "application/json"),
            ],
            "{}",
        );
        assert_eq!(r.status, 404, "{method} {path}");
    }
    let r = http(
        &server.addr,
        "POST",
        "/api/action",
        &[
            ("Origin", "https://board.example.com"),
            ("Content-Type", "application/json"),
        ],
        "{}",
    );
    assert_eq!(
        r.status, 404,
        "a public Origin alone does not open the operating routes"
    );
    // The same routes still work from the loopback host.
    assert_eq!(http(&server.addr, "GET", "/", &[], "").status, 200);

    // Signing in through the public host sets a Secure cookie, and the page works.
    let key_text = std::fs::read_to_string(server.path("iris.ui.key")).unwrap();
    let login = http(
        &server.addr,
        "POST",
        "/session",
        &[
            ("Host", "board.example.com"),
            ("Origin", "https://board.example.com"),
            ("Content-Type", "application/json"),
        ],
        &json!({"key": key_text}).to_string(),
    );
    assert_eq!(login.status, 200);
    assert!(login.header("set-cookie").unwrap().contains("Secure"));
    let token = login
        .header("set-cookie")
        .unwrap()
        .split_once('=')
        .unwrap()
        .1
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let data = http(
        &server.addr,
        "GET",
        "/api/board",
        &[
            ("Host", "board.example.com"),
            ("Authorization", &format!("Bearer {token}")),
        ],
        "",
    );
    assert_eq!(data.status, 200);
    let page = http(
        &server.addr,
        "GET",
        "/board",
        &[
            ("Host", "board.example.com"),
            ("Authorization", &format!("Bearer {token}")),
        ],
        "",
    );
    assert!(page.body.contains("/board.js"));
    // A loopback sign-in is not Secure (plain http on the loopback address).
    let local = http(
        &server.addr,
        "POST",
        "/session",
        &[
            ("Origin", &format!("http://{}", server.addr)),
            ("Content-Type", "application/json"),
        ],
        &json!({"key": key_text}).to_string(),
    );
    assert!(!local.header("set-cookie").unwrap().contains("Secure"));
}

#[test]
fn the_server_listens_on_loopback_only() {
    let (server, _keys) = board_server(
        &["--public-origin", "https://board.example.com"],
        &["alice"],
    );
    assert!(server.addr.starts_with("127.0.0.1:"), "{}", server.addr);
}

#[test]
fn startup_refuses_unusable_board_arguments() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("iris.sqlite3");
    let writers = dir.path().join("writers.json");
    issue_key(dir.path(), "alice");
    let run = |extra: &[&str]| {
        Command::new(BIN)
            .args(["--db", db.to_str().unwrap(), "--port", "0"])
            .args(extra)
            .stdin(Stdio::null())
            .output()
            .unwrap()
    };
    // A public origin without the board, a malformed one, a missing or broken writers file.
    for extra in [
        vec!["--public-origin", "https://board.example.com"],
        vec![
            "--board-writers",
            writers.to_str().unwrap(),
            "--public-origin",
            "http://board.example.com",
        ],
        vec![
            "--board-writers",
            writers.to_str().unwrap(),
            "--public-origin",
            "https://board.example.com/path",
        ],
        vec![
            "--board-writers",
            dir.path().join("missing.json").to_str().unwrap(),
        ],
        vec![
            "--board-token-out",
            dir.path().join("x.key").to_str().unwrap(),
        ],
    ] {
        let out = run(&extra);
        assert!(!out.status.success(), "{extra:?}");
        assert!(out.stdout.is_empty(), "{extra:?}");
    }
    std::fs::write(&writers, "{}").unwrap();
    assert!(
        !run(&["--board-writers", writers.to_str().unwrap()])
            .status
            .success()
    );
    assert!(
        !db.exists(),
        "a refused start must not create the state file"
    );
}

#[test]
fn issuing_a_key_prints_no_key_and_never_overwrites_a_key_file() {
    let dir = tempfile::tempdir().unwrap();
    let writers = dir.path().join("writers.json");
    let token_file = dir.path().join("agent.key");
    let run = |actor: &str, token_out: &Path| {
        Command::new(BIN)
            .args(["--board-add-writer", actor, "--board-writers"])
            .arg(&writers)
            .arg("--board-token-out")
            .arg(token_out)
            .output()
            .unwrap()
    };
    let first = run("agent-one", &token_file);
    assert!(first.status.success());
    let token = std::fs::read_to_string(&token_file).unwrap();
    let printed = String::from_utf8_lossy(&first.stdout).into_owned()
        + &String::from_utf8_lossy(&first.stderr);
    assert!(!printed.contains(&token), "the key must not be printed");
    let summary: Value = serde_json::from_str(printed.trim()).unwrap();
    assert_eq!(summary["actor"], "agent-one");
    assert_eq!(summary["ok"], true);
    assert!(summary.get("token").is_none());

    let before = std::fs::read(&writers).unwrap();
    let again = run("agent-two", &token_file);
    assert!(
        !again.status.success(),
        "an existing key file is not overwritten"
    );
    assert_eq!(std::fs::read_to_string(&token_file).unwrap(), token);
    assert_eq!(std::fs::read(&writers).unwrap(), before);
    assert!(!String::from_utf8_lossy(&again.stderr).contains(&token));
    // The same actor again, a bad name, and extra arguments are refused.
    assert!(
        !run("agent-one", &dir.path().join("two.key"))
            .status
            .success()
    );
    assert!(
        !run("Bad_Name", &dir.path().join("three.key"))
            .status
            .success()
    );
    assert!(!dir.path().join("two.key").exists() && !dir.path().join("three.key").exists());
    let extra = Command::new(BIN)
        .args(["--board-add-writer", "agent-three", "--board-writers"])
        .arg(&writers)
        .arg("--board-token-out")
        .arg(dir.path().join("four.key"))
        .args(["--port", "0"])
        .output()
        .unwrap();
    assert!(!extra.status.success());
    assert!(!dir.path().join("four.key").exists());
}

#[test]
fn a_key_added_while_the_server_runs_works_without_a_restart() {
    let (server, keys) = board_server(&[], &["alice"]);
    let late = issue_key(server.dir.path(), "late-writer");
    assert_eq!(
        call_with(&server, &[], &keys[0], "board_list", json!({})).status,
        200
    );
    let made = call(&server, &late, "board_upsert_item", item("late-1"));
    assert_eq!(
        made["structuredContent"]["item"]["updated_by"],
        "late-writer"
    );
}
