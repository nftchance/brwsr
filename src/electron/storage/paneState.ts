import { app } from "electron";
import * as fs from "fs";
import * as path from "path";
import { Node } from "../pane/types";

const PANE_STATE_FILE = "pane-state.json";

export interface SavedPaneState {
  root: SerializedNode | null;
  lastActivePaneId: number | null;
  windowBounds?: {
    width: number;
    height: number;
    x?: number;
    y?: number;
  };
}

export interface SerializedLeaf {
  kind: "leaf";
  id: number;
  url: string;
  title?: string;
  favicon?: string;
  description?: string;
  backgroundColor?: string;
  textColor?: string;
  image?: string;
}

export interface SerializedSplit {
  kind: "split";
  dir: "vertical" | "horizontal";
  size: number;
  a: SerializedNode;
  b: SerializedNode;
}

export type SerializedNode = SerializedLeaf | SerializedSplit;

export function savePaneState(state: SavedPaneState): void {
  try {
    const userDataPath = app.getPath("userData");
    const filePath = path.join(userDataPath, PANE_STATE_FILE);
    
    if (!fs.existsSync(userDataPath)) {
      fs.mkdirSync(userDataPath, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf-8");
  } catch (error) {
    console.error("Failed to save pane state:", error);
  }
}

export function loadPaneState(): SavedPaneState | null {
  try {
    const userDataPath = app.getPath("userData");
    const filePath = path.join(userDataPath, PANE_STATE_FILE);
    
    if (!fs.existsSync(filePath)) {
      return null;
    }
    
    const data = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(data);
  } catch (error) {
    console.error("Failed to load pane state:", error);
    return null;
  }
}

export function serializeNode(node: Node | null): SerializedNode | null {
  if (!node) return null;
  
  if (node.kind === "leaf") {
    return {
      kind: "leaf",
      id: node.id,
      url: node.url,
      title: node.title,
      favicon: node.favicon,
      description: node.description,
      backgroundColor: node.backgroundColor,
      textColor: node.textColor,
      image: node.image,
    };
  } else {
    return {
      kind: "split",
      dir: node.dir,
      size: node.size,
      a: serializeNode(node.a)!,
      b: serializeNode(node.b)!,
    };
  }
}