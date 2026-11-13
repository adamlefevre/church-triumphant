import { app, BrowserWindow, ipcMain, Menu, safeStorage, shell } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Core, type Host } from '../core/core'
import { seedDemo } from '../core/demo'
import { demoMailbox, providerFactory } from '../core/factory'
import { signIn } from '../core/oauth'
import type { FakeMailbox } from '../core/providers/fake'
import type { Api, ApiMethod } from '../shared/types'

// Lets tests and multiple profiles keep separate data.
if (process.env.MAIL_DATA_DIR) app.setPath('userData', process.env.MAIL_DATA_DIR)

let win: BrowserWindow | null = null
let core: Core | null = null

const host: Host = {
  async encrypt(plain) {
    return safeStorage.isEncryptionAvailable() ? 'v1:' + safeStorage.encryptString(plain).toString('base64') : 'v0:' + plain
  },
  async decrypt(cipher) {
    if (cipher.startsWith('v1:')) return safeStorage.decryptString(Buffer.from(cipher.slice(3), 'base64'))
    return cipher.slice(3)
  },
  async openExternal(url) {
    if (!/^https?:\/\//.test(url)) throw new Error('Refusing to open a non-web link')
    await shell.openExternal(url)
  },
  async openFile(filename, content) {
    const dir = join(app.getPath('temp'), 'church-triumphant-attachments')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, filename.replace(/[/\\:*?"<>|]/g, '_'))
    writeFileSync(path, content)
    await shell.openPath(path)
    return path
  },
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 760,
    minHeight: 480,
    backgroundColor: '#0f1115',
    title: 'Church Triumphant',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  win.once('ready-to-show', () => win?.show())
  // Links in mail open in the browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win?.webContents.getURL()) {
      e.preventDefault()
      if (/^(https?|mailto):/.test(url)) void shell.openExternal(url)
    }
  })
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
  win.on('closed', () => (win = null))
}

app.whenReady().then(async () => {
  const dataDir = app.getPath('userData')
  mkdirSync(dataDir, { recursive: true })
  const boxes = new Map<number, FakeMailbox>()
  core = new Core({
    dbPath: join(dataDir, 'mail.db'),
    host,
    createProvider: providerFactory(dataDir, boxes),
    oauthSignIn: (kind, settings, h) => signIn(kind, settings, h.openExternal),
    seedDemo: (c) => seedDemo(c, (id) => demoMailbox(dataDir, id, boxes)),
    emit: (event, payload) => win?.webContents.send(`core:${event}`, payload),
  })

  ipcMain.handle('api', async (_e, method: ApiMethod, args: unknown[]) => {
    const fn = core![method] as (...a: unknown[]) => unknown
    if (typeof fn !== 'function') throw new Error(`Unknown method ${method}`)
    return fn.apply(core, args)
  })

  if (process.env.MAIL_DEMO === '1' && core.accountsList().length === 0) await core.accountsAddDemo()

  if (process.platform !== 'darwin') Menu.setApplicationMenu(null)
  createWindow()
  core.start()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (!win) createWindow()
})

let quitting = false
app.on('before-quit', (e) => {
  if (quitting || !core) return
  e.preventDefault()
  quitting = true
  void core.stop().finally(() => app.quit())
})

export type { Api }
