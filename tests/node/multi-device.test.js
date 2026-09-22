const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter, once } = require('node:events')
const { Worker } = require('node:worker_threads')
const path = require('node:path')
const { createDeviceTasks, deviceDirectory } = require('../../src/main/device-tasks')
const { createDevicePreview } = require('../../src/main/device-preview')
const { createSession, retainLog, acceptEvent, screenLayout } = require('../../src/renderer/device-state')

test('两台手机独立 worker 并行运行，停止一台不停止另一台，消息和题目按设备隔离', async t => {
  const workers = new Map(), events = new EventEmitter(), messages = []
  const manager = createDeviceTasks({ runnerOptions: {}, emit: (type, value) => { messages.push({ type, ...value }); events.emit(`${type}:${value.serial}`, value) },
    createWorker: data => {
      const worker = new Worker(`
        const { parentPort, workerData } = require('node:worker_threads')
        parentPort.postMessage({ type: 'log', value: workerData.payload.questions[0] })
        parentPort.on('message', message => {
          parentPort.postMessage({ type: 'finished', value: { code: message.type === 'stop' ? 130 : 0, summary: { output: workerData.payload.outputDir } } })
          parentPort.close()
        })
      `, { eval: true, workerData: data })
      workers.set(data.payload.serial, worker)
      return worker
    },
  })
  t.after(async () => { manager.stop(); await manager.whenIdle() })
  const aLog = once(events, 'log:phone:A'), bLog = once(events, 'log:phone_B')
  const a = manager.start({ serial: 'phone:A', outputDir: '/tmp/out', questions: ['A 的题'] })
  const b = manager.start({ serial: 'phone_B', outputDir: '/tmp/out', questions: ['B 的题'] })
  assert.notEqual(a.taskId, b.taskId)
  assert.equal(manager.size, 2)
  assert.equal((await aLog)[0].text, 'A 的题')
  assert.equal((await bLog)[0].text, 'B 的题')
  assert.throws(() => manager.start({ serial: 'phone:A' }), /已有任务/)
  const aFinished = once(events, 'finished:phone:A')
  assert.deepEqual(manager.stop('phone:A'), { stopping: true })
  assert.equal((await aFinished)[0].code, 130)
  assert.equal(manager.size, 1)
  assert.equal(manager.snapshot()[0].serial, 'phone_B')
  const bFinished = once(events, 'finished:phone_B')
  workers.get('phone_B').postMessage({ type: 'complete' })
  const bResult = (await bFinished)[0]
  assert.equal(bResult.code, 0)
  assert.equal(manager.size, 0)
  assert.ok(bResult.summary.output.endsWith(deviceDirectory('phone_B')))
  assert.notEqual(deviceDirectory('phone:A'), deviceDirectory('phone_A'))
  assert.ok(messages.filter(m => m.serial === 'phone:A').every(m => m.taskId === a.taskId))
})

test('同一批次不能在不同手机同时续跑，收尾退出前不释放设备；worker 故障仅结束自身', async () => {
  const workers = [], results = []
  const manager = createDeviceTasks({ runnerOptions: {}, emit: (type, value) => { if (type === 'finished') results.push(value) }, createWorker: () => {
    const worker = new EventEmitter(); worker.postMessage = () => {}; workers.push(worker); return worker
  } })
  manager.start({ serial: 'A', batchDirectory: path.resolve('/tmp/batch') }, 'retryFailedBatch')
  assert.throws(() => manager.start({ serial: 'B', batchDirectory: path.resolve('/tmp/batch') }, 'retryFailedBatch'), /不能同时写入/)
  workers[0].emit('message', { type: 'finished', value: { code: 0 } })
  assert.throws(() => manager.start({ serial: 'A' }), /收尾/)
  workers[0].emit('exit', 0)
  manager.start({ serial: 'A', outputDir: '/tmp/out' })
  workers[1].emit('message', { type: 'progress', value: { type: 'batch_created', batch_directory: path.resolve('/tmp/new-batch') } })
  assert.throws(() => manager.start({ serial: 'B', batchDirectory: path.resolve('/tmp/new-batch') }, 'retryFailedBatch'), /不能同时写入/)
  workers[1].emit('message', { type: 'progress', value: { type: 'initialized', entries: [{ id: 'xiaohe-app' }], question_count: 2 } })
  workers[1].emit('message', { type: 'progress', value: { type: 'question_completed', entry_id: 'xiaohe-app', question_index: 1 } })
  assert.equal(manager.snapshot()[0].progress.entries[0].succeeded, 1)
  assert.equal(manager.snapshot()[0].progress.entries[0].total, 2)
  manager.start({ serial: 'B', outputDir: '/tmp/out' })
  workers[1].emit('error', new Error('worker 故障'))
  workers[1].emit('exit', 1)
  assert.equal(results.at(-1).serial, 'A')
  assert.equal(results.at(-1).code, 1)
  assert.equal(manager.snapshot()[0].serial, 'B')
  manager.stop(); workers[2].emit('message', { type: 'finished', value: { code: 130 } }); workers[2].emit('exit', 0)
  await manager.whenIdle()
})

test('实时预览独立连接，取消启动及旧会话不会影响新流，未消费的视频有界', async t => {
  const observers = [], events = []
  const previews = createDevicePreview({ adbPath: () => 'adb', serverPath: () => 'server', createObserver: callbacks => {
    const observer = { ...callbacks, stopped: 0, start: async (_serial, { signal }) => {
      observer.signal = signal
      await new Promise(resolve => { observer.ready = resolve; signal.addEventListener('abort', resolve, { once: true }) })
      signal.throwIfAborted()
    }, stop: async () => { observer.stopped++ } }
    observers.push(observer); return observer
  } })
  t.after(() => previews.stop())
  const first = previews.start('A', 'old', 1, e => events.push(e))
  const other = previews.start('B', 'b', 1, e => events.push(e))
  observers[1].ready(); await other
  const cancelled = previews.stop('A', 'old', 1)
  const next = previews.start('A', 'new', 1, e => events.push(e))
  observers[2].ready(); await next; await cancelled; await first
  assert.ok(observers[0].signal.aborted)
  assert.equal(observers[1].signal.aborted, false)
  await previews.stop('A', 'old', 1)
  assert.equal(observers[2].signal.aborted, false)
  observers[0].onFailure(new Error('late'))
  observers[2].onVideoSession({ codec: 'h264', width: 540, height: 1200 })
  assert.equal(events.at(-1).streamId, 'new')
  const packet = { size: 3, data: Buffer.from('abc'), pts: 1n }
  observers[2].onVideoPacket(packet)
  previews.acknowledge('A', 'old', 1, 1)
  previews.acknowledge('A', 'new', 1, 999)
  for (let i = 0; i < 8; i++) observers[2].onVideoPacket(packet)
  assert.match(events.at(-1).message, /跟不上视频流/)
  assert.equal(events.filter(e => e.type === 'packet').length, 8)
  assert.equal(observers[1].signal.aborted, false)
  observers[1].onFailure(new Error('USB disconnected'))
  assert.equal(events.at(-1).serial, 'B')
  await previews.stop()
  assert.equal(previews.size, 0)
})

test('屏幕总览按每台手机真实比例分配宽度，同高单行排列且不超出窗口', () => {
  for (const [width, height] of [[1180, 640], [900, 490]]) {
    for (const count of [1, 2, 4, 6, 8]) {
      const aspects = Array.from({ length: count }, (_, i) => i % 2 ? 480 / 640 : 1080 / 2400)
      const { widths, screenHeight } = screenLayout(width, height, aspects)
      assert.equal(widths.length, count)
      assert.ok(screenHeight > 80)
      assert.ok(screenHeight + 212 <= height + 1, '保留手机操作工具栏和卡片控件的高度')
      assert.ok(widths.reduce((sum, value) => sum + value, 0) + (count - 1) * 12 <= width + 1)
      widths.forEach((value, i) => assert.ok(Math.abs((value - 22) / screenHeight - aspects[i]) < 0.00001))
    }
  }
  assert.ok(screenLayout(1180, 640, [9 / 20]).screenHeight > 408, '新增工具栏后单台预览仍保留足够可用高度')
})

test('各手机配置和日志独立，过期任务消息不覆盖新任务，启动中的停止意图保留', () => {
  const draft = { text: '', entries: ['xiaohe-app'] }
  const a = createSession(draft), b = createSession(draft)
  a.draft.text = 'A 的题'; a.draft.entries.push('douyin-xiaohe-miniapp')
  assert.deepEqual(b.draft, draft)
  retainLog(a, '错误', 'failure')
  for (let index = 0; index < 120; index++) retainLog(a, String(index), 'routine')
  assert.equal(a.logs.length, 101); assert.equal(a.logs[0].text, '错误'); assert.equal(b.logs.length, 0)
  a.stopping = true
  assert.equal(acceptEvent(a, { type: 'starting', taskId: 'new' }), true)
  assert.equal(a.stopping, true)
  assert.equal(acceptEvent(a, { taskId: 'old' }), false)
})
