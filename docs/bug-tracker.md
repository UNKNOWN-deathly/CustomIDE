# CustomIDE - Bug Tracker

> Auto-maintained by Codex. Do not manually reorder entries.
> Statuses: `Open` | `Investigating` | `Needs confirmation` | `Fixed (unverified)` | `Resolved (verified)` | `Won't fix`

---

## Open Issues

- [ ] **BUG-2: Shell launcher reports `cmd_pty_open` not found** - `High`
  - **File**: `crates/ide-shell/src/main.rs` (line 68-75), `ui/src/ipc.ts` (line 86-89)
  - **Issue**: Pressing Shell invokes `cmd_pty_open`, but the running Tauri backend reports that the command is not registered.
  - **Probable cause**: The frontend bundle was updated, but the running `ide-shell.exe` was stale and did not contain the newly registered command.
  - **Fix**: Rebuild the actual Tauri desktop binary with `cargo build -p ide-shell` and restart the app so the backend command table includes `cmd_pty_open`.
  - **Evidence**: `rg -a "cmd_pty_open" target/debug/ide-shell.exe` failed before rebuilding and succeeded afterward.
  - **Status**: Fixed (unverified)

- [ ] **BUG-3: Workspace open shows phantom empty editor buffer** - `Medium`
  - **File**: `ui/src/main.ts` (line 63-75), `ui/index.html` (line 39-45), `ui/src/styles.css` (line 118-145)
  - **Issue**: Opening a workspace with no selected file shows CodeMirror's empty initial document, which looks like an unsaved unnamed file even though no real tab exists.
  - **Probable cause**: The editor is mounted immediately with an empty document and remains visible when `tabs.active()` is null.
  - **Fix**: Show a center empty state while no tab is active, hide/inactivate the editor host, and only reveal/remeasure CodeMirror after a real explorer file opens a real tab.
  - **Evidence**: Startup code mounts `mountEditor($("editor"), ...)` before any tab is opened; tab state remains empty until `tabs.open(path)`.
  - **Status**: Fixed (unverified)

## Needs Confirmation

## Resolved Issues

- [x] **BUG-1: Terminal printable input does not reach active PTY** - `High`
  - **File**: `ui/src/terminal.ts` (line 60-84), `ui/src/ipc.ts` (line 91-99), `crates/ide-shell/src/main.rs` (line 254), `crates/ide-core/src/pty.rs` (line 129)
  - **Issue**: The terminal textarea receives focus, but typing letters in the shell/REPL does not appear, so the failure is in the runtime input path after DOM focus.
  - **Probable cause**: Keyboard input may be suppressed by the xterm custom key handler, dropped because no active session id is attached, blocked at `cmd_pty_write`, or lost in the PTY writer path.
  - **Fix**: Instrument `onData`, frontend `ptyWrite`, `cmd_pty_write`, and `PtyManager::write`; bypass the custom key handler by default until normal printable input is verified.
  - **Evidence**: User confirmed interactive PTY input now works correctly when running Python files.
  - **Status**: Resolved (verified)
  - **Resolution**: Runtime PTY input path is functioning for Python-file PTY sessions; remaining Shell failure is separate command registration/runtime binary issue tracked as BUG-2.

## Won't Fix / Intended Behavior
