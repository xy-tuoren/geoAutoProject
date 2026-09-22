const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

test('runner 按所选模式切换真实入口准备链；归档、进度和恢复沿用原平台优先级', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'collection-order-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const bridge = require('../../src/automation/device-bridge')
  t.mock.method(bridge, 'waitForAdbDevice', async () => {})
  t.mock.method(bridge, 'adbCommand', async () => '2')
  t.mock.method(require('../../src/automation/environment-report'), 'captureEnvironment', async () => ({ test: true }))
  t.mock.method(require('../../src/automation/question-input-workflow'), 'createQuestionInputWorkflow', () => ({ waitForInput: async () => {} }))
  t.mock.method(require('../../src/automation/doubao-workflow'), 'createDoubaoWorkflow', () => ({ prepare: async () => {} }))
  const executed = [], launches = [], progress = []
  let currentPackage
  t.mock.method(require('../../src/automation/question-workflows'), 'createQuestionWorkflows', ({ getActiveEntry, beforeQuestionSubmission }) => ({
    askOnce: async (payload, artifacts, question) => {
      const entry = getActiveEntry()
      assert.equal(currentPackage, entry.packageName, '跨平台执行前必须启动并校验该平台')
      await beforeQuestionSubmission()
      executed.push([entry.id, question, payload.collectionOrder])
      const screenshot = path.join(artifacts.deliveryDirectory, '回答.png')
      const metadata = path.join(artifacts.diagnosticDirectory, '回答.json')
      await fs.mkdir(artifacts.deliveryDirectory, { recursive: true })
      await fs.writeFile(screenshot, 'synthetic-image')
      await fs.writeFile(metadata, JSON.stringify({ screenshot, ...payload.taskContext }))
      return { screenshot, metadata, content_type: 'answer', quality_status: 'verified' }
    },
  }))
  delete require.cache[require.resolve('../../src/automation/runner')]
  const { createRunner } = require('../../src/automation/runner')
  const makeRunner = () => createRunner({ root, adbPath: 'fake-adb', log: () => {}, progress: event => progress.push(event),
    uiClient: {
      start: async () => {}, stop: async () => {},
      appStart: async packageName => { launches.push(packageName); currentPackage = packageName },
      dumpHierarchy: async () => `<hierarchy><node package="${currentPackage}" /></hierarchy>`,
      prepareDevicePower: async () => ({ screen_on: true, lock_state: { locked: false }, stay_awake_original: 2 }),
      restoreDevicePower: async () => {},
    },
    ocrRecognizer: {}, scrcpyObserver: { active: false, start: async () => {}, stop: async () => {}, snapshot: () => ({}) },
  })
  const ids = ['doubao-app', 'xiaohe-app']
  for (const order of ['platform_first', 'question_first']) {
    executed.length = 0
    launches.length = 0
    progress.length = 0
    const summary = await makeRunner().run({ serial: 'test', outputDir: root, entries: ids, collectionOrder: order,
      brandGroups: [{ brand: '甲', questions: ['first', 'second'] }, { brand: '乙', questions: ['third'] }], timeout: 90 })
    const expected = order === 'platform_first'
      ? [[ids[0], 'first'], [ids[0], 'second'], [ids[0], 'third'], [ids[1], 'first'], [ids[1], 'second'], [ids[1], 'third']]
      : [[ids[0], 'first'], [ids[1], 'first'], [ids[0], 'second'], [ids[1], 'second'], [ids[0], 'third'], [ids[1], 'third']]
    assert.deepEqual(executed.map(item => item.slice(0, 2)), expected)
    assert.ok(executed.every(item => item[2] === order))
    assert.equal(summary.completed, 6)
    assert.equal(summary.collection_order, order)
    assert.deepEqual(summary.entry_priority, ids)
    assert.deepEqual(summary.results.map(item => [item.entry_id, item.question]), expected)
    assert.equal(launches.length, order === 'platform_first' ? 4 : 6)
    assert.deepEqual(progress.filter(event => event.type === 'question_started').map(event => [event.entry_id, event.question]), expected)
    for (const result of summary.results) {
      assert.ok(result.screenshot.includes(`${path.sep}${result.brand}${path.sep}${result.entry_id === ids[0] ? '01_' : '02_'}`))
    }
    const manifest = JSON.parse(await fs.readFile(summary.brand_manifest, 'utf8'))
    assert.equal(manifest.collection_order, order)
    assert.match(await fs.readFile(summary.event_log, 'utf8'), /collection_schedule_created/)
    // Simulate pending / failed checkpoint entries, then change UI settings.
    // Both continuation and retry must still execute the persisted sequence.
    const saved = JSON.parse(await fs.readFile(summary.summary, 'utf8'))
    for (const index of [1, 3, 4]) saved.results[index].status = index === 3 ? 'failed' : 'pending'
    await fs.writeFile(summary.summary, JSON.stringify(saved))
    executed.length = 0
    const resumed = await makeRunner().retryFailedBatch({ serial: 'test', batchDirectory: summary.batch_directory, resume: true,
      entries: [...ids].reverse(), collectionOrder: order === 'platform_first' ? 'question_first' : 'platform_first', timeout: 90 })
    assert.deepEqual(executed.map(item => item.slice(0, 2)), [expected[1], expected[3], expected[4]])
    assert.ok(executed.every(item => item[2] === order))
    assert.equal(resumed.completed, 6)
    assert.deepEqual(resumed.entry_priority, ids)
    assert.match(await fs.readFile(summary.event_log, 'utf8'), /collection_schedule_resumed/)
    const retrySaved = JSON.parse(await fs.readFile(summary.summary, 'utf8'))
    retrySaved.results[2].status = 'failed'
    retrySaved.results[5].status = 'failed'
    await fs.writeFile(summary.summary, JSON.stringify(retrySaved))
    executed.length = 0
    const retried = await makeRunner().retryFailedBatch({ serial: 'test', batchDirectory: summary.batch_directory,
      entries: [...ids].reverse(), collectionOrder: 'invalid_ui_setting_ignored', timeout: 90 })
    assert.deepEqual(executed.map(item => item.slice(0, 2)), [expected[2], expected[5]])
    assert.equal(retried.completed, 6)
  }
})
