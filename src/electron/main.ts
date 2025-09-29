import { app, BaseWindow } from "electron";
import * as path from "path";

import { Window } from "./window";

app.setName("Where");
app.setAboutPanelOptions({
  applicationName: "Where",
  applicationVersion: "0.1.0",
  copyright: "© 2024 Where Browser",
  credits: "Navigate the web with purpose"
});

if (process.platform === 'darwin') {
  app.dock.setIcon(path.join(__dirname, '..', 'assets', 'icon.png'));
}

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
