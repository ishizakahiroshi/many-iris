//! Many Iris product candidate. Executor mode is explicitly synthetic.
pub const CONTRACT_VERSION: &str = "many-iris-domain/0.1";
pub const MCP_VERSION: &str = "2026-07-28";
pub mod board;
pub mod cli_binding;
pub mod cli_executor;
pub mod domain;
pub mod executor;
pub mod mcp;
pub mod owned_http;
pub mod real_project;
