const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

test('实时总览只接受当前手机会话，切页关闭解码器并忽略延迟画面', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/renderer.js'), 'utf8')
  const handler = source.match(/function stopCardPreview[\s\S]*?(?=function renderDeviceCards)/)?.[0]
  assert.ok(handler)
  let listener, frameCallback, decoded = 0, closed = 0, acknowledged = 0
  const stopped = []
  const card = { serial: 'A', canvas: { hidden: true }, placeholder: {}, screen: { classList: { remove() {}, add() {} } }, freshness: {}, aspect: 0.45 }
  const context = { previewEpoch: 0, setTimeout, clearTimeout, canPreview: () => true, deviceCards: new Map([['A', card]]),
    window: { previewPlayer: { createPreviewPlayer: options => { frameCallback = options.onFrame; return { push() { decoded++ }, close() { closed++ } } } },
      automation: { onPreview: callback => { listener = callback }, startPreview: async () => {},
        stopPreview: async (...args) => { stopped.push(args) }, acknowledgePreview: () => { acknowledged++ } } } }
  vm.runInNewContext(handler, context)
  context.startCardPreview(card)
  const id = card.streamId
  listener({ serial: 'B', streamId: id, type: 'packet' })
  listener({ serial: 'A', streamId: 'old', type: 'packet' })
  listener({ serial: 'A', streamId: id, type: 'packet' })
  assert.equal(decoded, 1); assert.equal(acknowledged, 3)
  context.stopCardPreview(card)
  frameCallback({ width: 540, height: 1200 })
  assert.equal(card.canvas.hidden, true)
  assert.equal(closed, 1)
  assert.deepEqual(stopped, [['A', id]])
})

test('GUI点击停止在IPC返回前立即反馈并防止重复请求', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/renderer.js'), 'utf8')
  const handler = source.match(/async function stopDevice\(serial\) \{[\s\S]*?\n\}/)?.[0]
  assert.ok(handler)
  let finish, requests = 0
  const session = { running: true, stopping: false, taskId: 'task-A' }
  const stop = { disabled: false, textContent: '停止此手机' }
  const status = { textContent: '' }
  const context = { stop, status, sessions: new Map([['A', session]]), selectedSerial: 'A', renderDeviceCards: () => {},
    renderDeviceControls: () => { stop.disabled = session.stopping; stop.textContent = session.stopping ? '正在停止…' : '停止此手机' },
    window: { automation: { stop: serial => { assert.equal(serial, 'A'); requests++; return new Promise(resolve => { finish = resolve }) } } } }
  vm.runInNewContext(`${handler}; globalThis.stopDevice = stopDevice`, context)
  const pending = context.stopDevice('A')
  assert.equal(stop.disabled, true)
  assert.equal(stop.textContent, '正在停止…')
  assert.match(status.textContent, /保存进度/)
  await context.stopDevice('A')
  assert.equal(requests, 1)
  finish()
  await pending
  session.stopping = false
  context.addDeviceLog = () => {}
  context.window.automation.stop = async () => { throw new Error('IPC 暂不可用') }
  await context.stopDevice('A')
  assert.equal(session.running, true)
  assert.equal(session.stopping, false)
  assert.match(status.textContent, /再次点击停止/)
})

test('主进程立即确认停止请求，不让IPC等待控制服务收尾', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/main/index.js'), 'utf8')
  const handler = source.match(/ipcMain\.handle\('automation:stop',[^\n]+/)?.[0]
  let listener, called = false
  vm.runInNewContext(handler, { ipcMain: { handle: (_name, fn) => { listener = fn } }, log: () => {}, logError: () => {},
    tasks: { stop: serial => { assert.equal(serial, 'A'); called = true; return { stopping: true } } },
  })
  const result = await listener({}, 'A')
  assert.equal(called, true)
  assert.equal(result.stopping, true)
})

test('GUI日志保留全部失败记录，只限制最近的成功和过程记录', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/renderer.js'), 'utf8')
  const implementation = source.match(/const MAX_ROUTINE_LOG_ENTRIES[\s\S]*?function clearLog\(\) \{[\s\S]*?\n\}/)?.[0]
  assert.ok(implementation)
  const log = {
    children: [], scrollHeight: 0, scrollTop: 0,
    append(entry) { entry.parent = this; this.children.push(entry) },
    replaceChildren() { this.children.length = 0 },
  }
  const document = { createElement: () => ({ className: '', textContent: '', remove() { this.parent.children.splice(this.parent.children.indexOf(this), 1) } }) }
  const context = { log, document }
  vm.runInNewContext(`${implementation}; globalThis.logTest = { appendLog, clearLog, logEntryKind }`, context)
  context.logTest.appendLog('错误：设备断开\n处理：重新连接\n')
  for (let index = 0; index < 110; index++) context.logTest.appendLog(`过程 ${index}\n`)
  context.logTest.appendLog('  失败  截图接缝无法验证\n')
  context.logTest.appendLog('  完成  采集成功\n')
  assert.equal(log.children.filter(item => item.className.endsWith('failure')).length, 2)
  assert.equal(log.children.filter(item => !item.className.endsWith('failure')).length, 100)
  assert.equal(log.children.some(item => item.textContent === '过程 0\n'), false)
  assert.equal(log.children.some(item => item.textContent === '过程 109\n'), true)
  assert.equal(context.logTest.logEntryKind('执行完成：成功 1'), 'success')
  context.logTest.clearLog()
  assert.equal(log.children.length, 0)
})
