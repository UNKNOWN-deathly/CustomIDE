// Explorer: lazy tree backed by ide-core's fs.list_dir. No truth lives here —
// it just re-queries the backend on expand and reflects file events.

import { ipc, type DirEntry, type CoreEvent } from "./ipc";

export type CreateKind = "file" | "folder";

export type ScratchEntry = ScratchFile | ScratchFolder;

export interface ScratchFile {
  kind: "file";
  name: string;
  path: string;
  content: string;
}

export interface ScratchFolder {
  kind: "folder";
  name: string;
  path: string;
  children: ScratchEntry[];
}

export interface ExplorerBinding {
  setRoot(root: string): Promise<void>;
  setScratchRoot(rootName: string, rootPath: string, children: ScratchEntry[]): void;
  clearScratchRoot(): void;
  onOpenFile(handler: (path: string) => void): void;
  /** Called after the user creates a file via the in-tree input. */
  onFileCreated(handler: (path: string) => void): void;
  /** Begin an inline create at the current target dir (workspace root if none selected). */
  beginCreate(kind: CreateKind): Promise<void>;
  applyEvent(evt: CoreEvent): void;
}

interface NodeState {
  entry: DirEntry;
  el: HTMLElement;
  childrenWrap: HTMLElement | null;
  expanded: boolean;
  depth: number;
}

const chevronRightSvg = `
  <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="9 18 15 12 9 6"></polyline>
  </svg>
`;

const folderClosedSvg = `
  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#d8a042" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
  </svg>
`;

const folderOpenSvg = `
  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#d8a042" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
    <path d="M2 10h20" opacity="0.3"></path>
  </svg>
`;

const pythonFileSvg = `
  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#3572A5" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
    <polyline points="14 2 14 8 20 8"></polyline>
    <path d="M8 13h6" stroke-width="1.5" opacity="0.6"></path>
    <path d="M8 17h6" stroke-width="1.5" opacity="0.6"></path>
  </svg>
`;

const genericFileSvg = `
  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#8e8e93" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
    <polyline points="14 2 14 8 20 8"></polyline>
  </svg>
`;

function fileIconFor(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".py") || lower.endsWith(".pyi")) return pythonFileSvg;
  return genericFileSvg;
}

function joinPath(parent: string, name: string): string {
  const sep = parent.includes("\\") && !parent.includes("/") ? "\\" : "/";
  const trimmed = parent.replace(/[\\/]+$/, "");
  return `${trimmed}${sep}${name}`;
}

export function mountExplorer(host: HTMLElement): ExplorerBinding {
  let openHandler: ((p: string) => void) | null = null;
  let fileCreatedHandler: ((p: string) => void) | null = null;
  let rootPath: string | null = null;
  let selectedDir: string | null = null;
  const byPath = new Map<string, NodeState>();
  let pendingInput: HTMLElement | null = null;
  let scratchRoot: ScratchFolder | null = null;
  let scratchSelectedDir: string | null = null;
  const scratchExpanded = new Set<string>();
  const scratchContainers = new Map<string, HTMLElement>();
  const scratchDepths = new Map<string, number>();

  let setRootCallId = 0;
  async function setRoot(root: string) {
    scratchRoot = null;
    scratchSelectedDir = null;
    scratchExpanded.clear();
    scratchContainers.clear();
    scratchDepths.clear();
    rootPath = root;
    selectedDir = null;
    const currentId = ++setRootCallId;
    const entries = await ipc.fsList(root);
    if (currentId === setRootCallId) {
      host.innerHTML = "";
      byPath.clear();
      pendingInput = null;
      for (const e of entries) {
        host.appendChild(buildNode(e, 0));
      }
    }
  }

  function setScratchRoot(rootName: string, scratchPath: string, children: ScratchEntry[]) {
    rootPath = null;
    selectedDir = null;
    byPath.clear();
    pendingInput = null;
    scratchRoot = { kind: "folder", name: rootName, path: scratchPath, children };
    scratchSelectedDir = scratchPath;
    scratchExpanded.clear();
    scratchExpanded.add(scratchPath);
    renderScratchRoot();
  }

  function clearScratchRoot() {
    scratchRoot = null;
    scratchSelectedDir = null;
    scratchExpanded.clear();
    scratchContainers.clear();
    scratchDepths.clear();
    host.innerHTML = "";
  }

  function buildNode(entry: DirEntry, depth: number): HTMLElement {
    const el = document.createElement("div");
    el.className = "file-tree-node";
    el.style.paddingLeft = `${6 + depth * 10}px`;

    const twisty = document.createElement("span");
    twisty.className = "twisty";
    twisty.innerHTML = entry.is_dir ? chevronRightSvg : "";
    el.appendChild(twisty);

    const icon = document.createElement("span");
    icon.className = "tree-icon";
    icon.innerHTML = entry.is_dir ? folderClosedSvg : fileIconFor(entry.name);
    el.appendChild(icon);

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = entry.name;
    el.appendChild(name);

    const state: NodeState = { entry, el, childrenWrap: null, expanded: false, depth };
    byPath.set(entry.path, state);

    el.onclick = async () => {
      document
        .querySelectorAll(".file-tree-node.selected")
        .forEach((n) => n.classList.remove("selected"));
      el.classList.add("selected");
      if (entry.is_dir) {
        selectedDir = entry.path;
        await toggleExpand(state);
      } else {
        // Selected file → context for new-file lives in its parent dir.
        selectedDir = parentOf(entry.path);
        openHandler?.(entry.path);
      }
    };

    el.oncontextmenu = (e) => {
      e.preventDefault();
      document
        .querySelectorAll(".file-tree-node.selected")
        .forEach((n) => n.classList.remove("selected"));
      el.classList.add("selected");
      selectedDir = entry.is_dir ? entry.path : parentOf(entry.path);
      showContextMenu(e.clientX, e.clientY, entry);
    };

    const wrap = document.createElement("div");
    wrap.dataset.nodeWrap = entry.path;
    wrap.appendChild(el);
    return wrap;
  }

  function parentOf(p: string): string {
    const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
    return idx > 0 ? p.slice(0, idx) : (rootPath ?? p);
  }

  async function toggleExpand(state: NodeState) {
    if (state.expanded) {
      if (state.childrenWrap) state.childrenWrap.remove();
      state.childrenWrap = null;
      state.expanded = false;
      state.el.classList.remove("expanded");
      const iconSpan = state.el.querySelector(".tree-icon");
      if (iconSpan) iconSpan.innerHTML = folderClosedSvg;
      return;
    }
    await expand(state);
  }

  async function expand(state: NodeState) {
    if (state.expanded) return;
    const childWrap = document.createElement("div");
    childWrap.className = "tree-children";
    const children = await ipc.fsList(state.entry.path);
    for (const e of children) {
      childWrap.appendChild(buildNode(e, state.depth + 1));
    }
    state.el.parentElement!.appendChild(childWrap);
    state.childrenWrap = childWrap;
    state.expanded = true;
    state.el.classList.add("expanded");
    const iconSpan = state.el.querySelector(".tree-icon");
    if (iconSpan) iconSpan.innerHTML = folderOpenSvg;
  }

  async function refreshLevel(dir: string) {
    if (!rootPath) return;
    if (samePath(dir, rootPath)) {
      const entries = await ipc.fsList(rootPath);
      // Preserve expansion state for paths that still exist.
      const previouslyExpanded = new Set<string>();
      for (const [p, s] of byPath) {
        if (s.expanded) previouslyExpanded.add(p);
      }
      host.innerHTML = "";
      byPath.clear();
      for (const e of entries) {
        host.appendChild(buildNode(e, 0));
      }
      for (const p of previouslyExpanded) {
        const s = byPath.get(p);
        if (s) await expand(s);
      }
      return;
    }
    const state = findStateByPath(dir);
    if (!state || !state.expanded) return;
    const previouslyExpanded = new Set<string>();
    if (state.childrenWrap) {
      state.childrenWrap.querySelectorAll<HTMLElement>(".file-tree-node").forEach((el) => {
        for (const [p, s] of byPath) {
          if (s.el === el && s.expanded) previouslyExpanded.add(p);
        }
      });
      // Drop child entries from byPath.
      const toDelete: string[] = [];
      for (const [p] of byPath) {
        if (p !== dir && isDescendant(p, dir)) toDelete.push(p);
      }
      for (const p of toDelete) byPath.delete(p);
      state.childrenWrap.innerHTML = "";
    } else {
      return;
    }
    const children = await ipc.fsList(dir);
    for (const e of children) {
      state.childrenWrap.appendChild(buildNode(e, state.depth + 1));
    }
    for (const p of previouslyExpanded) {
      const s = byPath.get(p);
      if (s) await expand(s);
    }
  }

  function findStateByPath(p: string): NodeState | undefined {
    for (const [key, s] of byPath) {
      if (samePath(key, p)) return s;
    }
    return undefined;
  }

  function samePath(a: string, b: string): boolean {
    const na = a.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const nb = b.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    return na === nb;
  }

  function isDescendant(child: string, parent: string): boolean {
    const c = child.replace(/\\/g, "/").toLowerCase();
    const p = parent.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    return c.startsWith(`${p}/`);
  }

  // ── Inline create input ────────────────────────────────────────────────────
  async function beginCreate(kind: CreateKind) {
    if (scratchRoot) {
      beginScratchCreate(kind);
      return;
    }
    if (!rootPath) return;
    cancelPendingInput();

    const targetDir = selectedDir && byPath.has(selectedDir) ? selectedDir : rootPath;
    let container: HTMLElement;
    let depth: number;

    if (samePath(targetDir, rootPath)) {
      container = host;
      depth = 0;
    } else {
      const state = findStateByPath(targetDir);
      if (!state) return;
      if (!state.expanded) await expand(state);
      container = state.childrenWrap!;
      depth = state.depth + 1;
    }

    const row = buildInputRow(kind, depth, async (name) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      const full = joinPath(targetDir, trimmed);
      try {
        if (kind === "file") {
          await ipc.fsCreateFile(full);
        } else {
          await ipc.fsCreateDir(full);
        }
        await refreshLevel(targetDir);
        if (kind === "file") {
          fileCreatedHandler?.(full);
        }
      } catch (e) {
        // Visual: blink the row red briefly then keep it editable.
        row.classList.add("create-error");
        row.title = String(e);
        setTimeout(() => row.classList.remove("create-error"), 600);
        const input = row.querySelector("input");
        input?.focus();
      }
    });

    container.insertBefore(row, container.firstChild);
    pendingInput = row;
    const input = row.querySelector("input")!;
    input.focus();
  }

  function buildInputRow(
    kind: CreateKind,
    depth: number,
    onSubmit: (name: string) => Promise<void>
  ): HTMLElement {
    const wrap = document.createElement("div");
    const row = document.createElement("div");
    row.className = "file-tree-node create-row";
    row.style.paddingLeft = `${6 + depth * 10}px`;

    const twisty = document.createElement("span");
    twisty.className = "twisty";
    row.appendChild(twisty);

    const icon = document.createElement("span");
    icon.className = "tree-icon";
    icon.innerHTML = kind === "folder" ? folderClosedSvg : genericFileSvg;
    row.appendChild(icon);

    const input = document.createElement("input");
    input.className = "create-input";
    input.type = "text";
    input.placeholder = kind === "folder" ? "folder name" : "file name";
    input.spellcheck = false;
    input.autocomplete = "off";
    row.appendChild(input);

    let submitted = false;
    const submit = async () => {
      if (submitted) return;
      submitted = true;
      const value = input.value;
      if (!value.trim()) {
        cancelPendingInput();
        return;
      }
      try {
        await onSubmit(value);
      } finally {
        if (pendingInput === wrap) pendingInput = null;
        wrap.remove();
      }
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancelPendingInput();
      }
    });
    input.addEventListener("blur", () => {
      // Defer so click-on-another-tree-row doesn't race.
      setTimeout(() => {
        if (pendingInput === wrap && !submitted) cancelPendingInput();
      }, 100);
    });

    wrap.appendChild(row);
    return wrap;
  }

  function cancelPendingInput() {
    if (pendingInput) {
      pendingInput.remove();
      pendingInput = null;
    }
  }

  // ── Context menu ──────────────────────────────────────────────────────────
  let activeMenu: HTMLElement | null = null;
  function showContextMenu(x: number, y: number, _entry: DirEntry) {
    closeContextMenu();
    const menu = document.createElement("div");
    menu.className = "explorer-context-menu";
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;

    const mkItem = (label: string, fn: () => void) => {
      const it = document.createElement("button");
      it.className = "explorer-context-item";
      it.textContent = label;
      it.onclick = () => {
        closeContextMenu();
        fn();
      };
      return it;
    };
    menu.appendChild(mkItem("New File", () => beginCreate("file")));
    menu.appendChild(mkItem("New Folder", () => beginCreate("folder")));
    document.body.appendChild(menu);
    activeMenu = menu;

    const off = (e: MouseEvent) => {
      if (activeMenu && !activeMenu.contains(e.target as Node)) closeContextMenu();
    };
    setTimeout(() => document.addEventListener("mousedown", off, { once: true }), 0);
  }

  function renderScratchRoot() {
    if (!scratchRoot) return;
    host.innerHTML = "";
    scratchContainers.clear();
    scratchDepths.clear();

    const rootWrap = document.createElement("div");
    const rootRow = document.createElement("div");
    rootRow.className = "file-tree-node expanded";
    rootRow.style.paddingLeft = "6px";

    const twisty = document.createElement("span");
    twisty.className = "twisty";
    twisty.innerHTML = chevronRightSvg;
    rootRow.appendChild(twisty);

    const icon = document.createElement("span");
    icon.className = "tree-icon";
    icon.innerHTML = folderOpenSvg;
    rootRow.appendChild(icon);

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = scratchRoot.name;
    rootRow.appendChild(name);

    rootRow.onclick = () => {
      selectScratchRow(rootRow, scratchRoot!.path);
    };
    rootRow.oncontextmenu = (e) => {
      e.preventDefault();
      selectScratchRow(rootRow, scratchRoot!.path);
      showContextMenu(e.clientX, e.clientY, {} as DirEntry);
    };
    rootWrap.appendChild(rootRow);

    const childWrap = document.createElement("div");
    childWrap.className = "tree-children";
    scratchContainers.set(scratchRoot.path, childWrap);
    scratchDepths.set(scratchRoot.path, 0);
    for (const child of scratchRoot.children) {
      childWrap.appendChild(buildScratchNode(child, 1));
    }
    rootWrap.appendChild(childWrap);
    host.appendChild(rootWrap);
  }

  function buildScratchNode(entry: ScratchEntry, depth: number): HTMLElement {
    const wrap = document.createElement("div");
    const el = document.createElement("div");
    const isDir = entry.kind === "folder";
    const expanded = isDir && scratchExpanded.has(entry.path);
    el.className = "file-tree-node" + (expanded ? " expanded" : "");
    el.style.paddingLeft = `${6 + depth * 10}px`;

    const twisty = document.createElement("span");
    twisty.className = "twisty";
    twisty.innerHTML = isDir ? chevronRightSvg : "";
    el.appendChild(twisty);

    const icon = document.createElement("span");
    icon.className = "tree-icon";
    icon.innerHTML = isDir ? (expanded ? folderOpenSvg : folderClosedSvg) : fileIconFor(entry.name);
    el.appendChild(icon);

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = entry.name;
    el.appendChild(name);

    el.onclick = () => {
      selectScratchRow(el, isDir ? entry.path : scratchParentOf(entry.path));
      if (entry.kind === "folder") {
        if (scratchExpanded.has(entry.path)) scratchExpanded.delete(entry.path);
        else scratchExpanded.add(entry.path);
        renderScratchRoot();
      } else {
        openHandler?.(entry.path);
      }
    };
    el.oncontextmenu = (e) => {
      e.preventDefault();
      selectScratchRow(el, isDir ? entry.path : scratchParentOf(entry.path));
      showContextMenu(e.clientX, e.clientY, {} as DirEntry);
    };

    wrap.appendChild(el);
    if (entry.kind === "folder" && expanded) {
      const childWrap = document.createElement("div");
      childWrap.className = "tree-children";
      scratchContainers.set(entry.path, childWrap);
      scratchDepths.set(entry.path, depth);
      for (const child of entry.children) {
        childWrap.appendChild(buildScratchNode(child, depth + 1));
      }
      wrap.appendChild(childWrap);
    }
    return wrap;
  }

  function selectScratchRow(row: HTMLElement, dir: string) {
    document
      .querySelectorAll(".file-tree-node.selected")
      .forEach((n) => n.classList.remove("selected"));
    row.classList.add("selected");
    scratchSelectedDir = dir;
  }

  function beginScratchCreate(kind: CreateKind) {
    if (!scratchRoot) return;
    cancelPendingInput();
    const targetDir = scratchSelectedDir && findScratchFolder(scratchSelectedDir)
      ? scratchSelectedDir
      : scratchRoot.path;
    if (!scratchExpanded.has(targetDir)) {
      scratchExpanded.add(targetDir);
      renderScratchRoot();
    }
    const container = scratchContainers.get(targetDir);
    if (!container) return;
    const depth = (scratchDepths.get(targetDir) ?? 0) + 1;

    const row = buildInputRow(kind, depth, async (name) => {
      const trimmed = name.trim();
      if (!trimmed || !scratchRoot) return;
      const parent = findScratchFolder(targetDir);
      if (!parent) return;
      const full = joinPath(targetDir, trimmed);
      if (scratchChildExists(parent, trimmed)) {
        row.classList.add("create-error");
        row.title = `${trimmed} already exists`;
        setTimeout(() => row.classList.remove("create-error"), 600);
        return;
      }
      const entry: ScratchEntry = kind === "file"
        ? { kind: "file", name: trimmed, path: full, content: "" }
        : { kind: "folder", name: trimmed, path: full, children: [] };
      parent.children.unshift(entry);
      renderScratchRoot();
      if (entry.kind === "file") {
        fileCreatedHandler?.(entry.path);
      }
    });

    container.insertBefore(row, container.firstChild);
    pendingInput = row;
    const input = row.querySelector("input")!;
    input.focus();
  }

  function findScratchFolder(path: string): ScratchFolder | null {
    if (!scratchRoot) return null;
    if (samePath(scratchRoot.path, path)) return scratchRoot;
    const stack = [...scratchRoot.children];
    while (stack.length > 0) {
      const entry = stack.shift()!;
      if (entry.kind === "folder") {
        if (samePath(entry.path, path)) return entry;
        stack.push(...entry.children);
      }
    }
    return null;
  }

  function scratchChildExists(parent: ScratchFolder, name: string) {
    const key = name.toLowerCase();
    return parent.children.some((child) => child.name.toLowerCase() === key);
  }

  function scratchParentOf(p: string): string {
    const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
    return idx > 0 ? p.slice(0, idx) : (scratchRoot?.path ?? p);
  }
  function closeContextMenu() {
    if (activeMenu) {
      activeMenu.remove();
      activeMenu = null;
    }
  }

  // Click on empty area deselects so new-file targets the workspace root.
  host.addEventListener("click", (e) => {
    if (e.target === host) {
      document
        .querySelectorAll(".file-tree-node.selected")
        .forEach((n) => n.classList.remove("selected"));
      selectedDir = null;
    }
  });

  function applyEvent(evt: CoreEvent) {
    if (!rootPath || scratchRoot) return;
    if (
      evt.kind === "file_created" ||
      evt.kind === "file_removed" ||
      evt.kind === "file_renamed"
    ) {
      const path = evt.kind === "file_renamed" ? evt.to : evt.path;
      const parent = parentOf(path);
      refreshLevel(parent).catch(() => {});
    }
  }

  return {
    setRoot,
    setScratchRoot,
    clearScratchRoot,
    onOpenFile(handler) {
      openHandler = handler;
    },
    onFileCreated(handler) {
      fileCreatedHandler = handler;
    },
    beginCreate,
    applyEvent,
  };
}
