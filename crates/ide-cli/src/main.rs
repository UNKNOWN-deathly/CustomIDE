//! ide-cli — a thin driver that exercises every ide-core subsystem from a
//! shell, so the engine can be developed and tested before the Tauri UI exists.
//!
//! Usage:
//!   ide-cli open <path>
//!   ide-cli info <path>
//!   ide-cli ls <path>
//!   ide-cli find <path> <pattern> [--literal] [--ignore-case]
//!   ide-cli run <path> -- <program> [args...]
//!   ide-cli pyrun <path> <script.py> [args...]
//!   ide-cli ruff <path> [files...]
//!   ide-cli pytest-collect <path>
//!   ide-cli pytest-run <path> [nodeids...]
//!   ide-cli watch <path>
//!   ide-cli term <path>             # opens a pty shell, raw stdin -> pty
//!   ide-cli commands                # list registered commands
//!   ide-cli call <command> [json]   # invoke a registered command

use std::env;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use serde_json::{Value, json};
use tracing_subscriber::EnvFilter;

use ide_core::commands::CommandRegistry;
use ide_core::events::{Event, EventBus};
use ide_core::fs_service::FsService;
use ide_core::process::{ProcessRunner, RunSpec};
use ide_core::pty::{PtyManager, PtySpec};
use ide_core::python_env;
use ide_core::pytest;
use ide_core::ruff;
use ide_core::search::{SearchQuery, search};
use ide_core::settings::SettingsStore;
use ide_core::workspace::Workspace;

fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .with_target(false)
        .init();

    let args: Vec<String> = env::args().skip(1).collect();
    if args.is_empty() {
        print_usage();
        return Ok(());
    }

    let bus = EventBus::new();
    let workspace = Workspace::new();
    let fs = FsService::new(bus.clone());
    let runner = ProcessRunner::new(bus.clone());
    let pty = PtyManager::new(bus.clone());
    let settings = SettingsStore::new(SettingsStore::default_user_path())?;
    let registry = build_registry(&workspace, &fs, &runner, &settings);

    let cmd = args[0].as_str();
    let rest = &args[1..];

    match cmd {
        "open" => cmd_open(&workspace, &fs, &settings, path_arg(rest, 0)?),
        "info" => cmd_info(&workspace, path_arg(rest, 0)?),
        "ls" => cmd_ls(&fs, path_arg(rest, 0)?),
        "find" => cmd_find(rest),
        "run" => cmd_run(&runner, &bus, rest),
        "pyrun" => cmd_pyrun(&runner, &bus, rest),
        "ruff" => cmd_ruff(rest),
        "pytest-collect" => cmd_pytest_collect(rest),
        "pytest-run" => cmd_pytest_run(&runner, &bus, rest),
        "watch" => cmd_watch(&fs, &bus, path_arg(rest, 0)?),
        "term" => cmd_term(&pty, &bus, path_arg(rest, 0)?),
        "commands" => {
            for n in registry.list() {
                println!("{n}");
            }
            Ok(())
        }
        "call" => cmd_call(&registry, rest),
        _ => {
            print_usage();
            Err(anyhow!("unknown subcommand: {cmd}"))
        }
    }
}

fn print_usage() {
    println!(
        "ide-cli <subcommand> [args]\n\
         \n\
         open <path>                          Open a workspace, print info\n\
         info <path>                          Detect-only (no global state)\n\
         ls <path>                            List directory (gitignore-aware)\n\
         find <root> <pattern> [--literal] [--ignore-case]\n\
         run <cwd> -- <program> [args...]     Spawn a process, stream output\n\
         pyrun <root> <script.py> [args...]   Run a Python script in detected env\n\
         ruff <root> [files...]               Run ruff check, JSON diagnostics\n\
         pytest-collect <root>                List pytest node ids\n\
         pytest-run <root> [nodeids...]       Run pytest, stream output\n\
         watch <path>                         Watch dir, print events for 30s\n\
         term <cwd>                           Open a pty shell (Ctrl-D to quit)\n\
         commands                             List registered command handlers\n\
         call <command> [json]                Invoke a registered command\n"
    );
}

fn path_arg(args: &[String], idx: usize) -> Result<PathBuf> {
    let s = args
        .get(idx)
        .ok_or_else(|| anyhow!("missing path argument"))?;
    Ok(PathBuf::from(s))
}

fn subscribe_print(bus: &EventBus) -> std::thread::JoinHandle<()> {
    let rx = bus.subscribe();
    std::thread::spawn(move || {
        while let Ok(evt) = rx.recv() {
            match evt {
                Event::ProcessOutput { stream, line, .. } => {
                    let prefix = match stream {
                        ide_core::events::OutputStream::Stdout => "out",
                        ide_core::events::OutputStream::Stderr => "err",
                    };
                    println!("[{prefix}] {line}");
                }
                Event::ProcessStarted { id, cmd } => {
                    eprintln!("[start {id}] {cmd}");
                }
                Event::ProcessExited { id, code } => {
                    eprintln!("[exit {id}] code={code:?}");
                    break;
                }
                other => eprintln!("[event] {other:?}"),
            }
        }
    })
}

fn cmd_open(
    workspace: &Workspace,
    fs: &FsService,
    settings: &SettingsStore,
    path: PathBuf,
) -> Result<()> {
    let info = workspace.open(&path).context("opening workspace")?;
    settings.bind_workspace(&info.root).ok();
    fs.watch(&info.root).ok();
    println!("{}", serde_json::to_string_pretty(&info)?);
    Ok(())
}

fn cmd_info(workspace: &Workspace, path: PathBuf) -> Result<()> {
    let info = workspace.open(&path).context("opening workspace")?;
    println!("{}", serde_json::to_string_pretty(&info)?);
    Ok(())
}

fn cmd_ls(fs: &FsService, path: PathBuf) -> Result<()> {
    let entries = fs.list_dir(&path)?;
    for e in entries {
        let marker = if e.is_dir { "DIR " } else { "FILE" };
        println!("{marker}  {}", e.path.display());
    }
    Ok(())
}

fn cmd_find(args: &[String]) -> Result<()> {
    if args.len() < 2 {
        bail!("usage: find <root> <pattern> [--literal] [--ignore-case]");
    }
    let root = PathBuf::from(&args[0]);
    let pattern = args[1].clone();
    let literal = args.iter().any(|a| a == "--literal");
    let case_insensitive = args.iter().any(|a| a == "--ignore-case");
    let q = SearchQuery {
        pattern,
        literal,
        case_insensitive,
        include_hidden: false,
        max_results: Some(500),
    };
    let hits = search(&root, &q)?;
    for h in hits {
        println!("{}:{}: {}", h.path.display(), h.line_number, h.line);
    }
    Ok(())
}

fn cmd_run(runner: &ProcessRunner, bus: &EventBus, args: &[String]) -> Result<()> {
    let sep = args
        .iter()
        .position(|a| a == "--")
        .ok_or_else(|| anyhow!("usage: run <cwd> -- <program> [args...]"))?;
    let cwd = PathBuf::from(args.first().ok_or_else(|| anyhow!("missing cwd"))?);
    let rest = &args[sep + 1..];
    let program = rest.first().ok_or_else(|| anyhow!("missing program"))?.clone();
    let prog_args = rest[1..].to_vec();
    let pump = subscribe_print(bus);
    runner.spawn(RunSpec {
        program,
        args: prog_args,
        cwd: Some(cwd),
        env: vec![],
    })?;
    pump.join().ok();
    Ok(())
}

fn cmd_pyrun(runner: &ProcessRunner, bus: &EventBus, args: &[String]) -> Result<()> {
    if args.len() < 2 {
        bail!("usage: pyrun <root> <script.py> [args...]");
    }
    let root = PathBuf::from(&args[0]);
    let script = args[1].clone();
    let script_args = args[2..].to_vec();
    let env = python_env::detect(&root)?;
    eprintln!("[python] {} ({:?})", env.interpreter.display(), env.source);
    let mut prog_args = vec![script];
    prog_args.extend(script_args);
    let pump = subscribe_print(bus);
    runner.spawn(RunSpec {
        program: env.interpreter.to_string_lossy().into_owned(),
        args: prog_args,
        cwd: Some(root),
        env: vec![],
    })?;
    pump.join().ok();
    Ok(())
}

fn cmd_ruff(args: &[String]) -> Result<()> {
    let root = PathBuf::from(args.first().ok_or_else(|| anyhow!("usage: ruff <root> [files...]"))?);
    let file_bufs: Vec<PathBuf> = args[1..].iter().map(PathBuf::from).collect();
    let file_refs: Vec<&Path> = file_bufs.iter().map(|p| p.as_path()).collect();
    let diags = ruff::check(&root, &file_refs)?;
    println!("{}", serde_json::to_string_pretty(&diags)?);
    Ok(())
}

fn cmd_pytest_collect(args: &[String]) -> Result<()> {
    let root = PathBuf::from(args.first().ok_or_else(|| anyhow!("usage: pytest-collect <root>"))?);
    let env = python_env::detect(&root)?;
    let items = pytest::collect(&env, &root)?;
    for item in items {
        println!("{}", item.nodeid);
    }
    Ok(())
}

fn cmd_pytest_run(runner: &ProcessRunner, bus: &EventBus, args: &[String]) -> Result<()> {
    let root = PathBuf::from(args.first().ok_or_else(|| anyhow!("usage: pytest-run <root> [nodeids...]"))?);
    let env = python_env::detect(&root)?;
    let nodeids: Vec<String> = args[1..].to_vec();
    let pump = subscribe_print(bus);
    pytest::run(runner, &env, &root, &nodeids)?;
    pump.join().ok();
    Ok(())
}

fn cmd_watch(fs: &FsService, bus: &EventBus, path: PathBuf) -> Result<()> {
    let rx = bus.subscribe();
    fs.watch(&path)?;
    eprintln!("watching {} for 30s...", path.display());
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    while std::time::Instant::now() < deadline {
        match rx.recv_timeout(Duration::from_millis(500)) {
            Ok(evt) => println!("{}", serde_json::to_string(&evt)?),
            Err(crossbeam_channel::RecvTimeoutError::Timeout) => continue,
            Err(_) => break,
        }
    }
    Ok(())
}

fn cmd_term(pty: &PtyManager, bus: &EventBus, cwd: PathBuf) -> Result<()> {
    let rx = bus.subscribe();
    let id = pty.open(PtySpec {
        program: None,
        args: vec![],
        cwd: Some(cwd),
        cols: 120,
        rows: 30,
        env: vec![],
    })?;
    eprintln!("pty {id} open. type 'exit' or Ctrl-D to quit.");
    let pty_writer = pty.clone();
    let id_for_writer = id.clone();
    let writer_thread = std::thread::spawn(move || {
        let stdin = std::io::stdin();
        let mut buf = [0u8; 1024];
        let mut handle = stdin.lock();
        loop {
            match handle.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if pty_writer.write(&id_for_writer, &buf[..n]).is_err() {
                        break;
                    }
                }
            }
        }
    });
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    while let Ok(evt) = rx.recv() {
        match evt {
            Event::ProcessOutput { line, id: ev_id, .. } if ev_id == id => {
                out.write_all(line.as_bytes()).ok();
                out.flush().ok();
            }
            Event::ProcessExited { id: ev_id, .. } if ev_id == id => break,
            _ => {}
        }
    }
    drop(writer_thread);
    Ok(())
}

fn cmd_call(registry: &CommandRegistry, args: &[String]) -> Result<()> {
    let name = args.first().ok_or_else(|| anyhow!("usage: call <command> [json]"))?;
    let payload: Value = if let Some(j) = args.get(1) {
        serde_json::from_str(j).context("parsing json args")?
    } else {
        Value::Null
    };
    let result = registry.invoke(name, payload)?;
    println!("{}", serde_json::to_string_pretty(&result)?);
    Ok(())
}

fn build_registry(
    workspace: &Workspace,
    fs: &FsService,
    runner: &ProcessRunner,
    settings: &SettingsStore,
) -> CommandRegistry {
    let registry = CommandRegistry::new();

    {
        let workspace = workspace.clone();
        registry.register("workspace.open", move |args: Value| {
            let path = args
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| ide_core::errors::IdeError::other("missing path"))?;
            let info = workspace.open(path)?;
            Ok(serde_json::to_value(info)?)
        });
    }
    {
        let workspace = workspace.clone();
        registry.register("workspace.info", move |_args: Value| {
            Ok(serde_json::to_value(workspace.current())?)
        });
    }
    {
        let fs = fs.clone();
        registry.register("fs.list", move |args: Value| {
            let path = args
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| ide_core::errors::IdeError::other("missing path"))?;
            Ok(serde_json::to_value(fs.list_dir(Path::new(path))?)?)
        });
    }
    {
        let fs = fs.clone();
        registry.register("fs.read", move |args: Value| {
            let path = args
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| ide_core::errors::IdeError::other("missing path"))?;
            Ok(json!({ "contents": fs.read(Path::new(path))? }))
        });
    }
    {
        let fs = fs.clone();
        registry.register("fs.write", move |args: Value| {
            let path = args
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| ide_core::errors::IdeError::other("missing path"))?;
            let contents = args
                .get("contents")
                .and_then(|v| v.as_str())
                .ok_or_else(|| ide_core::errors::IdeError::other("missing contents"))?;
            fs.write(Path::new(path), contents)?;
            Ok(json!({ "ok": true }))
        });
    }
    {
        let runner = runner.clone();
        registry.register("process.spawn", move |args: Value| {
            let spec: RunSpec = serde_json::from_value(args)?;
            Ok(json!({ "id": runner.spawn(spec)? }))
        });
    }
    {
        let runner = runner.clone();
        registry.register("process.kill", move |args: Value| {
            let id = args
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| ide_core::errors::IdeError::other("missing id"))?;
            Ok(json!({ "killed": runner.kill(id)? }))
        });
    }
    {
        let settings = settings.clone();
        registry.register("settings.get", move |args: Value| {
            let key = args
                .get("key")
                .and_then(|v| v.as_str())
                .ok_or_else(|| ide_core::errors::IdeError::other("missing key"))?;
            Ok(settings.get(key).unwrap_or(Value::Null))
        });
    }
    {
        let settings = settings.clone();
        registry.register("settings.set", move |args: Value| {
            let key = args
                .get("key")
                .and_then(|v| v.as_str())
                .ok_or_else(|| ide_core::errors::IdeError::other("missing key"))?;
            let value = args.get("value").cloned().unwrap_or(Value::Null);
            let scope = args.get("scope").and_then(|v| v.as_str()).unwrap_or("user");
            match scope {
                "workspace" => settings.set_workspace(key, value)?,
                _ => settings.set_user(key, value)?,
            }
            Ok(json!({ "ok": true }))
        });
    }

    let _ = Arc::new(()); // silence unused-import warnings on some toolchains
    registry
}
