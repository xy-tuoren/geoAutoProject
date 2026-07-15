const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { U2Client, SEND_KEYS_TIMEOUT_MS, developmentCommand, packagedCommand, utf8ProcessEnvironment } = require('../../src/automation/u2-client')

const root = path.resolve(__dirname, '../..')
const fixture = path.join(root, 'tests', 'fixtures', 'u2-sidecar-fixture.js')

function fixtureClient(environment = {}) {
  return new U2Client({
    root,
    adbPath: '/bundled/adb',
    command: { command: process.execPath, args: [fixture], cwd: root },
    requestTimeout: 1_000,
    startTimeout: 1_000,
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
