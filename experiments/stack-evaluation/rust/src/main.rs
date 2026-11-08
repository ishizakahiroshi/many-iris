mod core;
mod process;

use axum::{
    Router,
    body::{Body, to_bytes},
    extract::State,
    http::{HeaderMap, Method, Request, StatusCode},
    response::{IntoResponse, Response},
    routing::any,
};
use core::{Core, Options};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    io::{self, BufRead, Read, Write},
    path::PathBuf,
    sync::{Arc, Mutex},
};

#[derive(Clone)]
struct App {
    core: Arc<Mutex<Core>>,
    token: Arc<String>,
    host: Arc<String>,
    ui: Arc<Vec<u8>>,
}

fn response(status: StatusCode, value: Value) -> Response {
    (
        status,
        [
            ("content-type", "application/json"),
            ("cache-control", "no-store"),
            ("x-content-type-options", "nosniff"),
        ],
        value.to_string(),
    )
        .into_response()
}
fn error(status: StatusCode, code: &str) -> Response {
    response(status, json!({"ok":false,"error":code}))
}

fn single_header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    let mut values = headers.get_all(name).iter();
    let value = values.next()?.to_str().ok()?;
    if values.next().is_some() {
        return None;
    }
    Some(value)
}
fn equal_secret(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut difference = 0u8;
    for (&a, &b) in a.iter().zip(b) {
        difference |= a ^ b;
    }
    difference == 0
}
fn authenticated(headers: &HeaderMap, host: &str, token: &str) -> bool {
    if single_header(headers, "host") != Some(host) {
        return false;
    }
    if headers.contains_key("origin")
        && single_header(headers, "origin") != Some(format!("http://{host}").as_str())
    {
        return false;
    }
    match single_header(headers, "authorization").and_then(|value| value.strip_prefix("Bearer ")) {
        Some(value) => equal_secret(value.as_bytes(), token.as_bytes()),
        None => false,
    }
}

async fn handle(State(app): State<App>, request: Request<Body>) -> Response {
    let path = request.uri().path();
    if request.uri().query().is_some() {
        return error(StatusCode::BAD_REQUEST, "INVALID");
    }
    if request.method() == Method::GET {
        if single_header(request.headers(), "host") != Some(app.host.as_str()) {
            return error(StatusCode::FORBIDDEN, "AUTH");
        }
        return match path {
            "/" => (
                StatusCode::OK,
                [
                    ("content-type", "text/html; charset=utf-8"),
                    ("cache-control", "no-store"),
                    ("x-content-type-options", "nosniff"),
                    ("x-frame-options", "DENY"),
                ],
                app.ui.as_ref().clone(),
            )
                .into_response(),
            "/health" => response(StatusCode::OK, json!({"ok":true})),
            _ => error(StatusCode::NOT_FOUND, "NOT_FOUND"),
        };
    }
    if path != "/api" {
        return error(StatusCode::NOT_FOUND, "NOT_FOUND");
    }
    if request.method() != Method::POST {
        return error(StatusCode::METHOD_NOT_ALLOWED, "INVALID");
    }
    if !authenticated(request.headers(), &app.host, &app.token) {
        return error(StatusCode::FORBIDDEN, "AUTH");
    }
    if request.headers().contains_key("transfer-encoding")
        && request.headers().contains_key("content-length")
    {
        return error(StatusCode::BAD_REQUEST, "INVALID");
    }
    let bytes = match to_bytes(request.into_body(), 65536).await {
        Ok(bytes) => bytes,
        Err(_) => return error(StatusCode::PAYLOAD_TOO_LARGE, "INVALID"),
    };
    let input: Value = match serde_json::from_slice(&bytes) {
        Ok(input) => input,
        Err(_) => return error(StatusCode::BAD_REQUEST, "INVALID"),
    };
    let result =
        tokio::task::spawn_blocking(move || app.core.lock().map_err(|_| "INTERNAL")?.call(input))
            .await;
    match result {
        Ok(Ok(value)) => response(StatusCode::OK, json!({"ok":true,"data":value})),
        Ok(Err(code)) => error(StatusCode::BAD_REQUEST, code),
        Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "INTERNAL"),
    }
}

fn configuration() -> Result<(Options, PathBuf, u16), &'static str> {
    let mut values = HashMap::<String, String>::new();
    let mut test_mode = false;
    let mut restored = false;
    let mut args = std::env::args().skip(1);
    while let Some(key) = args.next() {
        match key.as_str() {
            "--test-mode" if !test_mode => test_mode = true,
            "--restored" if !restored => restored = true,
            "--db" | "--fixture" | "--helper" | "--python" | "--ui" | "--port" => {
                let value = args.next().ok_or("CONFIG")?;
                if value.contains('\0') || values.insert(key, value).is_some() {
                    return Err("CONFIG");
                }
            }
            _ => return Err("CONFIG"),
        }
    }
    let path = |name: &str| -> Result<PathBuf, &'static str> {
        let value = values.get(name).ok_or("CONFIG")?;
        std::fs::canonicalize(value).map_err(|_| "CONFIG")
    };
    let db = PathBuf::from(values.get("--db").ok_or("CONFIG")?);
    let parent = std::fs::canonicalize(db.parent().ok_or("CONFIG")?).map_err(|_| "CONFIG")?;
    let db = parent.join(db.file_name().ok_or("CONFIG")?);
    let port = values
        .get("--port")
        .map_or(Ok(0), |s| s.parse::<u16>())
        .map_err(|_| "CONFIG")?;
    let options = Options {
        db,
        fixture: path("--fixture")?,
        helper: path("--helper")?,
        python: path("--python")?,
        test_mode,
        restored,
    };
    Ok((options, path("--ui")?, port))
}

async fn run() -> Result<(), &'static str> {
    let (options, ui, port) = configuration()?;
    let mut line = String::new();
    io::stdin()
        .lock()
        .take(4097)
        .read_line(&mut line)
        .map_err(|_| "CONFIG")?;
    if line.len() > 4096 {
        return Err("CONFIG");
    }
    let handshake: Value = serde_json::from_str(&line).map_err(|_| "CONFIG")?;
    if handshake.as_object().is_none_or(|o| o.len() != 1) {
        return Err("CONFIG");
    }
    let token = handshake
        .get("token")
        .and_then(Value::as_str)
        .ok_or("CONFIG")?;
    if !(16..=512).contains(&token.len()) || !token.bytes().all(|b| b.is_ascii_graphic()) {
        return Err("CONFIG");
    }
    let core = Core::open(options)?;
    let sqlite_version = core.sqlite_version();
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))
        .await
        .map_err(|_| "LISTEN")?;
    let port = listener.local_addr().map_err(|_| "LISTEN")?.port();
    let app = App {
        core: Arc::new(Mutex::new(core)),
        token: Arc::new(token.into()),
        host: Arc::new(format!("127.0.0.1:{port}")),
        ui: Arc::new(std::fs::read(ui).map_err(|_| "CONFIG")?),
    };
    println!(
        "{}",
        json!({"port":port,"pid":std::process::id(),"sqlite_version":sqlite_version,"language":"rust"})
    );
    io::stdout().flush().map_err(|_| "OUTPUT")?;
    axum::serve(
        listener,
        Router::new().fallback(any(handle)).with_state(app),
    )
    .await
    .map_err(|_| "HTTP")
}

#[tokio::main(worker_threads = 2)]
async fn main() {
    if let Err(code) = run().await {
        eprintln!("startup failed: {code}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_auth_host_and_origin() {
        let mut headers = HeaderMap::new();
        headers.insert("host", "127.0.0.1:1234".parse().unwrap());
        headers.insert(
            "authorization",
            "Bearer synthetic-test-token".parse().unwrap(),
        );
        assert!(authenticated(
            &headers,
            "127.0.0.1:1234",
            "synthetic-test-token"
        ));
        headers.insert("origin", "http://example.invalid".parse().unwrap());
        assert!(!authenticated(
            &headers,
            "127.0.0.1:1234",
            "synthetic-test-token"
        ));
        headers.insert("origin", "http://127.0.0.1:1234".parse().unwrap());
        assert!(authenticated(
            &headers,
            "127.0.0.1:1234",
            "synthetic-test-token"
        ));
        headers.append(
            "authorization",
            "Bearer synthetic-test-token".parse().unwrap(),
        );
        assert!(!authenticated(
            &headers,
            "127.0.0.1:1234",
            "synthetic-test-token"
        ));
    }
}
