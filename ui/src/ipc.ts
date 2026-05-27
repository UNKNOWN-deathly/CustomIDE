// Thin IPC layer: every backend call goes through here. No business logic.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface WorkspaceInfo {
  root: string;
  name: string;
  has_pyproject: boolean;
  has_requirements_txt: boolean;
  has_local_venv: boolean;
  has_uv_lock: boolean;
  has_pytest_config: boolean;
  python: PythonEnv | null;
  project_name: string | null;
}

export interface PythonEnv {
  interpreter: string;
  version: string | null;
  source: "local_venv" | "uv" | "system" | "override";
  venv_root: string | null;
}

export interface DirEntry {
  path: string;
  name: string;
  is_dir: boolean;
}

export interface RuffDiagnostic {
  filename: string;
  code: string | null;
  message: string;
  location: { row: number; column: number };
  end_location: { row: number; column: number };
}

export type DiagSeverity = "error" | "warning" | "info" | "hint";

export interface CoreDiagnostic {
  severity: DiagSeverity;
  message: string;
  code: string | null;
  source: string | null;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

export type CoreEvent =
  | { kind: "workspace_opened"; root: string }
  | { kind: "workspace_closed" }
  | { kind: "file_created"; path: string }
  | { kind: "file_modified"; path: string }
  | { kind: "file_removed"; path: string }
  | { kind: "file_renamed"; from: string; to: string }
  | { kind: "process_started"; id: string; cmd: string }
  | { kind: "process_output"; id: string; stream: "stdout" | "stderr"; line: string }
  | { kind: "process_exited"; id: string; code: number | null }
  | {
      kind: "diagnostics";
      path: string;
      source: string;
      items: CoreDiagnostic[];
    }
  | { kind: "log"; level: "debug" | "info" | "warn" | "error"; message: string };

export const ipc = {
  workspaceOpen: (path: string) =>
    invoke<WorkspaceInfo>("cmd_workspace_open", { path }),
  workspaceInfo: () =>
    invoke<WorkspaceInfo | null>("cmd_workspace_info"),
  fsList: (path: string) => invoke<DirEntry[]>("cmd_fs_list", { path }),
  fsRead: (path: string) => invoke<string>("cmd_fs_read", { path }),
  fsWrite: (path: string, contents: string) =>
    invoke<void>("cmd_fs_write", { path, contents }),
  pythonRun: (
    file: string,
    args: string[] = [],
    dims?: { cols: number; rows: number }
  ) =>
    invoke<{ id: string; interpreter: string }>("cmd_python_run", {
      payload: { file, args, cols: dims?.cols, rows: dims?.rows },
    }),
  processKill: (id: string) => invoke<boolean>("cmd_process_kill", { id }),
  ptyWrite: (id: string, data: string) =>
    invoke<void>("cmd_pty_write", { id, data }),
  ptyResize: (id: string, cols: number, rows: number) =>
    invoke<void>("cmd_pty_resize", { id, cols, rows }),
  ptyClose: (id: string) => invoke<boolean>("cmd_pty_close", { id }),
  ruffCheck: (files: string[] = []) =>
    invoke<RuffDiagnostic[]>("cmd_ruff_check", { payload: { files } }),
  docDidOpen: (path: string, text: string) =>
    invoke<void>("cmd_doc_did_open", { path, text }),
  docDidChange: (path: string, text: string) =>
    invoke<void>("cmd_doc_did_change", { path, text }),
  docDidSave: (path: string, text?: string) =>
    invoke<void>("cmd_doc_did_save", { path, text }),
  docDidClose: (path: string) =>
    invoke<void>("cmd_doc_did_close", { path }),
};

export async function onCoreEvent(
  handler: (evt: CoreEvent) => void
): Promise<UnlistenFn> {
  return listen<CoreEvent>("core://event", (msg) => handler(msg.payload));
}
