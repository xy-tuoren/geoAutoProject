const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createQuestionWorkflows, DOUYIN_SEARCH_SUMMARY_FILENAME } = require('../../src/automation/question-workflows')
const { ENTRY_DEFINITIONS } = require('../../src/automation/entry-catalog')

for (const failureStage of ['open', 'capture', null]) {
  test(`抖音智能总结只在全文采集成功后交付：${failureStage || 'success'}`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'douyin-summary-delivery-'))
    t.after(() => fs.rm(root, { recursive: true, force: true }))
    const artifacts = {
      batchDirectory: root,
      deliveryDirectory: path.join(root, '交付图片'),
      diagnosticDirectory: path.join(root, '调试产物'),
    }
    const entry = ENTRY_DEFINITIONS['douyin-xiaohe-miniapp']
    const frame = Buffer.from('search-summary')
    const failure = new Error(`failure at ${failureStage}`)
    let captureCalls = 0
    const workflow = createQuestionWorkflows({
      observer: {},
      recoverySnapshot: () => ({}),
      log: () => {},
      getActiveEntry: () => entry,
      getActivePackageName: () => entry.packageName,
      inputDouyinQuestion: async () => [0, 0, 100, 100],
      tap: async () => {},
      waitForDouyinSearchResult: async () => ({ size: { width: 1080, height: 2400 } }),
      captureDouyinSearchTarget: async () => ({
        frame,
        detectionMethod: 'hierarchy',
        target: { mode: 'smart_summary', viewFull: [0, 0, 100, 100] },
      }),
      openDouyinFullAnswer: async () => {
        if (failureStage === 'open') throw failure
        return { xml: '<hierarchy />', bounds: [0, 0, 1080, 2400] }
      },
      captureDouyinFullAnswerFrames: async () => {
        captureCalls += 1
        if (failureStage === 'capture') throw failure
      },
      waitForDouyinMiniAppAnswer: async full => full,
      saveArtifacts: async ({ captureMethod }) => {
        await captureMethod()
        assert.deepEqual(await fs.readdir(artifacts.deliveryDirectory), [])
        return { screenshot: path.join(artifacts.deliveryDirectory, '回答_001.png') }
      },
    })
    const run = () => workflow.askOnceDouyin({ serial: 'test-device', timeout: 1 }, artifacts, '测试问题', 1)
    if (failureStage) {
      await assert.rejects(run(), error => error === failure)
      assert.deepEqual(await fs.readdir(artifacts.deliveryDirectory), [])
    } else {
      const result = await run()
      assert.equal(result.summaryScreenshot, path.join(artifacts.deliveryDirectory, DOUYIN_SEARCH_SUMMARY_FILENAME))
      assert.deepEqual(await fs.readFile(result.summaryScreenshot), frame)
    }
    assert.equal(captureCalls, failureStage === 'open' ? 0 : 1)
  })
}
