const { app, BrowserWindow, dialog, ipcMain } = require('electron')
const { execFile } = require('node:child_process')
const fs = require('node:fs/promises')
const fsSync = require('node:fs')
const path = require('node:path')
const AdmZip = require('adm-zip')
const { createRunner, CancelledError } = require('../automation/runner')
const { loadQuestionFile } = require('../questions')
const { projectRoot, bundledAssetsRoot, resolveAdbPath, vendorAppiumHome, vendorAppiumHomeArchive } = require('../runtime-paths')

const root = projectRoot()
let activeTask = null

function adbCommand() {
  return resolveAdbPath({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, root })
}

function appRoot() { return app.getAppPath() }

async function appiumHome() {
  const assetsRoot = bundledAssetsRoot({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, root })
  const source = vendorAppiumHome(assetsRoot)
  if (!app.isPackaged) return source
  const archive = vendorAppiumHomeArchive(assetsRoot)
  const target = path.join(app.getPath('userData'), 'appium-home')
  const marker = path.join(target, '.bundled-version')
  const version = app.getVersion()
  const installed = await fs.readFile(marker, 'utf8').catch(() => '')
  if (installed !== version) {
    await fs.rm(target, { recursive: true, force: true })
    if (!fsSync.existsSync(archive)) throw new Error('内置 UiAutomator2 驱动资源缺失。请重新安装桌面应用。')
    new AdmZip(archive).extractAllTo(target, true)
    const manifest = path.join(target, 'node_modules', '.cache', 'appium', 'extensions.yaml')
    const contents = await fs.readFile(manifest, 'utf8')
    await fs.writeFile(manifest, contents.replace(/^\s+installPath: .*$/m, `    installPath: ${path.join(target, 'node_modules', 'appium-uiautomator2-driver')}`))
    await fs.writeFile(marker, version, 'utf8')
  }
  return target
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf8', ...options }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message))
      else resolve(stdout)
    })
  })
}

async function listDevices() {
  let output
  try {
    output = await run(adbCommand(), ['devices', '-l'])
  } catch (error) {
    throw new Error(`无法读取 ADB 设备：${error.message.includes('ENOENT') ? '内置 ADB 不可用，请重新安装桌面应用。' : error.message}`)
  }
  return output.split('\n').slice(1)
    .map(line => line.trim().split(/\s+/))
    .filter(parts => parts.length >= 2 && parts[1] === 'device')
    .map(parts => parts[0])
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1160,
    height: 780,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: '#f5f7fb',
    title: '提问自动化',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))
}

ipcMain.handle('dialog:select-directory', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
  return result.canceled ? null : result.filePaths[0]
})

ipcMain.handle('app:default-output-directory', () => path.join(app.getPath('documents'), 'QuestionCaptures'))

ipcMain.handle('dialog:select-questions', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: '问题文件', extensions: ['txt', 'csv', 'json', 'xlsx', 'xlsm'] }],
  })
  return result.canceled ? null : result.filePaths[0]
})

ipcMain.handle('automation:devices', async () => listDevices())

ipcMain.handle('questions:import', async (_event, payload) => {
  return loadQuestionFile(payload.file, payload.column || '问题')
})

ipcMain.handle('automation:start', async (event, payload) => {
  if (activeTask) throw new Error('已有任务正在执行。')
  if (!Array.isArray(payload.questions) || payload.questions.length === 0) throw new Error('请至少填写或导入一条问题。')
  if (!payload.serial || !payload.outputDir) throw new Error('请选择 Android 设备和截图目录。')
  const runner = createRunner({
    root: appRoot(),
    appiumHome: await appiumHome(),
    adbPath: adbCommand(),
    log: text => event.sender.send('automation:log', text),
  })
  activeTask = runner
  void runner.run(payload)
    .then(() => event.sender.send('automation:finished', { code: 0 }))
    .catch(error => {
      event.sender.send('automation:log', `${error.stack || error.message}\n`)
      event.sender.send('automation:finished', { code: error instanceof CancelledError ? 130 : 1 })
    })
    .finally(() => { activeTask = null })
  return true
})

ipcMain.handle('automation:stop', async () => {
  if (activeTask) await activeTask.stop()
})

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
