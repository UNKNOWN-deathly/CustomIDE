//! LSP client — minimal JSON-RPC over stdio framing, targeted at Pyright.
//!
//! This is intentionally small: lifecycle (initialize/initialized/shutdown),
//! send notifications, send requests with response routing, and a background
//! reader thread that delivers server messages on a channel.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};
use std::thread;

use crossbeam_channel::{Receiver, Sender, unbounded};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::errors::{IdeError, IdeResult};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ServerMessage {
    Response { jsonrpc: String, id: Value, #[serde(default)] result: Option<Value>, #[serde(default)] error: Option<Value> },
    Notification { jsonrpc: String, method: String, #[serde(default)] params: Value },
    Request { jsonrpc: String, id: Value, method: String, #[serde(default)] params: Value },
}

pub struct LspClient {
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
    next_id: AtomicI64,
    pending: Arc<Mutex<HashMap<i64, Sender<IdeResult<Value>>>>>,
    pub incoming: Receiver<ServerMessage>,
    name: String,
}

impl LspClient {
    /// Spawn `pyright-langserver --stdio` (or any LSP server) and start framing.
    pub fn spawn(program: &str, args: &[&str], cwd: Option<&Path>) -> IdeResult<Self> {
        let mut cmd = Command::new(program);
        cmd.args(args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        if let Some(c) = cwd {
            cmd.current_dir(c);
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| IdeError::ToolNotFound(format!("{program}: {e}")))?;
        let stdin = child.stdin.take().ok_or_else(|| IdeError::Lsp("no stdin".into()))?;
        let stdout = child.stdout.take().ok_or_else(|| IdeError::Lsp("no stdout".into()))?;

        let pending: Arc<Mutex<HashMap<i64, Sender<IdeResult<Value>>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let (tx, rx) = unbounded::<ServerMessage>();

        let pending_for_reader = pending.clone();
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                match read_message(&mut reader) {
                    Ok(Some(msg)) => {
                        if let ServerMessage::Response { id, result, error, .. } = &msg {
                            if let Some(id_num) = id.as_i64() {
                                if let Some(sender) = pending_for_reader.lock().remove(&id_num) {
                                    let payload = if let Some(err) = error {
                                        Err(IdeError::Lsp(err.to_string()))
                                    } else {
                                        Ok(result.clone().unwrap_or(Value::Null))
                                    };
                                    let _ = sender.send(payload);
                                    continue;
                                }
                            }
                        }
                        if tx.send(msg).is_err() {
                            break;
                        }
                    }
                    Ok(None) => break,
                    Err(_) => break,
                }
            }
        });

        Ok(Self {
            child,
            stdin: Arc::new(Mutex::new(stdin)),
            next_id: AtomicI64::new(1),
            pending,
            incoming: rx,
            name: program.to_string(),
        })
    }

    pub fn name(&self) -> &str { &self.name }

    pub fn notify(&self, method: &str, params: Value) -> IdeResult<()> {
        let msg = json!({ "jsonrpc": "2.0", "method": method, "params": params });
        write_message(&mut *self.stdin.lock(), &msg)
    }

    /// Reply to a server-initiated request. Used by reader threads handling
    /// things like `workspace/configuration` and `client/registerCapability`.
    pub fn respond(&self, id: &Value, result: Value) -> IdeResult<()> {
        let msg = json!({ "jsonrpc": "2.0", "id": id, "result": result });
        write_message(&mut *self.stdin.lock(), &msg)
    }

    /// Cheap handle: a shared writer that can `notify` / `respond` without
    /// holding the whole [`LspClient`]. Use this in background reader threads
    /// so they can answer server-initiated requests without locking the client.
    pub fn responder(&self) -> LspResponder {
        LspResponder { stdin: self.stdin.clone() }
    }

    pub fn request(&self, method: &str, params: Value) -> IdeResult<Receiver<IdeResult<Value>>> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = unbounded();
        self.pending.lock().insert(id, tx);
        let msg = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        write_message(&mut *self.stdin.lock(), &msg)?;
        Ok(rx)
    }

    /// Convenience: blocking request.
    pub fn request_sync(&self, method: &str, params: Value) -> IdeResult<Value> {
        let rx = self.request(method, params)?;
        rx.recv()
            .map_err(|_| IdeError::Lsp("response channel closed".into()))?
    }

    pub fn initialize(&self, root: &Path) -> IdeResult<Value> {
        let root_uri = path_to_uri(root);
        let params = json!({
            "processId": std::process::id(),
            "rootUri": root_uri,
            "capabilities": {
                "textDocument": {
                    "synchronization": { "didSave": true },
                    "publishDiagnostics": { "relatedInformation": false },
                    "hover": {}, "definition": {}, "references": {}, "documentSymbol": {}
                }
            },
            "workspaceFolders": [{ "uri": root_uri, "name": root.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default() }]
        });
        let result = self.request_sync("initialize", params)?;
        self.notify("initialized", json!({}))?;
        Ok(result)
    }

    pub fn shutdown(&mut self) -> IdeResult<()> {
        let _ = self.request_sync("shutdown", Value::Null);
        let _ = self.notify("exit", Value::Null);
        let _ = self.child.wait();
        Ok(())
    }
}

fn write_message<W: Write>(w: &mut W, msg: &Value) -> IdeResult<()> {
    let body = serde_json::to_vec(msg)?;
    let header = format!("Content-Length: {}\r\n\r\n", body.len());
    w.write_all(header.as_bytes())?;
    w.write_all(&body)?;
    w.flush()?;
    Ok(())
}

fn read_message<R: BufRead>(r: &mut R) -> IdeResult<Option<ServerMessage>> {
    let mut content_length: Option<usize> = None;
    loop {
        let mut line = String::new();
        let n = r.read_line(&mut line)?;
        if n == 0 {
            return Ok(None);
        }
        if line == "\r\n" || line == "\n" {
            break;
        }
        if let Some(rest) = line.strip_prefix("Content-Length:") {
            if let Ok(v) = rest.trim().parse::<usize>() {
                content_length = Some(v);
            }
        }
    }
    let len = content_length.ok_or_else(|| IdeError::Lsp("missing Content-Length".into()))?;
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf)?;
    let msg: ServerMessage = serde_json::from_slice(&buf)?;
    Ok(Some(msg))
}

/// Shared writer half of an [`LspClient`]. Cheap to clone, safe across threads.
#[derive(Clone)]
pub struct LspResponder {
    stdin: Arc<Mutex<ChildStdin>>,
}

impl LspResponder {
    pub fn notify(&self, method: &str, params: Value) -> IdeResult<()> {
        let msg = json!({ "jsonrpc": "2.0", "method": method, "params": params });
        write_message(&mut *self.stdin.lock(), &msg)
    }

    pub fn respond(&self, id: &Value, result: Value) -> IdeResult<()> {
        let msg = json!({ "jsonrpc": "2.0", "id": id, "result": result });
        write_message(&mut *self.stdin.lock(), &msg)
    }
}

pub fn path_to_uri(p: &Path) -> String {
    let abs: PathBuf = p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    let mut s = abs.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        if let Some(stripped) = s.strip_prefix("//?/") {
            s = stripped.to_string();
        }
        format!("file:///{s}")
    } else {
        format!("file://{s}")
    }
}

/// Inverse of [`path_to_uri`]. Returns a path in the host OS form so it
/// compares equal to paths obtained from the filesystem walker.
pub fn uri_to_path(uri: &str) -> PathBuf {
    let s = uri.strip_prefix("file://").unwrap_or(uri);
    // On Windows file:///C:/... → C:/...
    let s = if cfg!(windows) {
        s.strip_prefix('/').unwrap_or(s)
    } else {
        s
    };
    // Percent-decode the bare minimum (colons + spaces) so Windows drive
    // letters and common paths survive without pulling in a url crate.
    let decoded = s.replace("%3A", ":").replace("%3a", ":").replace("%20", " ");
    if cfg!(windows) {
        PathBuf::from(decoded.replace('/', "\\"))
    } else {
        PathBuf::from(decoded)
    }
}
