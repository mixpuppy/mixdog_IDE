import { app, BrowserWindow, ipcMain, dialog, shell, screen, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { join, basename } from 'path'
import { promises as fs, statSync } from 'fs'
import { publish } from './core/events'
import './core/commands'
import './ipc'
import { syncWebResource } from './tools/tomcat'
import { killAllTerms, killWindowTerms } from './core/pty'
import { markOwnWrite, syncWatchers } from './core/watcher'
import { syncGitWatchers } from './tools/git'
import './ai/claude'
import { sanitizeHostClaudeEnv } from './core/env'
import { registerWindow, allWindows, ctxOf, windowsFor, runInScope, scopeOf } from './core/windows'

// Must run before any child process is spawned.
const removedHostEnv = sanitizeHostClaudeEnv()

// The installed app uses %APPDATA%\mixdog-ide; the dev build (npm run dev) gets its own profile
// so both can run side by side - you keep using the app while it is being developed.
// Tool settings (JDKs, Tomcat, run configs) stay shared: see core/settings.ts.
app.setPath('userData', join(app.getPath('appData'), app.isPackaged ? 'mixdog-ide' : 'mixdog-ide-dev'))

/** A folder given on the command line (`mixdog-ide D:\work\proj`) or via MIXDOG_PROJECT. */
function folderArg(argv: string[], env = true): string | null {
  const candidates = [...argv.slice(1), env ? process.env['MIXDOG_PROJECT'] ?? '' : '']
  for (const c of candidates) {
    if (!c || c.startsWith('-') || c === '.') continue
    try {
      if (statSync(c).isDirectory()) return c
    } catch {
      /* not a path */
    }
  }
  return null
}

// One IDE process with many windows. Launching the EXE again with a folder opens that
// folder in a new window (or focuses the window that already has it); without a folder it
// just brings the IDE to the front.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    const folder = folderArg(argv, false)
    if (folder) {
      openProjectWindow(folder)
      return
    }
    const last = allWindows().pop()
    if (last) focus(last.win)
    else createWindow(null)
  })
}

function focus(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/** Open a project: focus the window that already shows it, else a new window. */
function openProjectWindow(folder: string): void {
  const existing = windowsFor(folder).find((c) => c.project?.toLowerCase() === folder.toLowerCase())
  if (existing) focus(existing.win)
  else createWindow(folder)
}

function createWindow(initialProject: string | null): BrowserWindow {
  const area = screen.getPrimaryDisplay().workAreaSize
  const others = BrowserWindow.getAllWindows()
  const win = new BrowserWindow({
    width: Math.min(1440, Math.round(area.width * 0.9)),
    height: Math.min(920, Math.round(area.height * 0.9)),
    center: others.length === 0,
    minWidth: 900,
    minHeight: 560,
    show: false,
    // Hide the native title bar but keep the Windows frame (snap layouts, rounded corners, shadow).
    titleBarStyle: 'hidden',
    // Windows 11 translucent material = macOS-like vibrancy for the sidebar.
    backgroundMaterial: process.platform === 'win32' ? 'mica' : undefined,
    backgroundColor: '#00000000',
    icon: app.isPackaged ? undefined : join(__dirname, '../../build/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  // cascade new windows a little so they don't sit exactly on top of each other
  const prev = others[others.length - 1]
  if (prev) {
    const [x, y] = prev.getPosition()
    win.setPosition(x + 32, y + 32)
  }

  const ctx = registerWindow(win, initialProject)
  const wc = win.webContents
  win.once('ready-to-show', () => win.show())
  win.on('maximize', () => wc.send('window:state', { maximized: true }))
  win.on('unmaximize', () => wc.send('window:state', { maximized: false }))
  win.on('focus', () => wc.send('window:focus', true))
  win.on('blur', () => wc.send('window:focus', false))
  win.on('closed', () => {
    killWindowTerms(wc)
    // the closed window's project may not need its watchers any more
    setImmediate(() => {
      syncWatchers()
      syncGitWatchers()
    })
  })
  void ctx

  // External links open in the default browser, never inside the IDE.
  wc.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

const senderWin = (e: IpcMainEvent | IpcMainInvokeEvent): BrowserWindow | null => BrowserWindow.fromWebContents(e.sender)

/* ---------- window controls (traffic lights) - act on the window that asked ---------- */
ipcMain.on('window:close', (e) => senderWin(e)?.close())
ipcMain.on('window:minimize', (e) => senderWin(e)?.minimize())
ipcMain.on('window:toggleMaximize', (e) => {
  const win = senderWin(e)
  if (!win) return
  win.isMaximized() ? win.unmaximize() : win.maximize()
})

/* ---------- windows ---------- */
ipcMain.handle('app:newWindow', (_e, folder: string | null) => {
  if (folder) openProjectWindow(folder)
  else createWindow(null)
  return true
})
ipcMain.handle('app:openFolderInNewWindow', async (e) => {
  const win = senderWin(e)
  const r = await (win ? dialog.showOpenDialog(win, { properties: ['openDirectory'] }) : dialog.showOpenDialog({ properties: ['openDirectory'] }))
  if (r.canceled || !r.filePaths[0]) return false
  openProjectWindow(r.filePaths[0])
  return true
})

/* ---------- file system ---------- */
export interface DirEntry {
  name: string
  path: string
  isDir: boolean
}

ipcMain.handle('fs:openFolder', async (e) => {
  const win = senderWin(e)
  if (!win) return null
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
  if (r.canceled || r.filePaths.length === 0) return null
  const path = r.filePaths[0]
  return { path, name: basename(path) }
})

ipcMain.handle('fs:readDir', async (_e, dir: string): Promise<DirEntry[]> => {
  const items = await fs.readdir(dir, { withFileTypes: true })
  return items
    .map((d) => ({ name: d.name, path: join(dir, d.name), isDir: d.isDirectory() }))
    .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
})

/** The project this window should open on start (new window / command line / MIXDOG_PROJECT). */
ipcMain.handle('app:initialProject', async (e) => {
  const ctx = ctxOf(e.sender)
  // a reloaded window comes back with the project it had open
  const p = ctx?.initialProject ?? ctx?.project
  if (!ctx || !p) return null
  ctx.initialProject = null
  return { path: p, name: basename(p) }
})

ipcMain.handle('fs:readFile', async (_e, path: string) => fs.readFile(path, 'utf-8'))
ipcMain.handle('fs:writeFile', async (e, path: string, content: string) => {
  markOwnWrite(path)
  await fs.writeFile(path, content, 'utf-8')
  runInScope(scopeOf(ctxOf(e.sender)), () => {
    publish('file.save', { path, length: content.length }, 'user')
    syncWebResource(path).catch((err) => publish('error', { message: `리소스 동기화 실패: ${err}` }))
  })
  return true
})

app.whenReady().then(async () => {
  if (removedHostEnv.length) publish('app.env.sanitized', { removed: removedHostEnv.length })
  createWindow(folderArg(process.argv))
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(null)
  })
})

app.on('before-quit', () => killAllTerms())

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
