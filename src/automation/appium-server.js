const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { setTimeout: wait } = require('node:timers/promises')
const { appiumEntry } = require('../runtime-paths')

async function choosePort() {
  const net = require('node:net')
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(error => error ? reject(error) : resolve(port))
    })
  })
}

async function waitForServer(port, processRef) {
  const deadline = Date.now() + 30_000
  let lastError = null
  while (Date.now() < deadline) {
    if (processRef.exitCode !== null) throw new Error(`Appium 服务启动失败（退出码 ${processRef.exitCode}）。`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/status`)
      if (response.ok) return
    } catch (error) { lastError = error }
    await wait(300)
  }
  throw new Error(`Appium 服务启动超时：${lastError?.message || '未返回状态'}。`)
}

async function startAppium({ root, appiumHome, adbPath, log }) {
  if (!fs.existsSync(appiumEntry(root))) throw new Error('Appium 未安装。请重新安装桌面应用。')
  if (!fs.existsSync(path.join(appiumHome, 'node_modules', '.cache', 'appium', 'extensions.yaml'))) {
    throw new Error('内置 UiAutomator2 驱动缺失。请重新安装桌面应用。')
  }
  const port = await choosePort()
  const env = {
    ...process.env,
    APPIUM_HOME: appiumHome,
    // UiAutomator2 only needs platform-tools for this application. Present the
    // bundled directory as a minimal Android SDK so Appium never depends on a
    // developer-installed SDK.
    ANDROID_HOME: path.dirname(path.dirname(adbPath)),
    ANDROID_SDK_ROOT: path.dirname(path.dirname(adbPath)),
    PATH: `${path.dirname(adbPath)}${path.delimiter}${process.env.PATH || ''}`,
  }
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1'
  const processRef = spawn(process.execPath, [appiumEntry(root), '--address', '127.0.0.1', '--port', String(port), '--base-path', '/'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const relay = (chunk, isError = false) => {
    for (const line of String(chunk).replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/)) {
      if (line && (isError || /\b(error|warn|failed|fatal)\b/i.test(line))) log(`[Appium] ${line}`)
    }
  }
  processRef.stdout.on('data', chunk => relay(chunk))
  processRef.stderr.on('data', chunk => relay(chunk, true))
  try {
    await waitForServer(port, processRef)
  } catch (error) {
    processRef.kill()
    throw error
  }
  return {
    port,
    async stop() {
      if (processRef.exitCode === null) {
        processRef.kill('SIGTERM')
        await Promise.race([new Promise(resolve => processRef.once('close', resolve)), wait(5_000)])
        if (processRef.exitCode === null) processRef.kill('SIGKILL')
      }
    },
  }
}

module.exports = { startAppium }
