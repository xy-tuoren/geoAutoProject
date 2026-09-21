const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { sleep } = require('../../src/automation/utils')
const { writeJsonAtomic, resumeItems, interruptRunning } = require('../../src/automation/batch-state')

test('停止立即取消等待；逐题进度可恢复且中断题不会默认重发，尝试证据不覆盖', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-resume-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const bridge = require('../../src/automation/device-bridge')
  t.mock.method(bridge, 'waitForAdbDevice', async () => {})
  t.mock.method(bridge, 'adbCommand', async () => '2')
  t.mock.method(require('../../src/automation/environment-report'), 'captureEnvironment', async () => ({ tool_version: 'test' }))
  t.mock.method(require('../../src/automation/question-input-workflow'), 'createQuestionInputWorkflow', () => ({ waitForInput: async () => {} }))
  let entered
  let ready = new Promise(resolve => { entered = resolve })
  const executed = []
  let hold = true
  t.mock.method(require('../../src/automation/question-workflows'), 'createQuestionWorkflows', ({ beforeQuestionSubmission }) => ({
    askOnce: async (_payload, artifacts, question) => {
      await beforeQuestionSubmission()
      executed.push(question)
      await fs.mkdir(artifacts.deliveryDirectory, { recursive: true })
      await fs.writeFile(path.join(artifacts.diagnosticDirectory, '识别证据.txt'), `evidence:${question}`)
      const recognitionDirectory = path.join(artifacts.diagnosticDirectory, '关键识别')
      await fs.mkdir(recognitionDirectory)
      for (const stem of ['before', 'confirm']) {
        await fs.writeFile(path.join(recognitionDirectory, `${stem}.png`), 'synthetic-image')
        await writeJsonAtomic(path.join(recognitionDirectory, `${stem}.json`), {
          frame_file: `${stem}.png`, frame_sha256: question === 'third' ? 'damaged' : createHash('sha256').update('synthetic-image').digest('hex'),
        })
      }
      if (question === 'second' && hold) { entered(); await sleep(60_000) }
      const screenshot = path.join(artifacts.deliveryDirectory, '回答.png')
      const metadata = path.join(artifacts.diagnosticDirectory, '回答.json')
      await fs.writeFile(screenshot, 'synthetic-image')
      await writeJsonAtomic(metadata, { screenshot })
      return { screenshot, metadata, content_type: 'answer', quality_status: 'verified' }
    },
  }))
  delete require.cache[require.resolve('../../src/automation/runner')]
  const { createRunner } = require('../../src/automation/runner')
  const stops = []
  const makeRunner = () => createRunner({ root, adbPath: 'fake-adb', log: () => {},
    uiClient: {
      start: async () => {}, stop: async () => { stops.push(Date.now()) }, appStart: async () => {},
      dumpHierarchy: async () => '<hierarchy><node package="com.aurora.xiaohe.aidoctor" /></hierarchy>',
      prepareDevicePower: async () => ({ screen_on: true, lock_state: { locked: false }, stay_awake_original: 2 }),
      restoreDevicePower: async () => {},
    },
    ocrRecognizer: {}, scrcpyObserver: { active: false, start: async () => {}, stop: async () => {}, snapshot: () => ({}) },
  })
  const first = makeRunner()
  const run = first.run({ serial: 'test', outputDir: root, entries: ['xiaohe-app'], questions: ['first', 'second', 'third'], timeout: 90 }).catch(error => error)
  await ready
  const stoppedAt = Date.now()
  await first.stop()
  const failure = await run
  assert.equal(failure.name, 'CancelledError')
  assert.ok(Date.now() - stoppedAt < 1_000, '停止不能等待原来的60秒超时')
  assert.ok(stops.some(time => time - stoppedAt < 100), '控制服务应优先收到停止')
  const summary = failure.batchSummary
  assert.deepEqual(summary.results.map(item => item.status), ['completed', 'needs_confirmation', 'pending'])
  const firstMetadata = await fs.readFile(summary.results[0].metadata, 'utf8')
  const firstEvidence = path.join(path.dirname(summary.results[0].metadata), '关键识别')
  assert.equal((await fs.readdir(firstEvidence)).filter(name => name.endsWith('.png')).length, 1)
  const oldDiagnostic = summary.results[1].diagnostic_directory
  assert.equal((await fs.readdir(path.join(oldDiagnostic, '关键识别'))).filter(name => name.endsWith('.png')).length, 2, '停止不执行额外去重')
  const saved = JSON.parse(await fs.readFile(summary.summary, 'utf8'))
  assert.equal(saved.completed, 1)
  assert.equal(saved.needs_confirmation, 1)
  hold = false
  const safe = await makeRunner().retryFailedBatch({ serial: 'test', batchDirectory: summary.batch_directory, resume: true, timeout: 90 })
  assert.deepEqual(executed, ['first', 'second', 'third'])
  assert.equal(safe.status, 'awaiting_confirmation')
  const complete = await makeRunner().retryFailedBatch({ serial: 'test', batchDirectory: summary.batch_directory, resume: true, includeUncertain: true, timeout: 90 })
  assert.equal(complete.completed, 3)
  assert.equal(complete.needs_confirmation, 0)
  assert.equal(complete.environment_reports.length, 3)
  assert.equal(await fs.readFile(complete.results[0].metadata, 'utf8'), firstMetadata)
  assert.equal(await fs.readFile(path.join(oldDiagnostic, '识别证据.txt'), 'utf8'), 'evidence:second')
  assert.notEqual(oldDiagnostic, complete.results[1].diagnostic_directory)
  assert.equal((await fs.readdir(path.dirname(complete.results[1].screenshot))).length, 1)
  const thirdDirectory = path.dirname(complete.results[2].metadata)
  assert.equal((await fs.readdir(path.join(thirdDirectory, '关键识别'))).filter(name => name.endsWith('.png')).length, 2)
  assert.match(await fs.readFile(path.join(thirdDirectory, '执行日志.jsonl'), 'utf8'), /diagnostic_storage_compaction_failed/)
})

test('异常退出留下running时恢复为待确认，只选择授权的恢复题', () => {
  const summary = interruptRunning({ results: ['completed', 'running', 'pending', 'failed'].map((status, i) => ({ status, question_index: i + 1 })) })
  assert.deepEqual(resumeItems(summary, { resume: true }).map(item => item.question_index), [3, 4])
  assert.deepEqual(resumeItems(summary, { resume: true, includeUncertain: true }).map(item => item.question_index), [2, 3, 4])
  const unsubmitted = interruptRunning({ results: [{ status: 'running', submission_started: false, question_index: 1 }] })
  assert.equal(unsubmitted.results[0].status, 'pending')
  assert.equal(resumeItems(unsubmitted, { resume: true }).length, 1)
})
