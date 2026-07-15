const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000
const UPDATE_STARTUP_DELAY_MS = 3_000

function errorMessage(error) {
  return String(error?.message || error || '未知错误')
}

function createUpdateManager({
  app,
  autoUpdater,
  BrowserWindow,
  platform = process.platform,
  isTaskActive = () => false,
  log = () => {},
  logError = () => {},
  timers = { setTimeout, setInterval, clearTimeout, clearInterval },
}) {
  const currentVersion = app.getVersion()
  const supported = Boolean(app.isPackaged && platform === 'win32')
  let started = false
  let startupTimer = null
  let intervalTimer = null
  let state = {
    status: supported ? 'idle' : 'unsupported',
    currentVersion,
    version: null,
    percent: null,
    message: supported ? '可检查更新' : '仅 Windows 安装包支持自动更新',
  }

  function snapshot() {
    const taskActive = Boolean(isTaskActive())
    const message = state.status === 'downloaded'
      ? (taskActive ? '更新已下载，任务结束后可安装' : '更新已下载，可以重启安装')
      : state.message
    return {
      ...state,
      message,
      supported,
      taskActive,
      canInstall: supported && state.status === 'downloaded' && !taskActive,
    }
  }

  function notify() {
    const value = snapshot()
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('update:state', value)
    }
    return value
  }

  function transition(status, values = {}) {
    state = { ...state, ...values, status }
    return notify()
  }

  function fail(error, prefix = '更新失败') {
    const message = errorMessage(error)
    logError(`${prefix}:`, message)
    return transition('error', { message, percent: null })
  }

  function bindEvents() {
    autoUpdater.on('checking-for-update', () => {
      log('正在检查应用更新')
      transition('checking', { message: '正在检查更新…', percent: null })
    })
    autoUpdater.on('update-available', info => {
      log('发现应用更新:', `v${info.version}`)
      transition('available', {
        version: info.version,
        message: `发现新版本 v${info.version}`,
        percent: null,
      })
    })
    autoUpdater.on('update-not-available', info => {
      log('当前已是最新版本:', `v${currentVersion}`)
      transition('not-available', {
        version: info?.version || currentVersion,
        message: '当前已是最新版本',
        percent: null,
      })
    })
    autoUpdater.on('download-progress', progress => {
      const percent = Math.max(0, Math.min(100, Number(progress?.percent) || 0))
      transition('downloading', {
        message: `正在下载更新 ${Math.round(percent)}%`,
        percent,
      })
    })
    autoUpdater.on('update-downloaded', info => {
      log('应用更新下载完成:', `v${info.version}`)
      transition('downloaded', {
        version: info.version,
        message: isTaskActive() ? '更新已下载，任务结束后可安装' : '更新已下载，可以重启安装',
        percent: 100,
      })
    })
    autoUpdater.on('error', error => fail(error))
  }

  async function check() {
    if (!supported) return snapshot()
    if (['checking', 'available', 'downloading', 'downloaded'].includes(state.status)) return snapshot()
    transition('checking', { message: '正在检查更新…', percent: null })
    try {
      await autoUpdater.checkForUpdates()
    } catch (error) {
      fail(error, '检查更新失败')
    }
    return snapshot()
  }

  async function download() {
    if (!supported) throw new Error('当前环境不支持自动更新。')
    if (state.status !== 'available') throw new Error('当前没有可下载的新版本。')
    transition('downloading', { message: '正在下载更新 0%', percent: 0 })
    try {
      await autoUpdater.downloadUpdate()
    } catch (error) {
      fail(error, '下载更新失败')
      throw error
    }
    return snapshot()
  }

  function install() {
    if (!supported) throw new Error('当前环境不支持自动更新。')
    if (state.status !== 'downloaded') throw new Error('更新尚未下载完成。')
    if (isTaskActive()) {
      transition('downloaded', { message: '更新已下载，任务结束后可安装' })
      throw new Error('自动化任务正在执行，请等待任务结束后再重启安装。')
    }
    log('正在重启并安装应用更新:', `v${state.version}`)
    autoUpdater.quitAndInstall(false, true)
    return true
  }

  function start({ autoCheck = true, startupDelayMs = UPDATE_STARTUP_DELAY_MS, intervalMs = UPDATE_CHECK_INTERVAL_MS } = {}) {
    if (started) return snapshot()
    started = true
    if (!supported) return notify()
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.allowPrerelease = currentVersion.includes('-')
    bindEvents()
    notify()
    if (autoCheck) {
      startupTimer = timers.setTimeout(() => { void check() }, startupDelayMs)
      intervalTimer = timers.setInterval(() => { void check() }, intervalMs)
      startupTimer?.unref?.()
      intervalTimer?.unref?.()
    }
    return snapshot()
  }

  function stop() {
    if (startupTimer) timers.clearTimeout(startupTimer)
    if (intervalTimer) timers.clearInterval(intervalTimer)
    startupTimer = null
    intervalTimer = null
  }

  return { start, stop, check, download, install, snapshot, notify }
}

module.exports = {
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_STARTUP_DELAY_MS,
  createUpdateManager,
}
