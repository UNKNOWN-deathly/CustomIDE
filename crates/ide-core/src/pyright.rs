//! Pyright lifecycle + diagnostics.
//!
//! The IDE owns the LSP process; the frontend only forwards document events.
//! Server-initiated requests we know how to answer (workspace/configuration,
//! client/registerCapability, workspace/workspaceFolders) are handled inside
//! the reader thread so Pyright never blocks waiting on us.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;

use parking_lot::Mutex;
use serde_json::{Value, json};

use crate::errors::{IdeError, IdeResult};
use crate::events::{
    Diagnostic, DiagnosticSeverity, Event, EventBus, LogLevel, Position, Range,
};
use crate::lsp::{LspClient, LspResponder, ServerMessage, path_to_uri, uri_to_path};
use crate::python_env::PythonEnv;

pub struct PyrightManager {
    bus: EventBus,
    inner: Arc<Mutex<Option<Session>>>,
}

struct Session {
    client: LspClient,
    root: PathBuf,
    versions: HashMap<PathBuf, i32>,
    open_docs: HashSet<PathBuf>,
    reader_alive: Arc<AtomicBool>,
    /// Files we have published non-empty diagnostics for; remembered so we can
    /// clear them on workspace shutdown.
    diagnostic_files: Arc<Mutex<HashSet<PathBuf>>>,
}

impl PyrightManager {
    pub fn new(bus: EventBus) -> Self {
        Self { bus, inner: Arc::new(Mutex::new(None)) }
    }

    /// True if a session is currently running.
    pub fn is_running(&self) -> bool {
        self.inner.lock().is_some()
    }

    pub fn start(&self, root: &Path, env: &PythonEnv) -> IdeResult<()> {
        self.stop();

        let pyright = find_pyright(root)?;
        let client = LspClient::spawn(
            &pyright.to_string_lossy(),
            &["--stdio"],
            Some(root),
        )?;

        let init_params = build_init_params(root, env);
        client.request_sync("initialize", init_params)?;
        client.notify("initialized", json!({}))?;
        // Some servers respect this for picking the interpreter.
        client.notify(
            "workspace/didChangeConfiguration",
            json!({ "settings": build_settings(env) }),
        )?;

        let reader_alive = Arc::new(AtomicBool::new(true));
        let diagnostic_files = Arc::new(Mutex::new(HashSet::new()));
        spawn_reader(
            client.incoming.clone(),
            client.responder(),
            self.bus.clone(),
            reader_alive.clone(),
            diagnostic_files.clone(),
            root.to_path_buf(),
            env.clone(),
        );

        *self.inner.lock() = Some(Session {
            client,
            root: root.to_path_buf(),
            versions: HashMap::new(),
            open_docs: HashSet::new(),
            reader_alive,
            diagnostic_files,
        });
        Ok(())
    }

    pub fn stop(&self) {
        let Some(session) = self.inner.lock().take() else { return };
        session.reader_alive.store(false, Ordering::Relaxed);
        // Clear any outstanding diagnostics we had pushed.
        let files: Vec<PathBuf> = session.diagnostic_files.lock().drain().collect();
        for path in files {
            self.bus.publish(Event::Diagnostics {
                path,
                source: "pyright".into(),
                items: vec![],
            });
        }
        let _ = session.client.notify("shutdown", Value::Null);
        let _ = session.client.notify("exit", Value::Null);
        // LspClient drops here -> stdin closes -> server exits.
        drop(session.client);
        let _ = session.root;
    }

    pub fn did_open(&self, path: &Path, text: &str) -> IdeResult<()> {
        let mut guard = self.inner.lock();
        let Some(s) = guard.as_mut() else { return Ok(()) };
        if s.open_docs.contains(path) {
            return Ok(());
        }
        s.versions.insert(path.to_path_buf(), 1);
        s.open_docs.insert(path.to_path_buf());
        s.client.notify(
            "textDocument/didOpen",
            json!({
                "textDocument": {
                    "uri": path_to_uri(path),
                    "languageId": "python",
                    "version": 1,
                    "text": text,
                }
            }),
        )
    }

    pub fn did_change(&self, path: &Path, text: &str) -> IdeResult<()> {
        let mut guard = self.inner.lock();
        let Some(s) = guard.as_mut() else { return Ok(()) };
        // If we never opened the doc (Pyright started after the file was
        // opened in the UI), do it now with the current full text.
        if !s.open_docs.contains(path) {
            s.versions.insert(path.to_path_buf(), 1);
            s.open_docs.insert(path.to_path_buf());
            return s.client.notify(
                "textDocument/didOpen",
                json!({
                    "textDocument": {
                        "uri": path_to_uri(path),
                        "languageId": "python",
                        "version": 1,
                        "text": text,
                    }
                }),
            );
        }
        let v = s.versions.entry(path.to_path_buf()).or_insert(1);
        *v += 1;
        let version = *v;
        s.client.notify(
            "textDocument/didChange",
            json!({
                "textDocument": {
                    "uri": path_to_uri(path),
                    "version": version,
                },
                "contentChanges": [{ "text": text }]
            }),
        )
    }

    pub fn did_save(&self, path: &Path, text: Option<&str>) -> IdeResult<()> {
        let mut guard = self.inner.lock();
        let Some(s) = guard.as_mut() else { return Ok(()) };
        if !s.open_docs.contains(path) {
            return Ok(());
        }
        let mut params = json!({
            "textDocument": { "uri": path_to_uri(path) }
        });
        if let Some(t) = text {
            params["text"] = json!(t);
        }
        s.client.notify("textDocument/didSave", params)
    }

    pub fn did_close(&self, path: &Path) -> IdeResult<()> {
        let mut guard = self.inner.lock();
        let Some(s) = guard.as_mut() else { return Ok(()) };
        if !s.open_docs.remove(path) {
            return Ok(());
        }
        s.versions.remove(path);
        s.client.notify(
            "textDocument/didClose",
            json!({ "textDocument": { "uri": path_to_uri(path) } }),
        )?;
        // Eagerly clear any diagnostics we'd published for this file.
        if s.diagnostic_files.lock().remove(path) {
            self.bus.publish(Event::Diagnostics {
                path: path.to_path_buf(),
                source: "pyright".into(),
                items: vec![],
            });
        }
        Ok(())
    }
}

fn spawn_reader(
    rx: crossbeam_channel::Receiver<ServerMessage>,
    responder: LspResponder,
    bus: EventBus,
    alive: Arc<AtomicBool>,
    diagnostic_files: Arc<Mutex<HashSet<PathBuf>>>,
    root: PathBuf,
    env: PythonEnv,
) {
    thread::spawn(move || {
        while alive.load(Ordering::Relaxed) {
            let Ok(msg) = rx.recv() else { break };
            match msg {
                ServerMessage::Notification { method, params, .. } => {
                    if method == "textDocument/publishDiagnostics" {
                        if let Some((path, items)) = parse_publish(&params) {
                            let had_any = !items.is_empty();
                            let mut files = diagnostic_files.lock();
                            if had_any {
                                files.insert(path.clone());
                            } else {
                                files.remove(&path);
                            }
                            drop(files);
                            bus.publish(Event::Diagnostics {
                                path,
                                source: "pyright".into(),
                                items,
                            });
                        }
                    }
                    // Other notifications (logMessage, telemetry, etc.) are
                    // ignored for this phase.
                }
                ServerMessage::Request { id, method, params, .. } => {
                    handle_server_request(&responder, &root, &env, &id, &method, &params);
                }
                ServerMessage::Response { .. } => {
                    // Responses to our requests are routed by LspClient itself.
                }
            }
        }
        bus.publish(Event::Log {
            level: LogLevel::Info,
            message: "pyright session ended".into(),
        });
    });
}

fn handle_server_request(
    responder: &LspResponder,
    root: &Path,
    env: &PythonEnv,
    id: &Value,
    method: &str,
    params: &Value,
) {
    let result = match method {
        // Acknowledge dynamic capability registrations.
        "client/registerCapability" | "client/unregisterCapability" => Value::Null,
        "workspace/workspaceFolders" => json!([{
            "uri": path_to_uri(root),
            "name": root.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
        }]),
        "workspace/configuration" => {
            // Reply with one config object per requested item.
            let items = params.get("items").and_then(|v| v.as_array());
            let count = items.map(|a| a.len()).unwrap_or(1);
            let cfg = build_settings(env);
            Value::Array((0..count).map(|_| cfg.clone()).collect())
        }
        _ => {
            // Unknown server request — answer empty result so it doesn't hang.
            Value::Null
        }
    };
    let _ = responder.respond(id, result);
}

fn parse_publish(params: &Value) -> Option<(PathBuf, Vec<Diagnostic>)> {
    let uri = params.get("uri")?.as_str()?;
    let path = uri_to_path(uri);
    let diags_val = params.get("diagnostics")?.as_array()?;
    let items = diags_val.iter().filter_map(parse_diag).collect();
    Some((path, items))
}

fn parse_diag(v: &Value) -> Option<Diagnostic> {
    let message = v.get("message")?.as_str()?.to_string();
    let severity = match v.get("severity").and_then(Value::as_u64).unwrap_or(1) {
        1 => DiagnosticSeverity::Error,
        2 => DiagnosticSeverity::Warning,
        3 => DiagnosticSeverity::Info,
        _ => DiagnosticSeverity::Hint,
    };
    let code = v
        .get("code")
        .and_then(|c| c.as_str().map(String::from).or_else(|| c.as_i64().map(|n| n.to_string())));
    let source = v.get("source").and_then(|c| c.as_str()).map(String::from);
    let range_v = v.get("range")?;
    let start = range_v.get("start")?;
    let end = range_v.get("end")?;
    Some(Diagnostic {
        severity,
        message,
        code,
        source,
        range: Range {
            start: Position {
                line: start.get("line")?.as_u64()? as u32,
                character: start.get("character")?.as_u64()? as u32,
            },
            end: Position {
                line: end.get("line")?.as_u64()? as u32,
                character: end.get("character")?.as_u64()? as u32,
            },
        },
    })
}

fn build_init_params(root: &Path, _env: &PythonEnv) -> Value {
    let uri = path_to_uri(root);
    json!({
        "processId": std::process::id(),
        "rootUri": uri,
        "capabilities": {
            "workspace": {
                "configuration": true,
                "workspaceFolders": true,
                "didChangeConfiguration": { "dynamicRegistration": false }
            },
            "textDocument": {
                "synchronization": { "didSave": true, "willSave": false, "willSaveWaitUntil": false },
                "publishDiagnostics": { "relatedInformation": false, "versionSupport": false }
            }
        },
        "initializationOptions": {},
        "workspaceFolders": [{ "uri": uri, "name": root.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default() }]
    })
}

fn build_settings(env: &PythonEnv) -> Value {
    let interp = env.interpreter.to_string_lossy().into_owned();
    let venv_path = env
        .venv_root
        .as_ref()
        .map(|p| p.parent().unwrap_or(p).to_string_lossy().into_owned());
    json!({
        "python": {
            "pythonPath": interp,
            "venvPath": venv_path,
            "analysis": {
                "autoSearchPaths": true,
                "useLibraryCodeForTypes": true,
                "diagnosticMode": "openFilesOnly"
            }
        }
    })
}

pub fn find_pyright(project_root: &Path) -> IdeResult<PathBuf> {
    let candidates: Vec<PathBuf> = if cfg!(windows) {
        vec![
            project_root.join(".venv").join("Scripts").join("pyright-langserver.exe"),
            project_root.join(".venv").join("Scripts").join("pyright-langserver.cmd"),
            project_root.join("venv").join("Scripts").join("pyright-langserver.exe"),
            project_root.join("venv").join("Scripts").join("pyright-langserver.cmd"),
        ]
    } else {
        vec![
            project_root.join(".venv").join("bin").join("pyright-langserver"),
            project_root.join("venv").join("bin").join("pyright-langserver"),
        ]
    };
    for c in candidates {
        if c.is_file() {
            return Ok(c);
        }
    }
    which::which("pyright-langserver")
        .map_err(|_| IdeError::ToolNotFound("pyright-langserver".into()))
}
