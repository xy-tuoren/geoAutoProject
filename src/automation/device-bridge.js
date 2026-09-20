const { execFile } = require('node:child_process')
const { sleep } = require('./utils')
const { cancellationSignal } = require('./cancellation')

function adbError(error, output, timeout) {
  const timedOut = error.killed && error.signal && error.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
  return Object.assign(new Error(timedOut
    ? `ADB 命令超时（${timeout}ms），设备操作结果未确认。`
    : `${error.message}: ${String(output || '').trim()}`, { cause: error }), {
    code: timedOut ? 'ADB_COMMAND_TIMEOUT' : error.code,
    details: { timeout_ms: timeout },
  })
}

function adbCommand(adbPath, serial, args, { timeout = 15_000, signal = cancellationSignal() } = {}) {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    execFile(adbPath, ['-s', serial, ...args], { encoding: 'utf8', timeout, signal, windowsHide: true }, (error, stdout, stderr) => {
      if (signal?.aborted) reject(signal.reason)
      else if (error) reject(adbError(error, stderr || stdout, timeout))
      else resolve(String(stdout))
    })
  })
}

function adbBinaryCommand(adbPath, serial, args, { timeout = 30_000, signal = cancellationSignal() } = {}) {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    execFile(adbPath, ['-s', serial, ...args], { encoding: null, maxBuffer: 32 * 1024 * 1024, timeout, signal, windowsHide: true }, (error, stdout, stderr) => {
      if (signal?.aborted) reject(signal.reason)
      else if (error) reject(adbError(error, stderr || stdout, timeout))
      else resolve(Buffer.from(stdout))
    })
  })
}

function adbConnectionLost(error) {
  const message = String(error?.message || error)
  return /\bdevice(?:\s+['"]?[A-Za-z0-9._:-]+['"]?)?\s+(?:not found|not online|offline|unauthorized)\b|no devices\/emulators found|(?:^|:\s)(?:adb:\s*)?(?:error:\s*)?closed(?:$|[\s:])/i.test(message)
}

async function waitForAdbDevice(adbPath, serial, timeout = 30_000) {
  const deadline = Date.now() + timeout
  let lastError
  while (Date.now() < deadline) {
    try {
      const remaining = Math.max(1, deadline - Date.now())
      if ((await adbCommand(adbPath, serial, ['get-state'], { timeout: Math.min(5_000, remaining) })).trim() === 'device') return
    } catch (error) { lastError = error }
    const remaining = deadline - Date.now()
    if (remaining > 0) await sleep(Math.min(1_000, remaining))
  }
  throw new Error(`ADB 设备 ${serial} 未连接或未授权。请重新插拔 USB 数据线并在手机上确认“允许 USB 调试”。`, { cause: lastError })
}

async function adbScreenshot(adbPath, serial) {
  await waitForAdbDevice(adbPath, serial)
  try {
    return await adbBinaryCommand(adbPath, serial, ['exec-out', 'screencap', '-p'])
  } catch (error) {
    if (!adbConnectionLost(error)) throw error
    await waitForAdbDevice(adbPath, serial)
    return adbBinaryCommand(adbPath, serial, ['exec-out', 'screencap', '-p'])
  }
}

async function adbCommandWithReconnect(adbPath, serial, args) {
  await waitForAdbDevice(adbPath, serial)
  try {
    return await adbCommand(adbPath, serial, args)
  } catch (error) {
    if (!adbConnectionLost(error)) throw error
    await waitForAdbDevice(adbPath, serial)
    return adbCommand(adbPath, serial, args)
  }
}

async function adbCommandOnceConnected(adbPath, serial, args) {
  await waitForAdbDevice(adbPath, serial)
  return adbCommand(adbPath, serial, args)
}

module.exports = {
  adbCommand,
  adbBinaryCommand,
  adbConnectionLost,
  waitForAdbDevice,
  adbScreenshot,
  adbCommandWithReconnect,
  adbCommandOnceConnected,
}
