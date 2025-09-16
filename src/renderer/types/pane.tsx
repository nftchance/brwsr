export type Rect = { x: number; y: number; width: number; height: number };
export type PaneState = {
  id: number;
  url: string;
  title?: string;
  rect: Rect;
  favicon?: string;
  description?: string;
  backgroundColor?: string;
  textColor?: string;
  image?: string;
};
