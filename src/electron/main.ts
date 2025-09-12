import { app, BrowserWindow, BrowserView, ipcMain, Menu } from "electron";
import * as path from "path";
import * as fs from "fs";

type Rect = { x: number; y: number; width: number; height: number };

// ---------- Split tree ----------
type Leaf = {
  kind: "leaf";
  id: number;
  view: BrowserView;
  url: string;
  title?: string;
};
type Split = {
  kind: "split";
  dir: "vertical" | "horizontal"; // vertical = left/right, horizontal = top/bottom
  size: number; // fraction [0..1] for A (left/top)
  a: Node;
  b: Node;
};
type Node = Leaf | Split;

// ---------- Globals ----------
let win: BrowserWindow | null = null;
let root: Node | null = null;
const leafById = new Map<number, Leaf>();
let lastActivePaneId: number | null = null;

let omniboxFocused = false;

const PANE_HEADER = 30;
const GUTTER = 2; // only between panes (not at window edges)
const BG = "#1d1f28";

const devUrl = process.env.VITE_DEV_SERVER_URL || "http://localhost:5173";
const isDev = !!process.env.ELECTRON_START_URL;

// ---------- Utils ----------
function contentSize() {
  if (!win) return { w: 0, h: 0 };
  const [w, h] = win.getContentSize();
  return { w, h };
}
function allocId() {
  return Date.now() + Math.floor(Math.random() * 1000);
}

/** Inset BrowserView so gutters only appear on interior edges. */
function setLeafBounds(leaf: Leaf, rect: Rect) {
  if (!win) return;
  const { w, h } = contentSize();

  const leftG = rect.x > 0 ? GUTTER : 0;
  const rightG = rect.x + rect.width < w ? GUTTER : 0;
  // Remove vertical gutters between header and content
  const topG = 0;
  const bottomG = 0;

  const x = rect.x + leftG;
  const y = rect.y + PANE_HEADER + topG;
  const bw = Math.max(0, rect.width - (leftG + rightG));
  const bh = Math.max(0, rect.height - PANE_HEADER - (topG + bottomG));

  leaf.view.setBounds({ x, y, width: bw, height: bh });
  leaf.view.setAutoResize({ width: false, height: false });
}

// Recursively layout the split tree and collect pane state for renderer
function layout(
  node: Node,
  rect: Rect,
  out: { id: number; url: string; title: string; rect: Rect }[]
) {
  if (node.kind === "leaf") {
    setLeafBounds(node, rect);
    out.push({ id: node.id, url: node.url, title: node.title ?? "", rect });
    return;
  }
  const { dir, size, a, b } = node;
  if (dir === "vertical") {
    const wA = Math.floor(rect.width * size);
    const wB = rect.width - wA;
    const rectA = { x: rect.x, y: rect.y, width: wA, height: rect.height };
    const rectB = { x: rect.x + wA, y: rect.y, width: wB, height: rect.height };
    layout(a, rectA, out);
    layout(b, rectB, out);
  } else {
    const hA = Math.floor(rect.height * size);
    const hB = rect.height - hA;
    const rectA = { x: rect.x, y: rect.y, width: rect.width, height: hA };
    const rectB = { x: rect.x, y: rect.y + hA, width: rect.width, height: hB };
    layout(a, rectA, out);
    layout(b, rectB, out);
  }
}

function sendState() {
  if (!win) return;
  const out: { id: number; url: string; title: string; rect: Rect }[] = [];
  if (root) {
    const { w, h } = contentSize();
    layout(root, { x: 0, y: 0, width: w, height: h }, out);
  }
  // Do NOT mutate lastActivePaneId here; renderer listens to panes:active events separately.
  win.webContents.send("panes:update", out);
}

// Find parent split of a leaf id
function findParent(
  node: Node,
  childId: number,
  parent: Split | null = null
): Split | null {
  if (node.kind === "leaf") return node.id === childId ? parent : null;
  return findParent(node.a, childId, node) || findParent(node.b, childId, node);
}
function replaceChild(parent: Split, prev: Node, next: Node) {
  if (parent.a === prev) parent.a = next;
  else parent.b = next;
}
function replaceNode(node: Node, targetId: number): Node | null {
  if (node.kind === "leaf") return node.id === targetId ? null : node;
  const a2 = replaceNode(node.a, targetId);
  const b2 = replaceNode(node.b, targetId);
  if (a2 === node.a && b2 === node.b) return node;
  if (a2 == null && b2 != null) return b2;
  if (b2 == null && a2 != null) return a2;
  return { ...node, a: a2!, b: b2! };
}

// ---------- Leaf wiring ----------
function wireLeaf(leaf: Leaf) {
  const wc = leaf.view.webContents;

  const sync = () => {
    const current = wc.getURL();
    if (!current.startsWith("data:")) {
      leaf.url = current || leaf.url;
    }
    leaf.title = wc.getTitle();
    sendState();
  };

  wc.on("did-navigate", sync);
  wc.on("did-navigate-in-page", sync);
  wc.on("page-title-updated", sync);
  wc.once("destroyed", () => {
    wc.removeListener("did-navigate", sync);
    wc.removeListener("did-navigate-in-page", sync);
    wc.removeListener("page-title-updated", sync);
  });

  wc.on(
    "did-fail-load",
    (_e, errorCode, errorDesc, validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      if (errorCode === -3) return;
      const html = renderErrorHTML(validatedURL, errorCode, errorDesc);
      wc.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`, {
        baseURLForDataURL: validatedURL || "about:blank",
      });
    }
  );

  // Keep active pane unchanged on navigation; explicit actions set it.
  wc.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const isCmdW =
      (process.platform === "darwin" &&
        input.meta &&
        !input.shift &&
        !input.alt &&
        !input.control &&
        input.key?.toLowerCase() === "w") ||
      (process.platform !== "darwin" &&
        input.control &&
        !input.shift &&
        !input.alt &&
        !input.meta &&
        input.key?.toLowerCase() === "w");
    if (isCmdW) {
      event.preventDefault();
      const targetId = lastActivePaneId ?? leaf.id;
      closePane(targetId);
    }
  });
}

function renderErrorHTML(url: string, code: number, desc: string) {
  const safeUrl = (url || "").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const safeDesc = (desc || "").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `
<!doctype html>
<meta charset="utf-8">
<title>Can’t load page</title>
<style>
  html,body{margin:0;background:#0b0c10;color:#e7e7ea;font:14px/1.45 system-ui, -apple-system, Segoe UI, Roboto, sans-serif}
  .wrap{max-width:720px;margin:14vh auto;padding:24px}
  h1{margin:0 0 8px;font-size:18px}
  .url{opacity:.9;word-break:break-all}
  .code{opacity:.7;margin-top:6px}
  button{margin-top:14px;padding:8px 12px;background:#1d1f28;border:1px solid #2b2d36;border-radius:6px;color:#e7e7ea;cursor:pointer}
  button:hover{filter:brightness(1.1)}
</style>
<div class="wrap">
  <h1>Hmm… couldn't reach this page</h1>
  <div class="url">${safeUrl}</div>
  <div class="code">Error ${code}: ${safeDesc}</div>
  <button onclick="location.reload()">Retry</button>
</div>`;
}

async function makeLeaf(url: string): Promise<Leaf> {
  const id = allocId();
  const view = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: "persist:default",
      preload: path.join(__dirname, "pane_preload.js"),
      additionalArguments: [`--paneId=${id}`],
    },
  });
  const leaf: Leaf = { kind: "leaf", id, view, url };
  leafById.set(id, leaf);
  win!.addBrowserView(view);
  wireLeaf(leaf);
  await view.webContents.loadURL(url);
  leaf.title = view.webContents.getTitle();
  return leaf;
}

// ---------- Public ops ----------
async function createPane(url: string) {
  if (!root) {
    root = await makeLeaf(url);
    // Make the very first pane active
    lastActivePaneId = (root as any).id as number;
    win?.webContents.send("panes:active", lastActivePaneId);
    focusPane(lastActivePaneId);
    sendState();
    return (root as Leaf).id;
  }
  const last = Array.from(leafById.values()).slice(-1)[0];
  return splitDirected(last.id, "vertical", "right", url);
}

/** Split relative to target with explicit side */
async function splitDirected(
  targetId: number,
  dir: "vertical" | "horizontal",
  side: "left" | "right" | "up" | "down",
  newUrl?: string
) {
  if (!root) return -1;
  const target = leafById.get(targetId);
  if (!target) return -1;

  const parent = findParent(root, targetId);
  const other = await makeLeaf(newUrl || "https://example.com");

  let node: Split;

  if (dir === "vertical") {
    // left/right relative to target
    if (side === "left") {
      node = { kind: "split", dir, size: 0.5, a: other, b: target }; // new on left
    } else {
      node = { kind: "split", dir, size: 0.5, a: target, b: other }; // new on right
    }
  } else {
    // up/down relative to target
    if (side === "up") {
      node = { kind: "split", dir, size: 0.5, a: other, b: target }; // new on top
    } else {
      node = { kind: "split", dir, size: 0.5, a: target, b: other }; // new below
    }
  }

  if (!parent) root = node;
  else replaceChild(parent, target, node);

  // Newly created pane becomes active
  lastActivePaneId = other.id;
  win?.webContents.send("panes:active", other.id);
  focusPane(other.id);

  sendState();
  return other.id;
}

// Legacy helper (kept if renderer still calls panes:split without side)
async function split(
  targetId: number,
  dir: "vertical" | "horizontal",
  newUrl?: string
) {
  return dir === "vertical"
    ? splitDirected(targetId, "vertical", "right", newUrl)
    : splitDirected(targetId, "horizontal", "down", newUrl);
}

function navigatePane(id: number, url: string) {
  const leaf = leafById.get(id);
  if (!leaf) return;
  leaf.url = url;
  leaf.view.webContents.loadURL(url);
  sendState();
}

function closePane(id: number) {
  if (!root || !win) return;

  // Compute next active pane before removal: choose closest by center distance
  const listBefore: { id: number; rect: Rect }[] = (() => {
    const out: { id: number; url: string; title: string; rect: Rect }[] = [];
    const { w, h } = contentSize();
    if (root) layout(root, { x: 0, y: 0, width: w, height: h }, out);
    return out.map((p) => ({ id: p.id, rect: p.rect }));
  })();
  const closedRect = listBefore.find((p) => p.id === id)?.rect;
  let nextActive: number | null = null;
  if (closedRect) {
    let best: { id: number; d2: number } | null = null;
    const cx = closedRect.x + closedRect.width / 2;
    const cy = closedRect.y + closedRect.height / 2;
    for (const p of listBefore) {
      if (p.id === id) continue;
      const px = p.rect.x + p.rect.width / 2;
      const py = p.rect.y + p.rect.height / 2;
      const dx = px - cx;
      const dy = py - cy;
      const d2 = dx * dx + dy * dy;
      if (!best || d2 < best.d2) best = { id: p.id, d2 };
    }
    nextActive = best?.id ?? null;
  }

  const leaf = leafById.get(id);
  if (!leaf) return;

  try {
    win.removeBrowserView(leaf.view);
  } catch {}
  try {
    (leaf.view as any)?.destroy?.();
  } catch {}
  leafById.delete(id);

  if (root.kind === "leaf" && (root as any).id === id) {
    root = null;
    sendState();
    win.close();
    return;
  }
  root = replaceNode(root, id);
  sendState();

  if (nextActive != null && leafById.has(nextActive)) {
    lastActivePaneId = nextActive;
    win.webContents.send("panes:active", nextActive);
    focusPane(nextActive);
  }
}

function relayoutAll() {
  sendState();
}

type PaneRect = { id: number; rect: Rect };
function getAllPaneRects(): PaneRect[] {
  const out: { id: number; url: string; title: string; rect: Rect }[] = [];
  if (root && win) {
    const { w, h } = contentSize();
    layout(root, { x: 0, y: 0, width: w, height: h }, out);
  }
  return out.map((p) => ({ id: p.id, rect: p.rect }));
}

function sortedPaneIdsReading(): number[] {
  const panes = getAllPaneRects();
  panes.sort(
    (a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x || a.id - b.id
  );
  return panes.map((p) => p.id);
}

function activatePrevNext(offset: -1 | 1) {
  const ids = sortedPaneIdsReading();
  if (!ids.length) return;
  const current = lastActivePaneId ?? ids[0];
  const idx = Math.max(0, ids.indexOf(current));
  const nextIdx = (idx + offset + ids.length) % ids.length;
  const nextId = ids[nextIdx];
  lastActivePaneId = nextId;
  win?.webContents.send("panes:active", nextId);
  focusPane(nextId);
}

function chooseNeighbor(
  currentId: number,
  dir: "left" | "right" | "up" | "down"
): number | null {
  const panes = getAllPaneRects();
  const cur = panes.find((p) => p.id === currentId);
  if (!cur) return null;

  const curLeft = cur.rect.x;
  const curRight = cur.rect.x + cur.rect.width;
  const curTop = cur.rect.y;
  const curBottom = cur.rect.y + cur.rect.height;
  const cx = (curLeft + curRight) / 2;
  const cy = (curTop + curBottom) / 2;

  const isHorizontal = dir === "left" || dir === "right";
  const correctSide = (dx: number, dy: number) =>
    dir === "left"
      ? dx < 0
      : dir === "right"
      ? dx > 0
      : dir === "up"
      ? dy < 0
      : dy > 0;

  const overlapsOrth = (r: Rect) => {
    const left = r.x;
    const right = r.x + r.width;
    const top = r.y;
    const bottom = r.y + r.height;
    if (isHorizontal) {
      // vertical overlap
      return Math.max(curTop, top) < Math.min(curBottom, bottom);
    } else {
      // horizontal overlap
      return Math.max(curLeft, left) < Math.min(curRight, right);
    }
  };

  type Cand = { id: number; primary: number; secondary: number };
  const overlapCands: Cand[] = [];
  const fallbackCands: Cand[] = [];

  for (const p of panes) {
    if (p.id === currentId) continue;
    const px = p.rect.x + p.rect.width / 2;
    const py = p.rect.y + p.rect.height / 2;
    const dx = px - cx;
    const dy = py - cy;
    if (!correctSide(dx, dy)) continue;
    const primary = Math.abs(isHorizontal ? dx : dy);
    const secondary = Math.abs(isHorizontal ? dy : dx);
    const cand: Cand = { id: p.id, primary, secondary };
    if (overlapsOrth(p.rect)) overlapCands.push(cand);
    else fallbackCands.push(cand);
  }

  const pickByPrimaryThenSecondary = (list: Cand[]): number | null => {
    if (!list.length) return null;
    list.sort(
      (a, b) =>
        a.primary - b.primary || a.secondary - b.secondary || a.id - b.id
    );
    return list[0].id;
  };

  // Prefer panes that overlap along the orthogonal axis
  const overlapPick = pickByPrimaryThenSecondary(overlapCands);
  if (overlapPick != null) return overlapPick;

  // Fallback: choose smallest angular deviation (secondary/primary), then by distance
  if (fallbackCands.length) {
    fallbackCands.sort((a, b) => {
      const angA = a.secondary / Math.max(1, a.primary);
      const angB = b.secondary / Math.max(1, b.primary);
      if (angA !== angB) return angA - angB;
      const distA = Math.hypot(a.primary, a.secondary);
      const distB = Math.hypot(b.primary, b.secondary);
      if (distA !== distB) return distA - distB;
      return a.id - b.id;
    });
    return fallbackCands[0].id;
  }

  return null;
}

function focusPane(id: number) {
  const leaf = leafById.get(id);
  try {
    leaf?.view?.webContents?.focus?.();
  } catch {}
  try {
    win?.focus();
  } catch {}
}

// ---------- Window / IPC ----------
async function createWindow() {
  Menu.setApplicationMenu(null);
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    frame: false,
    titleBarStyle: "hidden",
    backgroundColor: BG,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  // Hide macOS traffic lights (close/minimize/zoom)
  try {
    if (process.platform === "darwin") win.setWindowButtonVisibility(false);
  } catch {}

  win.on("resize", () => relayoutAll());

  // Intercept keybinds at the window level to make them global
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;

    // When omnibox is focused in renderer, don't handle any global keybinds here
    if (omniboxFocused) return;

    const key = (input.key || "").toLowerCase();
    const isOnlyMeta =
      input.meta && !input.shift && !input.alt && !input.control;
    const isOnlyShift =
      input.shift && !input.meta && !input.alt && !input.control;
    const isNoMods =
      !input.meta && !input.shift && !input.alt && !input.control;

    // Space: focus omnibox/input in active pane in the renderer
    if (isNoMods && key === " ") {
      event.preventDefault();
      const targetId =
        lastActivePaneId ?? Array.from(leafById.keys())[0] ?? null;
      if (targetId != null) {
        win?.webContents.send("panes:focusOmni", targetId);
        // Ensure renderer webContents receives typing
        try {
          win?.webContents.focus();
        } catch {}
      }
      return;
    }

    // Cmd+W: close active pane
    if (isOnlyMeta && key === "w") {
      event.preventDefault();
      if (lastActivePaneId != null) {
        closePane(lastActivePaneId);
      }
      return;
    }

    // Cmd+[ or Cmd+]: back/forward in active pane history
    if (isOnlyMeta && (key === "[" || key === "]")) {
      event.preventDefault();
      const targetId =
        lastActivePaneId ?? Array.from(leafById.keys())[0] ?? null;
      const leaf = targetId != null ? leafById.get(targetId) : null;
      const wc = leaf?.view?.webContents;
      if (wc) {
        if (key === "[") {
          if (wc.canGoBack()) wc.goBack();
        } else {
          if (wc.canGoForward()) wc.goForward();
        }
      }
      return;
    }

    // Cmd+H/J/K/L: split relative to active pane
    if (
      isOnlyMeta &&
      (key === "h" || key === "j" || key === "k" || key === "l")
    ) {
      event.preventDefault();
      const dir = key === "h" || key === "l" ? "vertical" : "horizontal";
      const side =
        key === "h"
          ? "left"
          : key === "l"
          ? "right"
          : key === "k"
          ? "up"
          : "down";
      const targetId =
        lastActivePaneId ?? Array.from(leafById.keys())[0] ?? null;
      if (targetId != null) splitDirected(targetId, dir as any, side as any);
      return;
    }

    // Shift+H/J/K/L: navigate active pane
    if (
      isOnlyShift &&
      (key === "h" || key === "j" || key === "k" || key === "l")
    ) {
      event.preventDefault();
      const dir =
        key === "h"
          ? "left"
          : key === "l"
          ? "right"
          : key === "k"
          ? "up"
          : "down";
      const start = lastActivePaneId ?? Array.from(leafById.keys())[0] ?? null;
      if (start != null) {
        const next = chooseNeighbor(start, dir as any);
        if (next != null && leafById.has(next)) {
          lastActivePaneId = next;
          win?.webContents.send("panes:active", next);
          focusPane(next);
        }
      }
      return;
    }
  });

  if (isDev) {
    win.loadURL(devUrl);
  } else {
    const distIndex = path.join(__dirname, "..", "dist", "index.html");
    if (!fs.existsSync(distIndex)) {
      throw new Error(
        `Renderer not built: ${distIndex} missing. Run "pnpm build".`
      );
    }
    win.loadFile(distIndex);
  }

  // Start with two side-by-side panes.
  const first = await createPane("https://example.com");
  await splitDirected(
    first,
    "vertical",
    "right",
    "https://developer.mozilla.org"
  );

  // Initialize main's active pane to the first pane until navigation overrides it
  lastActivePaneId = first;
  win.webContents.send("panes:active", first);
  focusPane(first);
}

// Renderer APIs
ipcMain.handle("panes:create", (_e, payload: { url: string }) =>
  createPane(payload.url || "https://example.com")
);
ipcMain.handle("panes:navigate", (_e, payload: { id: number; url: string }) =>
  navigatePane(payload.id, payload.url)
);
ipcMain.handle("panes:close", (_e, id: number) => closePane(id));
ipcMain.handle("panes:list", () => {
  const out: any[] = [];
  if (root) {
    const { w, h } = contentSize();
    layout(root, { x: 0, y: 0, width: w, height: h }, out);
  }
  return out;
});
ipcMain.handle("panes:setLayout", () => {});
ipcMain.handle(
  "panes:split",
  (_e, payload: { id: number; dir: "vertical" | "horizontal" }) =>
    split(payload.id, payload.dir)
);

// Scroll a specific pane by deltaY (forwarded into the pane's webContents)
ipcMain.handle(
  "panes:scroll",
  (_e, payload: { id: number; deltaY: number }) => {
    const { id, deltaY } = payload || ({} as any);
    const leaf = leafById.get(id);
    if (!leaf) return;
    try {
      leaf.view.webContents.send("pane:scroll", { deltaY });
    } catch {}
  }
);

// Keybinds from pane_preload (relative to the pane that sent it)
ipcMain.on(
  "pane:kb-split",
  (
    _e,
    payload: {
      paneId: number;
      dir: "vertical" | "horizontal";
      side: "left" | "right" | "up" | "down";
    }
  ) => {
    const targetId = lastActivePaneId ?? payload.paneId;
    splitDirected(targetId, payload.dir, payload.side);
  }
);

ipcMain.on("pane:kb-close", (_e, { paneId }: { paneId: number }) => {
  closePane(paneId);
  if (!root) win?.close();
});

// Active pane updates coming from pane webviews (hover/scroll)
ipcMain.on("pane:set-active", (_e, { paneId }: { paneId: number }) => {
  if (!win) return;
  // Only forward if pane still exists
  if (!leafById.has(paneId)) return;
  lastActivePaneId = paneId;
  win.webContents.send("panes:active", paneId);
});

// Scroll keybind requests from any pane -> apply to last active pane
ipcMain.on(
  "pane:kb-scroll",
  (_e, { paneId, deltaY }: { paneId: number; deltaY: number }) => {
    // Prefer the tracked lastActivePaneId so scroll follows hover activation
    const targetId = lastActivePaneId ?? paneId;
    const leaf = leafById.get(targetId);
    if (!leaf) return;
    try {
      leaf.view.webContents.send("pane:scroll", { deltaY });
    } catch {}
  }
);

ipcMain.handle("panes:setActive", (_e, id: number) => {
  if (!leafById.has(id)) return;
  lastActivePaneId = id;
  if (win) win.webContents.send("panes:active", id);
});

ipcMain.on(
  "pane:kb-nav",
  (
    _e,
    { paneId, dir }: { paneId: number; dir: "left" | "right" | "up" | "down" }
  ) => {
    const start = lastActivePaneId ?? paneId;
    const next = chooseNeighbor(start, dir);
    if (next != null && leafById.has(next)) {
      lastActivePaneId = next;
      win?.webContents.send("panes:active", next);
      focusPane(next);
    }
  }
);

// Handle pane-originated Space-to-omnibox requests as well
ipcMain.on("pane:req-focus-omni", (_e, { paneId }: { paneId: number }) => {
  // Focus omnibox for the global active pane, not necessarily the sender
  const targetId =
    lastActivePaneId ?? paneId ?? Array.from(leafById.keys())[0] ?? null;
  if (targetId != null) {
    win?.webContents.send("panes:focusOmni", targetId);
    try {
      win?.webContents.focus();
    } catch {}
  }
});

// IPC to set omnibox focus state from renderer
ipcMain.on("omnibox:focus", (_e, focused: boolean) => {
  omniboxFocused = !!focused;
});

app.whenReady().then(createWindow);
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
