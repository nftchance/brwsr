import { WebContentsView } from "electron";

export type Rect = { x: number; y: number; width: number; height: number };

export type Leaf = {
  kind: "leaf";
  id: number;
  view: WebContentsView;
  url: string;
  title?: string;
  favicon?: string;
  description?: string;
  backgroundColor?: string;
  textColor?: string;
  image?: string;
  html?: string;
  layers?: WebContentsView[];
};

export type Split = {
  kind: "split";
  dir: "vertical" | "horizontal";
  size: number;
  a: Node;
  b: Node;
};

export type Node = Leaf | Split;

export type PaneState = {
  id: number;
  url: string;
  rect: Rect;
  title?: string;
  favicon?: string;
  description?: string;
  backgroundColor?: string;
  textColor?: string;
  image?: string;
};

export type SearchState = {
  query: string;
  paneId: number;
  isFocused: boolean;
};
