// Wire the panels to ipc. No business logic — every action is a backend call,
// every notification is a backend event.

import { open as openDialog } from "@tauri-apps/plugin-dialog";

import { ipc, onCoreEvent, type CoreDiagnostic, type CoreEvent } from "./ipc";
import { mountEditor } from "./editor";
import { mountTabs } from "./tabs";
import { mountExplorer } from "./explorer";
import { mountTerminal } from "./terminal";
import { mountProblems, type ProblemEntry } from "./problems";

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

// Path normalisation — backend uses native OS paths; tab keys must match
// diagnostic event paths after a round trip through file:// URIs.
function normPath(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

async function bootstrap() {
  let activePtyId: string | null = null;
  let changeTimer: number | null = null;
  let terminalFocused = false;

  // path-key -> { path, items } so we always know how to clear / re-render.
  const diagnostics = new Map<string, { path: string; items: CoreDiagnostic[] }>();

  const editor = mountEditor($("editor"), () => {
    tabs.markDirty(true);
    scheduleDidChange();
  });
  const tabs = mountTabs($("tabs"));
  const explorer = mountExplorer($("panel-explorer"));
  const terminal = mountTerminal($("terminal"));
  const problems = mountProblems($("problems"));
  const editorHost = $("editor");
  const editorEmptyState = $("editor-empty-state");
  terminal.onFocusChange((focused) => {
    terminalFocused = focused;
  });

  function showEditor(active: boolean) {
    editorHost.classList.toggle("hidden", !active);
    editorEmptyState.classList.toggle("hidden", active);
  }

  function scheduleDidChange() {
    const tab = tabs.active();
    if (!tab) return;
    if (changeTimer) window.clearTimeout(changeTimer);
    changeTimer = window.setTimeout(() => {
      const cur = tabs.active();
      if (!cur) return;
      ipc.docDidChange(cur.path, editor.getDoc()).catch(() => {});
    }, 250);
  }

  function pushDiagsToEditor(forPath: string) {
    const key = normPath(forPath);
    const entry = diagnostics.get(key);
    editor.setDiagnostics(entry?.items ?? []);
  }

  function refreshProblems() {
    const flat: ProblemEntry[] = [];
    for (const { path, items } of diagnostics.values()) {
      for (const d of items) flat.push({ path, diagnostic: d });
    }
    // Stable sort: by file, then line.
    flat.sort((a, b) => {
      const p = a.path.localeCompare(b.path);
      if (p !== 0) return p;
      return a.diagnostic.range.start.line - b.diagnostic.range.start.line;
    });
    problems.setEntries(flat);
  }

  tabs.onActiveChange((tab) => {
    if (tab) {
      showEditor(true);
      editor.setDoc(tab.content, tab.path);
      editor.view.requestMeasure();
      // Re-apply any known diagnostics for this file (avoid stale set from previous tab).
      pushDiagsToEditor(tab.path);
      editor.focus();
    } else {
      showEditor(false);
      editor.setDoc("", "");
      editor.setDiagnostics([]);
    }
  });

  // tabs.open -> after fsRead, also notify Pyright.
  const baseOpen = tabs.open.bind(tabs);
  tabs.open = async (path: string) => {
    const isNew = !tabs.all().some((t) => t.path === path);
    await baseOpen(path);
    if (isNew && /\.pyi?$/i.test(path)) {
      const cur = tabs.active();
      if (cur && cur.path === path) {
        ipc.docDidOpen(path, cur.content).catch(() => {});
      }
    }
  };

  // tabs.close -> notify Pyright + drop local diagnostics for that path.
  const baseClose = tabs.close.bind(tabs);
  tabs.close = (path: string) => {
    if (/\.pyi?$/i.test(path)) ipc.docDidClose(path).catch(() => {});
    diagnostics.delete(normPath(path));
    refreshProblems();
    baseClose(path);
  };

  // tabs.saveActive -> notify Pyright with new text.
  const baseSave = tabs.saveActive.bind(tabs);
  tabs.saveActive = async (text: string) => {
    const active = tabs.active();
    await baseSave(text);
    if (active && /\.pyi?$/i.test(active.path)) {
      ipc.docDidSave(active.path, text).catch(() => {});
    }
  };

  explorer.onOpenFile((path) => tabs.open(path));

  problems.onJump(async (path, line, col) => {
    await tabs.open(path);
    editor.jumpTo(line, col);
    showBottom("terminal", false); // hide problems so the editor jump is visible
  });

  // Top bar wiring
  $("btn-open-folder").onclick = async () => {
    const picked = await openDialog({ directory: true, multiple: false });
    if (!picked || Array.isArray(picked)) return;
    // Clear any prior diagnostic state up-front; backend will also fire
    // empty-list events as Pyright restarts but this avoids any flash.
    diagnostics.clear();
    editor.setDiagnostics([]);
    refreshProblems();

    const info = await ipc.workspaceOpen(picked);
    $("workspace-label").textContent = `${info.name} — ${info.python?.interpreter ?? "no python"}`;
    await explorer.setRoot(info.root);
    terminal.log(
      `Workspace opened: ${info.root}` +
        (info.python ? ` (python: ${info.python.version ?? "?"})` : "")
    );
  };

  $("btn-save").onclick = async () => {
    const active = tabs.active();
    if (!active) return;
    await tabs.saveActive(editor.getDoc());
  };

  // Push current size to PTY whenever the terminal resizes.
  terminal.onResize((cols, rows) => {
    if (!activePtyId) return;
    ipc.ptyResize(activePtyId, cols, rows).catch(() => {});
  });

  $("btn-shell").onclick = async () => {
    if (activePtyId) {
      ipc.ptyClose(activePtyId).catch(() => {});
      activePtyId = null;
      terminal.detachSession();
    }
    showBottom("terminal");
    terminal.fit();
    try {
      const dims = terminal.dimensions();
      const { id } = await ipc.ptyOpen(dims);
      activePtyId = id;
      terminal.attachSession(id);
    } catch (e) {
      terminal.log(`shell failed: ${String(e)}`);
    }
  };

  $("btn-run").onclick = async () => {
    const active = tabs.active();
    if (!active) {
      terminal.log("No file open.");
      return;
    }
    if (active.dirty) await tabs.saveActive(editor.getDoc());
    if (activePtyId) {
      ipc.ptyClose(activePtyId).catch(() => {});
      activePtyId = null;
      terminal.detachSession();
    }
    showBottom("terminal");
    terminal.fit();
    try {
      const dims = terminal.dimensions();
      const { id } = await ipc.pythonRun(active.path, [], dims);
      activePtyId = id;
      terminal.attachSession(id);
    } catch (e) {
      terminal.log(`run failed: ${String(e)}`);
    }
  };

  $("btn-ruff").onclick = async () => {
    try {
      const ruffDiags = await ipc.ruffCheck([]);
      // Translate ruff's shape into the unified ProblemEntry list, layered
      // under any pyright diagnostics already in the store. We keep this
      // ephemeral (not stored in `diagnostics`) so pyright continues owning
      // the editor squiggles.
      const ruffEntries: ProblemEntry[] = ruffDiags.map((d) => ({
        path: d.filename,
        diagnostic: {
          severity: "warning",
          message: d.message,
          code: d.code,
          source: "ruff",
          range: {
            start: { line: Math.max(0, d.location.row - 1), character: Math.max(0, d.location.column - 1) },
            end: { line: Math.max(0, d.end_location.row - 1), character: Math.max(0, d.end_location.column - 1) },
          },
        },
      }));
      const live: ProblemEntry[] = [];
      for (const { path, items } of diagnostics.values()) {
        for (const d of items) live.push({ path, diagnostic: d });
      }
      problems.setEntries([...live, ...ruffEntries]);
      showBottom("problems");
    } catch (e) {
      terminal.log(`ruff failed: ${String(e)}`);
      showBottom("terminal");
    }
  };

  // Activity rail
  document.querySelectorAll<HTMLElement>(".rail-btn").forEach((btn) => {
    btn.onclick = () => {
      document.querySelectorAll(".rail-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const mode = btn.dataset.mode!;
      document
        .querySelectorAll<HTMLElement>(".sidebar-view")
        .forEach((v) => v.classList.add("hidden"));
      $(`panel-${mode}`).classList.remove("hidden");
    };
  });

  // Bottom tabs
  document.querySelectorAll<HTMLElement>(".bottom-tab").forEach((btn) => {
    btn.onclick = () => showBottom(btn.dataset.mode as "terminal" | "problems");
  });

  // Backend events
  await onCoreEvent((evt) => routeEvent(evt));

  function routeEvent(evt: CoreEvent) {
    terminal.applyEvent(evt);
    explorer.applyEvent(evt);

    if (evt.kind === "process_exited" && evt.id === activePtyId) {
      activePtyId = null;
    }

    if (evt.kind === "diagnostics" && evt.source === "pyright") {
      const key = normPath(evt.path);
      if (evt.items.length === 0) {
        diagnostics.delete(key);
      } else {
        diagnostics.set(key, { path: evt.path, items: evt.items });
      }
      // If this is the file currently shown, repaint the editor.
      const tab = tabs.active();
      if (tab && normPath(tab.path) === key) {
        editor.setDiagnostics(evt.items);
      }
      refreshProblems();
    }

    if (evt.kind === "workspace_closed") {
      diagnostics.clear();
      editor.setDiagnostics([]);
      refreshProblems();
    }

    if (evt.kind === "log") {
      const prefix = evt.level === "error" ? "ERR" : evt.level === "warn" ? "WARN" : "INFO";
      terminal.log(`[${prefix}] ${evt.message}`);
    }
  }

  function showBottom(mode: "terminal" | "problems", focus = true) {
    document
      .querySelectorAll<HTMLElement>(".bottom-tab")
      .forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
    document
      .querySelectorAll<HTMLElement>(".bottom-view")
      .forEach((v) => v.classList.add("hidden"));
    $(mode).classList.remove("hidden");
    if (focus) {
      $(mode).scrollTop = $(mode).scrollHeight;
      if (mode === "terminal") {
        terminal.fit();
        terminal.focus();
      }
    }
  }

  // Keyboard: Ctrl/Cmd+S = save
  window.addEventListener("keydown", (e) => {
    if (terminalFocused || terminal.isFocused()) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "s") {
      e.preventDefault();
      $("btn-save").click();
    }
  });

  function initResizing() {
    const body = $("body");
    const app = $("app");
    const sidebarResizer = $("sidebar-resizer");
    const bottomResizer = $("bottom-resizer");

    const savedSidebarWidth = localStorage.getItem("customide.sidebarWidth");
    let sidebarWidth = savedSidebarWidth ? parseInt(savedSidebarWidth, 10) : 260;
    sidebarWidth = Math.max(150, Math.min(sidebarWidth, 600));

    const savedBottomHeight = localStorage.getItem("customide.bottomHeight");
    let bottomHeight = savedBottomHeight ? parseInt(savedBottomHeight, 10) : 220;
    bottomHeight = Math.max(80, Math.min(bottomHeight, window.innerHeight - 150));

    body.style.gridTemplateColumns = `${sidebarWidth}px 1px 1fr`;
    app.style.gridTemplateRows = `36px 1fr 1px ${bottomHeight}px`;

    sidebarResizer.onmousedown = (e) => {
      e.preventDefault();
      document.body.classList.add("resizing");
      const startX = e.clientX;
      const startWidth = sidebarWidth;

      const onMouseMove = (moveEvent: MouseEvent) => {
        const deltaX = moveEvent.clientX - startX;
        let newWidth = startWidth + deltaX;
        newWidth = Math.max(150, Math.min(newWidth, 600));
        sidebarWidth = newWidth;
        body.style.gridTemplateColumns = `${newWidth}px 1px 1fr`;
      };

      const onMouseUp = () => {
        document.body.classList.remove("resizing");
        localStorage.setItem("customide.sidebarWidth", sidebarWidth.toString());
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        terminal.fit();
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    };

    bottomResizer.onmousedown = (e) => {
      e.preventDefault();
      document.body.classList.add("resizing");
      const startY = e.clientY;
      const startHeight = bottomHeight;

      const onMouseMove = (moveEvent: MouseEvent) => {
        const deltaY = moveEvent.clientY - startY;
        let newHeight = startHeight - deltaY;
        newHeight = Math.max(80, Math.min(newHeight, window.innerHeight - 150));
        bottomHeight = newHeight;
        app.style.gridTemplateRows = `36px 1fr 1px ${newHeight}px`;
        terminal.fit();
      };

      const onMouseUp = () => {
        document.body.classList.remove("resizing");
        localStorage.setItem("customide.bottomHeight", bottomHeight.toString());
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        terminal.fit();
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    };

    window.addEventListener("resize", () => {
      const maxBottomHeight = window.innerHeight - 150;
      if (bottomHeight > maxBottomHeight) {
        bottomHeight = Math.max(80, maxBottomHeight);
        app.style.gridTemplateRows = `36px 1fr 1px ${bottomHeight}px`;
      }
      terminal.fit();
    });
  }

  initResizing();
  refreshProblems(); // render empty placeholder
}

bootstrap().catch((err) => {
  console.error(err);
  document.body.textContent = `Bootstrap failed: ${err}`;
});
