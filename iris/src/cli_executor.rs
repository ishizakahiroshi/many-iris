//! Opt-in loopback MCP transport to the CLI execution contract.
//! No Hub lifecycle action, credential discovery or automatic retry. The owned
//! profile is always named by the caller from explicit configuration, never
//! chosen or upgraded here.
use crate::{cli_binding::OwnedProfile, mcp};
use serde_json::{Value, json};
use std::{collections::HashMap, net::Ipv4Addr};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    time::{Duration, timeout},
};

const PATH: &str = "/api/iris-execution/mcp";
const LIMIT_HEADERS: usize = 16_384;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(3);
const TOOLS: &[&str] = &[
    "capabilities",
    "executor_start",
    "executor_poll",
    "executor_stop",
    "executor_request",
];
/// The default (synthetic) owned profile. Any other profile must be named
/// explicitly through `OwnedProfile` and the `*_profile` connection methods.
pub const OWNED_PROFILE: &str = crate::cli_binding::OWNED_PROFILE_SYNTHETIC;
const OWNED_TOOLS: &[&str] = &[
    "owned_start",
    "owned_request",
    "owned_poll",
    "owned_stop",
    "owned_evidence",
];

pub struct Client {
    port: u16,
    token: String,
    next_id: u64,
    healthy: bool,
    ready: bool,
    capabilities: Value,
    owned_tools: bool,
    /// Set only by an owned handshake; every owned call is held to this profile.
    owned_profile: Option<OwnedProfile>,
    owned_start: bool,
    owned_stop: bool,
}

impl Client {
    pub async fn connect(port: u16, token: &str) -> Result<Self, String> {
        let mut client = Self::handshake(port, token).await?;
        validate_capabilities(&client.capabilities)?;
        client.ready = true;
        Ok(client)
    }

    /// The versioned owned profile never satisfies the old synthetic proof gate.
    /// Fixed to the default synthetic profile; see `connect_owned_profile`.
    pub async fn connect_owned(port: u16, token: &str) -> Result<Self, String> {
        Self::connect_owned_profile(port, token, OwnedProfile::Synthetic).await
    }

    /// Admission connection for an explicitly named owned profile.
    pub async fn connect_owned_profile(
        port: u16,
        token: &str,
        profile: OwnedProfile,
    ) -> Result<Self, String> {
        let mut client = Self::owned_handshake(port, token, true, profile).await?;
        client.owned_start = true;
        client.owned_stop = true;
        Ok(client)
    }

    /// Recovery is an explicit lookup-only connection, including when admission
    /// has expired or been disabled. It cannot send start or stop.
    pub async fn inspect_owned(port: u16, token: &str) -> Result<Self, String> {
        Self::inspect_owned_profile(port, token, OwnedProfile::Synthetic).await
    }

    pub async fn inspect_owned_profile(
        port: u16,
        token: &str,
        profile: OwnedProfile,
    ) -> Result<Self, String> {
        Self::owned_handshake(port, token, false, profile).await
    }

    /// A separately persisted user stop intent may be delivered once even when
    /// new admission is disabled. This connection cannot start anything.
    pub async fn connect_owned_stop(port: u16, token: &str) -> Result<Self, String> {
        Self::connect_owned_stop_profile(port, token, OwnedProfile::Synthetic).await
    }

    pub async fn connect_owned_stop_profile(
        port: u16,
        token: &str,
        profile: OwnedProfile,
    ) -> Result<Self, String> {
        let mut client = Self::owned_handshake(port, token, false, profile).await?;
        client.owned_stop = true;
        Ok(client)
    }

    async fn owned_handshake(
        port: u16,
        token: &str,
        admit: bool,
        profile: OwnedProfile,
    ) -> Result<Self, String> {
        let mut client = Self::handshake(port, token).await?;
        validate_owned_capabilities(&client.capabilities, client.owned_tools, admit, profile)?;
        client.owned_profile = Some(profile);
        Ok(client)
    }

    pub async fn call_owned(&mut self, tool: &str, args: Value) -> Result<Value, String> {
        let Some(profile) = self.owned_profile else {
            return Err("Owned execution transport unavailable; no automatic retry".into());
        };
        if !self.healthy || !OWNED_TOOLS.contains(&tool) {
            return Err("Owned execution transport unavailable; no automatic retry".into());
        }
        if (tool == "owned_start" && !self.owned_start)
            || (tool == "owned_stop" && !self.owned_stop)
        {
            return Err("Owned recovery connection is lookup-only".into());
        }
        let object = args
            .as_object()
            .ok_or("Invalid owned execution arguments")?;
        let expected: &[&str] = match tool {
            "owned_request" => &["profile", "request_id"],
            "owned_start" | "owned_stop" => &["profile", "binding", "request_id"],
            _ => &["profile", "binding"],
        };
        if object.len() != expected.len()
            || object.keys().any(|key| !expected.contains(&key.as_str()))
            || args["profile"] != profile.as_str()
        {
            return Err("Invalid owned execution argument profile".into());
        }
        if expected.contains(&"request_id") && !valid_request_id(&args["request_id"]) {
            return Err("Invalid owned execution request identity".into());
        }
        if expected.contains(&"binding") {
            let binding: crate::cli_binding::CliBinding =
                serde_json::from_value(args["binding"].clone())
                    .map_err(|_| "Invalid owned execution binding")?;
            binding
                .validate()
                .map_err(|_| "Invalid owned execution binding")?;
            if !profile.admits(&binding)
                || self.capabilities["execution_host_id"] != binding.execution_host_id
                || (tool == "owned_start"
                    && self.capabilities["executor_instance_id"] != binding.executor_instance_id)
            {
                return Err("Owned execution binding outside adopted profile scope".into());
            }
        }
        self.tool_call(tool, args).await
    }

    /// Read protocol/capabilities without enabling any execution call. Missing
    /// live proof is an inspectable fact, not permission to downgrade transport.
    pub async fn inspect(port: u16, token: &str) -> Result<Value, String> {
        let client = Self::handshake(port, token).await?;
        Ok(client.capabilities())
    }

    /// Inspect a durable request without enabling execution. `Ok` means the
    /// lookup identities match, never task success or permission to resend.
    /// Unknown states, restore hold and the original immutable receipt survive
    /// unchanged so recovery callers cannot mistake uncertainty for no work.
    pub async fn inspect_request(
        port: u16,
        token: &str,
        request_id: &str,
        expected_binding: Value,
    ) -> Result<Value, String> {
        let expected: crate::cli_binding::CliBinding =
            serde_json::from_value(expected_binding.clone())
                .map_err(|_| "Invalid complete CLI recovery binding")?;
        expected
            .validate()
            .map_err(|_| "Invalid complete CLI recovery binding")?;
        if request_id.is_empty()
            || request_id.len() > 128
            || !request_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err("Invalid CLI recovery request identity".into());
        }
        let mut client = Self::handshake(port, token).await?;
        if client.capabilities["contract_version"] != "iris-execution/1"
            || client.capabilities["query_by_request"] != true
        {
            return Err("CLI request recovery unavailable".into());
        }
        let value = client
            .tool_call("executor_request", json!({"request_id":request_id}))
            .await?;
        let receipt = &value["request_receipt"];
        let current = &value["current"];
        const JOURNAL_CONTRACT: &str = "many-ai-cli-iris-execution/1";
        if value["ok"] != true
            || receipt["ok"] != true
            || receipt["contract_version"] != JOURNAL_CONTRACT
            || receipt["request_id"] != request_id
            || receipt["binding"] != expected_binding
            || receipt["attempt_id"] != expected.attempt_id
            || receipt["fence"] != expected.fence
            || !matches!(receipt["operation"].as_str(), Some("start" | "stop"))
            || current["ok"] != true
            || current["contract_version"] != JOURNAL_CONTRACT
            || current["binding"] != expected_binding
            || !current["restore_hold"].is_boolean()
            || current["event_seq"].as_u64().is_none()
            || !matches!(
                current["execution_state"].as_str(),
                Some(
                    "accepted"
                        | "running"
                        | "stop_requested"
                        | "stop_unconfirmed"
                        | "unknown"
                        | "stopped_confirmed"
                )
            )
            || !matches!(
                current["outcome"].as_str(),
                Some("pending" | "unknown" | "succeeded" | "failed" | "rejected")
            )
        {
            return Err("CLI recovery receipt identity or profile mismatch".into());
        }
        Ok(value)
    }

    /// Explicit read-only recovery access stays available when production start
    /// lacks required proof capabilities. This method cannot select a write tool.
    pub async fn inspect_evidence(port: u16, token: &str, binding: Value) -> Result<Value, String> {
        if !binding.is_object() {
            return Err("Complete evidence binding required".into());
        }
        let mut client = Self::handshake(port, token).await?;
        if client.capabilities["owner_receipt_query"] != true {
            return Err("Owner evidence inspection unavailable".into());
        }
        let value = client
            .tool_call("executor_evidence", json!({"binding":binding}))
            .await?;
        if value["ticket"]["binding"] != binding {
            return Err("CLI owner evidence binding mismatch".into());
        }
        Ok(value)
    }

    async fn handshake(port: u16, token: &str) -> Result<Self, String> {
        if port == 0
            || token.is_empty()
            || token.len() > 4096
            || !token.bytes().all(|b| (0x21..=0x7e).contains(&b))
        {
            return Err("Invalid loopback endpoint or credential format".into());
        }
        let mut client = Self {
            port,
            token: token.into(),
            next_id: 1,
            healthy: true,
            ready: false,
            capabilities: Value::Null,
            owned_tools: false,
            owned_profile: None,
            owned_start: false,
            owned_stop: false,
        };
        let discovery = client.rpc("server/discover", json!({})).await?;
        if !discovery["supportedVersions"]
            .as_array()
            .is_some_and(|v| v.iter().any(|v| v == mcp::VERSION))
            || !discovery["capabilities"]["tools"].is_object()
        {
            return Err("CLI execution MCP version or tool capability unavailable".into());
        }
        let list = client.rpc("tools/list", json!({})).await?;
        if !TOOLS.iter().all(|name| {
            list["tools"]
                .as_array()
                .is_some_and(|tools| tools.iter().any(|tool| tool["name"] == *name))
        }) {
            return Err("CLI execution required tool unavailable".into());
        }
        client.owned_tools = OWNED_TOOLS.iter().all(|name| {
            list["tools"]
                .as_array()
                .is_some_and(|tools| tools.iter().any(|tool| tool["name"] == *name))
        });
        let capabilities = client.tool_call("capabilities", json!({})).await?;
        client.capabilities = capabilities;
        Ok(client)
    }

    pub fn capabilities(&self) -> Value {
        self.capabilities.clone()
    }

    pub async fn call(&mut self, tool: &str, args: Value) -> Result<Value, String> {
        if !self.ready || !self.healthy {
            return Err(
                "CLI execution transport unavailable; reconcile before reconnecting".into(),
            );
        }
        if !TOOLS.contains(&tool) || !args.is_object() {
            return Err("CLI execution tool or argument shape not permitted".into());
        }
        self.tool_call(tool, args).await
    }

    /// Per-request sockets are already closed. Never stop the external Hub.
    pub async fn shutdown(&mut self) -> Result<(), String> {
        self.ready = false;
        self.healthy = false;
        self.owned_start = false;
        self.owned_stop = false;
        Ok(())
    }

    async fn tool_call(&mut self, tool: &str, args: Value) -> Result<Value, String> {
        let result = self
            .rpc("tools/call", json!({"name":tool,"arguments":args}))
            .await?;
        if result["isError"] == true {
            let code = result["structuredContent"]["error"]["code"]
                .as_str()
                .filter(|code| {
                    !code.is_empty()
                        && code.len() <= 64
                        && code
                            .bytes()
                            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
                })
                .unwrap_or("REJECTED");
            return Err(format!(
                "CLI execution operation rejected: {code}; no automatic retry"
            ));
        }
        if result["isError"] != false || !result["structuredContent"].is_object() {
            self.healthy = false;
            return Err("CLI execution structured result profile mismatch".into());
        }
        Ok(result["structuredContent"].clone())
    }

    async fn rpc(&mut self, method: &str, params: Value) -> Result<Value, String> {
        if !self.healthy {
            return Err("CLI execution transport unusable; delivery may be unknown".into());
        }
        let id = self.next_id;
        self.next_id = self
            .next_id
            .checked_add(1)
            .ok_or("CLI execution request ID exhausted")?;
        let request = mcp::request(id, method, params);
        let body = request.to_string();
        if body.len() > mcp::MAX_BYTES {
            return Err("CLI execution request byte limit exceeded".into());
        }
        let tool = request["params"]["name"].as_str();
        let mut head = format!(
            "POST {PATH} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nConnection: close\r\nMCP-Protocol-Version: {}\r\nMcp-Method: {method}\r\nContent-Length: {}\r\n",
            self.port,
            self.token,
            mcp::VERSION,
            body.len()
        );
        if let Some(name) = tool {
            head.push_str(&format!("Mcp-Name: {name}\r\n"));
        }
        head.push_str("\r\n");
        let outcome = timeout(REQUEST_TIMEOUT, async {
            let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, self.port))
                .await
                .map_err(|_| "CLI execution loopback connection unavailable")?;
            stream
                .write_all(head.as_bytes())
                .await
                .map_err(|_| "CLI execution delivery unknown")?;
            stream
                .write_all(body.as_bytes())
                .await
                .map_err(|_| "CLI execution delivery unknown")?;
            stream
                .flush()
                .await
                .map_err(|_| "CLI execution delivery unknown")?;
            let bytes = read_http(&mut stream).await?;
            let value = mcp::parse_json(&bytes)
                .map_err(|_| "CLI execution invalid bounded JSON response")?;
            if value["jsonrpc"] != "2.0"
                || value["id"] != id
                || value.get("error").is_some()
                || value["result"]["resultType"] != "complete"
            {
                return Err("CLI execution RPC response identity or profile mismatch");
            }
            Ok::<Value, &str>(value["result"].clone())
        })
        .await;
        match outcome {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(message)) => {
                self.healthy = false;
                Err(message.into())
            }
            Err(_) => {
                self.healthy = false;
                Err(
                    "CLI execution response timeout; delivery/result unknown, no automatic retry"
                        .into(),
                )
            }
        }
    }
}

fn valid_request_id(value: &Value) -> bool {
    value.as_str().is_some_and(|id| {
        !id.is_empty()
            && id.len() <= 128
            && id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
    })
}

/// The synthetic profile may never claim a live provider. The real profile must
/// report a boolean, and a connection that can start must see it true: a start
/// is never sent on the strength of an unreported or false provider state.
/// Lookup and stop connections tolerate false, since the manifest may have been
/// disabled after the original admission.
fn live_provider_reported(profile: OwnedProfile, admit: bool, value: &Value) -> bool {
    match (profile, value.as_bool()) {
        (OwnedProfile::Synthetic, Some(live)) => !live,
        (OwnedProfile::RealBounded | OwnedProfile::RealProject, Some(live)) => live || !admit,
        (_, None) => false,
    }
}

fn validate_owned_capabilities(
    value: &Value,
    tools: bool,
    admit: bool,
    profile: OwnedProfile,
) -> Result<(), String> {
    let owned = &value["owned_dispatch"];
    // The default profile's peer must report the fixture host. The real profile's
    // peer reports the user-configured host; here only its shape is admitted, and
    // every call then requires it to equal the binding's host exactly.
    if value["contract_version"] != "iris-execution/1"
        || value["execution_ready"] != false
        || !value["execution_host_id"]
            .as_str()
            .is_some_and(|host| profile.admits_host(host))
        || !value["executor_instance_id"].as_str().is_some_and(|id| {
            !id.is_empty()
                && id.len() <= 128
                && id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
        })
        || !tools
        || owned["profile"] != profile.as_str()
        || owned["query_by_request"] != true
        || owned["automatic_handoff"] != false
        || !live_provider_reported(profile, admit, &owned["live_provider_execution"])
        || (admit && owned["admission_enabled"] != true)
    {
        return Err("Owned execution profile or adopted capability unavailable".into());
    }
    Ok(())
}

fn validate_capabilities(value: &Value) -> Result<(), String> {
    if value["contract_version"] != "iris-execution/1" {
        return Err("Unsupported CLI execution contract".into());
    }
    for name in ["execution_host_id", "executor_instance_id"] {
        if !value[name]
            .as_str()
            .is_some_and(|v| !v.is_empty() && v.len() <= 256 && !v.chars().any(char::is_control))
        {
            return Err("CLI execution host or instance identity unavailable".into());
        }
    }
    for name in [
        "durable_start_receipt",
        "query_by_attempt",
        "grant_revision_binding",
        "fenced_stop_proof",
        "result_sha256",
    ] {
        if value[name] != true {
            return Err("Required CLI execution semantic capability unavailable".into());
        }
    }
    // Current domain accepts only synthetic proof. Real execution needs an adopted
    // grant/evidence schema; capability self-assertion cannot widen this slice.
    if value["synthetic"] != true || value["external_effects"] != false {
        return Err(
            "CLI production execution proof not adopted; synthetic backend required".into(),
        );
    }
    Ok(())
}

async fn read_http(stream: &mut TcpStream) -> Result<Vec<u8>, &'static str> {
    let mut wire = Vec::new();
    let mut chunk = [0u8; 4096];
    let boundary;
    loop {
        let count = stream
            .read(&mut chunk)
            .await
            .map_err(|_| "CLI execution response read failed")?;
        if count == 0 {
            return Err("CLI execution response headers truncated");
        }
        wire.extend_from_slice(&chunk[..count]);
        if let Some(index) = wire.windows(4).position(|v| v == b"\r\n\r\n") {
            boundary = index + 4;
            break;
        }
        if wire.len() > LIMIT_HEADERS {
            return Err("CLI execution response header limit exceeded");
        }
    }
    if boundary > LIMIT_HEADERS {
        return Err("CLI execution response header limit exceeded");
    }
    let text = std::str::from_utf8(&wire[..boundary - 4])
        .map_err(|_| "CLI execution invalid HTTP headers")?;
    let mut lines = text.split("\r\n");
    let status = lines.next().ok_or("CLI execution missing status")?;
    let mut status_parts = status.splitn(3, ' ');
    if status_parts.next() != Some("HTTP/1.1") || status_parts.next() != Some("200") {
        return Err("CLI execution HTTP response rejected");
    }
    let mut headers = HashMap::new();
    for line in lines {
        let (name, value) = line
            .split_once(':')
            .ok_or("CLI execution malformed HTTP header")?;
        if name.is_empty()
            || !name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
            || value.bytes().any(|b| b < 0x20 && b != b'\t' || b == 0x7f)
        {
            return Err("CLI execution unsafe HTTP header");
        }
        if headers
            .insert(name.to_ascii_lowercase(), value.trim())
            .is_some()
        {
            return Err("CLI execution duplicate HTTP header");
        }
    }
    if headers.contains_key("transfer-encoding") {
        return Err("CLI execution chunked/encoded response not supported");
    }
    if headers.get("content-type").is_none_or(|value| {
        !value
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .eq_ignore_ascii_case("application/json")
    }) {
        return Err("CLI execution JSON response required");
    }
    if headers
        .get("mcp-protocol-version")
        .is_some_and(|v| *v != mcp::VERSION)
    {
        return Err("CLI execution HTTP protocol version mismatch");
    }
    let length = headers
        .get("content-length")
        .ok_or("CLI execution bounded content length required")?;
    if length.is_empty() || !length.bytes().all(|b| b.is_ascii_digit()) {
        return Err("CLI execution invalid content length");
    }
    let length: usize = length
        .parse()
        .map_err(|_| "CLI execution invalid content length")?;
    if length > mcp::MAX_BYTES {
        return Err("CLI execution response byte limit exceeded");
    }
    if wire.len() - boundary > length {
        return Err("CLI execution response content length mismatch");
    }
    while wire.len() - boundary < length {
        let count = stream
            .read(&mut chunk)
            .await
            .map_err(|_| "CLI execution response read failed")?;
        if count == 0 {
            return Err("CLI execution response body truncated");
        }
        wire.extend_from_slice(&chunk[..count]);
        if wire.len() - boundary > length {
            return Err("CLI execution response content length mismatch");
        }
    }
    // Connection: close is intentional. Trailing bytes are ambiguous framing.
    if stream
        .read(&mut chunk[..1])
        .await
        .map_err(|_| "CLI execution response close failed")?
        != 0
    {
        return Err("CLI execution trailing response bytes");
    }
    Ok(wire[boundary..].to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    use tokio::net::TcpListener;

    fn caps() -> Value {
        json!({"contract_version":"iris-execution/1","execution_host_id":"synthetic-host","executor_instance_id":"test-instance","synthetic":true,"external_effects":false,"durable_start_receipt":true,"query_by_attempt":true,"grant_revision_binding":true,"fenced_stop_proof":true,"result_sha256":true})
    }
    fn result(request: &Value, capabilities: &Value) -> Value {
        let value = match request["method"].as_str().unwrap() {
            "server/discover" => {
                json!({"resultType":"complete","supportedVersions":[mcp::VERSION],"capabilities":{"tools":{}}})
            }
            "tools/list" => {
                json!({"resultType":"complete","tools":TOOLS.iter().chain(OWNED_TOOLS.iter()).map(|name|json!({"name":name})).collect::<Vec<_>>()})
            }
            _ => {
                json!({"resultType":"complete","isError":false,"structuredContent":if request["params"]["name"]=="capabilities" {capabilities.clone()} else {json!({"accepted":true,"binding":request["params"]["arguments"]})}})
            }
        };
        json!({"jsonrpc":"2.0","id":request["id"],"result":value})
    }
    async fn peer(
        capabilities: Value,
        fault: &'static str,
    ) -> (u16, Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let calls = Arc::new(AtomicUsize::new(0));
        let observed = calls.clone();
        let task = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut wire = Vec::new();
                let mut buf = [0u8; 4096];
                let end;
                loop {
                    let n = socket.read(&mut buf).await.unwrap();
                    if n == 0 {
                        return;
                    }
                    wire.extend_from_slice(&buf[..n]);
                    if let Some(i) = wire.windows(4).position(|v| v == b"\r\n\r\n") {
                        end = i + 4;
                        break;
                    }
                }
                let head = String::from_utf8(wire[..end].to_vec()).unwrap();
                assert!(head.starts_with(&format!("POST {PATH} HTTP/1.1\r\n")));
                assert!(head.contains("Authorization: Bearer synthetic-test-key\r\n"));
                assert!(head.contains("Connection: close\r\n"));
                let length: usize = head
                    .lines()
                    .find_map(|line| line.strip_prefix("Content-Length: "))
                    .unwrap()
                    .parse()
                    .unwrap();
                while wire.len() - end < length {
                    let n = socket.read(&mut buf).await.unwrap();
                    wire.extend_from_slice(&buf[..n]);
                }
                let request = mcp::parse_json(&wire[end..]).unwrap();
                assert!(head.contains(&format!("MCP-Protocol-Version: {}\r\n", mcp::VERSION)));
                assert!(head.contains(&format!(
                    "Mcp-Method: {}\r\n",
                    request["method"].as_str().unwrap()
                )));
                if let Some(name) = request["params"]["name"].as_str() {
                    assert!(head.contains(&format!("Mcp-Name: {name}\r\n")));
                }
                let count = observed.fetch_add(1, Ordering::SeqCst) + 1;
                let mut value = result(&request, &capabilities);
                if fault == "version" {
                    value["result"]["supportedVersions"] = json!(["unsupported"]);
                }
                if fault == "missing-tool" && count == 2 {
                    value["result"]["tools"] = json!([]);
                }
                if fault == "id" && count == 4 {
                    value["id"] = json!(999);
                }
                if fault == "profile" && count == 4 {
                    value["result"]["resultType"] = json!("partial");
                }
                if fault == "timeout" && count == 4 {
                    tokio::time::sleep(Duration::from_secs(4)).await;
                    continue;
                }
                let mut body = value.to_string();
                if fault == "duplicate" && count == 4 {
                    body = "{\"id\":4,\"id\":4}".into();
                }
                let status = if fault == "status" && count == 4 {
                    "503 Unavailable"
                } else {
                    "200 OK"
                };
                let declared = if fault == "oversize" && count == 4 {
                    mcp::MAX_BYTES + 1
                } else if fault == "truncated" && count == 4 {
                    body.len() + 1
                } else if fault == "trailing" && count == 4 {
                    body.len() - 1
                } else {
                    body.len()
                };
                let extra = if fault == "chunked" && count == 4 {
                    "Transfer-Encoding: chunked\r\n"
                } else if fault == "header-version" && count == 4 {
                    "MCP-Protocol-Version: invalid\r\n"
                } else {
                    ""
                };
                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {declared}\r\nConnection: close\r\n{extra}\r\n{body}"
                );
                let _ = socket.write_all(response.as_bytes()).await;
                let _ = socket.shutdown().await;
            }
        });
        (port, calls, task)
    }

    #[tokio::test]
    async fn full_binding_headers_and_shutdown_without_hub_command() {
        let (port, calls, server) = peer(caps(), "").await;
        let mut client = Client::connect(port, "synthetic-test-key").await.unwrap();
        assert_eq!(
            client.capabilities()["contract_version"],
            "iris-execution/1"
        );
        let binding = json!({"attempt_id":"attempt-a","fence":7,"executor_instance_id":"test-instance","principal_id":"test-user","workspace_id":"test-workspace","plan_id":"plan-a","approval_revision":4,"instruction_hash":"fixed-synthetic-hash","request_id":"request-a"});
        let reply = client
            .call("executor_start", binding.clone())
            .await
            .unwrap();
        assert_eq!(reply["binding"], binding);
        client.shutdown().await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 4);
        assert!(client.call("executor_poll", json!({})).await.is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 4);
        server.abort();
    }

    fn owned_caps(admission: bool) -> Value {
        let mut value = caps();
        value["synthetic"] = json!(false);
        value["external_effects"] = json!(true);
        value["execution_ready"] = json!(false);
        value["owned_dispatch"] = json!({"profile":OWNED_PROFILE,"admission_enabled":admission,
            "query_by_request":true,"automatic_handoff":false,"live_provider_execution":false});
        value
    }
    fn owned_args() -> Value {
        json!({"profile":OWNED_PROFILE,"request_id":"original-start",
            "binding":{"principal_id":"local-user","workspace_id":"synthetic-workspace",
            "plan_id":"plan","plan_revision":1,"task_id":"task","instruction_revision":1,
            "instruction_hash":"a".repeat(64),"approval_id":"approval","approval_revision":1,
            "scope_hash":"b".repeat(64),"execution_host_id":"synthetic-host",
            "executor_instance_id":"test-instance","attempt_id":"attempt","fence":1,
            "provider":"synthetic","profile_id":"synthetic"}})
    }
    #[tokio::test]
    async fn owned_profile_is_separate_and_legacy_gate_stays_closed() {
        let (port, calls, server) = peer(owned_caps(true), "").await;
        assert!(Client::connect(port, "synthetic-test-key").await.is_err());
        let mut client = Client::connect_owned(port, "synthetic-test-key")
            .await
            .unwrap();
        assert!(client.call("executor_start", json!({})).await.is_err());
        client
            .call_owned("owned_start", owned_args())
            .await
            .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 7);
        server.abort();
    }
    #[tokio::test]
    async fn owned_inspection_survives_admission_expiry_but_cannot_write() {
        let (port, calls, server) = peer(owned_caps(false), "").await;
        assert!(
            Client::connect_owned(port, "synthetic-test-key")
                .await
                .is_err()
        );
        let mut client = Client::inspect_owned(port, "synthetic-test-key")
            .await
            .unwrap();
        for tool in ["owned_start", "owned_stop"] {
            assert!(client.call_owned(tool, owned_args()).await.is_err());
        }
        client
            .call_owned(
                "owned_request",
                json!({"profile":OWNED_PROFILE,"request_id":"original-start"}),
            )
            .await
            .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 7);
        server.abort();
    }
    #[tokio::test]
    async fn owned_start_checks_complete_binding_profile_and_instance_before_delivery() {
        let (port, calls, server) = peer(owned_caps(true), "").await;
        let mut client = Client::connect_owned(port, "synthetic-test-key")
            .await
            .unwrap();
        for key in [
            "provider",
            "profile_id",
            "execution_host_id",
            "executor_instance_id",
        ] {
            let mut args = owned_args();
            args["binding"][key] = json!("outside-adopted-scope");
            assert!(client.call_owned("owned_start", args).await.is_err());
        }
        let mut args = owned_args();
        args["profile"] = json!("iris-execution/1");
        assert!(client.call_owned("owned_start", args).await.is_err());
        let mut args = owned_args();
        args["policy"] = json!({});
        assert!(client.call_owned("owned_start", args).await.is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 3);
        server.abort();
    }
    #[tokio::test]
    async fn owned_ambiguous_delivery_requires_new_lookup_only_connection() {
        let (port, calls, server) = peer(owned_caps(true), "id").await;
        let mut client = Client::connect_owned(port, "synthetic-test-key")
            .await
            .unwrap();
        assert!(
            client
                .call_owned("owned_start", owned_args())
                .await
                .is_err()
        );
        assert!(
            client
                .call_owned("owned_start", owned_args())
                .await
                .is_err()
        );
        assert!(
            client
                .call_owned(
                    "owned_request",
                    json!({"profile":OWNED_PROFILE,"request_id":"original-start"})
                )
                .await
                .is_err()
        );
        assert_eq!(calls.load(Ordering::SeqCst), 4);
        let mut query = Client::inspect_owned(port, "synthetic-test-key")
            .await
            .unwrap();
        query
            .call_owned(
                "owned_request",
                json!({"profile":OWNED_PROFILE,"request_id":"original-start"}),
            )
            .await
            .unwrap();
        assert!(query.call_owned("owned_start", owned_args()).await.is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 8);
        server.abort();
    }
    #[tokio::test]
    async fn explicit_owned_stop_connection_cannot_start_with_admission_disabled() {
        let (port, calls, server) = peer(owned_caps(false), "").await;
        let mut client = Client::connect_owned_stop(port, "synthetic-test-key")
            .await
            .unwrap();
        assert!(
            client
                .call_owned("owned_start", owned_args())
                .await
                .is_err()
        );
        client.call_owned("owned_stop", owned_args()).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 4);
        server.abort();
    }

    // Literal wire string on purpose: a silent edit of the constant must fail here.
    const REAL: &str = "iris-owned-real-bounded/1";
    fn real_caps(admission: bool, live: Value) -> Value {
        let mut value = owned_caps(admission);
        value["owned_dispatch"]["profile"] = json!(REAL);
        value["owned_dispatch"]["live_provider_execution"] = live;
        value
    }
    fn real_args() -> Value {
        let mut args = owned_args();
        args["profile"] = json!(REAL);
        args["binding"]["provider"] = json!("claude");
        args["binding"]["profile_id"] = json!("claude-example");
        args
    }
    #[tokio::test]
    async fn real_profile_is_used_only_when_named_and_never_by_the_default_entry_points() {
        let (port, calls, server) = peer(real_caps(true, json!(true)), "").await;
        assert!(
            Client::connect_owned(port, "synthetic-test-key")
                .await
                .is_err()
        );
        assert!(
            Client::connect_owned_profile(port, "synthetic-test-key", OwnedProfile::Synthetic)
                .await
                .is_err()
        );
        assert_eq!(calls.load(Ordering::SeqCst), 6);
        let mut client =
            Client::connect_owned_profile(port, "synthetic-test-key", OwnedProfile::RealBounded)
                .await
                .unwrap();
        client.call_owned("owned_start", real_args()).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 10);
        server.abort();
        // The converse: the default profile's peer is not usable as the real one.
        let (port, calls, server) = peer(owned_caps(true), "").await;
        assert!(
            Client::connect_owned_profile(port, "synthetic-test-key", OwnedProfile::RealBounded)
                .await
                .is_err()
        );
        assert!(
            Client::inspect_owned_profile(port, "synthetic-test-key", OwnedProfile::RealBounded)
                .await
                .is_err()
        );
        assert!(
            Client::connect_owned_stop_profile(
                port,
                "synthetic-test-key",
                OwnedProfile::RealBounded
            )
            .await
            .is_err()
        );
        assert_eq!(calls.load(Ordering::SeqCst), 9);
        server.abort();
    }
    #[tokio::test]
    async fn real_profile_client_refuses_other_profiles_and_bindings_before_delivery() {
        let (port, calls, server) = peer(real_caps(true, json!(true)), "").await;
        let mut client =
            Client::connect_owned_profile(port, "synthetic-test-key", OwnedProfile::RealBounded)
                .await
                .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 3);
        for profile in [
            "iris-owned-dispatch/1",
            "iris-owned-real-bounded/2",
            "iris-owned-real-bounded",
            "",
        ] {
            let mut args = real_args();
            args["profile"] = json!(profile);
            assert!(
                client.call_owned("owned_start", args).await.is_err(),
                "{profile:?}"
            );
        }
        for (provider, profile_id) in [
            ("claude", "synthetic"),
            ("synthetic", "claude-example"),
            ("synthetic", "synthetic"),
            // The configured subscription profile is admitted by its shape; the CLI
            // refuses one its session does not run.
            ("claude", "claude other"),
            ("claude", ""),
            ("codex", "claude-example"),
            ("Claude", "claude-example"),
        ] {
            for tool in ["owned_start", "owned_stop"] {
                let mut args = real_args();
                args["binding"]["provider"] = json!(provider);
                args["binding"]["profile_id"] = json!(profile_id);
                assert!(
                    client.call_owned(tool, args).await.is_err(),
                    "{provider} {profile_id} {tool}"
                );
            }
        }
        for (key, value) in [
            ("execution_host_id", "other-host"),
            ("executor_instance_id", "other-instance"),
        ] {
            let mut args = real_args();
            args["binding"][key] = json!(value);
            assert!(client.call_owned("owned_start", args).await.is_err());
        }
        for key in ["policy", "launch_mode", "cwd"] {
            let mut args = real_args();
            args[key] = json!("bounded-edit");
            assert!(client.call_owned("owned_start", args).await.is_err());
        }
        // Nothing above reached the peer; the intended call still works.
        assert_eq!(calls.load(Ordering::SeqCst), 3);
        client.call_owned("owned_start", real_args()).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 4);
        server.abort();
    }
    #[tokio::test]
    async fn default_profile_client_refuses_the_real_profile_and_claude_scope() {
        let (port, calls, server) = peer(owned_caps(true), "").await;
        let mut client = Client::connect_owned(port, "synthetic-test-key")
            .await
            .unwrap();
        assert!(client.call_owned("owned_start", real_args()).await.is_err());
        let mut args = owned_args();
        args["profile"] = json!(REAL);
        assert!(client.call_owned("owned_start", args).await.is_err());
        let mut args = owned_args();
        args["binding"]["provider"] = json!("claude");
        args["binding"]["profile_id"] = json!("claude-example");
        assert!(client.call_owned("owned_start", args).await.is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 3);
        server.abort();
    }
    #[tokio::test]
    async fn live_provider_state_is_checked_per_profile_and_only_start_needs_it_true() {
        // The default profile never claims a live provider, on any connection.
        let mut live = owned_caps(true);
        live["owned_dispatch"]["live_provider_execution"] = json!(true);
        let (port, _, server) = peer(live, "").await;
        assert!(
            Client::connect_owned(port, "synthetic-test-key")
                .await
                .is_err()
        );
        assert!(
            Client::inspect_owned(port, "synthetic-test-key")
                .await
                .is_err()
        );
        server.abort();
        // The real profile: start needs true; lookup and stop only a boolean.
        let (port, _, server) = peer(real_caps(true, json!(false)), "").await;
        assert!(
            Client::connect_owned_profile(port, "synthetic-test-key", OwnedProfile::RealBounded)
                .await
                .is_err()
        );
        assert!(
            Client::inspect_owned_profile(port, "synthetic-test-key", OwnedProfile::RealBounded)
                .await
                .is_ok()
        );
        assert!(
            Client::connect_owned_stop_profile(
                port,
                "synthetic-test-key",
                OwnedProfile::RealBounded
            )
            .await
            .is_ok()
        );
        server.abort();
        for live in [json!(null), json!("true"), json!(1), json!([])] {
            let (port, _, server) = peer(real_caps(true, live.clone()), "").await;
            for admit in [true, false] {
                let result = if admit {
                    Client::connect_owned_profile(
                        port,
                        "synthetic-test-key",
                        OwnedProfile::RealBounded,
                    )
                    .await
                } else {
                    Client::inspect_owned_profile(
                        port,
                        "synthetic-test-key",
                        OwnedProfile::RealBounded,
                    )
                    .await
                };
                assert!(result.is_err(), "{live}");
            }
            server.abort();
        }
    }
    #[tokio::test]
    async fn real_profile_keeps_the_synthetic_capability_guards() {
        for (key, value) in [
            ("automatic_handoff", json!(true)),
            ("query_by_request", json!(false)),
            ("admission_enabled", json!(false)),
        ] {
            let mut caps = real_caps(true, json!(true));
            caps["owned_dispatch"][key] = value;
            let (port, _, server) = peer(caps, "").await;
            assert!(
                Client::connect_owned_profile(
                    port,
                    "synthetic-test-key",
                    OwnedProfile::RealBounded
                )
                .await
                .is_err(),
                "{key}"
            );
            server.abort();
        }
        for (key, value) in [
            ("execution_ready", json!(true)),
            ("contract_version", json!("iris-execution/2")),
        ] {
            let mut caps = real_caps(true, json!(true));
            caps[key] = value;
            let (port, _, server) = peer(caps, "").await;
            assert!(
                Client::connect_owned_profile(
                    port,
                    "synthetic-test-key",
                    OwnedProfile::RealBounded
                )
                .await
                .is_err(),
                "{key}"
            );
            server.abort();
        }
    }
    #[tokio::test]
    async fn real_profile_peer_reports_the_configured_host_and_the_binding_must_equal_it() {
        let host = "claude-host-01-example-test";
        let mut caps = real_caps(true, json!(true));
        caps["execution_host_id"] = json!(host);
        let (port, calls, server) = peer(caps, "").await;
        let mut client =
            Client::connect_owned_profile(port, "synthetic-test-key", OwnedProfile::RealBounded)
                .await
                .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 3);
        // Nothing but the peer's own reported host is delivered to it: not the
        // fixture host, not a near miss, not an empty or padded value.
        for other in [
            "synthetic-host",
            "other-host",
            "",
            " claude-host-01-example-test",
            "claude-host-01.example.test",
        ] {
            for tool in ["owned_start", "owned_stop"] {
                let mut args = real_args();
                args["binding"]["execution_host_id"] = json!(other);
                assert!(
                    client.call_owned(tool, args).await.is_err(),
                    "{other:?} {tool}"
                );
            }
        }
        assert_eq!(calls.load(Ordering::SeqCst), 3);
        let mut args = real_args();
        args["binding"]["execution_host_id"] = json!(host);
        client
            .call_owned("owned_start", args.clone())
            .await
            .unwrap();
        client.call_owned("owned_stop", args).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 5);
        server.abort();
    }
    #[tokio::test]
    async fn peer_host_shape_is_checked_per_profile_before_anything_is_delivered() {
        let host = "claude-host-01-example-test";
        for bad in [
            json!(null),
            json!(""),
            json!(1),
            json!(true),
            json!("lab pc"),
            // The CLI's identity rule has no `.`, so a peer cannot report one.
            json!("."),
            json!("host."),
            json!("lab-pc.local"),
            json!(" claude-host-01-example-test"),
            json!("claude-host-01-example-test "),
            json!("claude-host\u{202e}"),
            json!("ホスト"),
            json!("ｈｏｓｔ"),
            json!("h".repeat(129)),
            json!("h".repeat(257)),
            json!("host\u{7}"),
            json!("a\nb"),
            json!("a\u{85}b"),
        ] {
            let mut caps = real_caps(true, json!(true));
            caps["execution_host_id"] = bad.clone();
            let (port, calls, server) = peer(caps, "").await;
            assert!(
                Client::connect_owned_profile(
                    port,
                    "synthetic-test-key",
                    OwnedProfile::RealBounded
                )
                .await
                .is_err(),
                "{bad}"
            );
            assert!(
                Client::inspect_owned_profile(
                    port,
                    "synthetic-test-key",
                    OwnedProfile::RealBounded
                )
                .await
                .is_err(),
                "{bad}"
            );
            assert!(
                Client::connect_owned_stop_profile(
                    port,
                    "synthetic-test-key",
                    OwnedProfile::RealBounded
                )
                .await
                .is_err(),
                "{bad}"
            );
            assert_eq!(calls.load(Ordering::SeqCst), 9);
            server.abort();
        }
        let mut missing = real_caps(true, json!(true));
        missing.as_object_mut().unwrap().remove("execution_host_id");
        let (port, _, server) = peer(missing, "").await;
        assert!(
            Client::connect_owned_profile(port, "synthetic-test-key", OwnedProfile::RealBounded)
                .await
                .is_err()
        );
        server.abort();
        // The default profile's peer must still report the fixture host itself.
        let mut caps = owned_caps(true);
        caps["execution_host_id"] = json!(host);
        let (port, _, server) = peer(caps, "").await;
        assert!(
            Client::connect_owned(port, "synthetic-test-key")
                .await
                .is_err()
        );
        assert!(
            Client::inspect_owned(port, "synthetic-test-key")
                .await
                .is_err()
        );
        assert!(
            Client::connect_owned_stop(port, "synthetic-test-key")
                .await
                .is_err()
        );
        server.abort();
    }
    #[tokio::test]
    async fn real_profile_ambiguous_delivery_is_never_resent_and_lookup_stays_read_only() {
        let (port, calls, server) = peer(real_caps(true, json!(true)), "id").await;
        let mut client =
            Client::connect_owned_profile(port, "synthetic-test-key", OwnedProfile::RealBounded)
                .await
                .unwrap();
        assert!(client.call_owned("owned_start", real_args()).await.is_err());
        assert!(client.call_owned("owned_start", real_args()).await.is_err());
        assert!(
            client
                .call_owned(
                    "owned_request",
                    json!({"profile":REAL,"request_id":"original-start"})
                )
                .await
                .is_err()
        );
        assert_eq!(calls.load(Ordering::SeqCst), 4);
        let mut query =
            Client::inspect_owned_profile(port, "synthetic-test-key", OwnedProfile::RealBounded)
                .await
                .unwrap();
        query
            .call_owned(
                "owned_request",
                json!({"profile":REAL,"request_id":"original-start"}),
            )
            .await
            .unwrap();
        assert!(query.call_owned("owned_start", real_args()).await.is_err());
        assert!(query.call_owned("owned_stop", real_args()).await.is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 8);
        server.abort();
    }
    #[tokio::test]
    async fn real_profile_lookup_and_stop_connections_keep_their_limits() {
        let (port, calls, server) = peer(real_caps(false, json!(false)), "").await;
        assert!(
            Client::connect_owned_profile(port, "synthetic-test-key", OwnedProfile::RealBounded)
                .await
                .is_err()
        );
        let mut lookup =
            Client::inspect_owned_profile(port, "synthetic-test-key", OwnedProfile::RealBounded)
                .await
                .unwrap();
        for tool in ["owned_start", "owned_stop"] {
            assert!(lookup.call_owned(tool, real_args()).await.is_err());
        }
        lookup
            .call_owned(
                "owned_request",
                json!({"profile":REAL,"request_id":"original-start"}),
            )
            .await
            .unwrap();
        let mut stop = Client::connect_owned_stop_profile(
            port,
            "synthetic-test-key",
            OwnedProfile::RealBounded,
        )
        .await
        .unwrap();
        assert!(stop.call_owned("owned_start", real_args()).await.is_err());
        stop.call_owned("owned_stop", real_args()).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 11);
        server.abort();
    }

    #[tokio::test]
    async fn rejects_missing_semantics_and_production_before_start() {
        for name in [
            "durable_start_receipt",
            "query_by_attempt",
            "grant_revision_binding",
            "fenced_stop_proof",
            "result_sha256",
            "execution_host_id",
            "executor_instance_id",
            "contract_version",
            "synthetic",
            "external_effects",
        ] {
            let mut capability = caps();
            capability.as_object_mut().unwrap().remove(name);
            let (port, calls, server) = peer(capability, "").await;
            assert!(
                Client::connect(port, "synthetic-test-key").await.is_err(),
                "missing {name}"
            );
            assert_eq!(calls.load(Ordering::SeqCst), 3);
            server.abort();
        }
        let mut capability = caps();
        capability["synthetic"] = json!(false);
        let (port, calls, server) = peer(capability, "").await;
        assert!(Client::connect(port, "synthetic-test-key").await.is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 3);
        server.abort();
    }

    #[tokio::test]
    async fn rejects_discovery_version_without_fallback() {
        let (port, calls, server) = peer(caps(), "version").await;
        assert!(Client::connect(port, "synthetic-test-key").await.is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        server.abort();
    }

    #[tokio::test]
    async fn missing_tool_fails_before_capabilities_or_start() {
        let (port, calls, server) = peer(caps(), "missing-tool").await;
        assert!(Client::connect(port, "synthetic-test-key").await.is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        server.abort();
    }

    #[tokio::test]
    async fn bounded_http_and_protocol_failures_poison_without_retry() {
        for fault in [
            "status",
            "oversize",
            "truncated",
            "trailing",
            "chunked",
            "header-version",
            "duplicate",
            "id",
            "profile",
        ] {
            let (port, calls, server) = peer(caps(), fault).await;
            let mut client = Client::connect(port, "synthetic-test-key").await.unwrap();
            assert!(
                client
                    .call("executor_start", json!({"attempt_id":"a"}))
                    .await
                    .is_err(),
                "{fault}"
            );
            assert!(
                client
                    .call("executor_poll", json!({"attempt_id":"a"}))
                    .await
                    .is_err()
            );
            assert_eq!(calls.load(Ordering::SeqCst), 4);
            server.abort();
        }
    }

    #[tokio::test]
    async fn timeout_is_ambiguous_and_never_automatically_retried() {
        let (port, calls, server) = peer(caps(), "timeout").await;
        let mut client = Client::connect(port, "synthetic-test-key").await.unwrap();
        let start = std::time::Instant::now();
        assert!(
            client
                .call("executor_start", json!({"attempt_id":"a"}))
                .await
                .unwrap_err()
                .contains("unknown")
        );
        assert!(start.elapsed() < Duration::from_secs(4));
        assert!(client.call("executor_poll", json!({})).await.is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 4);
        server.abort();
    }

    #[tokio::test]
    async fn rejects_credential_header_injection_before_connect() {
        for token in [
            "",
            "value\r\nInjected: yes",
            "has space",
            "tab\tvalue",
            "non-ascii-鍵",
        ] {
            assert!(Client::connect(1, token).await.is_err());
        }
        assert!(Client::connect(0, "synthetic-test-key").await.is_err());
    }
}
