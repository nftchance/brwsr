import { BaseWindow } from "electron";

export const PANE_GUTTER = 1;

export function contentSize(win: BaseWindow) {
  if (!win) return { w: 0, h: 0 };
  const [w, h] = win.getContentSize();
  return { w, h };
}

export function allocId() {
  return Date.now() + Math.floor(Math.random() * 1000);
}

export function error(url: string, code: number, desc: string) {
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
