const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { U2Client, OCR_TIMEOUT_MS, SEND_KEYS_TIMEOUT_MS, APP_START_TIMEOUT_MS, developmentCommand, packagedCommand, utf8ProcessEnvironment } = require('../../src/automation/u2-client')

const root = path.resolve(__dirname, '../..')
const fixture = path.join(root, 'tests', 'fixtures', 'u2-sidecar-fixture.js')

function fixtureClient(environment = {}) {
  return new U2Client({
    root,
    adbPath: '/bundled/adb',
    command: { command: process.execPath, args: [fixture], cwd: root },
    requestTimeout: 1_000,
    startTimeout: 1_000,
    readRetryDelay: 0,
    log: () => {},
    environment,
  })
}

test('开发模式通过uv锁定环境启动Python bridge', () => {
  const command = developmentCommand('/project')
  assert.equal(command.command, process.env.UV_EXECUTABLE || 'uv')
  assert.deepEqual(command.args, ['run', '--locked', 'python', '-m', 'geoauto_u2.bridge'])
  assert.equal(command.cwd, path.join('/project', 'python'))
})

test('打包模式按平台和架构读取内置sidecar', () => {
  const command = packagedCommand({ root: '/project', resourcesPath: '/resources' })
  assert.match(command.command, /vendor[\\/]u2-runtime/)
  assert.match(command.command, new RegExp(`${process.platform}-${process.arch}`))
})

test('sidecar进程协议在Windows环境下强制使用UTF-8', () => {
  const environment = utf8ProcessEnvironment({ PYTHONUTF8: '0', PYTHONIOENCODING: 'cp936', KEEP: 'yes' })
  assert.deepEqual(environment, {
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    KEEP: 'yes',
  })
})

test('首次输入允许FastInputIME安装和切换完成', async () => {
  const client = new U2Client({ root, adbPath: '/bundled/adb', log: () => {} })
  const calls = []
  client.request = async (method, params, options) => {
    calls.push({ method, params, options })
    return true
  }

  await client.sendKeys('测试', { clear: true })

  assert.deepEqual(calls, [{
    method: 'send_keys',
    params: { text: '测试', clear: true },
    options: { timeout: SEND_KEYS_TIMEOUT_MS },
  }])
  assert.equal(SEND_KEYS_TIMEOUT_MS, 45_000)
})

test('输入回读不一致时可原子替换当前聚焦控件文本', async () => {
  const client = new U2Client({ root, adbPath: '/bundled/adb', log: () => {} })
  const calls = []
  client.request = async (method, params, options) => {
    calls.push({ method, params, options })
    return true
  }

  await client.setFocusedText('纠正后的问题')

  assert.deepEqual(calls, [{
    method: 'set_focused_text',
    params: { text: '纠正后的问题' },
    options: { timeout: SEND_KEYS_TIMEOUT_MS },
  }])
})

test('OCR通过通用只读请求传输图片和选项', async () => {
  const client = new U2Client({ root, adbPath: '/bundled/adb', log: () => {} })
  const calls = []
  client.request = async (method, params, options) => {
    calls.push({ method, params, options })
    return { coordinate_space: 'image_physical_pixels', image: { width: 2, height: 3 }, region: [0, 0, 2, 3], results: [] }
  }

  await client.ocrRecognize(Buffer.from('png'), { region: [0, 1, 2, 3], minConfidence: 0.8 })

  assert.deepEqual(calls, [{
    method: 'ocr_recognize',
    params: {
      image_base64: Buffer.from('png').toString('base64'),
      region: [0, 1, 2, 3],
      min_confidence: 0.8,
      use_detection: true,
      use_classification: false,
      use_recognition: true,
    },
    options: { timeout: OCR_TIMEOUT_MS, retryRead: true },
  }])
  assert.equal(OCR_TIMEOUT_MS, 60_000)
})

test('设备电源准备、锁屏读取和常亮恢复全部通过uiautomator2 sidecar', async () => {
  const client = new U2Client({ root, adbPath: '/bundled/adb', log: () => {} })
  const calls = []
  client.request = async (method, params, options) => {
    calls.push({ method, params, options })
    return true
  }

  await client.prepareDevicePower()
  await client.deviceLockState()
  await client.restoreDevicePower('7')

  assert.deepEqual(calls, [
    { method: 'prepare_device_power', params: {}, options: { timeout: 15_000 } },
    { method: 'device_lock_state', params: {}, options: { retryRead: true } },
    { method: 'restore_device_power', params: { stay_awake_original: '7' }, options: undefined },
  ])
})

test('uiautomator2客户端使用长驻进程获取层级', async () => {
  const client = fixtureClient()
  try {
    await client.start('SERIAL')
    assert.match(await client.dumpHierarchy(), /fixture/)
    assert.deepEqual(await client.currentApp(), { package: 'fixture.package', activity: '.FixtureActivity', pid: 123 })
    assert.deepEqual(await client.foregroundWindow(), { package: 'fixture.package', activity: 'fixture.package.MiniAppHostActivity0' })
  } finally {
    await client.stop()
  }
})

test('只读层级连续遇到瞬时服务断开时有限重启并恢复', async () => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'u2-read-retry-'))
  const stateFile = path.join(temporaryDirectory, 'attempts.txt')
  const names = [
    'U2_FIXTURE_COUNTED_FAIL_METHOD',
    'U2_FIXTURE_COUNTED_FAIL_STATE_FILE',
    'U2_FIXTURE_COUNTED_FAIL_LIMIT',
    'U2_FIXTURE_COUNTED_FAIL_MESSAGE',
  ]
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]))
  process.env.U2_FIXTURE_COUNTED_FAIL_METHOD = 'dump_hierarchy'
  process.env.U2_FIXTURE_COUNTED_FAIL_STATE_FILE = stateFile
  process.env.U2_FIXTURE_COUNTED_FAIL_LIMIT = '2'
  process.env.U2_FIXTURE_COUNTED_FAIL_MESSAGE = 'Remote end closed connection without response'
  const client = fixtureClient()
  try {
    await client.start('SERIAL')
    assert.match(await client.dumpHierarchy(), /fixture/)
    assert.equal(await fs.readFile(stateFile, 'utf8'), '2')
  } finally {
    await client.stop()
    await fs.rm(temporaryDirectory, { recursive: true, force: true })
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name]
      else process.env[name] = previous[name]
    }
  }
})

test('只读业务错误不会重启sidecar', async () => {
  const previous = process.env.U2_FIXTURE_FAIL_METHOD
  process.env.U2_FIXTURE_FAIL_METHOD = 'current_app'
  const client = fixtureClient()
  try {
    await client.start('SERIAL')
    let starts = 0
    const originalStart = client.start.bind(client)
    client.start = async (...args) => { starts += 1; return originalStart(...args) }
    await assert.rejects(() => client.currentApp(), /forced failure/)
    assert.equal(starts, 0)
  } finally {
    await client.stop()
    if (previous === undefined) delete process.env.U2_FIXTURE_FAIL_METHOD
    else process.env.U2_FIXTURE_FAIL_METHOD = previous
  }
})

test('应用未进入前台时只读复核后仅重新拉起一次', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'u2-app-start-recovery-'))
  const stateFile = path.join(directory, 'attempts.txt')
  const names = [
    'U2_FIXTURE_COUNTED_FAIL_METHOD',
    'U2_FIXTURE_COUNTED_FAIL_STATE_FILE',
    'U2_FIXTURE_COUNTED_FAIL_LIMIT',
    'U2_FIXTURE_COUNTED_FAIL_MESSAGE',
    'U2_FIXTURE_COUNTED_FAIL_CODE',
  ]
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]))
  process.env.U2_FIXTURE_COUNTED_FAIL_METHOD = 'app_start'
  process.env.U2_FIXTURE_COUNTED_FAIL_STATE_FILE = stateFile
  process.env.U2_FIXTURE_COUNTED_FAIL_LIMIT = '1'
  process.env.U2_FIXTURE_COUNTED_FAIL_MESSAGE = 'foreground mismatch'
  process.env.U2_FIXTURE_COUNTED_FAIL_CODE = 'APP_FOREGROUND_MISMATCH'
  const client = fixtureClient()
  try {
    await client.start('SERIAL')
    const result = await client.appStart('example.app')
    assert.equal(await fs.readFile(stateFile, 'utf8'), '1')
    assert.equal(result.method, 'app_start')
  } finally {
    await client.stop()
    await fs.rm(directory, { recursive: true, force: true })
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name]
      else process.env[name] = previous[name]
    }
  }
})

test('应用启动给足解析Activity、冷启动和前台校验的时间', async () => {
  const client = new U2Client({ root, adbPath: '/bundled/adb', log: () => {} })
  const calls = []
  client.request = async (method, params, options) => {
    calls.push({ method, params, options })
    return { package: params.package, activity: '.MainActivity' }
  }

  await client.appStart('com.aurora.xiaohe.aidoctor')

  assert.deepEqual(calls, [{
    method: 'app_start',
    params: { package: 'com.aurora.xiaohe.aidoctor' },
    options: { timeout: APP_START_TIMEOUT_MS },
  }])
  assert.equal(APP_START_TIMEOUT_MS, 45_000)
})

test('并发重启sidecar只会真正拉起一次进程', async () => {
  const client = fixtureClient()
  try {
    await client.start('SERIAL')
    let starts = 0
    const originalStart = client.start.bind(client)
    client.start = async (...args) => {
      starts += 1
      return originalStart(...args)
    }
    await Promise.all([client.restart(), client.restart(), client.restart()])
    assert.equal(starts, 1)
  } finally {
    await client.stop()
  }
})

test('显式停止后读取和重启不能重新拉起进程，明确start后才恢复', async () => {
  const client = fixtureClient()
  try {
    await client.start('SERIAL')
    await client.stop()
    await assert.rejects(client.currentApp(), { code: 'U2_STOPPED' })
    await assert.rejects(client.restart(), { code: 'U2_STOPPED' })
    assert.equal(client.process, null)
    await client.start('SERIAL')
    assert.equal((await client.currentApp()).package, 'fixture.package')
  } finally {
    await client.stop()
  }
})

test('停止正在等待的读写请求均返回停止状态且不自动恢复', async () => {
  for (const method of ['currentApp', 'click']) {
    const client = fixtureClient()
    client.options.command.args = ['-e', `
      require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
        const request = JSON.parse(line)
        if (request.method === 'connect') process.stdout.write(JSON.stringify({ id: request.id, ok: true, result: {} }) + '\\n')
      })
    `]
    client.options.requestTimeout = 100
    try {
      await client.start('SERIAL')
      const request = client[method](10, 20)
      const rejected = assert.rejects(request, { code: 'U2_STOPPED' })
      await client.stop()
      await rejected
      assert.equal(client.process, null)
    } finally {
      await client.stop()
    }
  }
})

test('停止可以取消正在执行的sidecar重启', async () => {
  const client = fixtureClient()
  try {
    await client.start('SERIAL')
    const restarting = client.restart()
    const rejected = assert.rejects(restarting, { code: 'U2_STOPPED' })
    await client.stop()
    await rejected
    assert.equal(client.process, null)
  } finally {
    await client.stop()
  }
})

test('停止后明确启动也不会复活旧请求的只读重试', async () => {
  const client = fixtureClient()
  client.options.readRetryDelay = 100
  const realRestart = client.restart.bind(client)
  let announceRestart
  const restarted = new Promise(resolve => { announceRestart = resolve })
  client.restart = async () => {
    await realRestart()
    announceRestart()
  }
  try {
    await client.start('SERIAL')
    client.process.kill('SIGKILL')
    await new Promise(resolve => client.process.once('exit', resolve))
    const request = client.currentApp()
    const rejected = assert.rejects(request, { code: 'U2_STOPPED' })
    await restarted
    await client.stop()
    await client.start('SERIAL')
    await rejected
    assert.equal((await client.currentApp()).package, 'fixture.package')
  } finally {
    await client.stop()
  }
})

test('有副作用的UI操作失败时显式报错，不产生ADB降级结果', async () => {
  const previous = process.env.U2_FIXTURE_FAIL_METHOD
  process.env.U2_FIXTURE_FAIL_METHOD = 'click'
  const client = fixtureClient()
  try {
    await client.start('SERIAL')
    await assert.rejects(() => client.click(10, 20), /forced failure/)
  } finally {
    await client.stop()
    if (previous === undefined) delete process.env.U2_FIXTURE_FAIL_METHOD
    else process.env.U2_FIXTURE_FAIL_METHOD = previous
  }
})
