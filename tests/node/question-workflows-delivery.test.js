const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createQuestionWorkflows, DOUYIN_SEARCH_SUMMARY_FILENAME } = require('../../src/automation/question-workflows')
const { ENTRY_DEFINITIONS } = require('../../src/automation/entry-catalog')
const { DouyinSearchResultNotFoundError, ToutiaoAnswerCardNotFoundError } = require('../../src/automation/search-recovery')

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
      waitForDouyinSearchResult: async () => ({
        size: { width: 1080, height: 2400 },
        ocrAttempts: 1,
        elapsedMs: 350,
        stableAbsence: false,
        stabilityPolicy: 'verified_media_mask',
        dynamicRegionsIgnored: 1,
      }),
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
      saveArtifacts: async ({ captureMethod, meta }) => {
        assert.equal(meta.search_entry_scan_policy, 'stable_first_screen_verified_media_mask')
        assert.equal(meta.search_entry_stability_policy, 'verified_media_mask')
        assert.equal(meta.search_entry_dynamic_regions_ignored, 1)
        assert.equal(meta.search_entry_stable_absence, false)
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

for (const [platform, reuseEvidence] of [['douyin', true], ['douyin', false], ['toutiao', true], ['toutiao', false]]) {
  test(`${platform}无入口交付${reuseEvidence ? '复用已验收首屏，禁止重新读取晚变化页面' : '兼容缺少首屏证据时的读取'}并保留检查元数据`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'search-absence-delivery-'))
    t.after(() => fs.rm(root, { recursive: true, force: true }))
    const entry = ENTRY_DEFINITIONS[platform === 'douyin' ? 'douyin-xiaohe-miniapp' : 'toutiao-xiaohe-miniapp']
    const artifacts = { batchDirectory: root, deliveryDirectory: path.join(root, '交付图片'), diagnosticDirectory: path.join(root, '调试产物') }
    const inspection = {
      ocrAttempts: 1, elapsedMs: 350, stableAbsence: true,
      stabilityPolicy: platform === 'douyin' ? 'verified_media_mask' : 'full_first_screen',
      dynamicRegionsIgnored: platform === 'douyin' ? 1 : 0,
    }
    const ErrorClass = platform === 'douyin' ? DouyinSearchResultNotFoundError : ToutiaoAnswerCardNotFoundError
    const acceptedFrame = Buffer.from('accepted-search-first-screen')
    const acceptedXml = '<hierarchy><node text="已核验的原查询" /></hierarchy>'
    const fallbackFrame = Buffer.from('fallback-search-first-screen')
    const fallbackXml = '<hierarchy />'
    let sourceCalls = 0
    let screenshotCalls = 0
    const notFound = new ErrorClass('首屏已确认无入口', {
      inspection,
      ...(reuseEvidence ? { searchEvidence: { frame: acceptedFrame, xml: acceptedXml } } : {}),
    })
    const workflow = createQuestionWorkflows({
      observer: {},
      recoverySnapshot: () => ({}),
      log: () => {},
      getActiveEntry: () => entry,
      getActivePackageName: () => entry.packageName,
      inputDouyinQuestion: async () => [0, 0, 100, 100],
      inputToutiaoQuestion: async () => [0, 0, 100, 100],
      tap: async () => {},
      waitForDouyinSearchResult: async () => { throw notFound },
      waitForToutiaoAnswerCard: async () => { throw notFound },
      source: async () => {
        sourceCalls += 1
        if (reuseEvidence) assert.fail('无入口证据已验收后不能再次读取可能改为另一查询的页面')
        return fallbackXml
      },
      screenshot: async () => {
        screenshotCalls += 1
        if (reuseEvidence) assert.fail('不能使用入口晚出现后的未经核验画面替换已验收首屏')
        return fallbackFrame
      },
      saveArtifacts: async ({ status, meta, frame, xml, stitch }) => {
        assert.equal(status, 'search_completed_without_xiaohe_result')
        assert.equal(stitch, false)
        assert.equal(frame, reuseEvidence ? acceptedFrame : fallbackFrame)
        assert.equal(xml, reuseEvidence ? acceptedXml : fallbackXml)
        assert.equal(meta.search_entry_stability_policy, inspection.stabilityPolicy)
        assert.equal(meta.search_entry_dynamic_regions_ignored, inspection.dynamicRegionsIgnored)
        assert.equal(meta.search_entry_stable_absence, true)
        assert.equal(meta.search_entry_ocr_attempts, 1)
        assert.equal(meta.search_entry_elapsed_ms, 350)
        return { saved: true }
      },
    })
    const run = platform === 'douyin' ? workflow.askOnceDouyin : workflow.askOnceToutiao
    const result = await run({ serial: 'test-device', timeout: 1 }, artifacts, '测试问题', 1)
    assert.equal(result.search_result_only, true)
    assert.equal(result.saved, true)
    assert.equal(sourceCalls, reuseEvidence ? 0 : 1)
    assert.equal(screenshotCalls, reuseEvidence ? 0 : 1)
  })
}
