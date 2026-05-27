//! Process runner — spawn child processes, stream stdout/stderr to the event
//! bus line-by-line, track them by id, kill on request.

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::thread;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::errors::IdeResult;
use crate::events::{Event, EventBus, OutputStream};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunSpec {
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub cwd: Option<PathBuf>,
    #[serde(default)]
    pub env: Vec<(String, String)>,
}

pub struct RunningProcess {
    pub id: String,
    pub child: Child,
}

#[derive(Clone)]
pub struct ProcessRunner {
    bus: EventBus,
    procs: Arc<Mutex<HashMap<String, Arc<Mutex<Child>>>>>,
}

impl ProcessRunner {
    pub fn new(bus: EventBus) -> Self {
        Self { bus, procs: Arc::new(Mutex::new(HashMap::new())) }
    }

    pub fn spawn(&self, spec: RunSpec) -> IdeResult<String> {
        let id = Uuid::new_v4().to_string();
        let mut cmd = Command::new(&spec.program);
        cmd.args(&spec.args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::null());
        if let Some(dir) = &spec.cwd {
            cmd.current_dir(dir);
        }
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }
        let mut child = cmd.spawn()?;
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        let display = format!(
            "{} {}",
            spec.program,
            spec.args.join(" ")
        );
        self.bus.publish(Event::ProcessStarted { id: id.clone(), cmd: display });

        if let Some(out) = stdout {
            spawn_pump(self.bus.clone(), id.clone(), OutputStream::Stdout, out);
        }
        if let Some(err) = stderr {
            spawn_pump(self.bus.clone(), id.clone(), OutputStream::Stderr, err);
        }

        let child = Arc::new(Mutex::new(child));
        self.procs.lock().insert(id.clone(), child.clone());

        // Reaper thread.
        let bus = self.bus.clone();
        let procs = self.procs.clone();
        let id_for_reaper = id.clone();
        thread::spawn(move || {
            let status = child.lock().wait();
            let code = match status {
                Ok(s) => s.code(),
                Err(_) => None,
            };
            procs.lock().remove(&id_for_reaper);
            bus.publish(Event::ProcessExited { id: id_for_reaper, code });
        });

        Ok(id)
    }

    pub fn kill(&self, id: &str) -> IdeResult<bool> {
        let Some(child) = self.procs.lock().get(id).cloned() else {
            return Ok(false);
        };
        child.lock().kill()?;
        Ok(true)
    }

    pub fn list(&self) -> Vec<String> {
        self.procs.lock().keys().cloned().collect()
    }
}

fn spawn_pump<R: std::io::Read + Send + 'static>(
    bus: EventBus,
    id: String,
    stream: OutputStream,
    reader: R,
) {
    thread::spawn(move || {
        let reader = BufReader::new(reader);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            bus.publish(Event::ProcessOutput { id: id.clone(), stream, line });
        }
    });
}
