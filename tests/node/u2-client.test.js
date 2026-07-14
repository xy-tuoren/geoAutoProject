const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { U2Client, developmentCommand, packagedCommand } = require('../../src/automation/u2-client')

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

test('uiautomator2客户端使用长驻进程获取层级', async () => {
  const client = fixtureClient()
  try {
    await client.start('SERIAL')
    assert.match(await client.dumpHierarchy(), /fixture/)
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
