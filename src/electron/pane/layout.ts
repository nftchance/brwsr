import { BaseWindow } from "electron";

import { Leaf, Rect, Node, Split, PaneState } from "./types";
import { contentSize, PANE_GUTTER } from "./utils";
import { Pane } from "./pane";

export function setLeafBounds(win: BaseWindow, leaf: Leaf, rect: Rect) {
  if (!win) return;
  const { w, h } = contentSize(win);

  const leftG = rect.x > 0 ? PANE_GUTTER : 0;
  const rightG = rect.x + rect.width < w ? PANE_GUTTER : 0;
  const topG = rect.y > 0 ? PANE_GUTTER : 0;
  const bottomG = rect.y + rect.height < h ? PANE_GUTTER : 0;

  const x = rect.x + leftG;
  const y = rect.y + topG;
  const bw = Math.max(0, rect.width - (leftG + rightG));
  const bh = Math.max(0, rect.height - (topG + bottomG));

  leaf.layers?.forEach((layer) => {
    layer.setBounds({ x, y, width: bw, height: bh });
  });
}

export function layout(
  win: BaseWindow,
  node: Node,
  rect: Rect,
  out: PaneState[]
) {
  if (node.kind === "leaf") {
    setLeafBounds(win, node, rect);
    out.push({
      id: node.id,
      url: node.url,
      title: node.title ?? "",
      rect,
      favicon: node.favicon ?? "",
      backgroundColor: node.backgroundColor ?? "",
      textColor: node.textColor ?? "",
      description: node.description ?? "",
      image: node.image ?? "",
    });
    return;
  }
  const { dir, size, a, b } = node;
  if (dir === "vertical") {
    const availableWidth = rect.width - PANE_GUTTER;
    const wA = Math.floor(availableWidth * size);
    const wB = availableWidth - wA;
    const rectA = { x: rect.x, y: rect.y, width: wA, height: rect.height };
    const rectB = {
      x: rect.x + wA + PANE_GUTTER,
      y: rect.y,
      width: wB,
      height: rect.height,
    };
    layout(win, a, rectA, out);
    layout(win, b, rectB, out);
  } else {
    const availableHeight = rect.height - PANE_GUTTER;
    const hA = Math.floor(availableHeight * size);
    const hB = availableHeight - hA;
    const rectA = { x: rect.x, y: rect.y, width: rect.width, height: hA };
    const rectB = {
      x: rect.x,
      y: rect.y + hA + PANE_GUTTER,
      width: rect.width,
      height: hB,
    };
    layout(win, a, rectA, out);
    layout(win, b, rectB, out);
  }
}

export function findParent(
  node: Node,
  childId: number,
  parent: Split | null = null
): Split | null {
  if (node.kind === "leaf") return node.id === childId ? parent : null;
  return findParent(node.a, childId, node) || findParent(node.b, childId, node);
}

export function replaceChild(parent: Split, prev: Node, next: Node) {
  if (parent.a === prev) parent.a = next;
  else parent.b = next;
}

export function replaceNode(node: Node, targetId: number): Node | null {
  if (node.kind === "leaf") return node.id === targetId ? null : node;
  const a2 = replaceNode(node.a, targetId);
  const b2 = replaceNode(node.b, targetId);
  if (a2 === node.a && b2 === node.b) return node;
  if (a2 == null && b2 != null) return b2;
  if (b2 == null && a2 != null) return a2;
  return { ...node, a: a2!, b: b2! };
}

export function containsNode(node: Node, id: number): boolean {
  if (node.kind === "leaf") return node.id === id;
  return containsNode(node.a, id) || containsNode(node.b, id);
}

export function findSplitForResize(
  node: Node,
  targetId: number,
  axis: "vertical" | "horizontal"
): { split: Split; isInA: boolean } | null {
  if (node.kind === "leaf") return null;
  const inA = containsNode(node.a, targetId);
  const inB = !inA && containsNode(node.b, targetId);
  if (!inA && !inB) return null;

  const child = inA ? node.a : node.b;
  const deeper = findSplitForResize(child, targetId, axis);
  if (deeper) return deeper;

  if (node.dir === axis) {
    return { split: node, isInA: inA };
  }
  return null;
}

export function nudgeSplitSize(
  win: BaseWindow,
  root: Node | null,
  targetLeafId: number,
  direction: "left" | "right" | "up" | "down",
  step = 0.03
) {
  if (!root) return;
  const axis =
    direction === "left" || direction === "right" ? "vertical" : "horizontal";
  const found = findSplitForResize(root, targetLeafId, axis);
  if (!found) return;
  const { split, isInA } = found;

  let delta = step;
  if (axis === "vertical") {
    delta = direction === "left" ? -step : step;
    split.size = Math.max(
      0.05,
      Math.min(0.95, split.size + (isInA ? delta : -delta))
    );
  } else {
    delta = direction === "up" ? -step : step;
    split.size = Math.max(
      0.05,
      Math.min(0.95, split.size + (isInA ? delta : -delta))
    );
  }
  sendState(win, root, null);
}

export function sendState(
  win: BaseWindow,
  root: Node | null = null,
  pane: Pane | null = null
) {
  if (!win) return;
  const out: PaneState[] = [];
  if (root) {
    const { w, h } = contentSize(win);
    layout(win, root, { x: 0, y: 0, width: w, height: h }, out);
  }
  if (pane) {
    for (const layer of pane.leaf.layers ?? []) {
      layer.webContents.send("panes:update", out);
    }
  }
}
