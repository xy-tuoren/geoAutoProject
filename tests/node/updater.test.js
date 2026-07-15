const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { createUpdateManager } = require('../../src/main/updater')

class FakeUpdater extends EventEmitter {
  constructor() {
    super()
    this.checkCount = 0
    this.downloadCount = 0
    this.installCount = 0
  }

  async checkForUpdates() {
    this.checkCount += 1
    this.emit('checking-for-update')
    this.emit('update-available', { version: '0.1.2' })
  }

  async downloadUpdate() {
    this.downloadCount += 1
    this.emit('download-progress', { percent: 42.4 })
    this.emit('update-downloaded', { version: '0.1.2' })
  }

  quitAndInstall() {
    this.installCount += 1
  }
}

function fixture({ packaged = true, platform = 'win32', version = '0.1.1', taskActive = false } = {}) {
  const autoUpdater = new FakeUpdater()
  const sent = []
  let running = taskActive
  const window = {
    isDestroyed: () => false,
    webContents: { send: (channel, value) => sent.push({ channel, value }) },
  }
  const manager = createUpdateManager({
    app: { isPackaged: packaged, getVersion: () => version },
    autoUpdater,
    BrowserWindow: { getAllWindows: () => [window] },
    platform,
    isTaskActive: () => running,
  })
  manager.start({ autoCheck: false })
  return { manager, autoUpdater, sent, setTaskActive: value => { running = value } }
}

test('开发环境不访问更新源', async () => {
  const { manager, autoUpdater } = fixture({ packaged: false })

  const state = await manager.check()

  assert.equal(state.status, 'unsupported')
  assert.equal(state.supported, false)
  assert.equal(autoUpdater.checkCount, 0)
})

test('发现更新后由用户主动下载并安装', async () => {
  const { manager, autoUpdater } = fixture()

  await manager.check()
  assert.equal(manager.snapshot().status, 'available')
  assert.equal(manager.snapshot().version, '0.1.2')
  await manager.check()
  assert.equal(autoUpdater.checkCount, 1)
  assert.equal(autoUpdater.autoDownload, false)
  assert.equal(autoUpdater.autoInstallOnAppQuit, false)

  await manager.download()
  assert.equal(manager.snapshot().status, 'downloaded')
  assert.equal(manager.snapshot().percent, 100)
  assert.equal(manager.snapshot().canInstall, true)
  await manager.check()
  assert.equal(autoUpdater.checkCount, 1)

  assert.equal(manager.install(), true)
  assert.equal(autoUpdater.installCount, 1)
})

test('运行中的自动化任务阻止重启安装，任务结束后恢复', async () => {
  const { manager, autoUpdater, setTaskActive } = fixture()
  await manager.check()
  await manager.download()
  setTaskActive(true)

  assert.equal(manager.snapshot().canInstall, false)
  assert.throws(() => manager.install(), /任务正在执行/)
  assert.equal(autoUpdater.installCount, 0)

  setTaskActive(false)
  manager.notify()
  assert.equal(manager.snapshot().canInstall, true)
  manager.install()
  assert.equal(autoUpdater.installCount, 1)
})

test('预发布安装包只接收预发布更新', () => {
  const stable = fixture({ version: '0.1.1' })
  const prerelease = fixture({ version: '0.1.2-rc.1' })

  assert.equal(stable.autoUpdater.allowPrerelease, false)
  assert.equal(prerelease.autoUpdater.allowPrerelease, true)
})
