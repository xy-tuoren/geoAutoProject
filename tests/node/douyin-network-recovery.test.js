const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const sharp = require('sharp')
const { createDouyinSearchWorkflow, DouyinMiniAppNetworkError } = require('../../src/automation/douyin-search-workflow')
const { createQuestionWorkflows } = require('../../src/automation/question-workflows')
const { automationErrorInfo } = require('../../src/automation/batch-recovery')
const { ENTRY_DEFINITIONS } = require('../../src/automation/entry-catalog')
const { replayRecognition } = require('../../src/automation/recognition-replay')

test('白屏未通过正文像素检查时仍识别网络错误，保留证据且不点击，覆盖两种缩放', async () => {
  const frame = await sharp({ create: { width: 1080, height: 2400, channels: 3, background: 'white' } }).png().toBuffer()
  for (const scale of [1, 2 / 3]) {
    let clock = 0, reads = 0
    const diagnostics = []
    const workflow = createDouyinSearchWorkflow({
      screenshot: async () => frame,
      windowSize: async () => ({ width: 1080 * scale, height: 2400 * scale }),
      now: () => clock, delay: async ms => { clock += ms },
      log: () => {}, checkCancelled: () => {},
      setLastOcrDiagnostic: value => diagnostics.push(value),
      tap: async () => assert.fail('不能点击错误页'),
      waitForStableReply: async () => assert.fail('白屏不能进入回答稳定等待'),
      ocr: { recognize: async () => {
        reads += 1
        return { image: { width: 1080, height: 2400 }, results: reads === 1 ? [] : [
          { text: '网络不稳定，请重试', confidence: 0.99, bounds: [333, 1235, 751, 1292] },
          { text: '重试', confidence: 0.99, bounds: [489, 1434, 594, 1493] },
        ] }
      } },
    })
    await assert.rejects(workflow.waitForDouyinMiniAppAnswer({
      bounds: [0, 200, 1080, 2100].map(v => v * scale), startedAt: 0,
    }, 10_000), DouyinMiniAppNetworkError)
    assert.equal(reads, 2)
    assert.ok(clock >= 3_000 && clock < 10_000)
    const evidence = diagnostics.find(d => d.purpose === 'douyin_miniapp_network_error')
    assert.ok(evidence?.target)
    assert.equal(evidence.logical_size.width, 1080 * scale)
    assert.ok(replayRecognition(evidence).matched)
  }
})

test('最终超时和稳定等待结束都复核网络错误；普通空白不触发重启', async () => {
  for (const mode of ['blank', 'deadline_network', 'stable_network']) {
    let clock = 0, reads = 0
    const raw = Buffer.alloc(360 * 800 * 3, 255)
    if (mode === 'stable_network') {
      for (let i = 0; i < raw.length; i += 1) raw[i] = Math.floor(i / 3) % 360 < 180 ? 255 : 40
    }
    const frame = await sharp(raw, { raw: { width: 360, height: 800, channels: 3 } }).png().toBuffer()
    const workflow = createDouyinSearchWorkflow({
      screenshot: async () => frame, windowSize: async () => ({ width: 360, height: 800 }),
      now: () => clock, delay: async ms => { clock += ms },
      checkCancelled: () => {}, log: () => {}, setLastOcrDiagnostic: () => {},
      waitForStableReply: async () => ({ status: 'timeout' }),
      ocr: { recognize: async () => {
        reads += 1
        return { image: { width: 360, height: 800 }, results: reads > 1 && mode !== 'blank' ? [
          { text: '网络不稳定，请重试', confidence: 0.99, bounds: [111, 412, 250, 431] },
          { text: '重试', confidence: 0.99, bounds: [163, 478, 198, 498] },
        ] : [{ normalizedText: '小荷AI医生', confidence: 0.99, bounds: [60, 40, 220, 65] }] }
      } },
    })
    await assert.rejects(workflow.waitForDouyinMiniAppAnswer({ bounds: [0, 84, 360, 592], startedAt: 0 }, 1_000), error => {
      if (mode === 'blank') {
        assert.equal(error instanceof DouyinMiniAppNetworkError, false)
        assert.match(error.message, /未出现可截图的回答正文/)
      } else assert.ok(error instanceof DouyinMiniAppNetworkError)
      return true
    })
    assert.equal(reads, 2)
  }
})

for (const mode of ['smart_summary', 'miniapp_entry_card']) {
  for (const alwaysFail of [false, true]) {
    test(`${mode} 网络错误重搜当前题一次，${alwaysFail ? '再次失败不循环' : '成功保留恢复次数'}`, async t => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'douyin-network-'))
      t.after(() => fs.rm(root, { recursive: true, force: true }))
      let searches = 0, waits = 0, restarts = 0, savedMeta
      const entry = ENTRY_DEFINITIONS['douyin-xiaohe-miniapp']
      const target = { mode, viewFull: [0, 0, 100, 100], tapBounds: [0, 0, 100, 100] }
      const full = { xml: '<hierarchy/>', bounds: [0, 100, 360, 700] }
      const workflow = createQuestionWorkflows({
        observer: {}, recoverySnapshot: () => ({}), log: () => {},
        getActiveEntry: () => entry, getActivePackageName: () => entry.packageName,
        inputDouyinQuestion: async question => { assert.equal(question, '测试问题'); searches += 1; return [0, 0, 100, 100] },
        tap: async () => {},
        waitForDouyinSearchResult: async () => ({ target, size: { width: 360, height: 800 } }),
        captureDouyinSearchTarget: async () => ({ target, frame: Buffer.from('search') }),
        openDouyinFullAnswer: async () => full, openDouyinMiniAppEntry: async () => full,
        waitForDouyinMiniAppAnswer: async state => {
          waits += 1
          if (alwaysFail || waits === 1) throw new DouyinMiniAppNetworkError()
          return state
        },
        saveArtifacts: async ({ meta }) => { savedMeta = meta; return {} },
        restartDouyinEntry: async () => { restarts += 1 },
      })
      const artifacts = { batchDirectory: root, diagnosticDirectory: root, deliveryDirectory: path.join(root, 'delivery') }
      const run = () => workflow.askOnceDouyin({ serial: 'test', timeout: 10 }, artifacts, '测试问题', 1)
      if (alwaysFail) {
        await assert.rejects(run(), error => {
          assert.equal(error.code, 'DOUYIN_MINIAPP_NETWORK_ERROR')
          assert.match(error.message, /重启抖音并重试当前题一次后/)
          assert.equal(automationErrorInfo(error).title, '抖音小程序网络异常')
          assert.equal(automationErrorInfo(error).fatal, false)
          return true
        })
        assert.equal(savedMeta, undefined)
        assert.deepEqual(await fs.readdir(artifacts.deliveryDirectory), [])
      } else {
        await run()
        assert.equal(savedMeta.douyin_network_restart_attempts, 1)
      }
      assert.equal(searches, 2)
      assert.equal(waits, 2)
      assert.equal(restarts, 1)
    })
  }
}
