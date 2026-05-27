// Explorer: lazy tree backed by ide-core's fs.list_dir. No truth lives here —
// it just re-queries the backend on expand and reflects file events.

import { ipc, type DirEntry, type CoreEvent } from "./ipc";

export interface ExplorerBinding {
  setRoot(root: string): Promise<void>;
  onOpenFile(handler: (path: string) => void): void;
  applyEvent(evt: CoreEvent): void;
}

interface NodeState {
  entry: DirEntry;
  el: HTMLElement;
  childrenWrap: HTMLElement | null;
  expanded: boolean;
}

export function mountExplorer(host: HTMLElement): ExplorerBinding {
  let openHandler: ((p: string) => void) | null = null;
  let rootPath: string | null = null;
  const byPath = new Map<string, NodeState>();

  let setRootCallId = 0;
  async function setRoot(root: string) {
    rootPath = root;
    const currentId = ++setRootCallId;
    const entries = await ipc.fsList(root);
    if (currentId === setRootCallId) {
      host.innerHTML = "";
      byPath.clear();
      for (const e of entries) {
        host.appendChild(buildNode(e, 0));
      }
    }
  }

  function buildNode(entry: DirEntry, depth: number): HTMLElement {
    const el = document.createElement("div");
    el.className = "file-tree-node";
    el.style.paddingLeft = `${8 + depth * 12}px`;

    const twisty = document.createElement("span");
    twisty.className = "twisty";
    twisty.textContent = entry.is_dir ? "▸" : " ";
    el.appendChild(twisty);

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = entry.name;
    el.appendChild(name);

    const state: NodeState = { entry, el, childrenWrap: null, expanded: false };
    byPath.set(entry.path, state);

    el.onclick = async () => {
      document
        .querySelectorAll(".file-tree-node.selected")
        .forEach((n) => n.classList.remove("selected"));
      el.classList.add("selected");
      if (entry.is_dir) {
        await toggleExpand(state, depth);
      } else {
        openHandler?.(entry.path);
      }
    };

    const wrap = document.createElement("div");
    wrap.appendChild(el);
    return wrap;
  }

  async function toggleExpand(state: NodeState, depth: number) {
    if (state.expanded) {
      if (state.childrenWrap) state.childrenWrap.remove();
      state.childrenWrap = null;
      state.expanded = false;
      (state.el.firstChild as HTMLElement).textContent = "▸";
      return;
    }
    const childWrap = document.createElement("div");
    const children = await ipc.fsList(state.entry.path);
    for (const e of children) {
      childWrap.appendChild(buildNode(e, depth + 1));
    }
    state.el.parentElement!.appendChild(childWrap);
    state.childrenWrap = childWrap;
    state.expanded = true;
    (state.el.firstChild as HTMLElement).textContent = "▾";
  }

  function applyEvent(evt: CoreEvent) {
    if (!rootPath) return;
    if (
      evt.kind === "file_created" ||
      evt.kind === "file_removed" ||
      evt.kind === "file_renamed"
    ) {
      // Cheap correctness over cleverness: re-query the visible levels we know
      // about. Walks the open ancestors and refreshes children.
      // For v1 just refresh the root view.
      setRoot(rootPath);
    }
  }

  return {
    setRoot,
    onOpenFile(handler) {
      openHandler = handler;
    },
    applyEvent,
  };
}
