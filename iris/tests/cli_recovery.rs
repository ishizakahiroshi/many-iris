//! Read-only recovery over a synthetic loopback peer; no Hub or provider.
use many_iris::{cli_executor::Client, mcp};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    time::Duration,
};

fn binding() -> Value {
    json!({"principal_id":"principal","workspace_id":"workspace","plan_id":"plan","plan_revision":1,"task_id":"task","instruction_revision":1,"instruction_hash":"a".repeat(64),"approval_id":"approval","approval_revision":1,"scope_hash":"b".repeat(64),"execution_host_id":"host","executor_instance_id":"old-boot","attempt_id":"attempt","fence":2,"provider":"synthetic","profile_id":"synthetic"})
}
fn lookup() -> Value {
    let receipt = json!({"ok":true,"contract_version":"many-ai-cli-iris-execution/1","receipt_id":"start-attempt-request","request_id":"request","operation":"start","binding":binding(),"attempt_id":"attempt","fence":2,"execution_state":"accepted","outcome":"pending","event_seq":0,"synthetic":null,"proof_scope":"unverified"});
    let mut recovered = receipt.clone();
    recovered["receipt_id"] = json!("recovery-attempt-new-boot");
    recovered["request_id"] = json!("new-boot");
    recovered["operation"] = json!("recovery");
    recovered["execution_state"] = json!("unknown");
    recovered["outcome"] = json!("unknown");
    json!({"ok":true,"request_receipt":receipt,"current":{"ok":true,"contract_version":"many-ai-cli-iris-execution/1","binding":binding(),"execution_state":"unknown","outcome":"unknown","event_seq":0,"synthetic":null,"restore_hold":true,"receipt":recovered,"start_receipt":receipt,"stop_request_id":null,"stop_receipt":null,"evidence":null,"proof_scope":"unverified"}})
}

async fn peer(
    value: Value,
    fault: &'static str,
) -> (u16, Arc<Mutex<Vec<String>>>, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let calls = Arc::new(Mutex::new(Vec::new()));
    let seen = calls.clone();
    let task = tokio::spawn(async move {
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut wire = Vec::new();
            let mut buf = [0; 4096];
            let end = loop {
                let n = stream.read(&mut buf).await.unwrap();
                if n == 0 {
                    return;
                }
                wire.extend_from_slice(&buf[..n]);
                if let Some(i) = wire.windows(4).position(|v| v == b"\r\n\r\n") {
                    break i + 4;
                }
                assert!(wire.len() < 16384);
            };
            let head = std::str::from_utf8(&wire[..end]).unwrap();
            assert!(head.starts_with("POST /api/iris-execution/mcp HTTP/1.1\r\n"));
            assert!(head.contains("Authorization: Bearer synthetic-recovery-key\r\n"));
            let length: usize = head
                .lines()
                .find_map(|l| l.strip_prefix("Content-Length: "))
                .unwrap()
                .parse()
                .unwrap();
            while wire.len() - end < length {
                let n = stream.read(&mut buf).await.unwrap();
                assert!(n > 0);
                wire.extend_from_slice(&buf[..n]);
            }
            let request = mcp::parse_json(&wire[end..]).unwrap();
            let method = request["method"].as_str().unwrap();
            let name = request["params"]["name"].as_str().unwrap_or(method);
            seen.lock().unwrap().push(name.to_string());
            if fault == "auth" {
                stream.write_all(b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
                continue;
            }
            let result = match method {
                "server/discover" => {
                    json!({"resultType":"complete","supportedVersions":[mcp::VERSION],"capabilities":{"tools":{}}})
                }
                "tools/list" => {
                    let tools = [
                        "capabilities",
                        "executor_start",
                        "executor_poll",
                        "executor_stop",
                        "executor_request",
                    ]
                    .map(|name| json!({"name":name}));
                    json!({"resultType":"complete","tools":tools})
                }
                "tools/call" if name == "capabilities" => {
                    json!({"resultType":"complete","isError":false,"structuredContent":{"contract_version":"iris-execution/1","query_by_request":fault!="no-query","execution_ready":false,"synthetic":false,"execution_host_id":"host","executor_instance_id":"new-boot"}})
                }
                "tools/call" => {
                    assert_eq!(name, "executor_request");
                    assert_eq!(
                        request["params"]["arguments"],
                        json!({"request_id":"request"})
                    );
                    if fault == "timeout" {
                        tokio::time::sleep(Duration::from_secs(5)).await;
                    }
                    if fault == "notfound" {
                        json!({"resultType":"complete","isError":true,"structuredContent":{"error":{"code":"NOT_FOUND","detail":"synthetic-private-detail"}}})
                    } else {
                        json!({"resultType":"complete","isError":false,"structuredContent":value})
                    }
                }
                _ => panic!("unexpected method"),
            };
            let body = json!({"jsonrpc":"2.0","id":request["id"],"result":result}).to_string();
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nMCP-Protocol-Version: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                mcp::VERSION,
                body.len(),
                body
            );
            let _ = stream.write_all(response.as_bytes()).await;
            let _ = stream.shutdown().await;
        }
    });
    (port, calls, task)
}

#[tokio::test]
async fn recovery_preserves_unknown_old_instance_and_restore_hold_without_write() {
    for state in [
        "unknown",
        "stop_unconfirmed",
        "accepted",
        "running",
        "stop_requested",
        "stopped_confirmed",
    ] {
        let mut expected = lookup();
        expected["current"]["execution_state"] = json!(state);
        let (port, calls, server) = peer(expected.clone(), "").await;
        let actual = Client::inspect_request(port, "synthetic-recovery-key", "request", binding())
            .await
            .unwrap();
        assert_eq!(actual, expected);
        assert_eq!(
            *calls.lock().unwrap(),
            [
                "server/discover",
                "tools/list",
                "capabilities",
                "executor_request"
            ]
        );
        server.abort();
    }
}

#[tokio::test]
async fn mismatched_or_malformed_receipts_are_rejected() {
    for case in 0..9 {
        let mut value = lookup();
        match case {
            0 => value["request_receipt"]["request_id"] = json!("other"),
            1 => value["request_receipt"]["binding"]["attempt_id"] = json!("other"),
            2 => value["current"]["binding"]["fence"] = json!(3),
            3 => value["request_receipt"]["binding"]["extra"] = json!(true),
            4 => value["current"]["contract_version"] = json!("future"),
            5 => value["current"]["execution_state"] = json!("not-dispatched"),
            6 => value["request_receipt"]["attempt_id"] = json!("other"),
            7 => value["request_receipt"]["fence"] = json!(1),
            _ => value["request_receipt"]["operation"] = json!("spawn"),
        }
        let (port, calls, server) = peer(value, "").await;
        let error = Client::inspect_request(port, "synthetic-recovery-key", "request", binding())
            .await
            .unwrap_err();
        assert!(!error.contains("other"));
        assert_eq!(calls.lock().unwrap().len(), 4);
        server.abort();
    }
}

#[tokio::test]
async fn failures_never_retry_or_expose_raw_details() {
    for (fault, count) in [
        ("auth", 1),
        ("notfound", 4),
        ("timeout", 4),
        ("no-query", 3),
    ] {
        let (port, calls, server) = peer(lookup(), fault).await;
        let started = std::time::Instant::now();
        let error = Client::inspect_request(port, "synthetic-recovery-key", "request", binding())
            .await
            .unwrap_err();
        assert!(!error.contains("synthetic-private-detail"));
        assert!(!error.contains("synthetic-recovery-key"));
        assert!(started.elapsed() < Duration::from_secs(4));
        assert_eq!(calls.lock().unwrap().len(), count);
        assert!(
            !calls
                .lock()
                .unwrap()
                .iter()
                .any(|v| v == "executor_start" || v == "executor_stop")
        );
        server.abort();
    }
}

#[tokio::test]
async fn invalid_expected_identity_is_rejected_before_network() {
    let (port, calls, server) = peer(lookup(), "").await;
    for field in [
        "instruction_hash",
        "scope_hash",
        "provider",
        "plan_revision",
    ] {
        let mut invalid = binding();
        invalid.as_object_mut().unwrap().remove(field);
        assert!(
            Client::inspect_request(port, "synthetic-recovery-key", "request", invalid)
                .await
                .is_err()
        );
    }
    let mut extra = binding();
    extra["extra"] = json!(true);
    assert!(
        Client::inspect_request(port, "synthetic-recovery-key", "request", extra)
            .await
            .is_err()
    );
    assert!(
        Client::inspect_request(port, "synthetic-recovery-key", "bad request", binding())
            .await
            .is_err()
    );
    assert!(calls.lock().unwrap().is_empty());
    server.abort();
}
