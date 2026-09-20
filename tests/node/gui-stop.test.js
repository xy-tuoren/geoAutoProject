const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

test('GUI点击停止在IPC返回前立即反馈并防止重复请求', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/renderer.js'), 'utf8')
  const handler = source.match(/stop\.addEventListener\('click', async \(\) => \{[\s\S]*?\n\}\)/)?.[0]
  assert.ok(handler)
  let listener, finish, requests = 0
  const stop = { disabled: false, textContent: '停止', addEventListener: (_event, fn) => { listener = fn } }
  const status = { textContent: '' }
  const context = { stop, status, stopping: false, window: { automation: { stop: () => { requests++; return new Promise(resolve => { finish = resolve }) } } } }
  vm.runInNewContext(handler, context)
  const pending = listener()
  assert.equal(stop.disabled, true)
  assert.equal(stop.textContent, '正在停止…')
  assert.match(status.textContent, /保存进度/)
  await listener()
  assert.equal(requests, 1)
  finish()
  await pending
})

test('主进程立即确认停止请求，不让IPC等待控制服务收尾', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/main/index.js'), 'utf8')
  const handler = source.match(/ipcMain\.handle\('automation:stop', async \(\) => \{[\s\S]*?\n\}\)/)?.[0]
  let listener, called = false
  vm.runInNewContext(handler, { ipcMain: { handle: (_name, fn) => { listener = fn } }, log: () => {}, logError: () => {},
    activeTask: { stop: () => { called = true; return new Promise(() => {}) } },
  })
  const result = await listener()
  assert.equal(called, true)
  assert.equal(result.stopping, true)
})
