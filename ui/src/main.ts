// Wire the panels to ipc. No business logic — every action is a backend call,
// every notification is a backend event.

import { open as openDialog } from "@tauri-apps/plugin-dialog";

import { ipc, onCoreEvent, type CoreDiagnostic, type CoreEvent, type RecentProject, type WorkspaceInfo } from "./ipc";
import { mountEditor } from "./editor";
import { mountTabs } from "./tabs";
import { mountExplorer } from "./explorer";
import { mountTerminal } from "./terminal";
import { mountProblems, type ProblemEntry } from "./problems";
import {
  chooseRunTarget,
  rememberRunTarget,
  suppressRunPrompt,
  type RunTargetSuggestion,
} from "./runTarget";

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

// Path normalisation — backend uses native OS paths; tab keys must match
// diagnostic event paths after a round trip through file:// URIs.
function normPath(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

function debugRecentProjects(message: string, details?: Record<string, unknown>) {
  const payload = details ?? {};
  if (localStorage.getItem("customide.debug.recentProjects") === "1") {
    console.debug(`[recent-projects] ${message}`, payload);
  }
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
  const runButton = $("btn-run");
  const runTargetPopover = $("run-target-popover");
  const runTargetSuggestion = $("run-target-suggestion");
  const runTargetCurrent = $("run-target-current");
  const runTargetSuppress = $("run-target-suppress");
  terminal.onFocusChange((focused) => {
    terminalFocused = focused;
  });

  let currentWorkspace: WorkspaceInfo | null = null;
  let recentProjects: RecentProject[] = [];

  function getLocalRecentProjects(): RecentProject[] {
    try {
      const raw = localStorage.getItem("customide.recentProjects");
      if (!raw) return [];
      const list = JSON.parse(raw);
      if (Array.isArray(list)) {
        return list.filter((p: any) => p && typeof p.path === "string" && typeof p.name === "string");
      }
    } catch (e) {
      console.error("Error reading recent projects", e);
    }
    return [];
  }

  async function loadRecentProjects() {
    try {
      recentProjects = trimRecentProjects(await ipc.recentProjectsGet());
      debugRecentProjects("loaded from backend", {
        count: recentProjects.length,
        paths: recentProjects.map((project) => project.path),
      });
      if (recentProjects.length === 0) {
        const local = getLocalRecentProjects();
        debugRecentProjects("backend empty; checked localStorage fallback", {
          count: local.length,
          paths: local.map((project) => project.path),
        });
        if (local.length > 0) {
          recentProjects = trimRecentProjects(local);
          await persistRecentProjects();
        }
      }
    } catch (e) {
      console.error("Error loading recent projects", e);
      recentProjects = trimRecentProjects(getLocalRecentProjects());
    }
  }

  async function persistRecentProjects() {
    localStorage.setItem("customide.recentProjects", JSON.stringify(recentProjects));
    try {
      await ipc.recentProjectsSet(recentProjects);
      debugRecentProjects("persisted", {
        count: recentProjects.length,
        paths: recentProjects.map((project) => project.path),
      });
    } catch (e) {
      console.error("Error saving recent projects", e);
    }
  }

  async function addToRecentProjects(path: string, name: string) {
    recentProjects = recentProjects.filter(p => normPath(p.path) !== normPath(path));
    recentProjects.unshift({
      name: name,
      path: path,
      lastOpened: Date.now()
    });
    recentProjects = trimRecentProjects(recentProjects);
    await persistRecentProjects();
  }

  function trimRecentProjects(projects: RecentProject[]) {
    return projects.slice(0, 4);
  }

  function pathBelongsToWorkspace(path: string, workspaceRoot: string) {
    const root = normPath(workspaceRoot).replace(/\/+$/, "");
    const file = normPath(path);
    return file === root || file.startsWith(`${root}/`);
  }

  function workspaceTabPaths(workspaceRoot: string) {
    return tabs
      .all()
      .map((tab) => tab.path)
      .filter((path) => pathBelongsToWorkspace(path, workspaceRoot));
  }

  async function persistWorkspaceTabState() {
    if (!currentWorkspace) return;
    const openFiles = workspaceTabPaths(currentWorkspace.root);
    await ipc.workspaceOpenFilesSet(currentWorkspace.root, openFiles);

    const active = tabs.active();
    if (active && pathBelongsToWorkspace(active.path, currentWorkspace.root)) {
      await ipc.workspaceLastActiveFileSet(currentWorkspace.root, active.path);
    }
  }

  async function removeRecentProject(path: string) {
    recentProjects = recentProjects.filter(p => normPath(p.path) !== normPath(path));
    await persistRecentProjects();
  }

  async function openWorkspace(path: string, restoreLastActiveFile = false) {
    diagnostics.clear();
    editor.setDiagnostics([]);
    refreshProblems();

    try {
      const info = await ipc.workspaceOpen(path);
      currentWorkspace = info;
      $("workspace-label").textContent = `${info.name} — ${info.python?.interpreter ?? "no python"}`;
      await explorer.setRoot(info.root);
      terminal.log(
        `Workspace opened: ${info.root}` +
          (info.python ? ` (python: ${info.python.version ?? "?"})` : "")
      );
      await addToRecentProjects(info.root, info.name);
      if (restoreLastActiveFile) {
        await restoreWorkspaceTabs(info.root);
      }
      renderEmptyState();
    } catch (e) {
      terminal.log(`Failed to open workspace: ${String(e)}`);
    }
  }

  async function restoreWorkspaceTabs(workspaceRoot: string) {
    try {
      const [openFiles, activeFile] = await Promise.all([
        ipc.workspaceOpenFilesGet(workspaceRoot),
        ipc.workspaceLastActiveFileGet(workspaceRoot),
      ]);
      const orderedFiles = dedupePaths([
        ...openFiles.filter((path) => !activeFile || normPath(path) !== normPath(activeFile)),
        ...(activeFile ? [activeFile] : []),
      ]);
      for (const path of orderedFiles) {
        try {
          await tabs.open(path);
        } catch (e) {
          terminal.log(`Could not restore tab ${path}: ${String(e)}`);
        }
      }
    } catch (e) {
      terminal.log(`Could not restore workspace tabs: ${String(e)}`);
    }
  }

  function dedupePaths(paths: string[]) {
    const seen = new Set<string>();
    const deduped: string[] = [];
    for (const path of paths) {
      const key = normPath(path);
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(path);
    }
    return deduped;
  }

  function renderEmptyState() {
    const listContainer = $("recent-projects-list");
    const recentSection = $("recent-projects-section");
    const shortcutsSection = document.querySelector<HTMLElement>(".empty-state-shortcuts");
    
    if (!listContainer || !recentSection || !shortcutsSection) {
      debugRecentProjects("render empty state skipped: missing DOM", {
        hasListContainer: Boolean(listContainer),
        hasRecentSection: Boolean(recentSection),
        hasShortcutsSection: Boolean(shortcutsSection),
      });
      return;
    }

    const recents = recentProjects;
    const shouldShowRecents = !currentWorkspace && recents.length > 0;
    debugRecentProjects("render empty state", {
      currentWorkspace: currentWorkspace?.root ?? null,
      count: recents.length,
      showRecents: shouldShowRecents,
    });
    
    if (shouldShowRecents) {
      recentSection.classList.remove("hidden");
      shortcutsSection.classList.add("hidden");
      
      listContainer.innerHTML = "";
      recents.forEach((proj) => {
        const row = document.createElement("div");
        row.className = "recent-project-row";
        row.title = proj.path;
        
        const infoDiv = document.createElement("div");
        infoDiv.className = "recent-project-info";
        
        const nameSpan = document.createElement("span");
        nameSpan.className = "recent-project-name";
        nameSpan.textContent = proj.name;
        
        const pathSpan = document.createElement("span");
        pathSpan.className = "recent-project-path";
        pathSpan.textContent = proj.path;
        
        infoDiv.appendChild(nameSpan);
        infoDiv.appendChild(pathSpan);
        row.appendChild(infoDiv);
        
        const removeBtn = document.createElement("button");
        removeBtn.className = "recent-project-remove";
        removeBtn.title = "Remove from recent projects";
        removeBtn.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        `;
        
        removeBtn.onclick = (e) => {
          e.stopPropagation();
          removeRecentProject(proj.path).then(() => renderEmptyState());
        };
        
        row.appendChild(removeBtn);
        
        row.onclick = () => {
          openWorkspace(proj.path, true);
        };
        
        listContainer.appendChild(row);
      });
    } else {
      recentSection.classList.add("hidden");
      shortcutsSection.classList.remove("hidden");
    }
    debugRecentProjects("render empty state applied", {
      recentSectionHidden: recentSection.classList.contains("hidden"),
      shortcutsHidden: shortcutsSection.classList.contains("hidden"),
      listChildren: listContainer.children.length,
      editorEmptyStateHidden: editorEmptyState.classList.contains("hidden"),
      editorHostHidden: editorHost.classList.contains("hidden"),
      activeTab: tabs.active()?.path ?? null,
      currentWorkspace: currentWorkspace?.root ?? null,
      recentCount: recents.length,
    });
  }

  function showEditor(active: boolean) {
    editorHost.classList.toggle("hidden", !active);
    editorEmptyState.classList.toggle("hidden", active);
    if (!active) {
      renderEmptyState();
    }
  }

  function hideRunTargetPopover() {
    runTargetPopover.classList.add("hidden");
    runTargetSuggestion.replaceChildren();
    runTargetCurrent.onclick = null;
    runTargetSuppress.onclick = null;
  }

  function showRunTargetPopover(activePath: string, suggestion: RunTargetSuggestion) {
    runTargetSuggestion.replaceChildren();
    const label = document.createElement("span");
    label.className = "run-target-path";
    label.textContent = suggestion.label;
    const reason = document.createElement("span");
    reason.className = "run-target-reason";
    reason.textContent = suggestion.reason;
    runTargetSuggestion.appendChild(label);
    runTargetSuggestion.appendChild(reason);

    runTargetSuggestion.onclick = async () => {
      hideRunTargetPopover();
      try {
        await tabs.open(suggestion.path);
        await runFile(suggestion.path);
      } catch (e) {
        terminal.log(`run failed: ${String(e)}`);
      }
    };
    runTargetCurrent.onclick = () => {
      hideRunTargetPopover();
      runFile(activePath);
    };
    runTargetSuppress.onclick = () => {
      suppressRunPrompt(activePath);
      hideRunTargetPopover();
      runFile(activePath);
    };

    const rect = runButton.getBoundingClientRect();
    runTargetPopover.style.top = `${rect.bottom + 6}px`;
    runTargetPopover.style.left = `${Math.max(8, rect.right - 280)}px`;
    runTargetPopover.classList.remove("hidden");
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
      if (currentWorkspace) {
        persistWorkspaceTabState().catch(() => {});
      }
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
    persistWorkspaceTabState().catch(() => {});
  };

  // tabs.close -> notify Pyright + drop local diagnostics for that path.
  const baseClose = tabs.close.bind(tabs);
  tabs.close = (path: string) => {
    if (/\.pyi?$/i.test(path)) ipc.docDidClose(path).catch(() => {});
    diagnostics.delete(normPath(path));
    refreshProblems();
    baseClose(path);
    persistWorkspaceTabState().catch(() => {});
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
    await openWorkspace(picked);
  };

  const btnEmptyOpenFolder = $("btn-empty-open-folder");
  if (btnEmptyOpenFolder) {
    btnEmptyOpenFolder.onclick = async () => {
      const picked = await openDialog({ directory: true, multiple: false });
      if (!picked || Array.isArray(picked)) return;
      await openWorkspace(picked);
    };
  }

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

  async function runFile(path: string) {
    const active = tabs.active();
    if (active && normPath(active.path) === normPath(path) && active.dirty) {
      await tabs.saveActive(editor.getDoc());
    }
    if (activePtyId) {
      ipc.ptyClose(activePtyId).catch(() => {});
      activePtyId = null;
      terminal.detachSession();
    }
    showBottom("terminal");
    terminal.fit();
    try {
      const dims = terminal.dimensions();
      const { id } = await ipc.pythonRun(path, [], dims);
      activePtyId = id;
      terminal.attachSession(id);
      rememberRunTarget(currentWorkspace, path);
    } catch (e) {
      terminal.log(`run failed: ${String(e)}`);
    }
  }

  runButton.onclick = async () => {
    hideRunTargetPopover();
    const active = tabs.active();
    if (!active) {
      terminal.log("No file open.");
      return;
    }

    const decision = await chooseRunTarget(active, editor.getDoc(), currentWorkspace);
    if (decision.shouldPrompt && decision.suggestion) {
      showRunTargetPopover(active.path, decision.suggestion);
      return;
    }

    await runFile(active.path);
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
  debugRecentProjects("before core event listener registration");
  await onCoreEvent((evt) => routeEvent(evt));
  debugRecentProjects("after core event listener registration");

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
      currentWorkspace = null;
      diagnostics.clear();
      editor.setDiagnostics([]);
      refreshProblems();
      renderEmptyState();
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
    if (e.key === "Escape") {
      hideRunTargetPopover();
    }
    if (terminalFocused || terminal.isFocused()) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "s") {
      e.preventDefault();
      $("btn-save").click();
    }
  });

  document.addEventListener("mousedown", (e) => {
    const target = e.target as Node;
    if (runTargetPopover.classList.contains("hidden")) return;
    if (runTargetPopover.contains(target) || runButton.contains(target)) return;
    hideRunTargetPopover();
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
  await loadRecentProjects();
  renderEmptyState();

  // Check if a workspace is already open on startup
  ipc.workspaceInfo().then((info) => {
    debugRecentProjects("startup workspaceInfo resolved", {
      workspace: info?.root ?? null,
      recentCount: recentProjects.length,
    });
    if (info) {
      currentWorkspace = info;
      $("workspace-label").textContent = `${info.name} — ${info.python?.interpreter ?? "no python"}`;
      explorer.setRoot(info.root).catch(() => {});
      debugRecentProjects("startup workspace found; recording recent project", {
        path: info.root,
      });
      addToRecentProjects(info.root, info.name).catch(() => {});
    }
    renderEmptyState();
  }).catch((e) => {
    console.error("Failed to query initial workspace", e);
    renderEmptyState();
  });
}

bootstrap().catch((err) => {
  console.error(err);
  document.body.textContent = `Bootstrap failed: ${err}`;
});
