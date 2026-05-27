// Wire the panels to ipc. No business logic — every action is a backend call,
// every notification is a backend event.

import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { ipc, onCoreEvent, type CoreDiagnostic, type CoreEvent, type RecentProject, type WorkspaceInfo } from "./ipc";
import { mountEditor } from "./editor";
import { mountTabs, isTemporaryPath, type Tab } from "./tabs";
import { mountExplorer, type ScratchEntry, type ScratchFile, type ScratchFolder } from "./explorer";
import { confirmSave, promptName, type SaveDecision } from "./modal";
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

interface TempWorkspace {
  id: number;
  name: string;
  rootPath: string;
  children: ScratchEntry[];
}

async function bootstrap() {
  let activePtyId: string | null = null;
  let changeTimer: number | null = null;
  let terminalFocused = false;

  // path-key -> { path, items } so we always know how to clear / re-render.
  const diagnostics = new Map<string, { path: string; items: CoreDiagnostic[] }>();

  const editor = mountEditor($("editor"), () => {
    tabs.updateActiveContent(editor.getDoc());
    syncActiveScratchFile();
    tabs.markDirty(true);
    scheduleDidChange();
  });
  const tabs = mountTabs($("tabs"));
  const explorer = mountExplorer($("explorer-tree"));
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

  // ── IDE-wide zoom ────────────────────────────────────────────────────────
  const ZOOM_MIN  = 0.8;
  const ZOOM_MAX  = 1.5;
  const ZOOM_STEP = 0.1;
  const ZOOM_KEY  = "customide.zoom";

  let zoomLevel: number = (() => {
    const v = parseFloat(localStorage.getItem(ZOOM_KEY) ?? "1");
    return Number.isFinite(v) ? Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, v)) : 1;
  })();

  function applyZoom(z: number): void {
    zoomLevel = Math.round(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z)) * 100) / 100;
    // Scale the whole IDE via CSS zoom on the root element.
    document.documentElement.style.zoom = String(zoomLevel);
    // Compensate #app's height so it still fills exactly one viewport after zoom.
    const appEl = document.getElementById("app")!;
    appEl.style.height = zoomLevel !== 1 ? `${(100 / zoomLevel).toFixed(4)}vh` : "";
    // Counter-zoom the xterm host so xterm renders at native pixel density.
    // terminal.setZoom() then scales the font size to match the visual zoom level.
    const termEl = document.getElementById("terminal");
    if (termEl) termEl.style.zoom = zoomLevel !== 1 ? String(1 / zoomLevel) : "";
    terminal.setZoom(zoomLevel);
    localStorage.setItem(ZOOM_KEY, zoomLevel.toFixed(2));
  }

  // Apply persisted zoom synchronously — happens before first paint, no flicker.
  applyZoom(zoomLevel);

  let currentWorkspace: WorkspaceInfo | null = null;
  let recentProjects: RecentProject[] = [];
  let scratchWorkspace: TempWorkspace | null = null;
  let scratchWorkspaceCounter = 0;

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

  function joinPath(parent: string, name: string) {
    const sep = parent.includes("\\") && !parent.includes("/") ? "\\" : "/";
    return `${parent.replace(/[\\/]+$/, "")}${sep}${name}`;
  }

  function scratchWorkspaceRoot(): ScratchFolder | null {
    if (!scratchWorkspace) return null;
    return {
      kind: "folder",
      name: scratchWorkspace.name,
      path: scratchWorkspace.rootPath,
      children: scratchWorkspace.children,
    };
  }

  function scratchChildExists(parent: ScratchFolder, name: string) {
    const key = name.toLowerCase();
    return parent.children.some((child) => child.name.toLowerCase() === key);
  }

  function findScratchFile(path: string): ScratchFile | null {
    if (!scratchWorkspace) return null;
    const stack = [...scratchWorkspace.children];
    while (stack.length > 0) {
      const entry = stack.shift()!;
      if (entry.kind === "file" && normPath(entry.path) === normPath(path)) {
        return entry;
      }
      if (entry.kind === "folder") {
        stack.push(...entry.children);
      }
    }
    return null;
  }

  function openScratchFile(path: string) {
    const file = findScratchFile(path);
    if (!file) return;
    tabs.openVirtualFile(file.path, file.name, file.content);
  }

  function syncActiveScratchFile() {
    const active = tabs.active();
    if (!active || !isTemporaryPath(active.path)) return;
    tabs.updateActiveContent(editor.getDoc());
    const file = findScratchFile(active.path);
    if (file) {
      file.content = editor.getDoc();
    }
  }

  function syncScratchTabs() {
    syncActiveScratchFile();
    if (!scratchWorkspace) return;
    for (const tab of tabs.all()) {
      const file = findScratchFile(tab.path);
      if (file) {
        file.content = tab.content;
      }
    }
  }

  function scratchRelativePath(path: string) {
    if (!scratchWorkspace) return path;
    return path
      .slice(scratchWorkspace.rootPath.length)
      .replace(/^[\\/]+/, "");
  }

  async function writeScratchEntry(destRoot: string, entry: ScratchEntry) {
    const dest = joinPath(destRoot, scratchRelativePath(entry.path));
    if (entry.kind === "folder") {
      await ipc.fsCreateDir(dest);
      for (const child of entry.children) {
        await writeScratchEntry(destRoot, child);
      }
      return;
    }
    await ipc.fsWrite(dest, entry.content);
  }

  async function saveScratchWorkspace(): Promise<boolean> {
    if (!scratchWorkspace) return false;
    syncScratchTabs();
    const scratch = scratchWorkspace;
    const active = tabs.active();
    const activeScratchFile = active ? findScratchFile(active.path) : null;
    const activeRelativePath = activeScratchFile ? scratchRelativePath(activeScratchFile.path) : null;

    const picked = await openDialog({
      title: "Save Scratch Workspace",
      directory: true,
      multiple: false,
    });
    if (!picked || Array.isArray(picked)) return false;

    const destRoot = joinPath(picked, scratch.name);
    try {
      await ipc.fsCreateDir(destRoot);
      for (const child of scratch.children) {
        await writeScratchEntry(destRoot, child);
      }
      scratchWorkspace = null;
      const opened = await openWorkspace(destRoot, false, true);
      if (opened && activeRelativePath) {
        await tabs.open(joinPath(destRoot, activeRelativePath));
      }
      return opened;
    } catch (e) {
      terminal.log(`save scratch workspace failed: ${String(e)}`);
      return false;
    }
  }

  function hasUnsavedWork() {
    return tabs.hasUnsavedChanges() || scratchWorkspace !== null;
  }

  function workspaceTabPaths(workspaceRoot: string) {
    return tabs
      .all()
      .map((tab) => tab.path)
      .filter((path) => !isTemporaryPath(path) && pathBelongsToWorkspace(path, workspaceRoot));
  }

  async function persistWorkspaceTabState() {
    if (!currentWorkspace) return;
    const openFiles = workspaceTabPaths(currentWorkspace.root);
    await ipc.workspaceOpenFilesSet(currentWorkspace.root, openFiles);

    const active = tabs.active();
    if (
      active &&
      !isTemporaryPath(active.path) &&
      pathBelongsToWorkspace(active.path, currentWorkspace.root)
    ) {
      await ipc.workspaceLastActiveFileSet(currentWorkspace.root, active.path);
    }
  }

  async function removeRecentProject(path: string) {
    recentProjects = recentProjects.filter(p => normPath(p.path) !== normPath(path));
    await persistRecentProjects();
  }

  function updateWorkspaceUi(info: WorkspaceInfo | null) {
    const workspaceLabel = $("workspace-label");
    const pythonSpan = $("statusbar-python-text");
    if (scratchWorkspace) {
      if (workspaceLabel) {
        workspaceLabel.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
          </svg>
          <span>${scratchWorkspace.name} (unsaved)</span>
        `;
      }
      if (pythonSpan) {
        pythonSpan.textContent = "Scratch workspace";
      }
    } else if (info) {
      if (workspaceLabel) {
        workspaceLabel.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
          </svg>
          <span>${info.name}</span>
        `;
      }
      if (pythonSpan) {
        pythonSpan.textContent = info.python ? `${info.python.interpreter} (${info.python.version ?? "?"})` : "No python";
      }
    } else {
      if (workspaceLabel) {
        workspaceLabel.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
            <line x1="8" y1="21" x2="16" y2="21"></line>
            <line x1="12" y1="17" x2="12" y2="21"></line>
          </svg>
          No workspace
        `;
      }
      if (pythonSpan) {
        pythonSpan.textContent = "No python";
      }
    }
  }

  async function openWorkspace(path: string, restoreLastActiveFile = false, skipUnsavedConfirm = false): Promise<boolean> {
    if (!skipUnsavedConfirm && !(await confirmDiscardAllUnsaved("Switching workspace will close all open files."))) {
      return false;
    }
    // Drop any leftover tabs (untitled or dirty) before swapping workspace.
    for (const tab of tabs.all()) {
      tabs.close(tab.path);
    }
    diagnostics.clear();
    editor.setDiagnostics([]);
    refreshProblems();

    try {
      const info = await ipc.workspaceOpen(path);
      scratchWorkspace = null;
      explorer.clearScratchRoot();
      currentWorkspace = info;
      updateWorkspaceUi(info);
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
      return true;
    } catch (e) {
      terminal.log(`Failed to open workspace: ${String(e)}`);
      return false;
    }
  }

  async function createFileFromEmptyState() {
    const name = await promptName({
      title: "New File",
      label: "File name",
      initialValue: "untitled.py",
    });
    if (!name) return;

    if (scratchWorkspace) {
      const root = scratchWorkspaceRoot();
      if (!root || scratchChildExists(root, name)) {
        terminal.log(`new file failed: ${name} already exists`);
        return;
      }
      const file: ScratchFile = {
        kind: "file",
        name,
        path: joinPath(scratchWorkspace.rootPath, name),
        content: "",
      };
      scratchWorkspace.children.unshift(file);
      explorer.setScratchRoot(scratchWorkspace.name, scratchWorkspace.rootPath, scratchWorkspace.children);
      openScratchFile(file.path);
      return;
    }

    tabs.openTemporaryFile(name);
  }

  async function createFolderFromEmptyState() {
    const name = await promptName({
      title: "New Folder",
      label: "Folder name",
      initialValue: "New Folder",
    });
    if (!name) return;

    if (!(await confirmDiscardAllUnsaved("Starting a scratch workspace will close current open files."))) {
      return;
    }
    for (const tab of tabs.all()) {
      tabs.close(tab.path);
    }
    currentWorkspace = null;
    diagnostics.clear();
    editor.setDiagnostics([]);
    refreshProblems();

    scratchWorkspaceCounter += 1;
    scratchWorkspace = {
      id: scratchWorkspaceCounter,
      name,
      rootPath: `scratch:${scratchWorkspaceCounter}`,
      children: [],
    };
    explorer.setScratchRoot(scratchWorkspace.name, scratchWorkspace.rootPath, scratchWorkspace.children);
    updateWorkspaceUi(null);
    showEditor(false);
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
    const shouldShowRecents = !currentWorkspace && !scratchWorkspace && recents.length > 0;
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
    if (isTemporaryPath(tab.path)) return;
    if (changeTimer) window.clearTimeout(changeTimer);
    changeTimer = window.setTimeout(() => {
      const cur = tabs.active();
      if (!cur || isTemporaryPath(cur.path)) return;
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
    let errorsCount = 0;
    let warningsCount = 0;
    for (const { path, items } of diagnostics.values()) {
      for (const d of items) {
        flat.push({ path, diagnostic: d });
        if (d.severity === "error") {
          errorsCount++;
        } else if (d.severity === "warning") {
          warningsCount++;
        }
      }
    }
    // Stable sort: by file, then line.
    flat.sort((a, b) => {
      const p = a.path.localeCompare(b.path);
      if (p !== 0) return p;
      return a.diagnostic.range.start.line - b.diagnostic.range.start.line;
    });
    problems.setEntries(flat);
    
    // Update statusbar diagnostic counters!
    const errCountSpan = $("statusbar-error-count");
    const warnCountSpan = $("statusbar-warning-count");
    if (errCountSpan) errCountSpan.textContent = errorsCount.toString();
    if (warnCountSpan) warnCountSpan.textContent = warningsCount.toString();
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
    if (isNew && !isTemporaryPath(path) && /\.pyi?$/i.test(path)) {
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
    if (!isTemporaryPath(path) && /\.pyi?$/i.test(path)) {
      ipc.docDidClose(path).catch(() => {});
    }
    diagnostics.delete(normPath(path));
    refreshProblems();
    baseClose(path);
    persistWorkspaceTabState().catch(() => {});
  };

  // Confirming close wraps the wrapped close, so the modal sits in front of
  // the pyright/persistence side-effects.
  async function closeTabWithConfirm(path: string): Promise<boolean> {
    const tab = tabs.all().find((t) => t.path === path);
    if (!tab) return true;
    if (!tab.dirty) {
      tabs.close(path);
      return true;
    }
    const decision = await confirmSave({
      title: `Save changes to ${tab.name}?`,
      message: "Your changes will be lost if you don't save them.",
    });
    if (decision === "cancel") return false;
    if (decision === "discard") {
      tabs.close(path);
      return true;
    }
    // "save" — if active, use editor text; otherwise persist last-known content.
    const wasActive = tabs.active()?.path === path;
    const wasScratch = Boolean(scratchWorkspace && findScratchFile(path));
    if (!wasActive) tabs.setActive(path);
    const saved = await saveActiveWithDialog();
    if (!saved) return false;
    if (tabs.all().some((t) => t.path === path)) {
      tabs.close(path);
    } else if (!wasScratch) {
      const current = tabs.active();
      if (current) tabs.close(current.path);
    }
    return true;
  }

  // tabs.saveActive -> notify Pyright with new text.
  const baseSave = tabs.saveActive.bind(tabs);
  tabs.saveActive = async (text: string) => {
    const active = tabs.active();
    await baseSave(text);
    if (active && !isTemporaryPath(active.path) && /\.pyi?$/i.test(active.path)) {
      ipc.docDidSave(active.path, text).catch(() => {});
    }
  };

  // Save current tab. Routes untitled tabs through the save() dialog; converts
  // them into real on-disk files on success. Returns true if persisted.
  async function saveActiveWithDialog(): Promise<boolean> {
    const active = tabs.active();
    if (!active && scratchWorkspace) {
      return saveScratchWorkspace();
    }
    if (!active) return false;
    if (scratchWorkspace && findScratchFile(active.path)) {
      return saveScratchWorkspace();
    }
    if (!isTemporaryPath(active.path)) {
      await tabs.saveActive(editor.getDoc());
      return true;
    }
    const defaultPath = currentWorkspace
      ? joinPath(currentWorkspace.root, active.name)
      : active.name;
    const picked = await saveDialog({
      defaultPath,
      filters: [
        { name: "Python", extensions: ["py", "pyi"] },
        { name: "All Files", extensions: ["*"] },
      ],
    });
    if (!picked) return false;
    const contents = editor.getDoc();
    try {
      await tabs.relocate(active.path, picked, contents);
    } catch (e) {
      terminal.log(`save failed: ${String(e)}`);
      return false;
    }
    if (/\.pyi?$/i.test(picked)) {
      ipc.docDidOpen(picked, contents).catch(() => {});
    }
    persistWorkspaceTabState().catch(() => {});
    return true;
  }

  // Walks every dirty tab, prompting once per tab. Returns false if user
  // cancels at any step. Used by workspace switch and window close.
  async function confirmDiscardAllUnsaved(reason: string): Promise<boolean> {
    if (!hasUnsavedWork()) return true;
    if (scratchWorkspace) {
      const decision = await confirmSave({
        title: `Save ${scratchWorkspace.name}?`,
        message: `${reason} Your scratch workspace exists only in memory until it is saved.`,
      });
      return resolveBulkDecision(decision, tabs.all().filter((t) => t.dirty));
    }
    const dirty: Tab[] = tabs.all().filter((t) => t.dirty);
    if (dirty.length === 1) {
      const t = dirty[0];
      const decision = await confirmSave({
        title: `Save changes to ${t.name}?`,
        message: `${reason} Your changes will be lost if you don't save them.`,
      });
      return resolveBulkDecision(decision, [t]);
    }
    const decision = await confirmSave({
      title: `Save changes to ${dirty.length} files?`,
      message: `${reason} Unsaved files:\n${dirty.map((t) => "  • " + t.name).join("\n")}`,
    });
    return resolveBulkDecision(decision, dirty);
  }

  async function resolveBulkDecision(decision: SaveDecision, dirty: Tab[]): Promise<boolean> {
    if (decision === "cancel") return false;
    if (decision === "discard") return true;
    if (scratchWorkspace) {
      return saveScratchWorkspace();
    }
    // Save each. For untitled tabs the save dialog opens; cancel aborts.
    for (const t of dirty) {
      tabs.setActive(t.path);
      const ok = await saveActiveWithDialog();
      if (!ok) return false;
    }
    return true;
  }

  explorer.onOpenFile((path) => {
    if (isTemporaryPath(path)) {
      openScratchFile(path);
      return;
    }
    tabs.open(path);
  });
  explorer.onFileCreated((path) => {
    if (isTemporaryPath(path)) {
      openScratchFile(path);
      return;
    }
    tabs.open(path).catch((e) => terminal.log(`open failed: ${String(e)}`));
  });

  tabs.onCloseRequest((path) => {
    closeTabWithConfirm(path).catch(() => {});
  });

  const btnNewFile = document.getElementById("btn-new-file");
  if (btnNewFile) {
    btnNewFile.onclick = () => {
      if (!currentWorkspace && !scratchWorkspace) return;
      explorer.beginCreate("file").catch(() => {});
    };
  }
  const btnNewFolder = document.getElementById("btn-new-folder");
  if (btnNewFolder) {
    btnNewFolder.onclick = () => {
      if (!currentWorkspace && !scratchWorkspace) return;
      explorer.beginCreate("folder").catch(() => {});
    };
  }

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

  const btnEmptyNewFile = $("btn-empty-new-file");
  if (btnEmptyNewFile) {
    btnEmptyNewFile.onclick = () => {
      createFileFromEmptyState().catch((e) => terminal.log(`new file failed: ${String(e)}`));
    };
  }

  const btnEmptyNewFolder = $("btn-empty-new-folder");
  if (btnEmptyNewFolder) {
    btnEmptyNewFolder.onclick = () => {
      createFolderFromEmptyState().catch((e) => terminal.log(`new folder failed: ${String(e)}`));
    };
  }

  $("btn-save").onclick = async () => {
    await saveActiveWithDialog();
  };

  const btnClearTerminal = $("btn-clear-terminal");
  if (btnClearTerminal) {
    btnClearTerminal.onclick = () => {
      terminal.clear();
    };
  }

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
    if (isTemporaryPath(path)) {
      const saved = await saveActiveWithDialog();
      if (!saved) return;
      const savedActive = tabs.active();
      if (!savedActive || isTemporaryPath(savedActive.path)) return;
      path = savedActive.path;
    }
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
      scratchWorkspace = null;
      explorer.clearScratchRoot();
      diagnostics.clear();
      editor.setDiagnostics([]);
      refreshProblems();
      renderEmptyState();
      updateWorkspaceUi(null);
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

  // Keyboard: Ctrl/Cmd+S = save, Ctrl/Cmd+N = new untitled file
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
    if (mod && e.key.toLowerCase() === "n") {
      e.preventDefault();
      createFileFromEmptyState().catch((err) => terminal.log(`new file failed: ${String(err)}`));
    }
    if (mod && e.key.toLowerCase() === "w") {
      const active = tabs.active();
      if (active) {
        e.preventDefault();
        closeTabWithConfirm(active.path).catch(() => {});
      }
    }
  });

  // Zoom shortcuts — capture phase fires before xterm's own keydown listeners,
  // so Ctrl+Plus/Minus/0 are intercepted even when the terminal has focus.
  // stopPropagation() prevents the keys from reaching xterm and the PTY.
  window.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key;
    const zoomIn  = k === "+" || k === "="; // "=" = unshifted Plus key
    const zoomOut = k === "-";
    const reset   = k === "0";
    if (!zoomIn && !zoomOut && !reset) return;
    e.preventDefault();
    e.stopPropagation();
    if (zoomIn)       applyZoom(zoomLevel + ZOOM_STEP);
    else if (zoomOut) applyZoom(zoomLevel - ZOOM_STEP);
    else              applyZoom(1.0);
  }, /* capture */ true);

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
    app.style.gridTemplateRows = `35px 1fr 1px ${bottomHeight}px 22px`;

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
        app.style.gridTemplateRows = `35px 1fr 1px ${newHeight}px 22px`;
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
        app.style.gridTemplateRows = `35px 1fr 1px ${bottomHeight}px 22px`;
      }
      terminal.fit();
    });
  }

  initResizing();
  refreshProblems(); // render empty placeholder
  await loadRecentProjects();
  renderEmptyState();

  // Block the window from closing if there are unsaved changes.
  // IMPORTANT: event.preventDefault() must be called synchronously before
  // any awaits — Tauri 2 checks it on the same tick, not after the promise
  // resolves. We therefore always prevent and call destroy() ourselves when
  // ready to close.
  try {
    const appWindow = getCurrentWindow();
    let handling = false;
    const destroyWindow = async () => {
      try {
        await appWindow.destroy();
      } catch (e) {
        console.error("Could not destroy window after close request", e);
      }
    };
    await appWindow.onCloseRequested(async (event) => {
      // Always take control; we'll call destroy() when it's safe to close.
      event.preventDefault();
      if (handling) return; // re-entrant guard (shouldn't happen with destroy())
      if (!hasUnsavedWork()) {
        await destroyWindow();
        return;
      }
      handling = true;
      const ok = await confirmDiscardAllUnsaved("The IDE is closing.");
      handling = false;
      if (ok) {
        await destroyWindow();
      }
    });
  } catch (e) {
    console.error("Could not attach close handler", e);
  }

  // Check if a workspace is already open on startup
  ipc.workspaceInfo().then((info) => {
    debugRecentProjects("startup workspaceInfo resolved", {
      workspace: info?.root ?? null,
      recentCount: recentProjects.length,
    });
    if (info) {
      currentWorkspace = info;
      updateWorkspaceUi(info);
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
