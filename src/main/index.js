const { app, BrowserWindow, dialog, ipcMain, clipboard } = require('electron')
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

function stamp() {
  return new Date().toISOString().replace('T', ' ').replace('Z', '')
}

function log(...parts) {
  process.stdout.write(`[${stamp()}] ${parts.join(' ')}\n`)
}

function logError(...parts) {
  process.stderr.write(`[${stamp()}] ERROR ${parts.join(' ')}\n`)
}

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
    log('解压内置 Appium 驱动到', target)
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
  const adb = adbCommand()
  log('读取 ADB 设备:', adb)
  let output
  try {
    output = await run(adb, ['devices', '-l'])
  } catch (error) {
    logError('ADB 读取失败:', error.message)
    throw new Error(`无法读取 ADB 设备：${error.message.includes('ENOENT') ? '内置 ADB 不可用，请重新安装桌面应用。' : error.message}`)
  }
  const devices = output.split('\n').slice(1)
    .map(line => line.trim().split(/\s+/))
    .filter(parts => parts.length >= 2 && parts[1] === 'device')
    .map(parts => parts[0])
  log(devices.length ? `已发现设备: ${devices.join(', ')}` : '未发现已授权设备')
  return devices
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1220,
    height: 860,
    minWidth: 960,
    minHeight: 700,
    backgroundColor: '#eef2f8',
    title: '提问自动化',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  window.webContents.on('console-message', (event, level, message, line, sourceId) => {
    const details = event && typeof event.message === 'string' ? event : null
    const msg = details ? details.message : message
    const lvl = details ? details.level : level
    const lineNo = details ? details.lineNumber : line
    const src = details ? details.sourceId : sourceId
    const tag = typeof lvl === 'string' ? lvl : (['debug', 'info', 'warn', 'error'][lvl] || 'log')
    const source = src ? ` (${path.basename(String(src))}:${lineNo})` : ''
    if (tag === 'error' || tag === 'warn' || lvl === 2 || lvl === 3) logError(`[renderer:${tag}] ${msg}${source}`)
    else log(`[renderer:${tag}] ${msg}${source}`)
  })
  window.webContents.on('did-fail-load', (_event, code, desc, url) => {
    logError('页面加载失败:', code, desc, url)
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    logError('渲染进程异常退出:', details.reason, details.exitCode)
  })
  window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))
  log('主窗口已创建')
}

ipcMain.handle('dialog:select-directory', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
  if (!result.canceled) log('选择截图目录:', result.filePaths[0])
  return result.canceled ? null : result.filePaths[0]
})

ipcMain.handle('app:default-output-directory', () => path.join(app.getPath('documents'), 'QuestionCaptures'))

ipcMain.handle('dialog:select-questions', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: '问题文件', extensions: ['txt', 'csv', 'json', 'xlsx', 'xlsm'] }],
  })
  if (!result.canceled) log('选择问题文件:', result.filePaths[0])
  return result.canceled ? null : result.filePaths[0]
})

ipcMain.handle('automation:devices', async () => listDevices())

ipcMain.handle('questions:import', async (_event, payload) => {
  log('导入问题文件:', payload.file, `列=${payload.column || '问题'}`)
  try {
    const questions = await loadQuestionFile(payload.file, payload.column || '问题')
    log(`导入完成: ${questions.length} 条问题`)
    return questions
  } catch (error) {
    logError('导入失败:', error.message)
    throw error
  }
})

ipcMain.handle('automation:start', async (event, payload) => {
  if (activeTask) throw new Error('已有任务正在执行。')
  if (!Array.isArray(payload.questions) || payload.questions.length === 0) throw new Error('请至少填写或导入一条问题。')
  if (!payload.serial || !payload.outputDir) throw new Error('请选择 Android 设备和截图目录。')
  log('启动任务:', `serial=${payload.serial}`, `questions=${payload.questions.length}`, `output=${payload.outputDir}`)
  const runner = createRunner({
    root: appRoot(),
    appiumHome: await appiumHome(),
    adbPath: adbCommand(),
    log: text => {
      process.stdout.write(text.endsWith('\n') ? text : `${text}\n`)
      event.sender.send('automation:log', text)
    },
  })
  activeTask = runner
  void runner.run(payload)
    .then(() => {
      log('任务完成')
      event.sender.send('automation:finished', { code: 0 })
    })
    .catch(error => {
      logError('任务失败:', error.message)
      event.sender.send('automation:log', `${error.stack || error.message}\n`)
      event.sender.send('automation:finished', { code: error instanceof CancelledError ? 130 : 1 })
    })
    .finally(() => { activeTask = null })
  return true
})

ipcMain.handle('automation:stop', async () => {
  if (!activeTask) {
    log('收到停止请求，但当前无运行中任务')
    return
  }
  log('正在停止任务…')
  await activeTask.stop()
})

ipcMain.handle('clipboard:write', (_event, text) => {
  clipboard.writeText(String(text ?? ''))
  return true
})

ipcMain.handle('log:export', async (_event, text) => {
  const stampName = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const result = await dialog.showSaveDialog({
    title: '导出执行日志',
    defaultPath: path.join(app.getPath('documents'), `提问自动化日志_${stampName}.txt`),
    filters: [{ name: '文本文件', extensions: ['txt'] }],
  })
  if (result.canceled || !result.filePath) {
    log('取消导出日志')
    return null
  }
  const target = result.filePath.toLowerCase().endsWith('.txt') ? result.filePath : `${result.filePath}.txt`
  await fs.writeFile(target, String(text ?? ''), 'utf8')
  log('日志已导出:', target)
  return target
})

process.on('uncaughtException', error => {
  logError('未捕获异常:', error.stack || error.message)
})
process.on('unhandledRejection', reason => {
  logError('未处理 Promise 拒绝:', reason?.stack || reason)
})

app.whenReady().then(() => {
  log('应用就绪', `v${app.getVersion()}`, app.isPackaged ? '(packaged)' : '(dev)')
  log('ADB:', adbCommand())
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', () => {
  log('所有窗口已关闭')
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => { log('应用即将退出') })
