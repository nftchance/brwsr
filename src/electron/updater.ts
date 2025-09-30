import { autoUpdater } from 'electron-updater'
import { app, dialog, BrowserWindow } from 'electron'

const isDev = !app.isPackaged || !!process.env.ELECTRON_START_URL

export function setupAutoUpdater(mainWindow: BrowserWindow) {
  // Skip auto-updater setup entirely in development
  if (isDev) {
    console.log('Auto-updater disabled in development mode')
    return
  }

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => {
    console.log('Checking for update...')
  })

  autoUpdater.on('update-available', (info) => {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Update available',
      message: 'A new version of Where is available!',
      detail: `Version ${info.version} is available (current version: ${app.getVersion()})`,
      buttons: ['Download', 'Later'],
      defaultId: 0
    }).then((result) => {
      if (result.response === 0) {
        autoUpdater.downloadUpdate()
      }
    })
  })

  autoUpdater.on('update-not-available', () => {
    console.log('Update not available')
  })

  autoUpdater.on('error', (err) => {
    console.error('Error in auto-updater:', err)
  })

  autoUpdater.on('download-progress', (progressObj) => {
    let log_message = 'Download speed: ' + progressObj.bytesPerSecond
    log_message = log_message + ' - Downloaded ' + progressObj.percent + '%'
    log_message = log_message + ' (' + progressObj.transferred + '/' + progressObj.total + ')'
    console.log(log_message)
  })

  autoUpdater.on('update-downloaded', () => {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Update ready',
      message: 'Install and restart now?',
      buttons: ['Yes', 'Later'],
      defaultId: 0
    }).then((result) => {
      if (result.response === 0) {
        autoUpdater.quitAndInstall()
      }
    })
  })

  return autoUpdater
}

export function checkForUpdates() {
  // Skip update checks in development
  if (isDev) {
    console.log('Skipping update check in development mode')
    return
  }
  
  try {
    autoUpdater.checkForUpdatesAndNotify().catch((error) => {
      console.log('Update check failed:', error.message)
    })
  } catch (error) {
    console.log('Update check error:', error)
  }
}