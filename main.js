/* const { app, BaseWindow, ipcMain, globalShortcut } = require("electron"); */
/* const path = require("path"); */
/**/
/* let win; */
/**/
/* const fs = require("fs"); */
/* const devUrl = process.env.VITE_DEV_SERVER_URL || "http://localhost:5173"; */
/* const isDev = !!process.env.ELECTRON_START_URL; */
/**/
/* function createWindow() { */
/*     win = new BaseWindow({ */
/*         width: 1280,  */
/*         height: 800,  */
/*         frame: false,  */
/*         titleBarStyle: "hidden", */
/*         webPreferences: { */
/*             preload: path.join(__dirname, "preload.js"), */
/*             contextIsolation: true, */
/*             nodeIntegration: false */
/*         } */
/*     }); */
/**/
/*     if (isDev) { */
/*         win.loadURL(devUrl); */
/*     } else { */
/*         const distIndex = path.join(__dirname, "dist", "index.html"); */
/*         if (!fs.existsSync(distIndex)) { */
/*             throw new Error(`Renderer not built: ${distIndex} missing. Run "pnpm build".`); */
/*         } */
/*         win.loadFile(distIndex); */
/*     } */
/* } */
/* app.whenReady().then(createWindow); */
/**/
/* app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); }); */
/* app.on("activate", () => { if (BaseWindow.getAllWindows().length === 0) createWindow(); }); */
/* app.on("will-quit", () => globalShortcut.unregisterAll()); */
/**/
/* ipcMain.on("app-close", () => win?.close()); */
/* ipcMain.on("app-minimize", () => win?.minimize()); */
/* ipcMain.on("app-maximize", () => { */
/*     if (!win) return; */
/*     if (win.isMaximized()) win.unmaximize(); */
/*     else win.maximize(); */
/* }); */
