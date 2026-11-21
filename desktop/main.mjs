import { app, BrowserWindow, dialog, safeStorage, session, shell } from 'electron'
import { isAbsolute, join } from 'node:path'
import { createAiSettings } from './settings.mjs'
import { startDesktopServer } from './server.mjs'

let mainWindow
let backend

async function openWindow() {
  const { origin, token } = backend
  const appSession = session.fromPartition('serenity-desktop')
  appSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  appSession.setPermissionCheckHandler(() => false)
  appSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const requestHeaders = details.requestHeaders
    if (new URL(details.url).origin === origin) requestHeaders['X-Serenity-Session'] = token
    callback({ requestHeaders })
  })

  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    autoHideMenuBar: true,
    webPreferences: { session: appSession, sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  mainWindow = window
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) && !url.startsWith(origin + '/')) void shell.openExternal(url).catch(() => {})
    return { action: 'deny' }
  })
  window.webContents.on('will-prevent-unload', (event) => {
    const selected = dialog.showMessageBoxSync(window, {
      type: 'warning',
      message: '画布还有更改未写入磁盘。',
      buttons: ['返回画布', '放弃未保存的更改'],
      defaultId: 0,
      cancelId: 0,
    })
    if (selected === 1) event.preventDefault()
  })
  window.on('closed', () => { mainWindow = undefined })
  await window.loadURL(origin)
}

function startupFailed(error) {
  dialog.showErrorBox('Serenity Map 无法启动', String(error.message || error))
  app.quit()
}

const profileDir = app.commandLine.getSwitchValue('user-data-dir')
if (isAbsolute(profileDir)) app.setPath('userData', profileDir)

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })
  app.whenReady().then(async () => {
    const dataDir = app.getPath('userData')
    const settings = await createAiSettings(join(dataDir, 'ai-settings.json'), safeStorage)
    backend = await startDesktopServer({
      distDir: join(app.getAppPath(), 'dist'),
      storeDir: join(dataDir, 'store'),
      settings,
    })
    await openWindow()
  }).catch(startupFailed)
  app.on('window-all-closed', () => app.quit())
  app.on('will-quit', () => backend?.close())
}
