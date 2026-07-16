const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const sharp = require('sharp')
const XLSX = require('xlsx')
const { questionVisible, currentQuestionText, replyTailOnScreen, findChatScrollBounds, validateCaptureViewport, floatingScrollControlBounds, replyCaptureBounds, estimateVerticalScrollShift, sharedTextSeam, evidencePanelBounds, visibleLabelBounds, visibleLabelBoundsList, boundsListForNodeAttribute, referenceProductsSection, referenceProductImageBounds } = require('../../src/automation/hierarchy')
const { stackFramesInGroups, verifyFrameOverlap, verifyProductGridOverlap, imageInfo, imageLooksLoaded, imagesSimilar, imageRegionsStable, alignCropToWhitespace, stitchFramesWithOverlaps, composeLongImages, cropFramesAtTextSeams } = require('../../src/automation/images')
const { createBatchDirectory, questionArtifactDirectory, batchArtifactDirectories, entryArtifactDirectories, questionArtifactDirectories } = require('../../src/automation/utils')
const { EventLog, classifyAutomationLog } = require('../../src/automation/event-log')
const { loadQuestionFile } = require('../../src/questions')
const { adbConnectionLost, captureFailureDiagnostics, captureStableObserved, captureStableSandwich, calibratedProductFallbackOverlap, chatSwipePlan, conservativeFallbackOverlap, buildReplyImages, CancelledError, DOUYIN_MINIAPP_ENTRY_FILENAME, DOUYIN_SEARCH_SUMMARY_FILENAME, TOUTIAO_SEARCH_SUMMARY_FILENAME, douyinGenericAiAnswerBounds, douyinMiniAppCaptureBounds, douyinMiniAppEntryBounds, douyinOcrViewFullTarget, douyinSearchInput, douyinSearchResultTarget, douyinSearchResultsBounds, douyinViewFullBounds, failedRetryItems, fillQuestionInput, historyOnboardingVisible, maxLongImageHeight, miniAppReferenceProductsTrigger, observerRegionFallbackOptions, prepareEmbeddedEvidence, referenceProductDrawerBounds, referenceProductsCaptureComplete, referenceProductSheetExpanded, referenceProductsTrigger, referenceProductViewportReadiness, refreshedReferenceProductsTrigger, requireQuestionLocated, retryAttemptCount, runQuestionsWithRecovery, scrollEndConfirmed, scrollSingleQuestionSessionToTop, toutiaoGenericConsultationPage, toutiaoHomeSearchBounds, toutiaoOcrViewMoreTarget, toutiaoSearchInput, toutiaoSearchResultBelongsToQuestion, toutiaoViewMoreBounds, waitForPackageHierarchy } = require('../../src/automation/runner')
const { automationEntries, ENTRY_DEFINITIONS, entryHierarchyStartupTimeout, hierarchyBelongsToPackage, normalizeAutomationEntries } = require('../../src/automation/entry-catalog')
const { DouyinSearchResultNotFoundError, ToutiaoAnswerCardNotFoundError, ToutiaoFullAnswerNotOpenedError, runDouyinSearchResultAttempts, runToutiaoAnswerCardAttempts, runToutiaoFullAnswerAttempts } = require('../../src/automation/search-recovery')
const { createQuestionWorkflows } = require('../../src/automation/question-workflows')
const { createReplyCapture } = require('../../src/automation/reply-capture')

const CHAT_BOUNDS = [0, 200, 1080, 1800]

test('抖音全文截图进入共享的回答稳定等待，不引用未定义常量', async () => {
  let quietOptions = null
  const capture = createReplyCapture({
    log: () => {},
    waitForFinalVisualQuiet: async options => {
      quietOptions = options
      throw new Error('quiet-probe')
    },
  })

  await assert.rejects(
    capture.captureDouyinFullAnswerFrames('<hierarchy />', CHAT_BOUNDS),
    /quiet-probe/,
  )
  assert.deepEqual(quietOptions, { quietMs: 3_000, timeout: 25_000 })
})

test('只允许目标App层级进入UI操作流程', () => {
  const target = '<hierarchy><node package="com.aurora.xiaohe.aidoctor" class="android.widget.EditText" /></hierarchy>'
  const search = '<hierarchy><node package="com.huawei.search" class="android.widget.EditText" /></hierarchy>'
  assert.equal(hierarchyBelongsToPackage(target), true)
  assert.equal(hierarchyBelongsToPackage(search), false)
})

test('桌面入口默认勾选小荷App和抖音，并按选择顺序去重执行', () => {
  assert.equal(normalizeAutomationEntries([])[0].id, 'douyin-xiaohe-miniapp')
  const entries = normalizeAutomationEntries(['douyin-xiaohe-miniapp', 'xiaohe-app', 'douyin-xiaohe-miniapp'])
  assert.deepEqual(entries.map(entry => entry.id), ['douyin-xiaohe-miniapp', 'xiaohe-app'])
  assert.deepEqual(automationEntries().map(entry => [entry.id, entry.defaultSelected]), [
    ['xiaohe-app', true],
    ['douyin-xiaohe-miniapp', true],
    ['toutiao-xiaohe-miniapp', false],
  ])
  assert.throws(() => normalizeAutomationEntries(['unknown-entry']), /未知入口/)
})

test('小荷App单题编排通过注入的当前入口生成元数据并继续发送', async () => {
  let saved = null
  const workflow = createQuestionWorkflows({
    observer: {
      active: true,
      mark: () => ({ frameCount: 0 }),
      snapshot: () => ({ active: true }),
      waitForActivity: async () => ({ activity: false }),
    },
    recoverySnapshot: () => ({}),
    log: () => {},
    tapNewSession: async () => false,
    inputQuestion: async () => {},
    tapSend: async () => {},
    recoverObserver: async () => false,
    waitForStableReply: async () => ({ status: 'stable', xml: '<hierarchy />' }),
    captureFullReplyFrames: async () => ({}),
    saveArtifacts: async options => {
      saved = options
      return { metadata: '/tmp/回答.json' }
    },
    getActiveEntry: () => ENTRY_DEFINITIONS['xiaohe-app'],
    getActivePackageName: () => ENTRY_DEFINITIONS['xiaohe-app'].packageName,
  })

  await workflow.askOnce({ serial: 'device', timeout: 1, newSession: false }, {
    batchDirectory: '/tmp/batch_1',
    diagnosticDirectory: '/tmp/batch_1/调试产物/001_测试',
  }, '测试问题', 1)

  assert.equal(saved.meta.entry_id, 'xiaohe-app')
  assert.equal(saved.meta.entry_hierarchy_startup_timeout_ms, 8_000)
})

test('失败重试只选择失败题，并保留原结果位置和题号', () => {
  const summary = {
    retry_count: 1,
    results: [
      { status: 'completed', entry_id: 'xiaohe-app', question: '第一题', question_index: 1 },
      { status: 'failed', entry_id: 'xiaohe-app', question: '第二题', question_index: 2 },
      { status: 'failed', entry_id: 'douyin-xiaohe-miniapp', question: '第三题', question_index: 3 },
    ],
  }
  assert.deepEqual(failedRetryItems(summary).map(item => [item.resultIndex, item.entry_id, item.question, item.question_index]), [
    [1, 'xiaohe-app', '第二题', 2],
    [2, 'douyin-xiaohe-miniapp', '第三题', 3],
  ])
  assert.equal(retryAttemptCount(summary), 2)
  assert.throws(() => failedRetryItems({ results: [{ status: 'failed', question: '缺少入口', question_index: 1 }] }), /信息不完整/)
})

test('单题失败后重新准备入口并继续执行后续问题', async () => {
  const events = []
  const result = await runQuestionsWithRecovery({
    questions: ['第一题', '第二题'],
    prepare: async () => events.push('prepare'),
    execute: async (question, index) => {
      events.push(`execute:${index}:${question}`)
      if (index === 1) throw new Error('搜索结果中没有小荷卡片')
      return { screenshot: '回答_001.png' }
    },
    recordFailure: async (error, question, index) => events.push(`failure:${index}:${question}:${error.message}`),
    isFatal: () => false,
  })

  assert.deepEqual(result, { completed: 1, failed: 1 })
  assert.deepEqual(events, [
    'prepare',
    'execute:1:第一题',
    'failure:1:第一题:搜索结果中没有小荷卡片',
    'prepare',
    'execute:2:第二题',
  ])
})

test('通用失败现场同时保存物理截图、逻辑层级、设备状态和OCR候选', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'geoauto-failure-scene-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const frame = await sharp({ create: { width: 1080, height: 2400, channels: 3, background: '#ffffff' } }).png().toBuffer()
  const xml = '<hierarchy rotation="0"><node package="com.ss.android.article.news" bounds="[0,0][720,1600]"/><node package="android" bounds="[0,0][720,96]"/></hierarchy>'
  const ocrDiagnostic = {
    purpose: 'toutiao_answer_card',
    recognition: { engine: 'rapidocr', image: { width: 1080, height: 2400 }, results: [{ text: '小荷AI医生', confidence: 0.96, bounds: [100, 400, 360, 460] }] },
    target: null,
  }
  const result = await captureFailureDiagnostics({
    directory,
    serial: 'portrait-device',
    entry: { id: 'toutiao-xiaohe-miniapp', label: '头条搜索框（小荷AI小程序）', packageName: 'com.ss.android.article.news' },
    context: { question: '测试问题', question_index: 2 },
    error: new Error('未找到小荷AI医生卡片'),
    captureScreenshot: async () => frame,
    dumpHierarchy: async () => xml,
    currentApp: async () => ({ package: 'com.ss.android.article.news', activity: '.MainActivity' }),
    foregroundWindow: async () => ({ package: 'com.ss.android.article.news', activity: '.MainActivity' }),
    deviceState: async () => ({ wm_size: { status: 'captured', value: 'Physical size: 1080x2400' } }),
    observerSnapshot: () => ({ active: true, frames: 42 }),
    ocrDiagnostic,
    operationTelemetry: {
      current_stage: '正在打开全文',
      failure_analysis: { failed_operation: { operation: 'ui.click', duration_ms: 812, outcome: 'failed' } },
      recent_operations: [{ operation: 'ui.dump_hierarchy', duration_ms: 620, outcome: 'completed' }],
      optimization_candidates: [{ operation: 'ui.dump_hierarchy', total_ms: 1240 }],
    },
  })

  const manifest = JSON.parse(await fs.readFile(result.manifest, 'utf8'))
  assert.equal(manifest.original_error.message, '未找到小荷AI医生卡片')
  assert.deepEqual(manifest.context, { question: '测试问题', question_index: 2 })
  assert.deepEqual([manifest.screenshot.width, manifest.screenshot.height], [1080, 2400])
  assert.equal(manifest.screenshot.coordinate_space, 'adb_screenshot_physical_pixels')
  assert.deepEqual(manifest.hierarchy.logical_size, { width: 720, height: 1600 })
  assert.deepEqual(manifest.hierarchy.packages, ['android', 'com.ss.android.article.news'])
  assert.equal(manifest.hierarchy.coordinate_space, 'uiautomator2_logical_pixels')
  assert.equal(manifest.current_app.value.package, 'com.ss.android.article.news')
  assert.equal(manifest.scrcpy_observer.value.frames, 42)
  assert.equal(manifest.operation_telemetry.current_stage, '正在打开全文')
  assert.equal(manifest.operation_telemetry.failure_analysis.failed_operation.operation, 'ui.click')
  assert.deepEqual(JSON.parse(await fs.readFile(result.ocr, 'utf8')), ocrDiagnostic)
  await Promise.all([result.screenshot, result.hierarchy, result.ocr].map(file => fs.access(file)))
})

test('失败现场的单个诊断源失败不会吞掉其他证据或原始错误', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'geoauto-partial-failure-scene-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const result = await captureFailureDiagnostics({
    directory,
    error: new Error('原始任务失败'),
    captureScreenshot: async () => { throw new Error('ADB截图失败') },
    dumpHierarchy: async () => '<hierarchy><node package="com.aurora.xiaohe.aidoctor" bounds="[0,0][1080,2400]"/></hierarchy>',
    currentApp: async () => { throw new Error('current_app超时') },
    foregroundWindow: async () => null,
    deviceState: async () => ({ wm_size: { status: 'failed', error: { message: '设备断开' } } }),
    observerSnapshot: () => ({ active: false }),
  })

  const manifest = JSON.parse(await fs.readFile(result.manifest, 'utf8'))
  assert.equal(manifest.original_error.message, '原始任务失败')
  assert.equal(manifest.screenshot.status, 'failed')
  assert.match(manifest.screenshot.error.message, /ADB截图失败/)
  assert.equal(manifest.hierarchy.status, 'captured')
  assert.equal(manifest.current_app.status, 'failed')
  assert.equal(manifest.ocr.status, 'not_available')
  await fs.access(result.hierarchy)
})

test('用户停止属于致命错误，不会继续后续问题', async () => {
  const executed = []
  await assert.rejects(() => runQuestionsWithRecovery({
    questions: ['第一题', '第二题'],
    prepare: async () => {},
    execute: async question => {
      executed.push(question)
      throw new CancelledError()
    },
    recordFailure: async () => assert.fail('停止任务不应写成单题失败'),
  }), /任务已停止/)
  assert.deepEqual(executed, ['第一题'])
})

test('抖音入口按真实搜索控件和回答卡片结构定位', () => {
  assert.equal(DOUYIN_SEARCH_SUMMARY_FILENAME, '回答_智能总结.png')
  const xml = `<hierarchy>
    <node package="com.ss.android.ugc.aweme" class="android.widget.EditText" resource-id="com.ss.android.ugc.aweme:id/et_search_kw" text="腹泻脱水用什么药" visible-to-user="true" bounds="[144,96][868,204]" />
    <node package="com.ss.android.ugc.aweme" class="android.widget.TextView" text="小荷AI医生" visible-to-user="true" bounds="[164,430][420,510]" />
    <node package="com.ss.android.ugc.aweme" class="android.view.ViewGroup" text="" content-desc="" visible-to-user="true" bounds="[414,1348][666,1456]" />
    <node package="com.ss.android.ugc.aweme" class="android.view.ViewGroup" text="" content-desc="" visible-to-user="true" bounds="[60,1648][224,1756]" />
  </hierarchy>`
  assert.deepEqual(douyinSearchInput(xml), { bounds: [144, 96, 868, 204], text: '腹泻脱水用什么药' })
  assert.deepEqual(douyinViewFullBounds(xml, { width: 1080, height: 2408 }), [414, 1348, 666, 1456])
})

test('抖音层级缺失时OCR以品牌、智能总结和查看全文三重证据定位', () => {
  const recognition = (width, height) => {
    const scaleX = width / 1080
    const scaleY = height / 2400
    const bounds = values => values.map((value, index) => Math.round(value * (index % 2 ? scaleY : scaleX)))
    return {
      image: { width, height },
      results: [
        { normalizedText: '小荷AI医生', confidence: 0.999, bounds: bounds([201, 448, 431, 499]) },
        { normalizedText: '根据医学数据智能总结', confidence: 0.999, bounds: bounds([199, 512, 597, 558]) },
        { normalizedText: '查看全文', confidence: 0.993, bounds: bounds([431, 982, 641, 1035]) },
      ],
    }
  }

  assert.deepEqual(douyinOcrViewFullTarget(recognition(1080, 2400), { width: 1080, height: 2400 }).bounds, [431, 982, 641, 1035])
  assert.deepEqual(douyinOcrViewFullTarget(recognition(720, 1600), { width: 1080, height: 2400 }).bounds, [431, 983, 641, 1035])
  assert.equal(douyinOcrViewFullTarget({
    ...recognition(1080, 2400),
    results: recognition(1080, 2400).results.filter(item => item.normalizedText !== '小荷AI医生'),
  }, { width: 1080, height: 2400 }), null)
})

test('抖音无智能总结时识别独立小程序入口卡片，混合页面优先独立入口', () => {
  const entry = `<hierarchy>
    <node package="com.ss.android.ugc.aweme" class="android.widget.EditText" resource-id="com.ss.android.ugc.aweme:id/et_search_kw" text="测试问题" visible-to-user="true" bounds="[132,90][754,210]" />
    <node package="com.ss.android.ugc.aweme" class="android.widget.FrameLayout" visible-to-user="true" bounds="[12,1387][534,2131]">
      <node package="com.ss.android.ugc.aweme" class="android.view.ViewGroup" visible-to-user="true" bounds="[12,1387][534,2131]"><node package="com.ss.android.ugc.aweme" class="android.view.ViewGroup" visible-to-user="true" bounds="[36,1411][510,2107]" /></node>
      <node package="com.ss.android.ugc.aweme" class="android.view.ViewGroup" visible-to-user="true" bounds="[36,1411][510,1579]"><node package="com.ss.android.ugc.aweme" class="android.view.ViewGroup" visible-to-user="true" bounds="[60,1435][180,1555]" /><node package="com.ss.android.ugc.aweme" class="android.view.ViewGroup" visible-to-user="true" bounds="[103,1565][137,1579]" /></node>
      <node package="com.ss.android.ugc.aweme" class="android.view.ViewGroup" visible-to-user="true" bounds="[36,1603][510,1783]" />
      <node package="com.ss.android.ugc.aweme" class="android.view.ViewGroup" visible-to-user="true" bounds="[36,1783][510,2095]" />
    </node>
  </hierarchy>`
  assert.equal(DOUYIN_MINIAPP_ENTRY_FILENAME, '回答_小程序入口.png')
  assert.deepEqual(douyinMiniAppEntryBounds(entry, { width: 1080, height: 2400 }), {
    cardBounds: [12, 1387, 534, 2131],
    tapBounds: [36, 1411, 510, 1579],
  })
  assert.deepEqual(douyinSearchResultsBounds(`${entry}<node package="com.ss.android.ugc.aweme" class="androidx.recyclerview.widget.RecyclerView" visible-to-user="true" bounds="[0,357][1080,2400]" />`, { width: 1080, height: 2400 }), [0, 357, 1080, 2400])
  assert.equal(douyinSearchResultTarget(entry, { width: 1080, height: 2400 }).mode, 'miniapp_entry_card')
  const summary = `${entry}<node package="com.ss.android.ugc.aweme" class="android.widget.TextView" text="小荷AI医生" visible-to-user="true" bounds="[164,430][420,510]" /><node package="com.ss.android.ugc.aweme" class="android.view.ViewGroup" visible-to-user="true" bounds="[414,1348][666,1456]" />`
  assert.equal(douyinSearchResultTarget(summary, { width: 1080, height: 2400 }).mode, 'miniapp_entry_card')
  assert.equal(douyinSearchResultTarget(summary.replace(entry, '<hierarchy>'), { width: 1080, height: 2400 }).mode, 'smart_summary')
  assert.equal(douyinSearchResultTarget('<hierarchy><node package="com.ss.android.ugc.aweme" class="android.widget.EditText" resource-id="com.ss.android.ugc.aweme:id/et_search_kw" text="测试问题" visible-to-user="true" bounds="[132,90][754,210]" /></hierarchy>', { width: 1080, height: 2400 }), null)
  assert.equal(douyinMiniAppEntryBounds(entry.replace('<node package="com.ss.android.ugc.aweme" class="android.view.ViewGroup" visible-to-user="true" bounds="[60,1435][180,1555]" />', '<node package="com.ss.android.ugc.aweme" class="android.view.ViewGroup" resource-id="other:id/card" visible-to-user="true" bounds="[60,1435][180,1555]" />'), { width: 1080, height: 2400 }), null)
})

test('抖音通用AI回答不得冒充小荷智能总结', () => {
  const genericAnswer = `<hierarchy>
    <node package="com.ss.android.ugc.aweme" class="android.widget.EditText" resource-id="com.ss.android.ugc.aweme:id/et_search_kw" text="拉肚子脱水怎么办" visible-to-user="true" bounds="[132,90][754,210]" />
    <node package="com.ss.android.ugc.aweme" class="android.widget.TextView" text="AI 生成回答" visible-to-user="true" bounds="[48,390][330,460]" />
    <node package="com.ss.android.ugc.aweme" class="android.view.ViewGroup" visible-to-user="true" bounds="[358,1210][722,1320]">
      <node package="com.ss.android.ugc.aweme" class="android.widget.TextView" text="展开更多" visible-to-user="true" bounds="[430,1225][650,1305]" />
    </node>
  </hierarchy>`
  const entryCard = `<node package="com.ss.android.ugc.aweme" class="android.widget.FrameLayout" visible-to-user="true" bounds="[12,1387][534,2131]">
    <node package="com.ss.android.ugc.aweme" class="android.view.ViewGroup" visible-to-user="true" bounds="[12,1387][534,2131]"><node package="com.ss.android.ugc.aweme" class="android.view.ViewGroup" visible-to-user="true" bounds="[36,1411][510,2107]" /></node>
    <node package="com.ss.android.ugc.aweme" class="android.view.ViewGroup" visible-to-user="true" bounds="[36,1411][510,1579]"><node package="com.ss.android.ugc.aweme" class="android.view.ViewGroup" visible-to-user="true" bounds="[60,1435][180,1555]" /><node package="com.ss.android.ugc.aweme" class="android.view.ViewGroup" visible-to-user="true" bounds="[103,1565][137,1579]" /></node>
    <node package="com.ss.android.ugc.aweme" class="android.view.ViewGroup" visible-to-user="true" bounds="[36,1603][510,1783]" />
    <node package="com.ss.android.ugc.aweme" class="android.view.ViewGroup" visible-to-user="true" bounds="[36,1783][510,2095]" />
  </node>`
  const mixed = genericAnswer.replace('</hierarchy>', `${entryCard}</hierarchy>`)

  assert.deepEqual(douyinGenericAiAnswerBounds(genericAnswer, { width: 1080, height: 2400 }), [430, 1225, 650, 1305])
  assert.equal(douyinSearchResultTarget(genericAnswer, { width: 1080, height: 2400 }), null)
  assert.equal(douyinSearchResultTarget(mixed, { width: 1080, height: 2400 }).mode, 'miniapp_entry_card')
})

test('抖音首轮没有结果时只刷新一次并执行第二轮识别', async () => {
  const calls = []
  const result = await runDouyinSearchResultAttempts({
    waitForResult: async attempt => {
      calls.push(`wait:${attempt}`)
      if (attempt === 1) throw new DouyinSearchResultNotFoundError('首轮未找到')
      return { target: { mode: 'smart_summary' } }
    },
    refreshResults: async () => calls.push('refresh'),
  })

  assert.equal(result.attempt, 2)
  assert.equal(result.refreshed, true)
  assert.deepEqual(calls, ['wait:1', 'refresh', 'wait:2'])
})

test('抖音刷新后仍没有入口时明确失败且不进行第三轮', async () => {
  const calls = []
  await assert.rejects(() => runDouyinSearchResultAttempts({
    waitForResult: async attempt => {
      calls.push(`wait:${attempt}`)
      throw new DouyinSearchResultNotFoundError(`第${attempt}轮未找到`)
    },
    refreshResults: async () => calls.push('refresh'),
  }), /刷新后再次扫描.*仍未出现/)
  assert.deepEqual(calls, ['wait:1', 'refresh', 'wait:2'])
})

test('抖音搜索读取异常不会被刷新重试掩盖', async () => {
  let refreshes = 0
  await assert.rejects(() => runDouyinSearchResultAttempts({
    waitForResult: async () => { throw new Error('uiautomator2读取失败') },
    refreshResults: async () => { refreshes += 1 },
  }), /uiautomator2读取失败/)
  assert.equal(refreshes, 0)
})

test('头条只在确认未召回小荷卡片时用相同问题受控重试一次', async () => {
  const calls = []
  const result = await runToutiaoAnswerCardAttempts({
    waitForResult: async attempt => {
      calls.push(`wait:${attempt}`)
      if (attempt === 1) throw new ToutiaoAnswerCardNotFoundError('首轮只有药品通结果')
      return { detectionMethod: 'ui_hierarchy' }
    },
    repeatExactSearch: async () => calls.push('repeat-exact'),
  })

  assert.equal(result.attempt, 2)
  assert.equal(result.repeated, true)
  assert.deepEqual(calls, ['wait:1', 'repeat-exact', 'wait:2'])
})

test('头条同词重试后仍未召回则明确失败且不进行第三次搜索', async () => {
  const calls = []
  await assert.rejects(() => runToutiaoAnswerCardAttempts({
    waitForResult: async attempt => {
      calls.push(`wait:${attempt}`)
      throw new ToutiaoAnswerCardNotFoundError(`第${attempt}轮未召回`)
    },
    repeatExactSearch: async () => calls.push('repeat-exact'),
  }), /相同问题受控重试后.*仍未出现/)
  assert.deepEqual(calls, ['wait:1', 'repeat-exact', 'wait:2'])
})

test('头条读取或点击异常不会被同词重试掩盖', async () => {
  let repeats = 0
  await assert.rejects(() => runToutiaoAnswerCardAttempts({
    waitForResult: async () => { throw new Error('uiautomator2读取失败') },
    repeatExactSearch: async () => { repeats += 1 },
  }), /uiautomator2读取失败/)
  assert.equal(repeats, 0)
})

test('头条全文路由拒绝带发送框的通用咨询页', () => {
  const generic = `<hierarchy>
    <node package="com.ss.android.article.news" class="android.widget.EditText" text="发送消息" hint="发送消息" visible-to-user="true" bounds="[99,2249][861,2321]" />
  </hierarchy>`
  const fullAnswer = generic.replace('android.widget.EditText', 'android.view.ViewGroup').replaceAll('发送消息', '')
  assert.equal(toutiaoGenericConsultationPage(generic), true)
  assert.equal(toutiaoGenericConsultationPage(fullAnswer), false)
})

test('头条全文误入通用咨询页时只重新搜索并路由一次', async () => {
  const calls = []
  const result = await runToutiaoFullAnswerAttempts({
    initialTarget: { viewMore: 'first' },
    openFullAnswer: async target => {
      calls.push(`open:${target.viewMore}`)
      if (target.viewMore === 'first') throw new ToutiaoFullAnswerNotOpenedError('误入通用咨询页')
      return { bounds: [0, 300, 1080, 2000] }
    },
    repeatExactSearch: async () => {
      calls.push('repeat-exact')
      return { viewMore: 'second' }
    },
  })
  assert.equal(result.attempt, 2)
  assert.equal(result.repeated, true)
  assert.deepEqual(calls, ['open:first', 'repeat-exact', 'open:second'])
})

test('头条非路由错误或已用完搜索次数时不重放全文点击', async () => {
  let repeats = 0
  await assert.rejects(() => runToutiaoFullAnswerAttempts({
    initialTarget: {},
    openFullAnswer: async () => { throw new Error('uiautomator2读取失败') },
    repeatExactSearch: async () => { repeats += 1 },
  }), /uiautomator2读取失败/)
  await assert.rejects(() => runToutiaoFullAnswerAttempts({
    initialTarget: {},
    canRepeat: false,
    openFullAnswer: async () => { throw new ToutiaoFullAnswerNotOpenedError('已用完搜索次数') },
    repeatExactSearch: async () => { repeats += 1 },
  }), /已用完搜索次数/)
  assert.equal(repeats, 0)
})

test('抖音小荷AI全文页排除固定顶部、工具栏和输入区', () => {
  const xml = `<hierarchy>
    <node package="com.ss.android.ugc.aweme" class="android.widget.ImageView" content-desc="关闭" visible-to-user="true" bounds="[944,111][1056,207]" />
    <node package="com.ss.android.ugc.aweme" class="android.view.ViewGroup" visible-to-user="true" bounds="[0,363][1080,1785]">
      <node package="com.ss.android.ugc.aweme" class="android.view.ViewGroup" visible-to-user="true" bounds="[0,363][1080,1785]" />
    </node>
    <node package="com.ss.android.ugc.aweme" class="android.widget.ScrollView" visible-to-user="true" bounds="[0,1785][1080,1940]" />
    <node package="com.ss.android.ugc.aweme" class="android.widget.HorizontalScrollView" scrollable="true" visible-to-user="true" bounds="[0,1785][1080,1940]" />
  </hierarchy>`
  assert.deepEqual(douyinMiniAppCaptureBounds(xml, { width: 1080, height: 2408 }), [0, 363, 1080, 1785])
  assert.equal(douyinMiniAppCaptureBounds(`${xml}<node package="com.ss.android.ugc.aweme" class="android.widget.EditText" resource-id="com.ss.android.ugc.aweme:id/et_search_kw" visible-to-user="true" bounds="[1,1][2,2]" />`, { width: 1080, height: 2408 }), null)
})

test('抖音小程序回答尾部用无文字卡片结构定位参考药品箭头', () => {
  const xml = `<hierarchy>
    <node class="android.view.ViewGroup" bounds="[0,363][1080,2014]">
      <node class="android.view.ViewGroup" bounds="[0,1093][1080,1486]">
        <node class="android.view.ViewGroup" bounds="[24,1111][1056,1486]">
          <node class="android.widget.ImageView" bounds="[972,1160][1008,1196]" />
          <node class="android.view.ViewGroup" bounds="[72,1244][240,1412]" />
        </node>
      </node>
      <node class="android.view.ViewGroup" bounds="[0,1486][1080,1774]" />
    </node>
  </hierarchy>`

  assert.deepEqual(miniAppReferenceProductsTrigger(xml, [0, 363, 1080, 2014]), [990, 1178])
  assert.equal(miniAppReferenceProductsTrigger(xml.replace('android.widget.ImageView', 'android.view.ViewGroup'), [0, 363, 1080, 2014]), null)
})

test('头条入口按真实搜索框和“查看更多”卡片结构定位', () => {
  assert.equal(TOUTIAO_SEARCH_SUMMARY_FILENAME, '回答_智能总结.png')
  const xml = `<hierarchy>
    <node package="com.ss.android.article.news" class="" resource-id="com.ss.android.article.news:id/cx" text="搜索框，腹泻脱水用什么药" clickable="true" visible-to-user="true" bounds="[245,102][792,222]" />
    <node package="com.ss.android.article.news" class="android.view.View" text="小荷AI医生·智能总结" visible-to-user="true" bounds="[168,441][714,528]" />
    <node package="com.ss.android.article.news" class="android.widget.Button" text="查看更多" clickable="true" visible-to-user="true" bounds="[72,1323][1008,1464]" />
  </hierarchy>`

  assert.deepEqual(toutiaoSearchInput(xml), { bounds: [245, 102, 792, 222], text: '腹泻脱水用什么药' })
  assert.equal(toutiaoSearchResultBelongsToQuestion(xml, '腹泻脱水用什么药'), true)
  assert.equal(toutiaoSearchResultBelongsToQuestion(xml, '旧问题'), false)
  assert.deepEqual(toutiaoViewMoreBounds(xml), [72, 1323, 1008, 1464])
  assert.equal(toutiaoViewMoreBounds(xml.replace('小荷AI医生·智能总结', '普通搜索结果')), null)
})

test('头条首页搜索入口兼容不同竖屏尺寸并拒绝非搜索框节点', () => {
  const home = (bounds, description = '搜索框，腹泻脱水用什么药') => `<hierarchy>
    <node package="com.ss.android.article.news" class="android.widget.TextView" resource-id="com.ss.android.article.news:id/kic" content-desc="${description}" visible-to-user="true" bounds="${bounds}" />
  </hierarchy>`

  assert.deepEqual(toutiaoHomeSearchBounds(home('[291,96][805,216]')), [291, 96, 805, 216])
  assert.deepEqual(toutiaoHomeSearchBounds(home('[194,64][537,144]')), [194, 64, 537, 144])
  assert.equal(toutiaoHomeSearchBounds(home('[291,96][805,216]', '普通推荐词')), null)
  assert.equal(toutiaoHomeSearchBounds(home('[291,96][805,216]').replace(':id/kic', ':id/l23')), null)
})

test('头条WebView不暴露文字时以品牌标题和查看更多的OCR几何关系定位', () => {
  const recognition = (width, height, scale = 1) => ({
    image: { width, height },
    results: [
      { text: '小荷AI医生・智能总结', normalizedText: '小荷AI医生智能总结', confidence: 0.988, bounds: [156, 433, 630, 489].map(value => value * scale) },
      { text: '查看更多>', normalizedText: '查看更多', confidence: 0.978, bounds: [420, 1254, 656, 1313].map(value => value * scale) },
      { text: '小荷AI医生', normalizedText: '小荷AI医生', confidence: 0.99, bounds: [68, 1681, 279, 1732].map(value => value * scale) },
    ],
  })

  const full = toutiaoOcrViewMoreTarget(recognition(1080, 2400), { width: 1080, height: 2400 })
  assert.deepEqual(full.bounds, [420, 1254, 656, 1313])
  assert.equal(full.summaryConfidence, 0.988)

  const scaled = toutiaoOcrViewMoreTarget(recognition(720, 1600, 2 / 3), { width: 1080, height: 2400 })
  assert.deepEqual(scaled.bounds, [420, 1254, 656, 1313])

  const generic = recognition(1080, 2400)
  generic.results[0] = { ...generic.results[0], text: 'AI生成回答', normalizedText: 'AI生成回答' }
  assert.equal(toutiaoOcrViewMoreTarget(generic, { width: 1080, height: 2400 }), null)
})

test('入口启动后等待目标App层级出现，避免启动过渡误判前台错误', async () => {
  let now = 0
  const packages = ['com.huawei.android.launcher', 'com.huawei.android.launcher', 'com.aurora.xiaohe.aidoctor']
  const xml = await waitForPackageHierarchy({
    dumpHierarchy: async () => `<hierarchy><node package="${packages.shift()}" /></hierarchy>`,
    packageName: 'com.aurora.xiaohe.aidoctor',
    packageLabel: '小荷App',
    delay: async milliseconds => { now += milliseconds },
    now: () => now,
    timeout: 1_000,
    interval: 100,
  })

  assert.match(xml, /com\.aurora\.xiaohe\.aidoctor/)
  assert.equal(now, 200)
})

test('头条冷启动允许更长的只读层级等待，其他入口保持原窗口', () => {
  assert.equal(entryHierarchyStartupTimeout({ workflow: 'toutiao-search' }), 30_000)
  assert.equal(entryHierarchyStartupTimeout({ workflow: 'douyin-search' }), 8_000)
  assert.equal(entryHierarchyStartupTimeout({}), 8_000)
})

test('头条冷启动层级一旦出现就立即继续，不固定等待完整30秒', async () => {
  let now = 0
  const xml = await waitForPackageHierarchy({
    dumpHierarchy: async () => `<hierarchy><node package="${now >= 12_000 ? 'com.ss.android.article.news' : 'com.android.systemui'}" /></hierarchy>`,
    packageName: 'com.ss.android.article.news',
    packageLabel: '头条小荷AI小程序',
    delay: async milliseconds => { now += milliseconds },
    now: () => now,
    timeout: entryHierarchyStartupTimeout({ workflow: 'toutiao-search' }),
    interval: 1_000,
  })

  assert.match(xml, /com\.ss\.android\.article\.news/)
  assert.equal(now, 12_000)
})

test('输入完成后不盲按返回键退出App', async () => {
  const events = []
  const xml = '<hierarchy><node package="com.aurora.xiaohe.aidoctor" /></hierarchy>'
  const result = await fillQuestionInput({
    ui: {
      sendKeys: async (text, options) => events.push(['sendKeys', text, options]),
      press: async key => events.push(['press', key]),
    },
    tap: async (x, y) => events.push(['tap', x, y]),
    source: async () => { events.push(['source']); return xml },
    delay: async milliseconds => events.push(['delay', milliseconds]),
  }, { bounds: [100, 200, 500, 300], text: '' }, '真机测试')

  assert.equal(result, xml)
  assert.deepEqual(events, [
    ['tap', 300, 250],
    ['delay', 300],
    ['sendKeys', '真机测试', { clear: true }],
    ['delay', 350],
    ['source'],
  ])
})

test('输入层级误报为空时仍先清空，避免把新问题追加到残留文本', async () => {
  const calls = []
  await fillQuestionInput({
    ui: { sendKeys: async (text, options) => calls.push([text, options]) },
    tap: async () => {},
    source: async () => '<hierarchy />',
    delay: async () => {},
  }, { bounds: [0, 0, 100, 50], text: '' }, '新问题')
  assert.deepEqual(calls, [['新问题', { clear: true }]])
})

test('输入回读发现旧文本被拼接时通过聚焦控件原子替换后再确认', async () => {
  const events = []
  const frames = ['旧问题新问题', '新问题']
  const result = await fillQuestionInput({
    ui: {
      sendKeys: async (text, options) => events.push(['sendKeys', text, options]),
      setFocusedText: async text => events.push(['setFocusedText', text]),
    },
    tap: async (x, y) => events.push(['tap', x, y]),
    source: async () => `<input text="${frames.shift()}" />`,
    readText: xml => /text="([^"]*)"/.exec(xml)?.[1] ?? null,
    log: message => events.push(['log', message]),
    delay: async milliseconds => events.push(['delay', milliseconds]),
  }, { bounds: [100, 200, 500, 300], text: '旧问题' }, '新问题')

  assert.equal(result, '<input text="新问题" />')
  assert.deepEqual(events, [
    ['tap', 300, 250],
    ['delay', 300],
    ['sendKeys', '新问题', { clear: true }],
    ['delay', 350],
    ['log', 'stage: 输入后回读不一致，正在通过聚焦控件原子替换并再次确认'],
    ['tap', 300, 250],
    ['delay', 200],
    ['setFocusedText', '新问题'],
    ['delay', 350],
  ])
})

test('定位不到刚发送的问题时拒绝截取旧回答', () => {
  assert.doesNotThrow(() => requireQuestionLocated(true, '新问题'))
  assert.throws(() => requireQuestionLocated(false, '新问题'), /避免截取旧回答/)
})

test('新会话不判断问题气泡，连续两次向上无变化才确认顶部', async () => {
  const frames = ['中部', '顶部', '顶部', '顶部']
  const touchpoints = []
  const result = await scrollSingleQuestionSessionToTop({
    capture: async () => ({ frame: '底部' }),
    swipeUp: async attempt => { touchpoints.push(attempt % 2 ? 0.68 : 0.84); return {} },
    settle: async () => ({ frame: frames.shift() }),
    framesStable: async (before, after) => before === after,
  })

  assert.equal(result.confirmed, true)
  assert.equal(result.swipes, 4)
  assert.deepEqual(touchpoints, [0.84, 0.68, 0.84, 0.68])
})

test('稳定帧夹心校验首轮只需要两次截图', async () => {
  let now = 0
  const events = []
  const frames = [Buffer.from('same'), Buffer.from('same')]
  const result = await captureStableSandwich({
    capture: async () => { events.push('capture'); return frames.shift() },
    hierarchy: async () => { events.push('hierarchy'); return '<hierarchy />' },
    framesStable: async (before, after) => before.equals(after),
    hierarchyLoading: () => false,
    delay: async milliseconds => { events.push(`delay:${milliseconds}`); now += milliseconds },
    now: () => now,
    interval: 80,
  }, 1_000)

  assert.equal(result.stable, true)
  assert.equal(result.attempts, 1)
  assert.deepEqual(events, ['capture', 'delay:80', 'hierarchy', 'capture'])
})

test('夹心校验发现滚动未停时复用最新帧继续检测', async () => {
  let now = 0
  const frames = [Buffer.from('first'), Buffer.from('moving'), Buffer.from('moving')]
  let captures = 0
  const result = await captureStableSandwich({
    capture: async () => { captures += 1; return frames.shift() },
    hierarchy: async () => '<hierarchy />',
    framesStable: async (before, after) => before.equals(after),
    hierarchyLoading: () => false,
    delay: async milliseconds => { now += milliseconds },
    now: () => now,
    interval: 80,
  }, 1_000)

  assert.equal(result.stable, true)
  assert.equal(result.attempts, 2)
  assert.equal(captures, 3)
})

test('从scrcpy路径切换夹心校验时复用已有PNG', async () => {
  let now = 0
  const events = []
  const initialFrame = Buffer.from('same')
  const result = await captureStableSandwich({
    capture: async () => { events.push('capture'); return Buffer.from('same') },
    hierarchy: async () => { events.push('hierarchy'); return '<hierarchy />' },
    framesStable: async (before, after) => before.equals(after),
    hierarchyLoading: () => false,
    delay: async milliseconds => { events.push(`delay:${milliseconds}`); now += milliseconds },
    now: () => now,
    interval: 80,
    initialFrame,
  }, 1_000)

  assert.equal(result.stable, true)
  assert.equal(result.attempts, 1)
  assert.deepEqual(events, ['delay:80', 'hierarchy', 'capture'])
})

test('scrcpy明确报告活动时要求目标区域连续两组像素稳定', async () => {
  let now = 0
  const events = []
  const initialFrame = Buffer.from('same')
  const result = await captureStableSandwich({
    capture: async () => { events.push('capture'); return Buffer.from('same') },
    hierarchy: async () => { events.push('hierarchy'); return '<hierarchy />' },
    framesStable: async (before, after) => before.equals(after),
    hierarchyLoading: () => false,
    delay: async milliseconds => { events.push(`delay:${milliseconds}`); now += milliseconds },
    now: () => now,
    interval: 80,
    initialFrame,
    requiredStablePairs: 2,
  }, 1_000)

  assert.equal(result.stable, true)
  assert.equal(result.attempts, 2)
  assert.deepEqual(events, ['delay:80', 'hierarchy', 'capture', 'delay:80', 'hierarchy', 'capture'])
})

test('严格区域校验遇到中途变化会重新累计连续稳定证据', async () => {
  let now = 0
  const frames = [Buffer.from('first'), Buffer.from('moving'), Buffer.from('moving'), Buffer.from('moving')]
  const result = await captureStableSandwich({
    capture: async () => frames.shift(),
    hierarchy: async () => '<hierarchy />',
    framesStable: async (before, after) => before.equals(after),
    hierarchyLoading: () => false,
    delay: async milliseconds => { now += milliseconds },
    now: () => now,
    interval: 80,
    initialFrame: Buffer.from('first'),
    requiredStablePairs: 2,
  }, 1_000)

  assert.equal(result.stable, true)
  assert.equal(result.attempts, 4)
  assert.ok(result.frame.equals(Buffer.from('moving')))
})

test('scrcpy确认静止后只截取一张无损PNG，并校验层级读取期间无重排', async () => {
  const events = []
  const observer = {
    waitForNoActivity: async () => { events.push('noActivity'); return { quiet: true } },
    mark: () => ({ frameCount: 7 }),
  }
  const result = await captureStableObserved({
    observer,
    capture: async () => { events.push('capture'); return Buffer.from('png') },
    hierarchy: async () => { events.push('hierarchy'); return '<hierarchy />' },
    hierarchyLoading: () => false,
  })

  assert.equal(result.stable, true)
  assert.equal(result.observer, true)
  assert.deepEqual(events, ['noActivity', 'hierarchy', 'capture', 'noActivity'])
})

test('滑动后的稳定截图优先使用活动标记快速判静止', async () => {
  const events = []
  const settleSince = { at: 1_000, frameCount: 4, activityFrameCount: 2 }
  const observer = {
    waitForSettleSince: async (mark, options) => {
      events.push(['settle', mark, options])
      return { settled: true, activity: true }
    },
    waitForNoActivity: async () => { events.push(['noActivity']); return { quiet: true } },
    mark: () => ({ frameCount: 7, activityFrameCount: 2 }),
  }

  const result = await captureStableObserved({
    observer,
    settleSince,
    capture: async () => { events.push(['capture']); return Buffer.from('png') },
    hierarchy: async () => { events.push(['hierarchy']); return '<hierarchy />' },
    hierarchyLoading: () => false,
  })

  assert.equal(result.stable, true)
  assert.deepEqual(events, [
    ['settle', settleSince, { hardTimeout: 2500, quietMs: 650, conservativeQuietMs: 1000 }],
    ['hierarchy'],
    ['capture'],
    ['noActivity'],
  ])
})

test('scrcpy未等到静止时不额外读层级或截PNG', async () => {
  const events = []
  const result = await captureStableObserved({
    observer: {
      waitForSettleSince: async () => ({ settled: false, activity: true }),
    },
    settleSince: { at: 0, frameCount: 0, activityFrameCount: 0 },
    capture: async () => { events.push('capture'); return Buffer.from('png') },
    hierarchy: async () => { events.push('hierarchy'); return '<hierarchy />' },
    hierarchyLoading: () => false,
  })

  assert.equal(result.stable, false)
  assert.equal(result.reason, 'settle_timeout')
  assert.equal(result.frame, null)
  assert.equal(result.xml, '')
  assert.deepEqual(events, [])
})

test('scrcpy二次确认失败时保留PNG给ADB夹心校验', async () => {
  const events = []
  let noActivityChecks = 0
  const observer = {
    waitForNoActivity: async () => {
      noActivityChecks += 1
      return noActivityChecks === 1 ? { quiet: true } : { quiet: false }
    },
    mark: () => ({ frameCount: 7, activityFrameCount: 2 }),
  }
  const result = await captureStableObserved({
    observer,
    capture: async () => { events.push('capture'); return Buffer.from('png') },
    hierarchy: async () => { events.push('hierarchy'); return '<hierarchy />' },
    hierarchyLoading: () => false,
  })

  assert.equal(result.stable, false)
  assert.equal(result.reason, 'confirmation_timeout')
  assert.ok(result.frame.equals(Buffer.from('png')))
  assert.equal(result.xml, '<hierarchy />')
  assert.deepEqual(events, ['hierarchy', 'capture'])
})

test('scrcpy二次确认拒绝截图期间任意活动帧', async () => {
  let marks = 0
  const observer = {
    waitForNoActivity: async () => ({ quiet: true }),
    mark: () => {
      marks += 1
      return marks === 1
        ? { activityFrameCount: 10, burstActivityFrameCount: 4 }
        : { activityFrameCount: 13, burstActivityFrameCount: 4 }
    },
  }

  const result = await captureStableObserved({
    observer,
    capture: async () => Buffer.from('png'),
    hierarchy: async () => '<hierarchy />',
    hierarchyLoading: () => false,
  })

  assert.equal(result.stable, false)
  assert.equal(result.reason, 'capture_activity')
})

test('scrcpy二次确认仍拒绝截图期间的连续活动突发', async () => {
  let marks = 0
  const observer = {
    waitForNoActivity: async () => ({ quiet: true }),
    mark: () => {
      marks += 1
      return marks === 1
        ? { activityFrameCount: 10, burstActivityFrameCount: 4 }
        : { activityFrameCount: 13, burstActivityFrameCount: 5 }
    },
  }

  const result = await captureStableObserved({
    observer,
    capture: async () => Buffer.from('png'),
    hierarchy: async () => '<hierarchy />',
    hierarchyLoading: () => false,
  })

  assert.equal(result.stable, false)
  assert.equal(result.reason, 'capture_activity')
})

test('scrcpy全屏活动升级为严格区域校验，其他不确定结果使用普通夹心校验', () => {
  const frame = Buffer.from('observed')
  assert.deepEqual(observerRegionFallbackOptions({ reason: 'capture_activity', frame }), {
    initialFrame: frame,
    requiredStablePairs: 2,
    activityObserved: true,
  })
  assert.deepEqual(observerRegionFallbackOptions({ reason: 'confirmation_timeout', frame }), {
    initialFrame: frame,
    requiredStablePairs: 1,
    activityObserved: false,
  })
  assert.deepEqual(observerRegionFallbackOptions({ reason: 'settle_timeout', frame: null }), {
    initialFrame: null,
    requiredStablePairs: 1,
    activityObserved: false,
  })
})

test('只有完整进入聊天截图区域的问题才视为已定位', () => {
  const bubble = (bounds, visible) => '<hierarchy><node class="android.view.View" bounds="[0,200][1080,1800]">'
    + `<node class="android.view.View" bounds="[0,160][1080,460]"><node class="android.view.View" bounds="[690,160][1030,460]"><node class="android.widget.TextView" text="这是一个很长的问题" content-desc="这是一个很长的问题" visible-to-user="${visible}" bounds="${bounds}" />`
    + '</node></node></node></hierarchy>'
  const hidden = bubble('[700,260][1020,340]', 'false')
  const clipped = bubble('[700,180][1020,260]', 'true')
  const visible = bubble('[700,260][1020,340]', 'true')
  assert.equal(questionVisible(hidden, '这是一个很长的问题', CHAT_BOUNDS), false)
  assert.equal(questionVisible(clipped, '这是一个很长的问题', CHAT_BOUNDS), false)
  assert.equal(questionVisible(visible, '这是一个很长的问题', CHAT_BOUNDS), true)
})

test('左侧回答标题包含完整问题文字时不能冒充用户问题气泡', () => {
  const xml = '<hierarchy><node class="android.view.View" bounds="[0,200][1080,1800]">'
    + '<node class="android.widget.TextView" text="心通口服液 详细科普" content-desc="心通口服液 详细科普" visible-to-user="true" bounds="[20,260][1060,420]" />'
    + '</node></hierarchy>'
  assert.equal(questionVisible(xml, '心通口服液', CHAT_BOUNDS), false)
})

test('兼容 class 命名的 UiAutomator 层级节点', () => {
  const xml = '<hierarchy><android.view.View bounds="[0,400][1080,1800]"><android.view.View bounds="[0,820][1080,1040]"><android.view.View bounds="[650,820][1030,1040]"><android.widget.TextView text="新的问题" content-desc="新的问题" displayed="true" bounds="[660,900][1020,980]" /></android.view.View></android.view.View></android.view.View></hierarchy>'
  assert.equal(questionVisible(xml, '新的问题', [0, 400, 1080, 1800]), true)
})

test('层级节点未写可见属性时仍按可见节点处理', () => {
  const xml = '<hierarchy><node class="android.view.View" bounds="[0,400][1080,1800]"><node class="android.view.View" bounds="[0,820][1080,1040]"><node class="android.view.View" bounds="[650,820][1030,1040]"><node class="android.widget.TextView" text="系统层级问题" content-desc="系统层级问题" bounds="[660,900][1020,980]" /></node></node></node></hierarchy>'
  assert.equal(questionVisible(xml, '系统层级问题', [0, 400, 1080, 1800]), true)
})

test('从右侧消息气泡自动识别当前已有问题而不依赖输入框', () => {
  const xml = '<hierarchy><node class="android.view.View" bounds="[0,200][1272,2300]">'
    + '<node class="android.view.View" bounds="[65,558][1207,715]">'
    + '<node class="android.view.View" bounds="[715,558][1155,715]">'
    + '<node class="android.widget.TextView" text="腹泻脱水用什么药" content-desc="腹泻脱水用什么药" bounds="[715,604][1155,669]" />'
    + '</node></node>'
    + '<node class="android.view.View" bounds="[0,786][1272,2200]">'
    + '<node class="android.widget.TextView" text="腹泻脱水首选口服补液盐" bounds="[65,970][1207,1192]" />'
    + '</node></node></hierarchy>'
  assert.equal(currentQuestionText(xml, [0, 440, 1272, 2315]), '腹泻脱水用什么药')
})

test('药品卡片里的医保标签不能被误识别为当前问题', () => {
  const xml = '<hierarchy><node class="android.view.View" bounds="[0,440][1272,2315]">'
    + '<node class="android.widget.HorizontalScrollView" bounds="[0,1200][1272,2315]">'
    + '<node class="android.view.ViewGroup" bounds="[588,1400][1106,2315]">'
    + '<node class="android.view.View" bounds="[619,2050][1048,2261]">'
    + '<node class="android.view.View" bounds="[761,2105][917,2261]">'
    + '<node class="android.widget.TextView" text="医保甲类" content-desc="" bounds="[772,2160][906,2206]" />'
    + '</node></node></node></node></node></hierarchy>'
  assert.equal(currentQuestionText(xml, [0, 440, 1272, 2315]), null)
})

test('新 Android 层级格式可识别引用资料卡和推荐药品入口', () => {
  const xml = '<hierarchy><androidx.compose.ui.viewinterop.ViewFactoryHolder class="androidx.compose.ui.viewinterop.ViewFactoryHolder" displayed="true" bounds="[40,700][1040,980]" /><android.widget.TextView text="推荐药品" displayed="true" bounds="[60,1100][300,1180]" /></hierarchy>'
  assert.deepEqual(evidencePanelBounds(xml, 100), [40, 700, 1040, 980])
  assert.deepEqual(visibleLabelBounds(xml, '推荐药品'), [60, 1100, 300, 1180])
})

test('到顶后通过OCR识别引用资料标题并按物理与逻辑尺寸映射点击', async () => {
  const expanded = '<hierarchy><androidx.compose.ui.viewinterop.ViewFactoryHolder class="androidx.compose.ui.viewinterop.ViewFactoryHolder" displayed="true" bounds="[0,466][720,900]" /></hierarchy>'
  const events = []
  const capture = { frame: Buffer.from('expanded-frame'), xml: expanded, stable: true }
  const result = await prepareEmbeddedEvidence({
    screenshot: async () => { events.push('screenshot'); return Buffer.from('raw-screen') },
    ocr: {
      recognize: async () => {
        events.push('ocr')
        return {
          engine: 'rapidocr',
          elapsedMs: 420,
          image: { width: 1080, height: 2400 },
          results: [{
            text: '根据 3 篇资料为你总结',
            normalizedText: '根据3篇资料为你总结',
            confidence: 0.998,
            bounds: [90, 600, 600, 660],
          }],
        }
      },
    },
    windowSize: async () => ({ width: 720, height: 1600 }),
    setLastOcrDiagnostic: value => { events.push(['diagnostic', value.target.logicalBounds]) },
    tap: async (x, y) => { events.push(['tap', x, y]) },
    delay: async () => { events.push('delay') },
    waitForStable: async () => { events.push('stable'); return capture },
    log: () => {},
  }, [0, 200, 720, 1400])

  assert.deepEqual(events, [
    'screenshot',
    'ocr',
    ['diagnostic', [60, 400, 400, 440]],
    ['tap', 230, 420],
    'delay',
    'stable',
  ])
  assert.equal(result.found, true)
  assert.equal(result.expanded, true)
  assert.equal(result.capture, capture)
})

test('OCR发现医学文献列表时确认资料已经展开且不再点击', async () => {
  const events = []
  const capture = { frame: Buffer.from('expanded-frame'), xml: '<hierarchy />', stable: true }
  const result = await prepareEmbeddedEvidence({
    screenshot: async () => Buffer.from('raw-screen'),
    ocr: {
      recognize: async () => ({
        engine: 'rapidocr',
        elapsedMs: 380,
        image: { width: 1080, height: 2400 },
        results: [
          { text: '根据3篇资料为你总结', normalizedText: '根据3篇资料为你总结', confidence: 0.999, bounds: [60, 700, 540, 750] },
          { text: '医学文献', normalizedText: '医学文献', confidence: 0.999, bounds: [850, 820, 1000, 870] },
        ],
      }),
    },
    windowSize: async () => ({ width: 1080, height: 2400 }),
    tap: async () => { events.push('tap') },
    delay: async () => { events.push('delay') },
    waitForStable: async () => { events.push('stable'); return capture },
    log: () => {},
  }, CHAT_BOUNDS)

  assert.deepEqual(events, ['stable'])
  assert.equal(result.found, true)
  assert.equal(result.expanded, true)
  assert.equal(result.capture, capture)
})

test('首次文字点击未展开时仅在OCR确认仍折叠后安全重试一次', async () => {
  const collapsedRecognition = {
    engine: 'rapidocr',
    elapsedMs: 300,
    image: { width: 1080, height: 2400 },
    results: [{
      text: '根据3篇资料为你总结', normalizedText: '根据3篇资料为你总结', confidence: 0.999, bounds: [60, 700, 540, 750],
    }],
  }
  const collapsedXml = '<hierarchy><androidx.compose.ui.viewinterop.ViewFactoryHolder class="androidx.compose.ui.viewinterop.ViewFactoryHolder" displayed="true" bounds="[0,700][1080,850]" /></hierarchy>'
  const expandedXml = '<hierarchy><androidx.compose.ui.viewinterop.ViewFactoryHolder class="androidx.compose.ui.viewinterop.ViewFactoryHolder" displayed="true" bounds="[0,700][1080,1300]" /></hierarchy>'
  const taps = []
  let stableReads = 0
  const result = await prepareEmbeddedEvidence({
    screenshot: async () => Buffer.from('raw-screen'),
    ocr: { recognize: async () => collapsedRecognition },
    windowSize: async () => ({ width: 1080, height: 2400 }),
    tap: async (x, y) => { taps.push([x, y]) },
    delay: async () => {},
    waitForStable: async () => ({
      frame: Buffer.from('frame'),
      xml: stableReads++ === 0 ? collapsedXml : expandedXml,
      stable: true,
    }),
    log: () => {},
  }, CHAT_BOUNDS)

  assert.deepEqual(taps, [[300, 725], [300, 725]])
  assert.equal(result.expanded, true)
})

test('仅在底部同时可见复制和免责声明时结束回答截图', () => {
  const xml = '<hierarchy><node text="复制" visible-to-user="true" bounds="[800,1550][900,1620]" /><node text="AI生成非医疗诊断仅供参考 不适就医" visible-to-user="true" bounds="[100,1500][900,1540]" /></hierarchy>'
  assert.equal(replyTailOnScreen(xml, CHAT_BOUNDS), true)
})

test('兼容新版回答操作栏和免责声明文案', () => {
  const xml = '<hierarchy>'
    + '<node content-desc="复制回答" displayed="true" bounds="[760,1510][880,1600]" />'
    + '<node text="AI生成内容可能存在不准确，仅供参考，请勿作为诊疗依据，不适请就医" displayed="true" bounds="[80,1430][940,1500]" />'
    + '</hierarchy>'
  assert.equal(replyTailOnScreen(xml, CHAT_BOUNDS), true)
})

test('向下滚动必须连续两次无变化才确认底部', () => {
  assert.equal(scrollEndConfirmed(false, 1), false)
  assert.equal(scrollEndConfirmed(null, 1), false)
  assert.equal(scrollEndConfirmed(true, 1), false)
  assert.equal(scrollEndConfirmed(null, 2), true)
})

test('聊天区域会避开底部输入框，并拒绝横屏', () => {
  const xml = '<hierarchy><node scrollable="true" bounds="[0,457][1272,2744]" /><node class="android.widget.EditText" visible-to-user="true" bounds="[189,2523][1064,2689]" /></hierarchy>'
  assert.deepEqual(findChatScrollBounds(xml, { width: 1272, height: 2800 }), [0, 457, 1272, 2317])
  assert.throws(() => validateCaptureViewport({ width: 1600, height: 720 }, [0, 100, 1600, 600]), /竖屏/)
})

test('识别聊天区底部固定的无标签向下按钮', () => {
  const xml = '<hierarchy>'
    + '<node class="android.view.View" clickable="true" text="" content-desc="" displayed="true" bounds="[475,1829][607,1961]" />'
    + '<node class="android.view.View" clickable="true" text="操作" displayed="true" bounds="[430,900][650,1030]" />'
    + '</hierarchy>'
  assert.deepEqual(floatingScrollControlBounds(xml, [0, 333, 1080, 2001]), [475, 1829, 607, 1961])
})

test('滚到顶部后重新计算回答截图范围并排除新出现的向下按钮', () => {
  const xml = '<hierarchy>'
    + '<node class="android.view.View" scrollable="true" displayed="true" bounds="[0,333][1080,2001]" />'
    + '<node class="android.view.View" clickable="true" text="" content-desc="" displayed="true" bounds="[475,1829][607,1961]" />'
    + '</hierarchy>'
  assert.deepEqual(replyCaptureBounds(xml, { width: 1080, height: 2340 }), {
    bounds: [0, 333, 1080, 1816],
    floatingControl: [475, 1829, 607, 1961],
  })
})

test('顶部定位使用更长且更快的滚动，回答采集保持较高重叠', () => {
  const bounds = [0, 333, 1080, 2001]
  const capture = chatSwipePlan(bounds, 0.45, { speed: 1400 })
  const navigation = chatSwipePlan(bounds, 0.65, { speed: 3200 })
  assert.equal(capture.distance, 750)
  assert.equal(navigation.distance, 1084)
  assert.ok(navigation.durationMs < capture.durationMs)
})

test('根据相同文本节点测量真实滚动距离，忽略固定控件', () => {
  const before = '<hierarchy><node text="固定标题" displayed="true" bounds="[0,100][500,160]" /><node text="回答中的同一段文字" displayed="true" bounds="[20,900][1000,1000]" /></hierarchy>'
  const after = '<hierarchy><node text="固定标题" displayed="true" bounds="[0,100][500,160]" /><node text="回答中的同一段文字" displayed="true" bounds="[20,400][1000,500]" /></hierarchy>'
  assert.equal(estimateVerticalScrollShift(before, after, [0, 200, 1080, 1800]), 500)
  assert.deepEqual(sharedTextSeam(before, after, [0, 200, 1080, 1800]), { previousEnd: 700, currentStart: 200 })
})

test('滚动距离估计排除重复文本，并拒绝互相矛盾的节点位移', () => {
  const before = '<hierarchy>'
    + '<node text="重复段落文字" displayed="true" bounds="[20,1200][900,1260]" />'
    + '<node text="重复段落文字" displayed="true" bounds="[20,1500][900,1560]" />'
    + '<node text="唯一段落文字" displayed="true" bounds="[20,900][900,960]" />'
    + '</hierarchy>'
  const after = '<hierarchy>'
    + '<node text="重复段落文字" displayed="true" bounds="[20,300][900,360]" />'
    + '<node text="唯一段落文字" displayed="true" bounds="[20,400][900,460]" />'
    + '</hierarchy>'
  assert.equal(estimateVerticalScrollShift(before, after, [0, 200, 1080, 1800]), 500)

  const inconsistentAfter = '<hierarchy>'
    + '<node text="唯一段落文字" displayed="true" bounds="[20,400][900,460]" />'
    + '<node text="另一个唯一段落" displayed="true" bounds="[20,300][900,360]" />'
    + '</hierarchy>'
  const inconsistentBefore = '<hierarchy>'
    + '<node text="唯一段落文字" displayed="true" bounds="[20,900][900,960]" />'
    + '<node text="另一个唯一段落" displayed="true" bounds="[20,1200][900,1260]" />'
    + '</hierarchy>'
  assert.equal(estimateVerticalScrollShift(inconsistentBefore, inconsistentAfter, [0, 200, 1080, 1800]), null)
})

test('在共享文字顶部切换视口，避免接缝切过文字行', async () => {
  const frame = await sharp({ create: { width: 20, height: 100, channels: 3, background: 'white' } }).png().toBuffer()
  const segments = await cropFramesAtTextSeams([frame, frame], [{ previousEnd: 70, currentStart: 20 }])
  assert.deepEqual(await imageInfo(segments[0]), { width: 20, height: 70 })
  assert.deepEqual(await imageInfo(segments[1]), { width: 20, height: 80 })
})

test('共享文字接缝拒绝同一视口内重复出现的标题', () => {
  const before = '<hierarchy>'
    + '<node text="重复标题" displayed="true" bounds="[20,700][800,760]" />'
    + '<node text="重复标题" displayed="true" bounds="[20,1100][800,1160]" />'
    + '</hierarchy>'
  const after = '<hierarchy><node text="重复标题" displayed="true" bounds="[20,300][800,360]" /></hierarchy>'
  assert.equal(sharedTextSeam(before, after, [0, 200, 1080, 1800]), null)
})

test('拼接参考药品时保留完整视口，并阻止无法验证的跨屏拼接', async () => {
  const make = color => sharp({ create: { width: 20, height: 10, channels: 3, background: color } }).png().toBuffer()
  const chunks = await stackFramesInGroups([await make('red'), await make('green'), await make('blue'), await make('white')], 3)
  assert.equal(chunks.length, 2)
  assert.deepEqual(await imageInfo(chunks[0]), { width: 20, height: 30 })
  const black = await make('black')
  const white = await make('white')
  await assert.rejects(() => verifyFrameOverlap(black, white, 4), /连续性/)
})

test('按已验证的精确重叠高度拼接，不再二次猜测滚动距离', async () => {
  const first = await sharp({ create: { width: 20, height: 20, channels: 3, background: 'red' } }).png().toBuffer()
  const second = await sharp({ create: { width: 20, height: 20, channels: 3, background: 'blue' } }).png().toBuffer()
  const [stitched] = await stitchFramesWithOverlaps([first, second], [6])
  assert.deepEqual(await imageInfo(stitched), { width: 20, height: 34 })
})

test('单列药品行使用整宽校验，不把右侧黑色空栏当成接缝证据', async () => {
  const width = 240
  const height = 300
  const raw = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < 110; x += 1) {
      const offset = (y * width + x) * 3
      raw[offset] = (y * 37 + x * 11) % 256
      raw[offset + 1] = (y * 13 + x * 29) % 256
      raw[offset + 2] = (y * 7 + x * 19) % 256
    }
  }
  const previous = await sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer()
  const current = await sharp(previous).extract({ left: 0, top: 80, width, height: 220 }).extend({ bottom: 80, background: 'black' }).png().toBuffer()
  assert.equal(await verifyProductGridOverlap(previous, current, 220), 220)
})

test('药品动态接缝仅在前序滚动位移一致时采用保守重叠', () => {
  assert.equal(calibratedProductFallbackOverlap([403, 391]), null)
  assert.equal(calibratedProductFallbackOverlap([403, 391, 393, 410]), 383)
  assert.equal(calibratedProductFallbackOverlap([403, 391, 520]), null)
})

test('批次产物拆分为纯图片交付区和镜像调试区，CSV 默认读取问题列', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'node-automation-test-'))
  try {
    const batch = await createBatchDirectory(directory, new Date(2026, 6, 11, 23, 59, 0))
    assert.equal(path.basename(batch), 'batch_20260711-235900')
    assert.equal(path.basename(questionArtifactDirectory(batch, 2, '儿童腹泻/脱水用什么药？')), '002_儿童腹泻_脱水用什么药？')
    const batchArtifacts = batchArtifactDirectories(batch)
    assert.equal(path.basename(batchArtifacts.deliveryDirectory), '交付图片')
    assert.equal(path.basename(batchArtifacts.diagnosticDirectory), '调试产物')
    const entryArtifacts = entryArtifactDirectories(batchArtifacts, 2, '抖音搜索框（小荷AI小程序）', 3)
    assert.equal(path.basename(entryArtifacts.deliveryDirectory), '02_抖音搜索框（小荷AI小程序）')
    assert.equal(path.basename(entryArtifacts.diagnosticDirectory), '02_抖音搜索框（小荷AI小程序）')
    const artifacts = questionArtifactDirectories(entryArtifacts, 2, '儿童腹泻/脱水用什么药？')
    assert.equal(path.basename(artifacts.deliveryDirectory), '002_儿童腹泻_脱水用什么药？')
    assert.equal(path.basename(artifacts.diagnosticDirectory), '002_儿童腹泻_脱水用什么药？')
    const csv = path.join(directory, 'questions.csv')
    await fs.writeFile(csv, '问题,分类\n腹泻怎么办,儿科\n腹泻怎么办,儿科\n', 'utf8')
    assert.deepEqual(await loadQuestionFile(csv), ['腹泻怎么办'])
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([{ 问题: '儿童发热怎么办' }, { 问题: '儿童发热怎么办' }]), '问题')
    const xlsx = path.join(directory, 'questions.xlsx')
    XLSX.writeFile(workbook, xlsx)
    assert.deepEqual(await loadQuestionFile(xlsx), ['儿童发热怎么办'])
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('结构化事件日志记录参考药品关键阶段和单题上下文', async () => {
  assert.deepEqual(classifyAutomationLog('capture: 推荐药品 page 3'), {
    event: 'reference_products_page_captured',
    category: 'capture',
    details: { page: 3, target: '推荐药品' },
  })
  assert.deepEqual(classifyAutomationLog('capture: 推荐药品抽屉已先展开，列表视口=2148px'), {
    event: 'reference_products_drawer_expanded',
    category: 'capture',
    details: { viewport_height: 2148 },
  })
  assert.deepEqual(classifyAutomationLog('capture: 推荐药品抽屉初始边界 sheet=0,482,1080,2400 list=0,699,1080,2400'), {
    event: 'reference_products_drawer_detected',
    category: 'capture',
    details: { drawer_bounds: [0, 482, 1080, 2400], list_bounds: [0, 699, 1080, 2400] },
  })
  assert.deepEqual(classifyAutomationLog('ocr: purpose=toutiao_answer_card outcome=matched engine=rapidocr elapsed=479ms lines=22 summary_confidence=0.979 view_more_confidence=0.978 physical_bounds=422,1256,655,1313 logical_bounds=422,1256,655,1313'), {
    event: 'ocr_recognition',
    category: 'diagnostic',
    details: {
      purpose: 'toutiao_answer_card', outcome: 'matched', engine: 'rapidocr', elapsed_ms: 479, recognized_lines: 22,
      summary_confidence: 0.979, view_more_confidence: 0.978,
      physical_bounds: [422, 1256, 655, 1313], logical_bounds: [422, 1256, 655, 1313],
    },
  })
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'node-event-log-test-'))
  try {
    const filePath = path.join(directory, '调试产物', '001_问题', '执行日志.jsonl')
    const logger = new EventLog({
      filePath,
      scope: 'question',
      context: { batch_id: 'batch_1', entry_id: 'xiaohe-app', question: '测试', question_index: 1 },
      now: () => new Date('2026-07-15T04:00:00.000Z'),
    })
    logger.recordMessage('stage: 正在发送问题')
    logger.recordMessage('capture: 推荐药品截图完成，共 4 屏，图片已全部加载')
    await logger.flush()
    const records = (await fs.readFile(filePath, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.deepEqual(records.map(item => item.sequence), [1, 2])
    assert.deepEqual(records.map(item => item.event), ['stage', 'reference_products_capture_completed'])
    assert.equal(records[1].question, '测试')
    assert.equal(records[1].details.pages, 4)
    assert.equal(records[1].details.images_status, '已全部加载')
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('逐接缝混合拼接只在失败位置保留少量重复内容和浅色留白', async () => {
  const make = color => sharp({ create: { width: 20, height: 100, channels: 3, background: color } }).png().toBuffer()
  const frames = [await make('red'), await make('green'), await make('blue')]
  const transitions = [
    { verified: true, overlap: 70 },
    { verified: false, fallbackOverlap: 60 },
  ]
  const images = await buildReplyImages(frames, { transitions, maxHeight: 3000 })
  assert.equal(images.length, 1)
  assert.deepEqual(await imageInfo(images[0]), { width: 20, height: 194 })
  const separator = await sharp(images[0]).extract({ left: 0, top: 130, width: 20, height: 24 }).raw().toBuffer()
  assert.ok(separator.every(value => value >= 230))
})

test('失败接缝依据真实滚动距离计算保守重叠，节点不可用时增加安全余量', () => {
  assert.equal(conservativeFallbackOverlap(1000, 400, 450), 528)
  assert.equal(conservativeFallbackOverlap(1483, null, 667, [700, 702]), 581)
  assert.equal(conservativeFallbackOverlap(1483, null, 667, [164, 256]), 0)
  assert.equal(conservativeFallbackOverlap(1000, null, 450), 0)
})

test('失败接缝会把裁切位置移到附近空白行，避免从文字中间切开', async () => {
  const frame = await sharp({ create: { width: 120, height: 120, channels: 3, background: 'white' } })
    .composite([
      { input: await sharp({ create: { width: 100, height: 14, channels: 3, background: 'black' } }).png().toBuffer(), left: 10, top: 42 },
      { input: await sharp({ create: { width: 100, height: 14, channels: 3, background: 'black' } }).png().toBuffer(), left: 10, top: 76 },
    ])
    .png().toBuffer()
  const cut = await alignCropToWhitespace(frame, 50, { searchBefore: 20, searchAfter: 24, minimumBand: 8 })
  assert.ok(cut >= 60 && cut <= 72, `裁切位置 ${cut}px 未落在两行文字之间`)
})

test('局部文字区域变化不会被全屏平均差异掩盖', async () => {
  const first = await sharp({ create: { width: 240, height: 240, channels: 3, background: 'white' } }).png().toBuffer()
  const patch = await sharp({ create: { width: 20, height: 10, channels: 3, background: 'black' } }).png().toBuffer()
  const second = await sharp(first).composite([{ input: patch, left: 24, top: 96 }]).png().toBuffer()
  assert.equal(await imagesSimilar(first, second, 1), true)
  assert.equal(await imageRegionsStable(first, second), false)
})

test('不同内容区域测得不同滚动位移时拒绝拼接', async () => {
  const width = 240
  const height = 300
  const raw = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3
      const value = (y * 37 + x * 17 + ((y * x) % 97)) % 256
      raw[offset] = value
      raw[offset + 1] = (value * 3) % 256
      raw[offset + 2] = (value * 7) % 256
    }
  }
  const previous = await sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer()
  const left = await sharp(previous).extract({ left: 0, top: 80, width: 120, height: 220 }).extend({ bottom: 80, background: 'white' }).png().toBuffer()
  const right = await sharp(previous).extract({ left: 120, top: 100, width: 120, height: 200 }).extend({ bottom: 100, background: 'white' }).png().toBuffer()
  const current = await sharp({ create: { width, height, channels: 3, background: 'white' } })
    .composite([{ input: left, left: 0, top: 0 }, { input: right, left: 120, top: 0 }]).png().toBuffer()
  await assert.rejects(() => verifyFrameOverlap(previous, current, 210), /区域.*不一致|连续性/)
})

test('末屏一侧大面积同色时以跨区域唯一候选确认短距离滚动', async () => {
  const width = 240
  const height = 300
  const shift = 40
  const overlap = height - shift
  const raw = Buffer.alloc(width * height * 3, 238)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < 104; x += 1) {
      const offset = (y * width + x) * 3
      const value = 40 + ((Math.floor(y / 5) * 31 + Math.floor(x / 8) * 17) % 170)
      raw[offset] = value
      raw[offset + 1] = Math.min(230, value + 11)
      raw[offset + 2] = Math.min(230, value + 23)
    }
  }
  const previous = await sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer()
  const current = await sharp(previous)
    .extract({ left: 0, top: shift, width, height: overlap })
    .extend({ bottom: shift, background: '#eeeeee' })
    .png().toBuffer()

  assert.equal(await verifyFrameOverlap(previous, current, null), overlap)
})

test('精细复核粗采样附近的多个候选，识别末屏短距离滚动的真实接缝', async () => {
  const width = 240
  const height = 500
  const shift = 137
  const overlap = height - shift
  const raw = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3
      const value = 80 + ((Math.floor(y / 6) * 29 + Math.floor(x / 16) * 13) % 140)
      raw[offset] = value
      raw[offset + 1] = (value + 23) % 220
      raw[offset + 2] = (value + 47) % 220
    }
  }
  // Make the previous viewport's bottom resemble the next viewport's top.
  // The coarse search sees this plausible short overlap before the exact
  // 363px overlap, whose position falls between its 4px samples.
  for (let y = 0; y < 48; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const source = ((shift + y) * width + x) * 3
      const target = ((height - 48 + y) * width + x) * 3
      for (let channel = 0; channel < 3; channel += 1) raw[target + channel] = Math.min(255, raw[source + channel] + 2)
    }
  }
  const previous = await sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer()
  const current = await sharp(previous)
    .extract({ left: 0, top: shift, width, height: overlap })
    .extend({ bottom: shift, background: '#f3f4f5' })
    .png().toBuffer()

  assert.equal(await verifyFrameOverlap(previous, current, null), overlap)
})

test('长截图超过高度上限时只在视口边界拆分', async () => {
  const frame = await sharp({ create: { width: 20, height: 1000, channels: 3, background: 'white' } }).png().toBuffer()
  const images = await composeLongImages([frame, frame, frame, frame], { maxHeight: 3000 })
  assert.equal(images.length, 2)
  for (const image of images) assert.ok((await imageInfo(image)).height <= 3000)
  assert.equal(maxLongImageHeight(undefined), 12000)
  assert.throws(() => maxLongImageHeight(2999), /3000/)
})

test('已验证长图拆成多个文件时不会重新保留整屏重叠内容', async () => {
  const frame = await sharp({ create: { width: 20, height: 1000, channels: 3, background: 'white' } }).png().toBuffer()
  const transitions = Array.from({ length: 3 }, () => ({ verified: true, overlap: 600 }))
  const images = await composeLongImages([frame, frame, frame, frame], { transitions, maxHeight: 1500 })

  assert.equal(images.length, 2)
  assert.deepEqual(await imageInfo(images[0]), { width: 20, height: 1400 })
  assert.deepEqual(await imageInfo(images[1]), { width: 20, height: 800 })
})

test('药品图片检测拒绝纯色占位区并接受有实际图像细节的区域', async () => {
  const blank = await sharp({ create: { width: 80, height: 60, channels: 3, background: '#000' } }).png().toBuffer()
  const detailed = await sharp({ create: { width: 80, height: 60, channels: 3, background: '#fff' } })
    .composite([{ input: await sharp({ create: { width: 36, height: 30, channels: 3, background: '#d22' } }).png().toBuffer(), left: 10, top: 12 }]).png().toBuffer()
  assert.equal(await imageLooksLoaded(blank), false)
  assert.equal(await imageLooksLoaded(detailed), true)
})

test('可枚举当前药品列表内的说明书按钮与图片节点', () => {
  const xml = '<hierarchy>'
    + '<node class="android.widget.ImageView" displayed="true" bounds="[20,100][220,260]" />'
    + '<node class="android.widget.ImageView" displayed="true" bounds="[20,300][220,460]" />'
    + '<node text="查看说明书" displayed="true" bounds="[30,250][200,290]" />'
    + '<node text="查看说明书" displayed="true" bounds="[30,450][200,490]" />'
    + '</hierarchy>'
  assert.equal(boundsListForNodeAttribute(xml, 'class', 'android.widget.ImageView').length, 2)
  assert.equal(visibleLabelBoundsList(xml, '查看说明书').length, 2)
})

test('参考药品卡片虽无文本，也能凭结构（Compose 面板+横向列表）定位入口箭头', () => {
  const xml = '<hierarchy>'
    + '<node class="androidx.compose.ui.viewinterop.ViewFactoryHolder" bounds="[0,673][1080,1714]">'
    + '<node class="android.widget.ImageView" bounds="[942,682][1020,760]" />'
    + '<node class="android.widget.HorizontalScrollView" scrollable="true" bounds="[0,817][1080,1714]">'
    + '<node class="android.view.ViewGroup" bounds="[48,817][504,1714]" />'
    + '</node></node></hierarchy>'
  const section = referenceProductsSection(xml)
  assert.deepEqual(section.panel, [0, 673, 1080, 1714])
  assert.deepEqual(section.tap, [981, 721])
})

test('回答滚动阶段直接返回参考药品入口坐标', () => {
  const xml = '<hierarchy>'
    + '<node class="androidx.compose.ui.viewinterop.ViewFactoryHolder" bounds="[0,673][1080,1714]">'
    + '<node class="android.widget.ImageView" bounds="[942,682][1020,760]" />'
    + '<node class="android.widget.HorizontalScrollView" scrollable="true" bounds="[0,817][1080,1714]" />'
    + '</node></hierarchy>'

  assert.deepEqual(referenceProductsTrigger(xml, CHAT_BOUNDS), [981, 721])
})

test('参考药品标题旁存在真实可点击按钮时使用按钮中心而非估算坐标', () => {
  const xml = '<hierarchy>'
    + '<node text="参考药品" class="android.widget.TextView" bounds="[65,1394][1096,1482]" />'
    + '<node class="android.view.View" clickable="true" bounds="[1096,1360][1253,1517]" />'
    + '</hierarchy>'
  assert.deepEqual(referenceProductsTrigger(xml, [0, 200, 1272, 2300]), [1174, 1438])
})

test('点击药品入口前使用最新层级刷新发生位移的按钮坐标', () => {
  const xml = '<hierarchy>'
    + '<node text="参考药品" bounds="[64,1600][918,1686]" />'
    + '<node class="android.view.View" clickable="true" bounds="[918,1577][1050,1687]" />'
    + '</hierarchy>'
  const result = refreshedReferenceProductsTrigger(xml, [0, 333, 1080, 2001], [984, 1955])
  assert.deepEqual(result, { trigger: [984, 1632], moved: true })
})

test('兼容华为弹窗窗口中的参考药品抽屉与竖向列表', () => {
  const xml = '<hierarchy>'
    + '<node class="android.widget.FrameLayout" resource-id="com.aurora.xiaohe.aidoctor:id/bullet_popup_bottom_sheet" bounds="[0,960][984,2304]">'
    + '<node class="android.widget.FrameLayout" resource-id="com.aurora.xiaohe.aidoctor:id/bullet_container" bounds="[0,960][984,2304]">'
    + '<node class="androidx.recyclerview.widget.RecyclerView" scrollable="true" bounds="[0,1116][984,2304]" />'
    + '</node></node></hierarchy>'
  assert.deepEqual(referenceProductDrawerBounds(xml), {
    sheet: [0, 960, 984, 2304],
    list: [0, 1116, 984, 2304],
  })
})

test('识别抖音小程序无资源名的参考药品 BottomSheet', () => {
  const xml = '<hierarchy>'
    + '<node class="android.widget.ScrollView" bounds="[0,0][1080,2400]">'
    + '<node class="android.widget.HorizontalScrollView" bounds="[0,0][1080,2400]">'
    + '<node class="android.view.ViewGroup" bounds="[0,480][1080,2400]">'
    + '<node class="android.view.ViewGroup" bounds="[0,480][1080,2400]">'
    + '<node class="androidx.recyclerview.widget.RecyclerView" bounds="[0,636][1080,2400]">'
    + '<node class="android.view.ViewGroup" bounds="[36,660][1044,1549]" />'
    + '</node></node></node></node></node></hierarchy>'

  assert.deepEqual(referenceProductDrawerBounds(xml), {
    sheet: [0, 480, 1080, 2400],
    list: [0, 636, 1080, 2400],
  })
})

test('抽屉列表兜底不会误选仍在抽屉后方的聊天滚动区', () => {
  const xml = '<hierarchy>'
    + '<node class="android.view.View" scrollable="true" bounds="[0,333][1080,2010]" />'
    + '<node class="android.widget.FrameLayout" resource-id="com.aurora.xiaohe.aidoctor:id/bullet_container" bounds="[0,960][1080,2400]">'
    + '<node class="android.widget.ScrollView" scrollable="true" bounds="[0,1116][1080,2400]" />'
    + '</node></hierarchy>'
  assert.deepEqual(referenceProductDrawerBounds(xml), {
    sheet: [0, 960, 1080, 2400],
    list: [0, 1116, 1080, 2400],
  })
})

test('检测到回答尾部药品入口后只要求完整采集药品，不依赖正文锚点恢复', () => {
  const complete = { firstViewportIncluded: true, imagesReady: true, confirmedEnd: true, continuityVerified: true }

  assert.equal(referenceProductsCaptureComplete({ detected: false, products: null }), true)
  assert.equal(referenceProductsCaptureComplete({ detected: true, products: null }), false)
  assert.equal(referenceProductsCaptureComplete({ detected: true, products: { ...complete, firstViewportIncluded: false } }), false)
  assert.equal(referenceProductsCaptureComplete({ detected: true, products: { ...complete, imagesReady: false } }), false)
  assert.equal(referenceProductsCaptureComplete({ detected: true, products: { ...complete, confirmedEnd: false } }), false)
  assert.equal(referenceProductsCaptureComplete({ detected: true, products: { ...complete, continuityVerified: false } }), false)
  assert.equal(referenceProductsCaptureComplete({ detected: true, products: complete }), true)
})

test('药品抽屉按竖屏可视比例确认展开而不依赖固定列表顶部', () => {
  assert.equal(referenceProductSheetExpanded([0, 84, 1080, 2282], [0, 544, 1080, 2282]), true)
  assert.equal(referenceProductSheetExpanded([0, 56, 720, 1512], [0, 362, 720, 1512]), true)
  assert.equal(referenceProductSheetExpanded([0, 900, 1080, 2282], [0, 1180, 1080, 2282]), false)
  assert.equal(referenceProductSheetExpanded([0, 600, 720, 1512], [0, 840, 720, 1512]), false)
  assert.equal(referenceProductSheetExpanded([0, 960, 984, 2304], [0, 1116, 984, 2304]), false)
  assert.equal(referenceProductSheetExpanded([0, 240, 984, 2304], [0, 396, 984, 2304]), true)
})

test('新版药品抽屉无图片节点时从卡片上半部推断药品图片区域', () => {
  const list = [0, 1280, 1272, 2744]
  const xml = '<hierarchy>'
    + '<node class="androidx.recyclerview.widget.RecyclerView" bounds="[0,1280][1272,2744]">'
    + '<node class="android.view.ViewGroup" bounds="[42,1424][560,2413]" />'
    + '<node class="android.view.ViewGroup" bounds="[588,1424][1106,2413]" />'
    + '<node class="android.view.ViewGroup" bounds="[42,2641][560,2744]" />'
    + '</node></hierarchy>'
  const result = referenceProductImageBounds(xml, list)
  assert.equal(result.mode, 'inferred_card_artwork')
  assert.deepEqual(result.bounds, [[73, 1454, 529, 1968], [619, 1454, 1075, 1968]])
})

test('药品图片只从列表子树识别，不把抽屉后的输入按钮当成商品图', () => {
  const list = [0, 636, 1080, 2400]
  const xml = '<hierarchy>'
    + '<node class="android.widget.ImageView" bounds="[909,2249][981,2321]" />'
    + '<node class="androidx.recyclerview.widget.RecyclerView" bounds="[0,636][1080,2400]">'
    + '<node class="android.view.ViewGroup" bounds="[36,660][1044,1549]">'
    + '<node class="android.widget.HorizontalScrollView" bounds="[36,759][1044,1549]">'
    + '<node class="android.view.ViewGroup" bounds="[36,759][480,1549]" />'
    + '</node></node></node></hierarchy>'

  const result = referenceProductImageBounds(xml, list)
  assert.equal(result.mode, 'inferred_card_artwork')
  assert.deepEqual(result.bounds, [[63, 783, 453, 1194]])
})

test('药品稳定截图直接复用完成图片就绪判断', async () => {
  const artwork = await sharp({ create: { width: 140, height: 140, channels: 3, background: '#fff' } })
    .composite([{ input: await sharp({ create: { width: 80, height: 60, channels: 3, background: '#d71945' } }).png().toBuffer(), left: 30, top: 40 }])
    .png().toBuffer()
  const frame = await sharp({ create: { width: 400, height: 500, channels: 3, background: '#000' } })
    .composite([{ input: artwork, left: 30, top: 50 }])
    .png().toBuffer()
  const xml = '<hierarchy><node class="android.widget.ImageView" bounds="[30,150][170,290]" /></hierarchy>'
  const result = await referenceProductViewportReadiness(frame, xml, [0, 100, 400, 600])
  assert.equal(result.ready, true)
  assert.equal(result.mode, 'explicit_images')
  assert.equal(result.loaded, 1)
})

test('普通资料卡（Compose 面板但无横向药品列表）不会被误判为参考药品', () => {
  const xml = '<hierarchy>'
    + '<node class="androidx.compose.ui.viewinterop.ViewFactoryHolder" displayed="true" bounds="[40,700][1040,980]">'
    + '<node class="android.widget.TextView" text="引用资料" displayed="true" bounds="[60,720][300,780]" />'
    + '</node></hierarchy>'
  assert.equal(referenceProductsSection(xml), null)
})

test('仅为 ADB 短暂断连启用安装重试', () => {
  assert.equal(adbConnectionLost(new Error('adb: device offline')), true)
  assert.equal(adbConnectionLost(new Error('Remote end closed connection without response')), false)
  assert.equal(adbConnectionLost(new Error('INSTALL_FAILED_UPDATE_INCOMPATIBLE')), false)
})

test('识别首次启动时遮挡输入框的历史对话引导', () => {
  assert.equal(historyOnboardingVisible('<node text="在这里查看「历史对话」" />'), true)
  assert.equal(historyOnboardingVisible('<node text="输入问题 或 按住说话" />'), false)
})
