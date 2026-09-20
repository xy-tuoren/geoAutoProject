const test = require('node:test')
const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const nativeExecFile = childProcess.execFile
const { withCancellation } = require('../../src/automation/cancellation')

function bridgeWithProcess(t, execFile) {
  t.mock.method(childProcess, 'execFile', execFile)
  delete require.cache[require.resolve('../../src/automation/device-bridge')]
  return require('../../src/automation/device-bridge')
}

test('ADB 文本和 PNG 命令卡住时由子进程超时终止并保留原始错误', async t => {
  const bridge = bridgeWithProcess(t, (_file, _args, options, callback) =>
    nativeExecFile(process.execPath, ['-e', 'setTimeout(() => process.stdout.write("late"), 600)'], options, callback))
  for (const command of [bridge.adbCommand, bridge.adbBinaryCommand]) {
    await assert.rejects(command('adb', 'SERIAL', ['shell', 'test'], { timeout: 50 }), error => {
      assert.equal(error.code, 'ADB_COMMAND_TIMEOUT')
      assert.equal(error.cause.killed, true)
      assert.equal(error.details.timeout_ms, 50)
      return true
    })
  }
})

test('等待设备的截止时间也限制卡住的 get-state 子进程', async t => {
  const bridge = bridgeWithProcess(t, (_file, _args, options, callback) =>
    nativeExecFile(process.execPath, ['-e', 'setTimeout(() => process.stdout.write("device"), 600)'], options, callback))
  const started = Date.now()
  await assert.rejects(bridge.waitForAdbDevice('adb', 'SERIAL', 100), /未连接或未授权/)
  assert.ok(Date.now() - started < 500, '设备等待不应超出截止时间后继续阻塞或额外睡眠')
})

test('滑动超时不重放；命令超时应终止整批并提供处理建议', async t => {
  const calls = []
  const bridge = bridgeWithProcess(t, (_file, args, _options, callback) => {
    calls.push(args.slice(2))
    if (args[2] === 'get-state') callback(null, 'device', '')
    else callback(Object.assign(new Error('process timed out'), { killed: true, signal: 'SIGTERM' }), '', '')
  })
  const failure = await bridge.adbCommandOnceConnected('adb', 'SERIAL', ['shell', 'input', 'swipe', '1', '2', '1', '3', '250']).catch(error => error)
  assert.equal(failure.code, 'ADB_COMMAND_TIMEOUT')
  assert.equal(calls.length, 2)
  const { automationErrorInfo } = require('../../src/automation/batch-recovery')
  const info = automationErrorInfo(failure)
  assert.equal(info.code, 'ADB_COMMAND_TIMEOUT')
  assert.equal(info.fatal, true)
  assert.match(info.action, /USB/)
})

test('停止信号取消卡住的ADB文本和PNG子进程，不等待30秒也不重试', async t => {
  let calls = 0
  const bridge = bridgeWithProcess(t, (_file, _args, options, callback) => {
    calls++
    return nativeExecFile(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], options, callback)
  })
  for (const command of [bridge.adbCommand, bridge.adbBinaryCommand]) {
    const controller = new AbortController()
    const reason = new Error('cancelled')
    const started = Date.now()
    const promise = withCancellation(controller.signal, () => command('adb', 'test', ['shell', 'test']))
    controller.abort(reason)
    await assert.rejects(promise, error => error === reason)
    assert.ok(Date.now() - started < 1_000)
  }
  assert.equal(calls, 2)
})
