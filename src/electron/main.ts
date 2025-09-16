import { app, BaseWindow } from "electron";

import { Window } from "./window";

app
  .whenReady()
  .then(() => new Window())
  .then((win) => win.init())
  .catch(console.error);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (BaseWindow.getAllWindows().length !== 0) return;

  const window = new Window();
  window.init();
});
