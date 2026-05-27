//! DAP client — minimal Debug Adapter Protocol over stdio, targeted at
//! `python -m debugpy.adapter`. Same framing as LSP (Content-Length header +
//! JSON body) but messages use seq numbers and a `type` discriminator.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
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
#[serde(tag = "type", rename_all = "lowercase")]
pub enum DapMessage {
    Request { seq: i64, command: String, #[serde(default)] arguments: Value },
    Response {
        seq: i64,
        request_seq: i64,
        success: bool,
        command: String,
        #[serde(default)] body: Value,
        #[serde(default)] message: Option<String>,
    },
    Event { seq: i64, event: String, #[serde(default)] body: Value },
}

pub struct DapClient {
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
    next_seq: AtomicI64,
    pending: Arc<Mutex<HashMap<i64, Sender<IdeResult<Value>>>>>,
    pub events: Receiver<DapMessage>,
}

impl DapClient {
    pub fn spawn(program: &str, args: &[&str]) -> IdeResult<Self> {
        let mut child = Command::new(program)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| IdeError::ToolNotFound(format!("{program}: {e}")))?;
        let stdin = child.stdin.take().ok_or_else(|| IdeError::Dap("no stdin".into()))?;
        let stdout = child.stdout.take().ok_or_else(|| IdeError::Dap("no stdout".into()))?;

        let pending: Arc<Mutex<HashMap<i64, Sender<IdeResult<Value>>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let (tx, rx) = unbounded::<DapMessage>();
        let pending_for_reader = pending.clone();
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                match read_message(&mut reader) {
                    Ok(Some(msg)) => {
                        if let DapMessage::Response { request_seq, success, body, message, .. } =
                            &msg
                        {
                            if let Some(sender) =
                                pending_for_reader.lock().remove(request_seq)
                            {
                                let payload = if *success {
                                    Ok(body.clone())
                                } else {
                                    Err(IdeError::Dap(message.clone().unwrap_or_default()))
                                };
                                let _ = sender.send(payload);
                                continue;
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
            next_seq: AtomicI64::new(1),
            pending,
            events: rx,
        })
    }

    pub fn request(&self, command: &str, arguments: Value) -> IdeResult<Receiver<IdeResult<Value>>> {
        let seq = self.next_seq.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = unbounded();
        self.pending.lock().insert(seq, tx);
        let msg = json!({
            "seq": seq,
            "type": "request",
            "command": command,
            "arguments": arguments,
        });
        write_message(&mut *self.stdin.lock(), &msg)?;
        Ok(rx)
    }

    pub fn request_sync(&self, command: &str, arguments: Value) -> IdeResult<Value> {
        let rx = self.request(command, arguments)?;
        rx.recv().map_err(|_| IdeError::Dap("response channel closed".into()))?
    }

    pub fn initialize(&self) -> IdeResult<Value> {
        self.request_sync(
            "initialize",
            json!({
                "clientID": "ide-core",
                "adapterID": "debugpy",
                "linesStartAt1": true,
                "columnsStartAt1": true,
                "pathFormat": "path",
            }),
        )
    }

    pub fn launch_python(&self, program: &str, args: Vec<String>, cwd: Option<String>) -> IdeResult<Value> {
        self.request_sync(
            "launch",
            json!({
                "name": "Launch",
                "type": "python",
                "request": "launch",
                "program": program,
                "args": args,
                "cwd": cwd,
                "console": "internalConsole",
            }),
        )
    }

    pub fn disconnect(&mut self) -> IdeResult<()> {
        let _ = self.request_sync("disconnect", json!({ "restart": false, "terminateDebuggee": true }));
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

fn read_message<R: BufRead>(r: &mut R) -> IdeResult<Option<DapMessage>> {
    let mut content_length: Option<usize> = None;
    loop {
        let mut line = String::new();
        let n = r.read_line(&mut line)?;
        if n == 0 { return Ok(None) }
        if line == "\r\n" || line == "\n" { break }
        if let Some(rest) = line.strip_prefix("Content-Length:") {
            if let Ok(v) = rest.trim().parse::<usize>() {
                content_length = Some(v);
            }
        }
    }
    let len = content_length.ok_or_else(|| IdeError::Dap("missing Content-Length".into()))?;
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf)?;
    let msg: DapMessage = serde_json::from_slice(&buf)?;
    Ok(Some(msg))
}
