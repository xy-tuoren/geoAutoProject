const { app, BrowserWindow, dialog, ipcMain, clipboard } = require('electron')
const { autoUpdater } = require('electron-updater')
const { execFile } = require('node:child_process')
const fs = require('node:fs/promises')
const path = require('node:path')
const { createDeviceTasks } = require('./device-tasks')
const { createDevicePreview } = require('./device-preview')
const { interruptRunning } = require('../automation/batch-state')
const { automationEntries, normalizeAutomationEntries } = require('../automation/entry-catalog')
const { loadQuestionFile } = require('../questions')
const { parseProductWorkbook } = require('../product-question-import')
const { normalizeQuestionPlan } = require('../question-plan')
const { projectRoot, resolveAdbPath, bundledScrcpyServer } = require('../runtime-paths')
const { createUpdateManager } = require('./updater')

const root = projectRoot()
let updateManager = null
let connectedDevices = new Set()
let quitting = false
const previews = createDevicePreview({ adbPath: adbCommand, serverPath: () => bundledScrcpyServer({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, root }), log })
const tasks = createDeviceTasks({
  runnerOptions: { root: appRoot(), isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, adbPath: adbCommand() },
  emit: (type, value) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.webContents.isDestroyed()) window.webContents.send(`automation:${type}`, value)
    }
  },
  changed: () => updateManager?.notify(),
})

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
function windowIconPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'assets', 'app-icon.png')
    : path.join(root, 'assets', 'app-icon.png')
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
    output = await run(adb, ['devices', '-l'], { timeout: 5_000, windowsHide: true })
  } catch (error) {
    logError('ADB 读取失败:', error.message)
    throw new Error(`无法读取 ADB 设备：${error.message.includes('ENOENT') ? '内置 ADB 不可用，请重新安装桌面应用。' : error.message}`)
  }
  const devices = output.split('\n').slice(1)
    .map(line => line.trim().split(/\s+/))
    .filter(parts => parts.length >= 2 && parts[1] === 'device')
    .map(parts => parts[0])
  log(devices.length ? `已发现设备: ${devices.join(', ')}` : '未发现已授权设备')
  connectedDevices = new Set(devices)
  return devices
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1220,
    height: 860,
    minWidth: 960,
    minHeight: 700,
    backgroundColor: '#eef2f8',
    title: '莲藕医生AI监测系统（数据采集）',
    icon: windowIconPath(),
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
    void previews.stop(undefined, undefined, window.webContents.id)
  })
  const owner = window.webContents.id
  const stopPreviews = () => { void previews.stop(undefined, undefined, owner) }
  window.on('hide', stopPreviews)
  window.on('minimize', stopPreviews)
  window.webContents.on('did-start-loading', stopPreviews)
  window.webContents.on('destroyed', stopPreviews)
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

ipcMain.handle('dialog:select-product-workbook', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: '商品信息表格', extensions: ['xlsx'] }],
  })
  if (!result.canceled) log('选择商品信息表格:', result.filePaths[0])
  return result.canceled ? null : result.filePaths[0]
})

ipcMain.handle('automation:devices', async () => listDevices())
ipcMain.handle('automation:entries', () => automationEntries())
ipcMain.handle('automation:tasks', () => tasks.snapshot())
ipcMain.handle('automation:preview-start', async (event, serial, streamId) => {
  if (!connectedDevices.has(serial)) throw new Error('手机未连接，请刷新设备列表。')
  if (typeof streamId !== 'string' || !streamId || streamId.length > 256) throw new Error('预览会话标识无效。')
  if (!BrowserWindow.fromWebContents(event.sender)?.isVisible()) throw new Error('窗口不可见，画面预览已暂停。')
  await previews.start(serial, streamId, event.sender.id, message => {
    if (!event.sender.isDestroyed()) event.sender.send('automation:preview-event', message)
  })
})
ipcMain.handle('automation:preview-stop', (event, serial, streamId) => previews.stop(serial, streamId, event.sender.id))
ipcMain.on('automation:preview-ack', (event, serial, streamId, sequence) => previews.acknowledge(serial, streamId, sequence, event.sender.id))

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

ipcMain.handle('product-questions:import', async (_event, file) => {
  log('导入商品信息表格:', file)
  try {
    const products = parseProductWorkbook(file)
    log(`商品信息导入完成: ${products.length} 行`)
    return products
  } catch (error) {
    logError('商品信息导入失败:', error.message)
    throw error
  }
})

ipcMain.handle('automation:start', async (_event, payload) => {
  const questionPlan = normalizeQuestionPlan(payload)
  payload.questions = questionPlan.questions
  payload.brandGroups = questionPlan.brandGroups
  payload.questionPlanMode = questionPlan.mode
  if (!payload.serial || !payload.outputDir) throw new Error('请选择 Android 设备和截图目录。')
  const entries = normalizeAutomationEntries(payload.entries)
  payload.entries = entries.map(entry => entry.id)
  payload.newSession = true
  if (!(await listDevices()).includes(payload.serial)) throw new Error('所选手机已断开，请刷新设备列表。')
  log('启动任务:', `serial=${payload.serial}`, `entries=${payload.entries.join(',')}`, `mode=${questionPlan.mode}`, `questions=${payload.questions.length}`, `output=${payload.outputDir}`)
  return tasks.start(payload)
})

ipcMain.handle('automation:retry-failed', async (_event, payload) => {
  if (!payload?.serial || !payload?.batchDirectory) throw new Error('请选择 Android 设备并保留原批次后再重试。')
  if (!(await listDevices()).includes(payload.serial)) throw new Error('所选手机已断开，请刷新设备列表。')
  payload.batchDirectory = await fs.realpath(payload.batchDirectory)
  payload.newSession = true
  if (payload.resume) {
    const summary = interruptRunning(JSON.parse(await fs.readFile(path.join(payload.batchDirectory, '调试产物', 'batch-summary.json'), 'utf8')))
    if (summary.needs_confirmation) {
      const choice = await dialog.showMessageBox({
        type: 'question', title: '中断题目需要确认',
        message: `有 ${summary.needs_confirmation} 题在中断时可能已输入或发送。`,
        detail: '默认只继续未开始和已失败的题。选择重新采集中断题会重新搜索或提问，可能产生重复记录。',
        buttons: ['仅继续未开始和失败题', '同时重新采集中断题', '取消'], defaultId: 0, cancelId: 2,
      })
      if (choice.response === 2) return false
      payload.includeUncertain = choice.response === 1
    } else payload.includeUncertain = false
  }
  log('重试失败题:', `serial=${payload.serial}`, `batch=${payload.batchDirectory}`)
  return tasks.start(payload, 'retryFailedBatch')
})

ipcMain.handle('automation:stop', async (_event, serial) => tasks.stop(serial))

ipcMain.handle('clipboard:write', (_event, text) => {
  clipboard.writeText(String(text ?? ''))
  return true
})

ipcMain.handle('log:export', async (_event, text) => {
  const stampName = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const result = await dialog.showSaveDialog({
    title: '导出执行日志',
    defaultPath: path.join(app.getPath('documents'), `莲藕医生AI监测系统（数据采集）日志_${stampName}.txt`),
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

ipcMain.handle('update:state', () => updateManager?.snapshot() || {
  status: 'unsupported',
  currentVersion: app.getVersion(),
  supported: false,
  taskActive: tasks.size > 0,
  canInstall: false,
})
ipcMain.handle('update:check', () => updateManager.check())
ipcMain.handle('update:download', () => updateManager.download())
ipcMain.handle('update:install', () => updateManager.install())

process.on('uncaughtException', error => {
  logError('未捕获异常:', error.stack || error.message)
})
process.on('unhandledRejection', reason => {
  logError('未处理 Promise 拒绝:', reason?.stack || reason)
})

app.whenReady().then(() => {
  log('应用就绪', `v${app.getVersion()}`, app.isPackaged ? '(packaged)' : '(dev)')
  log('ADB:', adbCommand())
  updateManager = createUpdateManager({
    app,
    autoUpdater,
    BrowserWindow,
    isTaskActive: () => tasks.size > 0,
    log,
    logError,
  })
  createWindow()
  updateManager.start()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', () => {
  log('所有窗口已关闭')
  previews.stop()
  tasks.stop()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', event => {
  if (!tasks.size && !previews.size) return
  event.preventDefault()
  if (quitting) return
  quitting = true
  tasks.stop()
  void Promise.all([tasks.whenIdle(), previews.stop()]).then(() => app.quit())
})

app.on('will-quit', () => {
  updateManager?.stop()
  log('应用即将退出')
})
