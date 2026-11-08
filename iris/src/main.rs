use axum::{
    Router,
    body::{Body, to_bytes},
    extract::State,
    http::{HeaderMap, Method, Request, StatusCode},
    response::{IntoResponse, Response},
    routing::any,
};
use many_iris::{domain::Store, executor, mcp};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::watch;

enum SchedulerClient {
    StdioSynthetic {
        client: executor::Client,
        instance: String,
    },
    OwnedHttp(many_iris::owned_http::OwnedHttp),
}

impl SchedulerClient {
    fn allows_lookup_after_error(&self) -> bool {
        matches!(self, Self::OwnedHttp(_))
    }
    async fn tick(&mut self, store: &Arc<Mutex<Store>>) -> Result<(), String> {
        match self {
            Self::StdioSynthetic { client, instance } => drive_once(store, client, instance).await,
            Self::OwnedHttp(client) => client.tick(store).await,
        }
    }
    async fn shutdown(&mut self) -> Result<(), String> {
        match self {
            Self::StdioSynthetic { client, .. } => client.shutdown().await,
            Self::OwnedHttp(client) => client.shutdown().await,
        }
    }
}

#[derive(Clone)]
struct App {
    store: Arc<Mutex<Store>>,
    host: String,
    ui_token: String,
    ui_login_key: String,
    mcp_token: String,
    scheduler_error: Arc<Mutex<Option<String>>>,
    /// Real-project profile only: the latest error of each case, by plan id.
    case_errors: many_iris::owned_http::CaseErrors,
    /// The board, present only when `--board-writers` was given.
    board: Option<Arc<many_iris::board::Board>>,
    /// The one public origin allowed in front of the loopback listener.
    public: Option<many_iris::board::PublicOrigin>,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn random_hex() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| "System random source unavailable".to_string())?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
fn one_header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    let mut all = headers.get_all(name).iter();
    let first = all.next()?.to_str().ok()?;
    if all.next().is_some() {
        return None;
    }
    Some(first)
}
fn matches_token(actual: &str, expected: &str) -> bool {
    if actual.len() != expected.len() {
        return false;
    }
    actual
        .bytes()
        .zip(expected.bytes())
        .fold(0u8, |v, (a, b)| v | (a ^ b))
        == 0
}
fn authorized(headers: &HeaderMap, token: &str) -> bool {
    one_header(headers, "authorization")
        .and_then(|s| s.strip_prefix("Bearer "))
        .is_some_and(|actual| matches_token(actual, token))
}
fn ui_page_authorized(headers: &HeaderMap, app: &App) -> bool {
    if authorized(headers, &app.ui_token) {
        return true;
    }
    let name = format!(
        "iris_ui_{}=",
        app.host.rsplit(':').next().unwrap_or("local")
    );
    one_header(headers, "cookie").is_some_and(|cookie| {
        cookie
            .split(';')
            .filter_map(|v| v.trim().strip_prefix(&name))
            .any(|value| matches_token(value, &app.ui_token))
    })
}
fn respond(status: StatusCode, body: impl Into<String>, content_type: &'static str) -> Response {
    (status, [
        ("content-type",content_type), ("cache-control","no-store"),
        ("x-content-type-options","nosniff"), ("x-frame-options","DENY"),
        ("referrer-policy","no-referrer"),
        ("content-security-policy","default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"),
    ], body.into()).into_response()
}
fn json_response(status: StatusCode, value: Value) -> Response {
    respond(status, value.to_string(), "application/json; charset=utf-8")
}
fn failure(status: StatusCode, code: &str, detail: &str) -> Response {
    json_response(status, json!({"ok":false,"code":code,"detail":detail}))
}
fn local_envelope(input: &Value) -> Result<Value, &'static str> {
    let obj = input.as_object().ok_or("input must be an object")?;
    if obj
        .keys()
        .any(|key| !["request_id", "payload"].contains(&key.as_str()))
    {
        return Err("Unknown input field");
    }
    Ok(
        json!({"request_id":obj.get("request_id"),"payload":obj.get("payload"),"principal_id":"local-user","workspace_id":"synthetic-workspace"}),
    )
}
const USER_OPERATIONS: &[&str] = &[
    "start_plan",
    "pause_plan",
    "continue_plan",
    "request_stop",
    "submit_decision",
    "handoff_task",
];

/// What a request that names the public host or origin may reach: the board
/// and its sign-in, nothing else.
fn public_path_allowed(method: &Method, path: &str) -> bool {
    if method == Method::GET {
        [
            "/board",
            "/board.js",
            "/board.css",
            "/app.css",
            "/login.js",
            "/health",
            "/api/board",
        ]
        .contains(&path)
    } else {
        ["/board/mcp", "/session"].contains(&path)
    }
}

async fn board_mcp(app: &App, headers: &HeaderMap, body: Body) -> Response {
    let Some(board) = app.board.as_ref() else {
        return failure(
            StatusCode::NOT_FOUND,
            "BOARD_DISABLED",
            "The board is not enabled",
        );
    };
    let actor = match board.authenticate(one_header(headers, "authorization")) {
        Ok(actor) => actor,
        Err(many_iris::board::AuthError::Disabled) => {
            return failure(
                StatusCode::FORBIDDEN,
                "WRITER_DISABLED",
                "This writer is switched off",
            );
        }
        Err(many_iris::board::AuthError::Unavailable) => {
            return failure(
                StatusCode::SERVICE_UNAVAILABLE,
                "WRITERS_UNAVAILABLE",
                "The writers file cannot be used",
            );
        }
        Err(_) => return failure(StatusCode::UNAUTHORIZED, "AUTH", "Authorization required"),
    };
    if one_header(headers, "content-type").is_none_or(|s| {
        !s.split(';')
            .next()
            .unwrap_or("")
            .trim()
            .eq_ignore_ascii_case("application/json")
    }) {
        return failure(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "CONTENT_TYPE",
            "JSON required",
        );
    }
    let bytes = match to_bytes(body, 65536).await {
        Ok(b) => b,
        Err(_) => {
            return failure(
                StatusCode::PAYLOAD_TOO_LARGE,
                "LIMIT",
                "Request body exceeds limit",
            );
        }
    };
    let value = match mcp::parse_json(&bytes) {
        Ok(v) => v,
        Err(_) => {
            return failure(
                StatusCode::BAD_REQUEST,
                "INVALID_JSON",
                "Invalid or ambiguous JSON",
            );
        }
    };
    let header_pairs: Vec<(&str, &str)> = headers
        .iter()
        .filter_map(|(k, v)| v.to_str().ok().map(|v| (k.as_str(), v)))
        .collect();
    let (status, response) = board.handle_mcp(&actor, &header_pairs, &value);
    if response.is_null() {
        return respond(StatusCode::ACCEPTED, "", "application/json");
    }
    json_response(
        StatusCode::from_u16(status).unwrap_or(StatusCode::OK),
        response,
    )
}

async fn handle(State(app): State<App>, request: Request<Body>) -> Response {
    let (parts, body) = request.into_parts();
    let path = parts.uri.path();
    // The local host is always accepted. The public host and origin are
    // accepted only when `--public-origin` named them.
    let host_header = one_header(&parts.headers, "host");
    let host_public = app
        .public
        .as_ref()
        .zip(host_header)
        .is_some_and(|(public, host)| public.host_matches(host));
    if host_header != Some(app.host.as_str()) && !host_public {
        return failure(StatusCode::FORBIDDEN, "HOST", "接続先が一致しません。");
    }
    let mut origin_public = false;
    if parts.headers.contains_key("origin") {
        let origin = one_header(&parts.headers, "origin");
        origin_public = app
            .public
            .as_ref()
            .zip(origin)
            .is_some_and(|(public, origin)| public.origin_matches(origin));
        if !origin_public && origin != Some(format!("http://{}", app.host).as_str()) {
            return failure(
                StatusCode::FORBIDDEN,
                "ORIGIN",
                "この画面からの操作は許可されていません。",
            );
        }
    }
    let public_request = host_public || origin_public;
    if parts.uri.query().is_some() {
        return failure(
            StatusCode::BAD_REQUEST,
            "INVALID",
            "Query parameters are not supported",
        );
    }
    if public_request && !public_path_allowed(&parts.method, path) {
        return failure(StatusCode::NOT_FOUND, "NOT_FOUND", "Not found");
    }
    if parts.method == Method::GET {
        return match path {
            "/board" | "/api/board" if app.board.is_none() => failure(
                StatusCode::NOT_FOUND,
                "BOARD_DISABLED",
                "The board is not enabled",
            ),
            "/board" => {
                if ui_page_authorized(&parts.headers, &app) {
                    respond(
                        StatusCode::OK,
                        include_str!("../web/board.html")
                            .replace("__IRIS_UI_TOKEN__", &app.ui_token),
                        "text/html; charset=utf-8",
                    )
                } else {
                    respond(
                        StatusCode::OK,
                        include_str!("../web/login.html"),
                        "text/html; charset=utf-8",
                    )
                }
            }
            "/board.js" => respond(
                StatusCode::OK,
                include_str!("../web/board.js"),
                "text/javascript; charset=utf-8",
            ),
            "/board.css" => respond(
                StatusCode::OK,
                include_str!("../web/board.css"),
                "text/css; charset=utf-8",
            ),
            "/api/board" => {
                if !authorized(&parts.headers, &app.ui_token) {
                    return failure(
                        StatusCode::UNAUTHORIZED,
                        "AUTH",
                        "本人用画面を開き直してください。",
                    );
                }
                match app.board.as_ref().map(|board| board.page_data()) {
                    Some(Ok(data)) => json_response(StatusCode::OK, data),
                    _ => failure(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "STORAGE",
                        "看板を取得できません。",
                    ),
                }
            }
            "/board/mcp" => failure(
                StatusCode::METHOD_NOT_ALLOWED,
                "METHOD",
                "This stateless MCP endpoint accepts POST only",
            ),
            "/" => {
                if ui_page_authorized(&parts.headers, &app) {
                    respond(
                        StatusCode::OK,
                        include_str!("../web/index.html")
                            .replace("__IRIS_UI_TOKEN__", &app.ui_token),
                        "text/html; charset=utf-8",
                    )
                } else {
                    respond(
                        StatusCode::OK,
                        include_str!("../web/login.html"),
                        "text/html; charset=utf-8",
                    )
                }
            }
            "/app.css" => respond(
                StatusCode::OK,
                include_str!("../web/app.css"),
                "text/css; charset=utf-8",
            ),
            "/app.js" => respond(
                StatusCode::OK,
                include_str!("../web/app.js"),
                "text/javascript; charset=utf-8",
            ),
            "/login.js" => respond(
                StatusCode::OK,
                include_str!("../web/login.js"),
                "text/javascript; charset=utf-8",
            ),
            "/health" => json_response(
                StatusCode::OK,
                json!({"ok":true,"synthetic":true,"version":env!("CARGO_PKG_VERSION"),"protocol":many_iris::MCP_VERSION}),
            ),
            "/api/state" => {
                if !authorized(&parts.headers, &app.ui_token) {
                    return failure(
                        StatusCode::UNAUTHORIZED,
                        "AUTH",
                        "本人用画面を開き直してください。",
                    );
                }
                match app
                    .store
                    .lock()
                    .map_err(|_| ())
                    .and_then(|store| store.snapshot().map_err(|_| ()))
                {
                    Ok(mut v) => {
                        v["scheduler"] = match app
                            .scheduler_error
                            .lock()
                            .ok()
                            .and_then(|s| s.clone())
                        {
                            Some(code) => {
                                json!({"state":"paused_error","code":code,"message":"実行状態の照合が必要です。自動再送を停止しています。"})
                            }
                            None => json!({"state":"ready"}),
                        };
                        // Per case, so one case's error never pauses the others.
                        if let Ok(errors) = app.case_errors.lock()
                            && !errors.is_empty()
                        {
                            v["scheduler"]["case_errors"] = json!(*errors);
                        }
                        json_response(StatusCode::OK, v)
                    }
                    Err(_) => failure(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "STORAGE",
                        "状態を取得できません。再実行せず確認してください。",
                    ),
                }
            }
            "/mcp" => failure(
                StatusCode::METHOD_NOT_ALLOWED,
                "METHOD",
                "This stateless MCP endpoint accepts POST only",
            ),
            _ => failure(StatusCode::NOT_FOUND, "NOT_FOUND", "Not found"),
        };
    }
    if parts.method != Method::POST {
        return failure(
            StatusCode::METHOD_NOT_ALLOWED,
            "METHOD",
            "Method not allowed",
        );
    }
    if !["/api/action", "/mcp", "/session", "/board/mcp"].contains(&path) {
        return failure(StatusCode::NOT_FOUND, "NOT_FOUND", "Not found");
    }
    if path == "/board/mcp" {
        return board_mcp(&app, &parts.headers, body).await;
    }
    let token = if path == "/mcp" {
        &app.mcp_token
    } else {
        &app.ui_token
    };
    if path != "/session" && !authorized(&parts.headers, token) {
        return failure(StatusCode::UNAUTHORIZED, "AUTH", "Authorization required");
    }
    if one_header(&parts.headers, "content-type").is_none_or(|s| {
        !s.split(';')
            .next()
            .unwrap_or("")
            .trim()
            .eq_ignore_ascii_case("application/json")
    }) {
        return failure(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "CONTENT_TYPE",
            "JSON required",
        );
    }
    let bytes = match to_bytes(body, 65536).await {
        Ok(b) => b,
        Err(_) => {
            return failure(
                StatusCode::PAYLOAD_TOO_LARGE,
                "LIMIT",
                "Request body exceeds limit",
            );
        }
    };
    let value = match mcp::parse_json(&bytes) {
        Ok(v) => v,
        Err(_) => {
            return failure(
                StatusCode::BAD_REQUEST,
                "INVALID_JSON",
                "Invalid or ambiguous JSON",
            );
        }
    };
    if path == "/session" {
        if !origin_public
            && one_header(&parts.headers, "origin") != Some(format!("http://{}", app.host).as_str())
        {
            return failure(
                StatusCode::FORBIDDEN,
                "ORIGIN",
                "本人用画面から接続してください。",
            );
        }
        let object = match value.as_object() {
            Some(o) if o.len() == 1 && o.contains_key("key") => o,
            _ => {
                return failure(
                    StatusCode::BAD_REQUEST,
                    "INVALID",
                    "本人用キーを入力してください。",
                );
            }
        };
        if !object["key"]
            .as_str()
            .is_some_and(|key| matches_token(key, &app.ui_login_key))
        {
            return failure(
                StatusCode::UNAUTHORIZED,
                "AUTH",
                "本人用キーを確認してください。",
            );
        }
        let mut response = json_response(StatusCode::OK, json!({"ok":true,"synthetic":true}));
        let mut cookie = format!(
            "iris_ui_{}={}; Path=/; HttpOnly; SameSite=Strict",
            app.host.rsplit(':').next().unwrap_or("local"),
            app.ui_token
        );
        if public_request {
            cookie.push_str("; Secure");
        }
        response.headers_mut().insert(
            "set-cookie",
            cookie.parse().expect("hex cookie is a valid header"),
        );
        return response;
    }
    if path == "/mcp" {
        let header_pairs: Vec<(&str, &str)> = parts
            .headers
            .iter()
            .filter_map(|(k, v)| v.to_str().ok().map(|v| (k.as_str(), v)))
            .collect();
        if let Err(e) = mcp::validate_http(&header_pairs, &value) {
            return json_response(
                StatusCode::BAD_REQUEST,
                mcp::error_response(value.get("id"), &e),
            );
        }
        let mut context = |operation: &str, input: &Value| -> Result<Value, (String, String)> {
            let mut store = app
                .store
                .lock()
                .map_err(|_| ("STORAGE".into(), "State unavailable".into()))?;
            // MCP never returns a real-project case's markdown or instruction
            // text: only their SHA-256 and length.
            if operation == "snapshot" {
                let mut snapshot = store.snapshot().map_err(|e| (e.code, e.detail))?;
                many_iris::domain::redact_real_project_text(&mut snapshot);
                return Ok(snapshot);
            }
            if operation == "submit_decision" {
                return Err((
                    "HUMAN_DECISION_REQUIRED".into(),
                    "Confirm this decision in the local human UI".into(),
                ));
            }
            if !USER_OPERATIONS.contains(&operation) {
                return Err(("FORBIDDEN".into(), "Operation unavailable".into()));
            }
            if !store.mcp_operation_allowed(operation) {
                return Err((
                    "FORBIDDEN".into(),
                    "Start a real-project case in the local human UI".into(),
                ));
            }
            let envelope = local_envelope(input).map_err(|e| ("INVALID".into(), e.into()))?;
            let mut result = store
                .apply(operation, &envelope)
                .map_err(|e| (e.code, e.detail))?;
            many_iris::domain::redact_real_project_text(&mut result);
            Ok(result)
        };
        let response = mcp::handle(&value, &mut context);
        return if response.is_null() {
            respond(StatusCode::ACCEPTED, "", "application/json")
        } else {
            let status = if response["error"]["code"] == -32601 {
                StatusCode::NOT_FOUND
            } else {
                StatusCode::OK
            };
            json_response(status, response)
        };
    }
    let obj = match value.as_object() {
        Some(o) => o,
        None => return failure(StatusCode::BAD_REQUEST, "INVALID", "Object required"),
    };
    if obj
        .keys()
        .any(|key| !["operation", "input"].contains(&key.as_str()))
    {
        return failure(StatusCode::BAD_REQUEST, "INVALID", "Unknown action field");
    }
    let operation = obj.get("operation").and_then(Value::as_str).unwrap_or("");
    if !USER_OPERATIONS.contains(&operation) {
        return failure(
            StatusCode::FORBIDDEN,
            "FORBIDDEN",
            "この操作は利用画面から実行できません。",
        );
    }
    let envelope = match local_envelope(obj.get("input").unwrap_or(&Value::Null)) {
        Ok(v) => v,
        Err(e) => return failure(StatusCode::BAD_REQUEST, "INVALID", e),
    };
    let mut store = match app.store.lock() {
        Ok(s) => s,
        Err(_) => {
            return failure(
                StatusCode::SERVICE_UNAVAILABLE,
                "STORAGE",
                "State unavailable",
            );
        }
    };
    match store.apply(operation, &envelope) {
        Ok(v) => json_response(StatusCode::OK, v),
        Err(e) => failure(
            if e.code == "STORAGE" {
                StatusCode::SERVICE_UNAVAILABLE
            } else {
                StatusCode::CONFLICT
            },
            &e.code,
            &e.detail,
        ),
    }
}

fn system_body(request_id: String, payload: Value) -> Value {
    json!({"request_id":request_id,"principal_id":"synthetic-executor","workspace_id":"synthetic-workspace","payload":payload})
}
fn user_body(request_id: String, payload: Value) -> Value {
    json!({"request_id":request_id,"principal_id":"local-user","workspace_id":"synthetic-workspace","payload":payload})
}

async fn drive_once(
    store: &Arc<Mutex<Store>>,
    client: &mut executor::Client,
    instance: &str,
) -> Result<(), String> {
    let snapshot = store
        .lock()
        .map_err(|_| "State lock")?
        .snapshot()
        .map_err(|e| e.code)?;
    if snapshot["restore_hold"] == true {
        return Ok(());
    }
    let plans = snapshot["plans"].as_array().ok_or("Invalid state")?;
    for plan in plans {
        let plan_state = plan["plan_state"].as_str().unwrap_or("");
        let tasks = plan["tasks"].as_array().ok_or("Missing tasks")?;
        let active = tasks.iter().find(|t| {
            t["attempt_id"].is_string()
                && [
                    "dispatch_intent",
                    "accepted",
                    "running",
                    "stop_requested",
                    "unknown",
                    "stop_unconfirmed",
                ]
                .contains(&t["execution_state"].as_str().unwrap_or(""))
        });
        if let Some(task) = active {
            let attempt = task["attempt_id"].as_str().ok_or("Missing attempt")?;
            let state = task["execution_state"].as_str().unwrap_or("");
            let mut args = json!({"attempt_id":attempt,"fence":task["fence"],"executor_instance_id":task["executor_instance_id"]});
            let tool = match state {
                "dispatch_intent" => {
                    args["instruction_hash"] = task["instruction_hash"].clone();
                    "executor_start"
                }
                "stop_requested" => {
                    let stop_id = task
                        .get("stop_request_id")
                        .or_else(|| task.get("stop_receipt_id"))
                        .cloned()
                        .unwrap_or(Value::Null);
                    if !stop_id.is_string() {
                        return Err("Missing persisted stop request binding".into());
                    }
                    args["stop_request_id"] = stop_id;
                    "executor_stop"
                }
                _ => "executor_poll",
            };
            let binding = args.clone();
            let mut reply = client.call(tool, args).await;
            if reply
                .as_ref()
                .is_err_and(|e| e.contains("EXECUTOR_TERMINAL"))
                && tool == "executor_stop"
            {
                let mut query = binding;
                query
                    .as_object_mut()
                    .ok_or("Invalid executor binding")?
                    .remove("stop_request_id");
                reply = client.call("executor_poll", query).await;
            }
            match reply {
                Ok(reply) => {
                    let event = reply
                        .get("event")
                        .cloned()
                        .ok_or("Executor event missing")?;
                    let seq = event["event_seq"]
                        .as_u64()
                        .ok_or("Event sequence missing")?;
                    let terminal = ["result", "stop_observed"]
                        .contains(&event["event_kind"].as_str().unwrap_or(""));
                    let recovering = ["unknown", "stop_unconfirmed"].contains(&state);
                    if recovering && !terminal {
                        continue;
                    }
                    let body = system_body(
                        format!(
                            "{}-{attempt}-{seq}",
                            if recovering { "reconcile" } else { "evt" }
                        ),
                        event.clone(),
                    );
                    let operation = if recovering {
                        "reconcile_attempt"
                    } else {
                        "record_executor_event"
                    };
                    let mut core = store.lock().map_err(|_| "State lock")?;
                    if let Err(e) = core.apply(operation, &body) {
                        if terminal && ["SEQUENCE_GAP", "STATE"].contains(&e.code.as_str()) {
                            core.apply(
                                "reconcile_attempt",
                                &system_body(format!("reconcile-{attempt}-{seq}"), event),
                            )
                            .map_err(|e| format!("{}: {}", e.code, e.detail))?;
                        } else if e.code != "STATE" || terminal {
                            return Err(format!("{}: {}", e.code, e.detail));
                        }
                    }
                }
                Err(_) => {
                    if ["unknown", "stop_unconfirmed"].contains(&state) {
                        continue;
                    }
                    let seq = task["event_seq"].as_u64().unwrap_or(0) + 1;
                    let event = json!({"attempt_id":attempt,"fence":task["fence"],"executor_instance_id":task["executor_instance_id"],"event_seq":seq,"event_kind":"disconnected","observed_at":now()});
                    store
                        .lock()
                        .map_err(|_| "State lock")?
                        .apply(
                            "record_executor_event",
                            &system_body(format!("lost-{attempt}-{seq}"), event),
                        )
                        .map_err(|e| e.code)?;
                    return Err("EXECUTOR_DISCONNECTED".into());
                }
            }
        } else if plan_state == "running" {
            // The core chooses the current task and enforces scope/dependencies/approval.
            let next = tasks
                .iter()
                .find(|t| t["status"] != "completed" && t["outcome"] != "succeeded");
            if let Some(task) = next {
                if task["attempt_id"].is_string()
                    && ["unknown", "stop_unconfirmed", "stopped_confirmed"]
                        .contains(&task["execution_state"].as_str().unwrap_or(""))
                {
                    continue;
                }
                if task["status"] == "pending" {
                    let request = format!(
                        "select-{}-{}",
                        plan["run_id"].as_str().unwrap_or("run"),
                        task["task_id"].as_str().unwrap_or("task")
                    );
                    match store.lock().map_err(|_| "State lock")?.apply(
                        "continue_plan",
                        &user_body(request, json!({"run_id":plan["run_id"]})),
                    ) {
                        Ok(_) => {}
                        Err(e)
                            if [
                                "HUMAN_DECISION_REQUIRED",
                                "STATE",
                                "OUTCOME_UNRESOLVED",
                                "STALE_APPROVAL",
                                "RESTORE_HOLD",
                            ]
                            .contains(&e.code.as_str()) => {}
                        Err(e) => return Err(format!("{}: {}", e.code, e.detail)),
                    }
                    continue;
                }
                let executor_id = task["executor_id"]
                    .as_str()
                    .filter(|v| !v.is_empty())
                    .unwrap_or("synthetic-executor");
                let payload = json!({"run_id":plan["run_id"],"task_id":task["task_id"],"instruction_revision":task["instruction_revision"],"instruction_hash":task["instruction_hash"],"executor_id":executor_id,"executor_instance_id":format!("{instance}-{executor_id}"),"execution_host_id":"synthetic-host"});
                let req = format!(
                    "dispatch-{}-{}-{}",
                    plan["run_id"].as_str().unwrap_or("run"),
                    task["task_id"].as_str().unwrap_or("task"),
                    task["fence"].as_u64().unwrap_or(0)
                );
                match store
                    .lock()
                    .map_err(|_| "State lock")?
                    .apply("dispatch_attempt", &user_body(req, payload))
                {
                    Ok(_) => {}
                    Err(e)
                        if [
                            "HUMAN_DECISION_REQUIRED",
                            "STATE",
                            "STALE_APPROVAL",
                            "OUTCOME_UNRESOLVED",
                            "STOP_UNCONFIRMED",
                            "RESTORE_HOLD",
                            "FORBIDDEN",
                            "SCOPE_MISMATCH",
                        ]
                        .contains(&e.code.as_str()) => {}
                    Err(e) => return Err(format!("{}: {}", e.code, e.detail)),
                }
            }
        }
    }
    Ok(())
}

fn arguments() -> Result<HashMap<String, String>, String> {
    let mut result = HashMap::new();
    let mut args = std::env::args().skip(1);
    while let Some(key) = args.next() {
        if ![
            "--db",
            "--port",
            "--ready-file",
            "--mcp-token-file",
            "--ui-key-file",
            "--synthetic-executor",
            "--backup-to",
            "--restore-from",
            "--doctor",
            "--shutdown-file",
            "--executor-probe-port",
            "--executor-token-file",
            "--executor-evidence-binding",
            "--executor-request-id",
            "--executor-request-binding",
            "--executor-config",
            "--real-cases-preview",
            "--board-writers",
            "--board-add-writer",
            "--board-token-out",
            "--public-origin",
        ]
        .contains(&key.as_str())
        {
            return Err("Unknown command argument".into());
        }
        let value = if ["--synthetic-executor", "--doctor"].contains(&key.as_str()) {
            "true".into()
        } else {
            args.next()
                .filter(|v| !v.starts_with("--"))
                .ok_or("Argument value missing")?
        };
        if result.insert(key, value).is_some() {
            return Err("Duplicate command argument".into());
        }
    }
    Ok(result)
}
fn token_file(path: &Path) -> Result<String, String> {
    use std::io::Write;
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
    {
        Ok(mut file) => {
            let token = random_hex()?;
            file.write_all(token.as_bytes())
                .map_err(|_| "Cannot save MCP credential")?;
            file.sync_all().map_err(|_| "Cannot save MCP credential")?;
            Ok(token)
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            let token = std::fs::read_to_string(path).map_err(|_| "Cannot read MCP credential")?;
            if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err("Invalid MCP credential file".into());
            }
            Ok(token)
        }
        Err(_) => Err("Cannot create MCP credential file".into()),
    }
}

#[tokio::main]
async fn main() {
    if let Err(message) = run().await {
        eprintln!("Many Iris: {message}");
        std::process::exit(1);
    }
}
async fn run() -> Result<(), String> {
    let args = arguments()?;
    // Issues a board writer key: the key goes to a new file, its SHA-256 into the
    // writers file. Nothing else runs, and the key is never printed.
    if let Some(actor) = args.get("--board-add-writer") {
        let (Some(writers), Some(token_out), 3) = (
            args.get("--board-writers"),
            args.get("--board-token-out"),
            args.len(),
        ) else {
            return Err(
                "--board-add-writer takes only --board-writers and --board-token-out".into(),
            );
        };
        many_iris::board::add_writer(Path::new(writers), Path::new(token_out), actor)?;
        println!(
            "{}",
            json!({"ok":true,"actor":actor,"writers_file":writers,"token_file":token_out})
        );
        return Ok(());
    }
    if args.contains_key("--board-token-out") {
        return Err("--board-token-out is only used with --board-add-writer".into());
    }
    let public_origin = args
        .get("--public-origin")
        .map(|value| many_iris::board::PublicOrigin::parse(value))
        .transpose()?;
    if public_origin.is_some() && !args.contains_key("--board-writers") {
        return Err("--public-origin is only used together with --board-writers".into());
    }
    // A writers file that cannot be used stops the start before any state is touched.
    if let Some(writers) = args.get("--board-writers") {
        many_iris::board::Writers::load(Path::new(writers))?;
    }
    // Read-only report on a real-project configuration's case files: ids,
    // sizes, hashes, scope hashes and whether each instruction holds its
    // markdown. No store, connection or content. Exits 1 unless every case is
    // ready to load.
    if let Some(path) = args.get("--real-cases-preview") {
        if args.len() != 1 {
            return Err("The real-cases preview takes no other argument".into());
        }
        let report = many_iris::owned_http::real_cases_preview(Path::new(path))?;
        println!("{report}");
        if report["ready"] != true {
            return Err("Real cases are not ready; see the preview".into());
        }
        return Ok(());
    }
    if args.contains_key("--executor-config")
        && (args.contains_key("--executor-probe-port") || args.contains_key("--synthetic-executor"))
    {
        return Err(
            "Explicit executor composition cannot be combined with probe or stdio worker".into(),
        );
    }
    let executor_config = match args.get("--executor-config") {
        Some(path) => many_iris::owned_http::ExecutorConfig::load(Path::new(path))?,
        None => many_iris::owned_http::ExecutorConfig::StdioSynthetic,
    };
    let request_id = args.get("--executor-request-id");
    let request_binding = args.get("--executor-request-binding");
    if request_id.is_some() != request_binding.is_some()
        || (request_id.is_some() && args.contains_key("--executor-evidence-binding"))
    {
        return Err(
            "Request lookup requires its ID and binding, separately from owner evidence".into(),
        );
    }
    if let Some(port) = args.get("--executor-probe-port") {
        let port: u16 = port.parse().map_err(|_| "Invalid executor probe port")?;
        let key_path = args
            .get("--executor-token-file")
            .ok_or("Separate execution credential file required")?;
        let key = std::fs::read_to_string(key_path)
            .map_err(|_| "Cannot read separate execution credential")?;
        let capabilities = many_iris::cli_executor::Client::inspect(port, &key).await?;
        let mut report = json!({"probe_only":true,"execution_sent":false,
            "supported_contract":capabilities["contract_version"]=="iris-execution/1"});
        for field in [
            "synthetic",
            "external_effects",
            "execution_ready",
            "durable_start_receipt",
            "query_by_attempt",
            "query_by_request",
            "grant_revision_binding",
            "fenced_stop_proof",
            "result_sha256",
            "live_provider_execution",
            "owner_receipt_query",
            "operator_grants_loaded",
        ] {
            report[field] = capabilities[field]
                .as_bool()
                .map(Value::Bool)
                .unwrap_or(Value::Null);
        }
        if let Some(binding_path) = args.get("--executor-evidence-binding") {
            let bytes = std::fs::read(binding_path)
                .map_err(|_| "Cannot read requested evidence binding")?;
            let binding = mcp::parse_json(&bytes).map_err(|_| "Invalid evidence binding file")?;
            let evidence =
                many_iris::cli_executor::Client::inspect_evidence(port, &key, binding).await?;
            report["owner_receipt_present"] = Value::Bool(true);
            for field in [
                "local_tree_ceased",
                "task_outcome_verified",
                "effects_verified",
            ] {
                report[field] = evidence[field]
                    .as_bool()
                    .map(Value::Bool)
                    .unwrap_or(Value::Null);
            }
            report["artifact_integrity_verified"] = Value::Bool(
                evidence["outcome_receipt"]["verification_scope"] == "artifact-integrity-only",
            );
        }
        if let (Some(request_id), Some(binding_path)) = (request_id, request_binding) {
            let bytes =
                std::fs::read(binding_path).map_err(|_| "Cannot read requested receipt binding")?;
            let binding = mcp::parse_json(&bytes).map_err(|_| "Invalid receipt binding file")?;
            let observation =
                many_iris::cli_executor::Client::inspect_request(port, &key, request_id, binding)
                    .await?;
            let state = observation["current"]["execution_state"]
                .as_str()
                .filter(|s| {
                    [
                        "accepted",
                        "running",
                        "unknown",
                        "stop_requested",
                        "stop_unconfirmed",
                        "stopped_confirmed",
                        "completed",
                        "failed",
                    ]
                    .contains(s)
                })
                .ok_or("Invalid observed execution state")?;
            report["request_observation_only"] = Value::Bool(true);
            report["request_receipt_present"] = Value::Bool(true);
            report["request_execution_state"] = Value::String(state.into());
            report["request_delivery_unknown"] =
                Value::Bool(["unknown", "stop_unconfirmed"].contains(&state));
        }
        println!("{report}");
        return Ok(());
    }
    if args.contains_key("--executor-token-file")
        || args.contains_key("--executor-evidence-binding")
        || request_id.is_some()
        || request_binding.is_some()
    {
        return Err("Executor credential is only used with the explicit probe".into());
    }
    let db = PathBuf::from(
        args.get("--db")
            .map(String::as_str)
            .unwrap_or(".state/iris.sqlite3"),
    );
    if let Some(parent) = db.parent().filter(|p| !p.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent).map_err(|_| "Cannot create state directory")?;
    }
    if args.contains_key("--synthetic-executor") {
        return executor::serve_stdio(&db).await;
    }
    if args.contains_key("--doctor") {
        println!(
            "{}",
            json!({"synthetic":true,"external_execution":false,"protocol":many_iris::MCP_VERSION,"sqlite_version":rusqlite::version(),"state_parent_exists":db.parent().is_some_and(Path::exists),"real_chatgpt":"not configured","real_cli":"unsupported pending durable receipt/stop proof contract"})
        );
        return Ok(());
    }
    // Only a real-bounded or real-project configuration carries tasks of its
    // own; every other start opens the store exactly as before.
    let (real_fixture, real_project) = match &executor_config {
        many_iris::owned_http::ExecutorConfig::OwnedHttp(config) => (
            config.real_fixture().cloned(),
            config.real_project().cloned(),
        ),
        many_iris::owned_http::ExecutorConfig::StdioSynthetic => (None, None),
    };
    let open = |restored: bool| match &real_project {
        Some(project) if restored => Store::open_restored_real_project(&db, project),
        Some(project) => Store::open_real_project(&db, project),
        None if restored => Store::open_restored_with(&db, real_fixture.as_ref()),
        None => Store::open_with(&db, real_fixture.as_ref()),
    };
    let store = if let Some(source) = args.get("--restore-from") {
        if db.exists() {
            return Err("Restore destination already exists; choose a new state path".into());
        }
        let source = rusqlite::Connection::open_with_flags(
            source,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .map_err(|_| "Backup cannot be opened")?;
        let mut target =
            rusqlite::Connection::open(&db).map_err(|_| "Restore target cannot be created")?;
        rusqlite::backup::Backup::new(&source, &mut target)
            .map_err(|_| "Restore backup failed")?
            .run_to_completion(16, std::time::Duration::from_millis(10), None)
            .map_err(|_| "Restore backup failed")?;
        drop(target);
        open(true).map_err(|e| format!("{}: {}", e.code, e.detail))?
    } else {
        open(false).map_err(|e| format!("{}: {}", e.code, e.detail))?
    };
    if let Some(destination) = args.get("--backup-to") {
        store
            .backup_to(Path::new(destination))
            .map_err(|e| format!("{}: {}", e.code, e.detail))?;
        println!(
            "{}",
            json!({"ok":true,"operation":"backup","synthetic":true})
        );
        return Ok(());
    }
    let port = args
        .get("--port")
        .map(String::as_str)
        .unwrap_or("0")
        .parse::<u16>()
        .map_err(|_| "Invalid local port")?;
    let shutdown_path = args.get("--shutdown-file").map(PathBuf::from);
    if shutdown_path.as_ref().is_some_and(|p| p.exists()) {
        return Err("Shutdown marker already exists; choose a new startup marker".into());
    }
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))
        .await
        .map_err(|_| "Local port unavailable")?;
    let address = listener
        .local_addr()
        .map_err(|_| "Cannot obtain listener address")?;
    let host = address.to_string();
    let token_path = args
        .get("--mcp-token-file")
        .map(PathBuf::from)
        .unwrap_or_else(|| db.with_extension("mcp.token"));
    let mcp_token = token_file(&token_path)?;
    let ui_key_path = args
        .get("--ui-key-file")
        .map(PathBuf::from)
        .unwrap_or_else(|| db.with_extension("ui.key"));
    if ui_key_path == token_path {
        return Err("UI and MCP credentials require separate files".into());
    }
    let ui_login_key = token_file(&ui_key_path)?;
    if matches_token(&ui_login_key, &mcp_token) {
        return Err("UI and MCP credentials must differ".into());
    }
    let board = match args.get("--board-writers") {
        Some(writers) => Some(Arc::new(many_iris::board::Board::open(
            &db,
            Path::new(writers),
        )?)),
        None => None,
    };
    let store = Arc::new(Mutex::new(store));
    let mut case_errors: many_iris::owned_http::CaseErrors = Default::default();
    let (mut client, executor_profile) = match executor_config {
        many_iris::owned_http::ExecutorConfig::StdioSynthetic => {
            let executable =
                std::env::current_exe().map_err(|_| "Cannot identify executor binary")?;
            let executor_db = db.with_extension("executor.sqlite3");
            let client = executor::Client::spawn(&executable, &executor_db).await?;
            let instance = format!("instance-{}", &random_hex()?[..12]);
            (
                SchedulerClient::StdioSynthetic { client, instance },
                "stdio-synthetic/1",
            )
        }
        many_iris::owned_http::ExecutorConfig::OwnedHttp(config) => {
            let owned = many_iris::owned_http::OwnedHttp::new(config)?;
            let profile = owned.profile().as_str();
            case_errors = owned.case_errors();
            (SchedulerClient::OwnedHttp(owned), profile)
        }
    };
    let scheduler_error = Arc::new(Mutex::new(None::<String>));
    let app = App {
        store: store.clone(),
        host: host.clone(),
        ui_token: random_hex()?,
        ui_login_key,
        mcp_token,
        scheduler_error: scheduler_error.clone(),
        case_errors,
        board: board.clone(),
        public: public_origin.clone(),
    };
    let router = Router::new().fallback(any(handle)).with_state(app);
    let (stop_tx, mut stop_rx) = watch::channel(false);
    let worker = tokio::spawn(async move {
        loop {
            tokio::select! {
                _=stop_rx.changed()=>break,
                _=tokio::time::sleep(std::time::Duration::from_millis(250))=>{
                    if !client.allows_lookup_after_error()
                        && scheduler_error.lock().map(|s|s.is_some()).unwrap_or(true) {continue;}
                    if let Err(message)=client.tick(&store).await {
                        // Do not keep dispatching after a failed state/receipt reconciliation.
                        if let Ok(mut state)=scheduler_error.lock() {*state=Some(message.split(':').next().unwrap_or("SCHEDULER").to_owned());}
                    } else if client.allows_lookup_after_error() {
                        if let Ok(mut state)=scheduler_error.lock() {*state=None;}
                    }
                }
            }
        }
        let _ = client.shutdown().await;
    });
    let mut ready = json!({"ok":true,"url":format!("http://{host}"),"synthetic":true,"pid":std::process::id(),"version":env!("CARGO_PKG_VERSION"),"protocol":many_iris::MCP_VERSION,"shutdown_file":shutdown_path,"executor_profile":executor_profile});
    // Added only when the board is on, so the output of a plain start is unchanged.
    if board.is_some() {
        ready["board"] = json!(true);
        ready["public_origin"] = json!(public_origin.as_ref().map(|p| p.origin()));
    }
    if let Some(path) = args.get("--ready-file") {
        std::fs::write(path, ready.to_string()).map_err(|_| "Cannot save startup receipt")?;
    }
    println!("{ready}");
    let server=axum::serve(listener,router).with_graceful_shutdown(async move {
        tokio::select! {
            _=tokio::signal::ctrl_c()=>{},
            _=async {
                if let Some(path)=shutdown_path {
                    loop {if path.exists(){break;}tokio::time::sleep(std::time::Duration::from_millis(200)).await;}
                } else {std::future::pending::<()>().await;}
            }=>{},
        }
    }).await;
    let _ = stop_tx.send(true);
    let _ = worker.await;
    server.map_err(|_| "Local server stopped with an error".into())
}
