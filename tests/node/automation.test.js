const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const sharp = require('sharp')
const XLSX = require('xlsx')
const { questionVisible, questionVisibleExact, currentQuestionText, replyTailOnScreen, findChatScrollBounds, validateCaptureViewport, floatingScrollControlBounds, replyCaptureBounds, estimateVerticalScrollShift, sharedTextSeam, evidencePanelBounds, evidencePanelBoundsForTitle, visibleLabelBounds, visibleLabelBoundsList, boundsListForNodeAttribute, responseTimeoutRetryTarget, referenceProductsSection, referenceProductImageBounds } = require('../../src/automation/hierarchy')
const { stackFramesInGroups, verifyFrameOverlap, verifyReplyFrameOverlap, verifyProductGridOverlap, imageInfo, imageLooksLoaded, imagesSimilar, imageRegionsStable, detectXiaoheUserQuestionBubble, alignCropToWhitespace, stitchFramesWithOverlaps, composeLongImages, cropFramesAtTextSeams } = require('../../src/automation/images')
const { createBatchDirectory, questionArtifactDirectory, batchArtifactDirectories, entryArtifactDirectories, questionArtifactDirectories, groupedQuestionArtifactDirectories } = require('../../src/automation/utils')
const { EventLog, classifyAutomationLog } = require('../../src/automation/event-log')
const { loadQuestionFile } = require('../../src/questions')
const { adbConnectionLost, captureFailureDiagnostics, captureStableObserved, captureStableSandwich, calibratedProductFallbackOverlap, chatSwipePlan, conservativeFallbackOverlap, buildReplyImages, CancelledError, confirmPersistentScrollEnd, confirmQuestionAtTop, DOUYIN_MINIAPP_ENTRY_FILENAME, DOUYIN_SEARCH_SUMMARY_FILENAME, TOUTIAO_SEARCH_SUMMARY_FILENAME, douyinGenericAiAnswerBounds, douyinMiniAppCaptureBounds, douyinMiniAppEntryBounds, douyinOcrViewFullTarget, douyinSearchInput, douyinSearchResultTarget, douyinSearchResultsBounds, douyinViewFullBounds, failedRetryItems, fillQuestionInput, groupedBrandSummaries, historyOnboardingVisible, maxLongImageHeight, miniAppQuestionFirstFrameCropBounds, miniAppReferenceProductsTrigger, observerRegionFallbackOptions, prepareDeviceForAutomation, prepareEmbeddedEvidence, referenceProductDrawerBounds, referenceProductsCaptureComplete, referenceProductSheetExpanded, referenceProductsTrigger, referenceProductViewportReadiness, refreshedReferenceProductsTrigger, requireQuestionLocated, retryAttemptCount, runQuestionsWithRecovery, scrollEndConfirmed, scrollSingleQuestionSessionToTop, toutiaoGenericConsultationPage, toutiaoHomeSearchBounds, toutiaoOcrViewMoreTarget, toutiaoSearchInput, toutiaoSearchResultBelongsToQuestion, toutiaoViewMoreBounds, waitForPackageHierarchy } = require('../../src/automation/runner')
const { toutiaoAddToHomeScreenCancelBounds } = require('../../src/automation/miniapp-locators')
const { automationEntries, ENTRY_DEFINITIONS, entryHierarchyStartupTimeout, hierarchyBelongsToPackage, normalizeAutomationEntries } = require('../../src/automation/entry-catalog')
const { DouyinSearchResultNotFoundError, ToutiaoAnswerCardNotFoundError, ToutiaoFullAnswerNotOpenedError, runDouyinSearchResultAttempts, runToutiaoAnswerCardAttempts, runToutiaoFullAnswerAttempts } = require('../../src/automation/search-recovery')
const { createQuestionWorkflows } = require('../../src/automation/question-workflows')
const { createReplyCapture, navigateReplyToBottomControl, miniAppTopFramesStable, miniAppQuestionOcrTarget, miniAppQuestionFirstFrameReacquisitionAllowed, confirmMiniAppTop } = require('../../src/automation/reply-capture')
const { createDouyinSearchWorkflow, DouyinMiniAppNetworkError, douyinMiniAppAnswerContextEvidence, douyinMiniAppNetworkRetryTarget, douyinSearchTargetStabilityBounds } = require('../../src/automation/douyin-search-workflow')
const { recoverTimedOutExistingReply } = require('../../src/automation/existing-reply-recovery')
const { toutiaoAnswerRegionLooksReady } = require('../../src/automation/toutiao-search-workflow')
const { createReferenceProductCapture } = require('../../src/automation/reference-product-capture')
const { evidenceSummaryExpandedByOcr, evidenceSummaryOcrTarget, suspiciousEvidenceSummaryOcrTarget } = require('../../src/automation/capture-primitives')

const CHAT_BOUNDS = [0, 200, 1080, 1800]

test('执行前唤醒并设置常亮，锁屏时提示用户且解锁后继续', async () => {
  let now = 0
  const lockStates = [
    { locked: true, method: 'trust' },
    { locked: false, method: 'trust' },
  ]
  const logs = []
  const events = []
  const preparation = await prepareDeviceForAutomation({
    ui: {
      prepareDevicePower: async () => ({
        screen_was_on: false,
        screen_on: true,
        wake_performed: true,
        stay_awake_original: '7',
        stay_awake_applied: '2',
        lock_state: { locked: true, method: 'trust' },
      }),
      deviceLockState: async () => lockStates.shift(),
    },
    log: message => logs.push(message),
    record: async (event, details) => events.push({ event, details }),
    delay: async milliseconds => { now += milliseconds },
    now: () => now,
    unlockTimeout: 5_000,
    unlockPollMs: 1_000,
  })

  assert.equal(preparation.stay_awake_original, '7')
  assert.match(logs.join('\n'), /请先在设备上完成解锁/)
  assert.match(logs.join('\n'), /已确认手机解锁/)
  assert.deepEqual(events.map(item => item.event), [
    'device_power_prepared',
    'device_unlock_required',
    'device_unlocked',
  ])
})

test('手机持续锁屏超过等待窗口时在任何入口操作前明确停止', async () => {
  let now = 0
  let registeredPreparation = null
  await assert.rejects(prepareDeviceForAutomation({
    ui: {
      prepareDevicePower: async () => ({
        screen_was_on: true,
        screen_on: true,
        wake_performed: false,
        stay_awake_original: null,
        stay_awake_applied: '2',
        lock_state: { locked: true, method: 'trust' },
      }),
      deviceLockState: async () => ({ locked: true, method: 'trust' }),
    },
    delay: async milliseconds => { now += milliseconds },
    now: () => now,
    onPrepared: preparation => { registeredPreparation = preparation },
    unlockTimeout: 2_000,
    unlockPollMs: 1_000,
  }), /手机仍处于锁屏状态/)
  assert.equal(registeredPreparation.stay_awake_original, null)
})

test('小荷到底按钮未在首次点击后消失时只按最新层级受控重试', async () => {
  const control = '<hierarchy><node class="android.view.View" clickable="true" visible-to-user="true" bounds="[475,1500][607,1632]" /></hierarchy>'
  const cleared = '<hierarchy><node class="android.view.View" clickable="false" visible-to-user="true" bounds="[0,200][1080,1800]" /></hierarchy>'
  const sources = [control, cleared]
  const taps = []
  const logs = []
  const result = await navigateReplyToBottomControl({
    initialXml: control,
    bounds: CHAT_BOUNDS,
    source: async () => sources.shift(),
    tap: async (x, y) => taps.push([x, y]),
    log: message => logs.push(message),
    delay: async () => {},
  })
  assert.deepEqual(taps, [[541, 1566], [541, 1566]])
  assert.equal(result.clicks, 2)
  assert.equal(result.targetCleared, true)
  assert.match(logs[0], /最新层级重新定位/)
})

test('抖音和头条全文正式采集前先持续确认到底，并记录成功接缝证据', async () => {
  const width = 240
  const frameHeight = 300
  const shift = 120
  const contentHeight = frameHeight + shift
  const raw = Buffer.alloc(width * contentHeight * 3)
  for (let y = 0; y < contentHeight; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3
      const value = 35 + ((y * 31 + x * 17 + (x * y) % 101) % 190)
      raw[offset] = value
      raw[offset + 1] = (value + 37) % 240
      raw[offset + 2] = (value + 73) % 240
    }
  }
  const content = sharp(raw, { raw: { width, height: contentHeight, channels: 3 } })
  const top = await content.clone().extract({ left: 0, top: 0, width, height: frameHeight }).png().toBuffer()
  const bottom = await content.clone().extract({ left: 0, top: shift, width, height: frameHeight }).png().toBuffer()
  let position = 'top'
  let visualQuietCalled = false
  const directions = []
  const capture = createReplyCapture({
    log: () => {},
    source: async () => '<hierarchy />',
    screenshot: async () => top,
    windowSize: async () => ({ width, height: frameHeight }),
    waitForVisualQuiet: async () => {},
    waitForFinalVisualQuiet: async () => { visualQuietCalled = true },
    captureReplyRegionSnapshot: async () => ({
      frame: position === 'top' ? top : bottom,
      xml: '<hierarchy />',
      stable: true,
      attempts: 1,
    }),
    swipeChat: async (_bounds, direction) => {
      directions.push(direction)
      position = direction === 'up' ? 'top' : 'bottom'
      return { distance: shift, canScrollMore: null, x: 204, durationMs: 75 }
    },
    captureReferenceProductsAtTrigger: async () => { throw new Error('不应采集药品') },
    miniAppCompletionConfirmationOptions: {
      quietMs: 0,
      probeInterval: 0,
      timeout: 1_000,
      delay: async () => {},
    },
  })

  const result = await capture.captureDouyinFullAnswerFrames('<hierarchy />', [0, 0, width, frameHeight])
  assert.equal(visualQuietCalled, false)
  assert.equal(result.captureMetadata.reply_completion_confirmed_before_capture, true)
  assert.ok(result.captureMetadata.reply_completion_confirmation_probes >= 4)
  assert.equal(result.frames.length, 2)
  assert.equal(result.transitions.length, 1)
  assert.equal(result.seamRecords.length, 1)
  assert.equal(result.seamRecords[0].outcome, 'verified')
  assert.equal(result.scrollDecisions.filter(item => item.outcome === 'no_progress').length, 2)
  assert.ok(directions.slice(0, 4).every(direction => direction === 'down'))
  assert.ok(directions.includes('up'))

  position = 'top'
  directions.length = 0
  const toutiao = await capture.captureToutiaoFullAnswerFrames('<hierarchy />', [0, 0, width, frameHeight])
  assert.equal(toutiao.captureMetadata.reply_completion_confirmed_before_capture, true)
  assert.ok(toutiao.captureMetadata.reply_completion_confirmation_probes >= 4)
  assert.equal(toutiao.frames.length, 2)
  assert.equal(toutiao.transitions.length, 1)
  assert.equal(toutiao.seamRecords[0].outcome, 'verified')
  assert.ok(directions.slice(0, 4).every(direction => direction === 'down'))
  assert.ok(directions.includes('up'))
})

test('抖音全文打开后允许正文和药品图片继续变化，由到底探测负责等待稳定', async () => {
  const width = 240
  const height = 300
  const frame = await sharp({ create: { width, height, channels: 3, background: '#f5f5f5' } })
    .png().toBuffer()
  let completionProbeStarted = false
  let screenshotCalls = 0
  const capture = createReplyCapture({
    log: () => {},
    source: async () => '<hierarchy />',
    screenshot: async () => {
      screenshotCalls += 1
      if (!completionProbeStarted) throw new Error('不应在到底探测前要求整屏稳定')
      return frame
    },
    windowSize: async () => ({ width, height }),
    waitForVisualQuiet: async () => {},
    waitForFinalVisualQuiet: async () => {},
    captureReplyRegionSnapshot: async () => ({
      frame,
      xml: '<hierarchy />',
      stable: completionProbeStarted,
      attempts: 1,
    }),
    swipeChat: async (_bounds, direction) => {
      if (direction === 'down') completionProbeStarted = true
      return { distance: 0, canScrollMore: false, x: 204, durationMs: 75 }
    },
    captureReferenceProductsAtTrigger: async () => { throw new Error('不应采集药品') },
    miniAppCompletionConfirmationOptions: {
      quietMs: 0,
      probeInterval: 0,
      timeout: 1_000,
      delay: async () => {},
    },
  })

  const result = await capture.captureDouyinFullAnswerFrames('<hierarchy />', [0, 0, width, height])
  assert.equal(result.captureMetadata.reply_completion_confirmed_before_capture, true)
  assert.equal(completionProbeStarted, true)
  assert.ok(screenshotCalls > 0)
})

test('抖音回顶忽略下半部没有更多Toast，但正文移动仍会重置确认', async () => {
  const width = 360
  const height = 640
  const base = await sharp({ create: { width, height, channels: 3, background: '#f5f5f5' } })
    .composite([
      { input: Buffer.from('<svg width="300" height="180"><path d="M0 20H270M0 70H240M0 120H280" stroke="black" stroke-width="12"/></svg>'), left: 30, top: 45 },
    ])
    .png().toBuffer()
  const toastOnly = await sharp(base).composite([{
    input: await sharp({ create: { width: 210, height: 72, channels: 3, background: '#303030' } }).png().toBuffer(),
    left: 75,
    top: 430,
  }]).png().toBuffer()
  const movedContent = await sharp(base).composite([{
    input: await sharp({ create: { width: 280, height: 80, channels: 3, background: '#78d9cc' } }).png().toBuffer(),
    left: 40,
    top: 110,
  }]).png().toBuffer()

  assert.equal(await miniAppTopFramesStable(base, toastOnly), true)
  assert.equal(await miniAppTopFramesStable(base, movedContent), false)
})

test('抖音独立小程序只用右侧完全一致的问题气泡作为本题截图起点', () => {
  const recognition = {
    image: { width: 1080, height: 1693 },
    results: [
      { text: '奥利司他胶囊', normalizedText: '奥利司他胶囊', confidence: 0.99, bounds: [72, 380, 365, 438] },
      { text: '奥利司他胶囊', normalizedText: '奥利司他胶囊', confidence: 0.98, bounds: [650, 220, 992, 285] },
      { text: '奥利司他胶囊是什么药', normalizedText: '奥利司他胶囊是什么药', confidence: 0.99, bounds: [620, 500, 1000, 565] },
    ],
  }
  assert.deepEqual(miniAppQuestionOcrTarget(recognition, '奥利司他胶囊', { width: 720, height: 1129 }), {
    bounds: [433, 147, 661, 190],
    physicalBounds: [650, 220, 992, 285],
    confidence: 0.98,
    text: '奥利司他胶囊',
  })
  assert.equal(miniAppQuestionOcrTarget({ ...recognition, results: recognition.results.slice(0, 1) }, '奥利司他胶囊', { width: 720, height: 1129 }), null)
  assert.equal(miniAppQuestionOcrTarget(recognition, '奥利司他胶囊是什么药', { width: 720, height: 1129 })?.bounds[0], 413)
})

test('抖音独立小程序首帧从本题问题气泡上方安全留白开始裁剪并适配物理尺寸', () => {
  assert.deepEqual(miniAppQuestionFirstFrameCropBounds({ physicalBounds: [650, 500, 992, 565] }, { width: 1080, height: 1693 }), [0, 449, 1080, 1693])
  assert.deepEqual(miniAppQuestionFirstFrameCropBounds({ physicalBounds: [433, 333, 661, 377] }, { width: 720, height: 1129 }), [0, 299, 720, 1129])
  assert.equal(miniAppQuestionFirstFrameCropBounds(null, { width: 1080, height: 1693 }), null)
})

test('抖音独立小程序首帧因顶部回弹漏掉问题气泡时仅允许两次找回', () => {
  assert.equal(miniAppQuestionFirstFrameReacquisitionAllowed(0), true)
  assert.equal(miniAppQuestionFirstFrameReacquisitionAllowed(1), true)
  assert.equal(miniAppQuestionFirstFrameReacquisitionAllowed(2), false)
  assert.equal(miniAppQuestionFirstFrameReacquisitionAllowed(-1), false)
})

test('抖音回顶无法确认时按上限停止，不再无限向上滑动', async () => {
  let now = 0
  let swipes = 0
  await assert.rejects(() => confirmMiniAppTop({
    initialCapture: { frame: 'initial' },
    swipeUp: async () => { swipes += 1; now += 100; return {} },
    settle: async () => ({ frame: `changed-${swipes}` }),
    framesStable: async () => false,
    maxAttempts: 3,
    timeout: 10_000,
    now: () => now,
  }), /停止继续滚动，避免无限刷新/)
  assert.equal(swipes, 3)
})

test('抖音独立入口必须识别本题上下文，不能把旧会话当作新回答', () => {
  const recognition = lines => ({ results: lines.map(text => ({ text, normalizedText: text, confidence: 0.99 })) })
  const oldReply = douyinMiniAppAnswerContextEvidence(
    recognition(['咖啡因刺激交感神经，导致心悸心慌', '喝咖啡后出现心悸']),
    '畅莱舒普济痔疮栓',
  )
  const currentReply = douyinMiniAppAnswerContextEvidence(
    recognition(['畅莱舒普济痔疮栓用于缓解痔疮相关症状']),
    '畅莱舒普济痔疮栓',
  )
  const paraphrasedReply = douyinMiniAppAnswerContextEvidence(
    recognition(['腹泻后发生脱水，应及时补充液体']),
    '腹泻脱水用什么药',
  )

  assert.equal(oldReply.matched, false)
  assert.equal(currentReply.matched, true)
  assert.equal(paraphrasedReply.matched, true)
})

test('抖音小程序网络错误必须同时匹配错误文案和其下方重试按钮', () => {
  const recognition = {
    image: { width: 1080, height: 2400 },
    results: [
      { text: '网络不稳定，请重试', normalizedText: '网络不稳定,请重试', confidence: 0.99, bounds: [333, 1235, 751, 1292] },
      { text: '重试', normalizedText: '重试', confidence: 0.99, bounds: [489, 1434, 594, 1493] },
    ],
  }
  assert.deepEqual(douyinMiniAppNetworkRetryTarget(recognition, { width: 720, height: 1600 }), {
    bounds: [326, 956, 396, 995],
    physicalBounds: [489, 1434, 594, 1493],
    errorPhysicalBounds: [333, 1235, 751, 1292],
    errorConfidence: 0.99,
    retryConfidence: 0.99,
  })
  assert.equal(douyinMiniAppNetworkRetryTarget({ ...recognition, results: recognition.results.slice(1) }, { width: 720, height: 1600 }), null)
  assert.equal(douyinMiniAppNetworkRetryTarget({
    ...recognition,
    results: [recognition.results[0], { ...recognition.results[1], bounds: [10, 400, 110, 470] }],
  }, { width: 720, height: 1600 }), null)
})

test('抖音小程序网络错误会重启应用并从当前题完整重试一次', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'geo-douyin-restart-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const logs = []
  let searches = 0
  let waits = 0
  let restarts = 0
  const target = {
    mode: 'miniapp_entry_card',
    cardBounds: [0, 200, 720, 1300],
    tapBounds: [500, 900, 700, 1100],
  }
  const workflow = createQuestionWorkflows({
    observer: { snapshot: () => ({ active: true }) },
    recoverySnapshot: () => ({}),
    log: message => logs.push(message),
    inputDouyinQuestion: async () => { searches += 1; return [600, 40, 710, 120] },
    tap: async () => {},
    waitForDouyinSearchResult: async () => ({ target, size: { width: 720, height: 1600 } }),
    refreshDouyinSearchResults: async () => {},
    captureDouyinSearchTarget: async () => ({ target, frame: Buffer.from('entry'), detectionMethod: 'hierarchy' }),
    openDouyinMiniAppEntry: async () => ({ xml: '<hierarchy />', bounds: [0, 200, 720, 1200], activity: 'MiniAppHostActivity0' }),
    waitForDouyinMiniAppAnswer: async full => {
      waits += 1
      if (waits === 1) throw new DouyinMiniAppNetworkError()
      return full
    },
    captureDouyinMiniAppEntryAnswerFrames: async () => ({}),
    saveArtifacts: async () => ({ metadata: path.join(root, '回答.json') }),
    restartDouyinEntry: async () => { restarts += 1 },
    getActiveEntry: () => ENTRY_DEFINITIONS['douyin-xiaohe-miniapp'],
    getActivePackageName: () => ENTRY_DEFINITIONS['douyin-xiaohe-miniapp'].packageName,
  })
  const artifacts = {
    batchDirectory: root,
    deliveryDirectory: path.join(root, '交付图片', '001_奥利司他胶囊'),
    diagnosticDirectory: path.join(root, '调试产物', '001_奥利司他胶囊'),
  }
  await fs.mkdir(artifacts.diagnosticDirectory, { recursive: true })

  await workflow.askOnceDouyin({ serial: 'device', timeout: 90 }, artifacts, '奥利司他胶囊', 1)

  assert.equal(searches, 2)
  assert.equal(waits, 2)
  assert.equal(restarts, 1)
  assert.equal(logs.some(message => /从当前题重新执行/.test(message)), true)
})

test('抖音独立入口只用小荷卡片确认点击稳定，不受旁边自动播放视频影响', () => {
  assert.deepEqual(douyinSearchTargetStabilityBounds({
    mode: 'miniapp_entry_card',
    cardBounds: [12, 910, 626, 2290],
  }, { width: 1272, height: 2800 }), [12, 910, 626, 2290])
  assert.deepEqual(douyinSearchTargetStabilityBounds({
    mode: 'miniapp_entry_card',
    cardBounds: [8, 520, 360, 1320],
  }, { width: 720, height: 1600 }), [8, 520, 360, 1320])
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

test('小荷App即使调用方传入false也强制新建会话后再发送', async () => {
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
    tapNewSession: async () => true,
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
  assert.equal(saved.meta.new_session_requested, true)
  assert.equal(saved.meta.new_session_performed, true)
  assert.equal(typeof saved.captureMethod, 'function')
})

test('小荷App普通批次遇到响应超时时只点击一次重试并等待新回答后再截图', async () => {
  const timeoutXml = '<hierarchy><node class="android.view.View" scrollable="true" bounds="[0,384][1080,1968]">'
    + '<node package="com.aurora.xiaohe.aidoctor" class="android.widget.TextView" text="响应超时，点击重新生成回答。" bounds="[55,643][811,726]" />'
    + '<node package="com.aurora.xiaohe.aidoctor" class="android.widget.Button" text="重试" clickable="true" bounds="[55,754][1025,887]" />'
    + '</node></hierarchy>'
  const stableXml = '<hierarchy><node class="android.view.View" scrollable="true" bounds="[0,384][1080,1968]">'
    + '<node package="com.aurora.xiaohe.aidoctor" class="android.widget.TextView" text="重新生成后的回答" bounds="[55,643][1025,887]" />'
    + '</node></hierarchy>'
  const taps = []
  const events = []
  let waits = 0
  let saved = null
  const workflow = createQuestionWorkflows({
    observer: {
      active: true,
      mark: () => ({ frameCount: 0 }),
      snapshot: () => ({ active: true }),
      waitForActivity: async () => ({ activity: true }),
    },
    recoverySnapshot: () => ({}),
    log: () => {},
    tap: async (x, y) => taps.push([x, y]),
    source: async () => timeoutXml,
    windowSize: async () => ({ width: 1080, height: 2400 }),
    recordResponseTimeoutRecovery: async (event, details) => events.push([event, details]),
    tapNewSession: async () => true,
    inputQuestion: async () => {},
    tapSend: async () => {},
    recoverObserver: async () => false,
    waitForStableReply: async () => {
      waits += 1
      return waits === 1
        ? { status: 'stable', xml: timeoutXml }
        : { status: 'stable', xml: stableXml }
    },
    captureFullReplyFrames: async () => ({}),
    saveArtifacts: async options => {
      saved = options
      return { metadata: '/tmp/回答.json' }
    },
    getActiveEntry: () => ENTRY_DEFINITIONS['xiaohe-app'],
    getActivePackageName: () => ENTRY_DEFINITIONS['xiaohe-app'].packageName,
  })

  await workflow.askOnce({ serial: 'device', timeout: 90, newSession: false }, {
    batchDirectory: '/tmp/batch_1',
    diagnosticDirectory: '/tmp/batch_1/调试产物/001_测试',
  }, '测试问题', 1)

  assert.equal(waits, 2)
  assert.deepEqual(taps, [[540, 820]])
  assert.equal(saved.xml, stableXml)
  assert.deepEqual({
    detected: saved.meta.submitted_reply_timeout_detected,
    performed: saved.meta.submitted_reply_retry_performed,
    attempts: saved.meta.submitted_reply_retry_attempts,
    succeeded: saved.meta.submitted_reply_retry_succeeded,
  }, { detected: true, performed: true, attempts: 1, succeeded: true })
  assert.equal(events.some(([event]) => event === 'submitted_reply_timeout_retry_clicked'), true)
})

test('小荷App普通批次唯一一次重试后仍超时则本题失败且不生成正式截图', async () => {
  const timeoutXml = '<hierarchy><node class="android.view.View" scrollable="true" bounds="[0,240][720,1320]">'
    + '<node class="android.widget.TextView" text="响应超时，点击重新生成回答。" bounds="[36,420][542,478]" />'
    + '<node class="android.widget.Button" content-desc="重试" clickable="true" bounds="[36,495][684,585]" />'
    + '</node></hierarchy>'
  let taps = 0
  let saves = 0
  const workflow = createQuestionWorkflows({
    observer: {
      active: true,
      mark: () => ({ frameCount: 0 }),
      snapshot: () => ({ active: true }),
      waitForActivity: async () => ({ activity: true }),
    },
    recoverySnapshot: () => ({}),
    log: () => {},
    tap: async () => { taps += 1 },
    source: async () => timeoutXml,
    windowSize: async () => ({ width: 720, height: 1600 }),
    tapNewSession: async () => true,
    inputQuestion: async () => {},
    tapSend: async () => {},
    recoverObserver: async () => false,
    waitForStableReply: async () => ({ status: 'stable', xml: timeoutXml }),
    captureFullReplyFrames: async () => ({}),
    saveArtifacts: async () => { saves += 1 },
    getActiveEntry: () => ENTRY_DEFINITIONS['xiaohe-app'],
    getActivePackageName: () => ENTRY_DEFINITIONS['xiaohe-app'].packageName,
  })

  await assert.rejects(workflow.askOnce({ serial: 'device', timeout: 90, newSession: false }, {
    batchDirectory: '/tmp/batch_1',
    diagnosticDirectory: '/tmp/batch_1/调试产物/001_测试',
  }, '测试问题', 1), /唯一一次重试后仍显示响应超时/)

  assert.equal(taps, 1)
  assert.equal(saves, 0)
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

test('分组失败项缺少品牌路径信息时拒绝重试', () => {
  assert.throws(() => failedRetryItems({
    question_plan_mode: 'grouped',
    results: [{ status: 'failed', entry_id: 'xiaohe-app', question: '问题', question_index: 1 }],
  }), /品牌归档信息不完整/)
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
    error: new Error('未找到小荷AI医生卡片', { cause: new Error('搜索结果仍是旧问题') }),
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
  assert.equal(manifest.original_error.cause.message, '搜索结果仍是旧问题')
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
  }), /刷新后再次检查首屏.*仍未出现/)
  assert.deepEqual(calls, ['wait:1', 'refresh', 'wait:2'])
})

test('抖音两轮未召回智能总结或小荷入口时保存正式搜索结果截图', async () => {
  let saved = null
  const workflow = createQuestionWorkflows({
    observer: { snapshot: () => ({ active: true }) },
    recoverySnapshot: () => ({}),
    log: () => {},
    inputDouyinQuestion: async () => [600, 40, 710, 120],
    tap: async () => {},
    waitForDouyinSearchResult: async () => { throw new DouyinSearchResultNotFoundError('未召回') },
    refreshDouyinSearchResults: async () => {},
    source: async () => '<hierarchy><node text="普通搜索结果" /></hierarchy>',
    screenshot: async () => Buffer.from('douyin-results'),
    saveArtifacts: async options => {
      saved = options
      return { screenshot: `${options.artifacts.deliveryDirectory}/${options.stem}.png`, metadata: '/tmp/meta.json' }
    },
    getActiveEntry: () => ENTRY_DEFINITIONS['douyin-xiaohe-miniapp'],
    getActivePackageName: () => ENTRY_DEFINITIONS['douyin-xiaohe-miniapp'].packageName,
  })
  const artifacts = { batchDirectory: '/tmp/batch', deliveryDirectory: '/tmp/delivery', diagnosticDirectory: '/tmp/debug' }
  const result = await workflow.askOnceDouyin({ serial: 'device', timeout: 1 }, artifacts, '测试问题', 1)

  assert.equal(result.search_result_only, true)
  assert.equal(saved.stem, '回答_搜索结果')
  assert.equal(saved.stitch, false)
  assert.equal(saved.frame.toString(), 'douyin-results')
  assert.equal(saved.meta.douyin_result_mode, 'search_results_only')
  assert.equal(saved.meta.xiaohe_result_detected, false)
  assert.equal(saved.meta.search_result_capture_complete, true)
})

test('抖音两轮都只检查首屏且第一次无入口后仅下拉刷新一次', async () => {
  let now = 0
  const swipes = []
  const xml = '<hierarchy>'
    + '<node package="com.ss.android.ugc.aweme" class="android.widget.EditText" resource-id="com.ss.android.ugc.aweme:id/et_search_kw" text="测试问题" visible-to-user="true" bounds="[132,90][754,210]" />'
    + '<node package="com.ss.android.ugc.aweme" class="androidx.recyclerview.widget.RecyclerView" visible-to-user="true" bounds="[0,220][1080,2200]" />'
    + '</hierarchy>'
  const workflow = createDouyinSearchWorkflow({
    source: async () => xml,
    windowSize: async () => ({ width: 1080, height: 2400 }),
    log: () => {},
    screenshot: async () => Buffer.from('screen'),
    ocr: {
      recognize: async () => ({
        engine: 'rapidocr', elapsedMs: 0, image: { width: 1080, height: 2400 }, results: [],
      }),
    },
    setLastOcrDiagnostic: () => {},
    swipeChat: async (_bounds, direction, fraction, options) => {
      swipes.push({ direction, fraction, options })
      return {}
    },
    waitForVisualQuiet: async () => {},
    tap: async () => {},
    ui: {},
    getActivePackageName: () => 'com.ss.android.ugc.aweme',
    checkCancelled: () => {},
    waitForStableReply: async () => ({ status: 'stable' }),
    now: () => now,
    delay: async milliseconds => { now += milliseconds },
  })

  await assert.rejects(
    workflow.waitForDouyinSearchResult(1_000, { attempt: 1 }),
    error => error instanceof DouyinSearchResultNotFoundError && error.scanScrolls === 0,
  )
  assert.deepEqual(swipes, [])

  await workflow.refreshDouyinSearchResults('测试问题', 0)
  assert.equal(swipes.length, 1)
  assert.equal(swipes[0].direction, 'up')

  await assert.rejects(
    workflow.waitForDouyinSearchResult(1_000, { attempt: 2 }),
    error => error instanceof DouyinSearchResultNotFoundError && error.scanScrolls === 0,
  )
  assert.equal(swipes.length, 1)
  assert.equal(swipes.some(item => item.direction === 'down'), false)
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

test('头条同词重试仍未召回小荷入口时保存正式搜索结果截图', async () => {
  let saved = null
  const workflow = createQuestionWorkflows({
    observer: { snapshot: () => ({ active: true }) },
    recoverySnapshot: () => ({}),
    log: () => {},
    inputToutiaoQuestion: async () => [600, 40, 710, 120],
    tap: async () => {},
    waitForToutiaoAnswerCard: async () => { throw new ToutiaoAnswerCardNotFoundError('未召回') },
    source: async () => '<hierarchy><node text="普通搜索结果" /></hierarchy>',
    screenshot: async () => Buffer.from('toutiao-results'),
    saveArtifacts: async options => {
      saved = options
      return { screenshot: `${options.artifacts.deliveryDirectory}/${options.stem}.png`, metadata: '/tmp/meta.json' }
    },
    getActiveEntry: () => ENTRY_DEFINITIONS['toutiao-xiaohe-miniapp'],
    getActivePackageName: () => ENTRY_DEFINITIONS['toutiao-xiaohe-miniapp'].packageName,
  })
  const artifacts = { batchDirectory: '/tmp/batch', deliveryDirectory: '/tmp/delivery', diagnosticDirectory: '/tmp/debug' }
  const result = await workflow.askOnceToutiao({ serial: 'device', timeout: 1 }, artifacts, '测试问题', 1)

  assert.equal(result.search_result_only, true)
  assert.equal(saved.stem, '回答_搜索结果')
  assert.equal(saved.stitch, false)
  assert.equal(saved.frame.toString(), 'toutiao-results')
  assert.equal(saved.meta.toutiao_result_mode, 'search_results_only')
  assert.equal(saved.meta.xiaohe_result_detected, false)
  assert.equal(saved.meta.search_result_capture_complete, true)
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

test('头条新版回答页正文已出现时不因发送框被误判为通用咨询页', () => {
  const answerPage = `<hierarchy>
    <node package="com.ss.android.article.news" class="android.view.View" content-desc="点击退出小程序" visible-to-user="true" bounds="[0,0][1080,2400]" />
    <node package="com.ss.android.article.news" class="android.view.ViewGroup" visible-to-user="true" bounds="[0,233][1080,2014]">
      <node package="com.ss.android.article.news" class="android.view.ViewGroup" visible-to-user="true" bounds="[0,233][1080,2014]" />
    </node>
    <node package="com.ss.android.article.news" class="android.widget.HorizontalScrollView" visible-to-user="true" bounds="[0,2014][1080,2180]" />
    <node package="com.ss.android.article.news" class="android.widget.EditText" text="发送消息" hint="发送消息" visible-to-user="true" bounds="[99,2249][861,2321]" />
  </hierarchy>`
  assert.equal(toutiaoGenericConsultationPage(answerPage, { answerContentReady: true }), false)
  assert.equal(toutiaoGenericConsultationPage(answerPage, { answerContentReady: false }), true)
})

test('头条回答正文像素检测映射不同物理与逻辑竖屏尺寸', async () => {
  const blank = await sharp({ create: { width: 1080, height: 2400, channels: 3, background: '#f5f5f5' } }).png().toBuffer()
  const answer = await sharp(blank).composite([
    { input: Buffer.from('<svg width="720" height="500"><rect width="720" height="500" fill="white"/><path d="M20 70H650M20 150H680M20 230H610M20 310H670" stroke="black" stroke-width="16"/></svg>'), left: 180, top: 300 },
  ]).png().toBuffer()
  const logicalSize = { width: 720, height: 1600 }
  const logicalBounds = [0, 155, 720, 1343]
  assert.equal(await toutiaoAnswerRegionLooksReady(blank, logicalBounds, logicalSize), false)
  assert.equal(await toutiaoAnswerRegionLooksReady(answer, logicalBounds, logicalSize), true)
})

test('头条冷启动只识别添加到主屏幕弹窗的取消按钮', () => {
  const popup = `<hierarchy>
    <node package="com.huawei.android.launcher" class="android.widget.TextView" text="添加到主屏幕" visible-to-user="true" bounds="[120,1655][960,1747]" />
    <node package="com.huawei.android.launcher" class="android.widget.TextView" text="今日头条" visible-to-user="true" bounds="[435,2029][643,2099]" />
    <node package="com.huawei.android.launcher" class="android.widget.Button" text="取消" clickable="true" visible-to-user="true" bounds="[84,2202][539,2334]" />
    <node package="com.huawei.android.launcher" class="android.widget.Button" text="添加" clickable="true" visible-to-user="true" bounds="[541,2202][996,2334]" />
  </hierarchy>`
  assert.deepEqual(toutiaoAddToHomeScreenCancelBounds(popup), [84, 2202, 539, 2334])
  assert.equal(toutiaoAddToHomeScreenCancelBounds(popup.replace('今日头条', '其他应用')), null)
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

test('头条全文二次路由失败保留最后一次底层拒绝原因', async () => {
  await assert.rejects(() => runToutiaoFullAnswerAttempts({
    initialTarget: { viewMore: 'first' },
    openFullAnswer: async target => {
      throw new ToutiaoFullAnswerNotOpenedError(target.viewMore === 'first' ? '首次页面空白' : '正文区域仍未出现')
    },
    repeatExactSearch: async () => ({ viewMore: 'second' }),
  }), /正文区域仍未出现/)
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

  const scaledXml = xml
    .replaceAll('1080', '720')
    .replaceAll('2408', '1605')
    .replaceAll('944', '629').replaceAll('1056', '704')
    .replaceAll('111', '74').replaceAll('207', '138')
    .replaceAll('363', '242').replaceAll('1785', '1190').replaceAll('1940', '1293')
  assert.deepEqual(douyinMiniAppCaptureBounds(scaledXml, { width: 720, height: 1605 }), [0, 242, 720, 1190])

  const currentDouyinXml = `<hierarchy>
    <node package="com.ss.android.ugc.aweme" class="android.view.View" content-desc="close" visible-to-user="true" bounds="[978,135][1020,177]" />
    <node package="com.ss.android.ugc.aweme" class="android.view.ViewGroup" visible-to-user="true" bounds="[0,231][1080,2014]">
      <node package="com.ss.android.ugc.aweme" class="android.view.ViewGroup" visible-to-user="true" bounds="[0,231][1080,2014]" />
    </node>
    <node package="com.ss.android.ugc.aweme" class="android.widget.ScrollView" visible-to-user="true" bounds="[0,2014][1080,2169]" />
    <node package="com.ss.android.ugc.aweme" class="android.widget.HorizontalScrollView" scrollable="true" visible-to-user="true" bounds="[0,2014][1080,2169]" />
  </hierarchy>`
  assert.deepEqual(douyinMiniAppCaptureBounds(currentDouyinXml, { width: 1080, height: 2400 }), [0, 231, 1080, 2014])
  const scaledCurrentDouyinXml = currentDouyinXml
    .replaceAll('1080', '720').replaceAll('2400', '1600')
    .replaceAll('978', '652').replaceAll('1020', '680')
    .replaceAll('135', '90').replaceAll('177', '118')
    .replaceAll('231', '154').replaceAll('2014', '1343').replaceAll('2169', '1446')
  assert.deepEqual(douyinMiniAppCaptureBounds(scaledCurrentDouyinXml, { width: 720, height: 1600 }), [0, 154, 720, 1343])
  assert.equal(douyinMiniAppCaptureBounds(currentDouyinXml.replace('[978,135][1020,177]', '[400,135][442,177]'), { width: 1080, height: 2400 }), null)
  assert.deepEqual(douyinMiniAppCaptureBounds(currentDouyinXml.replaceAll('com.ss.android.ugc.aweme', 'com.ss.android.article.news'), { width: 1080, height: 2400 }), [0, 231, 1080, 2014])
  assert.equal(douyinMiniAppCaptureBounds(currentDouyinXml.replaceAll('com.ss.android.ugc.aweme', 'invalid.package'), { width: 1080, height: 2400 }), null)
})

test('抖音查看全文以真实前台窗口确认新版小程序宿主', async () => {
  const xml = `<hierarchy>
    <node package="com.ss.android.ugc.aweme" class="android.view.View" content-desc="close" visible-to-user="true" bounds="[978,135][1020,177]" />
    <node package="com.ss.android.ugc.aweme" class="android.view.ViewGroup" visible-to-user="true" bounds="[0,231][1080,2014]" />
    <node package="com.ss.android.ugc.aweme" class="android.widget.HorizontalScrollView" scrollable="true" visible-to-user="true" bounds="[0,2014][1080,2169]" />
  </hierarchy>`
  let taps = 0
  const workflow = createDouyinSearchWorkflow({
    source: async () => xml,
    windowSize: async () => ({ width: 1080, height: 2400 }),
    log: () => {},
    screenshot: async () => Buffer.from('screen'),
    ocr: { recognize: async () => ({ image: { width: 1080, height: 2400 }, results: [] }) },
    setLastOcrDiagnostic: () => {},
    swipeChat: async () => {},
    waitForVisualQuiet: async () => {},
    tap: async () => { taps += 1 },
    ui: {
      currentApp: async () => ({ package: 'com.ss.android.ugc.aweme', activity: 'com.ss.android.ugc.aweme.search.activity.SearchResultActivity' }),
      foregroundWindow: async () => ({ package: 'com.ss.android.ugc.aweme', activity: 'com.bytedance.kmp.open_platform.kmp_miniapp_business_impl.process.container.MiniAppHostActivity0' }),
    },
    getActivePackageName: () => 'com.ss.android.ugc.aweme',
    checkCancelled: () => {},
    waitForStableReply: async () => ({ status: 'stable', xml }),
  })

  const opened = await workflow.openDouyinFullAnswer([420, 900, 660, 1020], { width: 1080, height: 2400 })
  assert.equal(taps, 1)
  assert.equal(opened.activity.endsWith('MiniAppHostActivity0'), true)
  assert.deepEqual(opened.bounds, [0, 231, 1080, 2014])
})

test('抖音查看全文兼容currentApp先看到宿主而foregroundWindow仍报告搜索页', async () => {
  const xml = `<hierarchy>
    <node package="com.ss.android.ugc.aweme" class="android.view.View" content-desc="close" visible-to-user="true" bounds="[978,135][1020,177]" />
    <node package="com.ss.android.ugc.aweme" class="android.view.ViewGroup" visible-to-user="true" bounds="[0,231][1080,2014]" />
    <node package="com.ss.android.ugc.aweme" class="android.widget.HorizontalScrollView" scrollable="true" visible-to-user="true" bounds="[0,2014][1080,2169]" />
  </hierarchy>`
  const workflow = createDouyinSearchWorkflow({
    source: async () => xml,
    windowSize: async () => ({ width: 1080, height: 2400 }),
    log: () => {}, screenshot: async () => Buffer.from('screen'),
    ocr: { recognize: async () => ({ image: { width: 1080, height: 2400 }, results: [] }) },
    setLastOcrDiagnostic: () => {}, swipeChat: async () => {}, waitForVisualQuiet: async () => {}, tap: async () => {},
    ui: {
      currentApp: async () => ({ package: 'com.ss.android.ugc.aweme', activity: 'com.bytedance.kmp.open_platform.kmp_miniapp_business_impl.process.container.MiniAppHostActivity0' }),
      foregroundWindow: async () => ({ package: 'com.ss.android.ugc.aweme', activity: 'com.ss.android.ugc.aweme.search.activity.SearchResultActivity' }),
    },
    getActivePackageName: () => 'com.ss.android.ugc.aweme', checkCancelled: () => {},
    waitForStableReply: async () => ({ status: 'stable', xml }),
  })
  const opened = await workflow.openDouyinFullAnswer([420, 900, 660, 1020], { width: 1080, height: 2400 })
  assert.equal(opened.activity.endsWith('MiniAppHostActivity0'), true)
  assert.deepEqual(opened.bounds, [0, 231, 1080, 2014])
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

test('抖音小程序两项药品卡较高时仍定位全部药品箭头并兼容缩放', () => {
  const xml = `<hierarchy><node class="android.view.ViewGroup" bounds="[0,321][1080,2014]">
    <node class="android.view.ViewGroup" bounds="[24,1324][1056,2014]">
      <node class="android.widget.ImageView" bounds="[972,1373][1008,1409]" />
      <node class="android.view.ViewGroup" bounds="[72,1457][240,1625]" />
      <node class="android.view.ViewGroup" bounds="[72,1751][240,1919]" />
    </node>
  </node></hierarchy>`
  assert.deepEqual(miniAppReferenceProductsTrigger(xml, [0, 321, 1080, 2014]), [990, 1391])
  const scaled = `<hierarchy><node class="android.view.ViewGroup" bounds="[0,214][720,1343]">
    <node class="android.view.ViewGroup" bounds="[16,883][704,1343]">
      <node class="android.widget.ImageView" bounds="[648,915][672,939]" />
      <node class="android.view.ViewGroup" bounds="[48,971][160,1083]" />
      <node class="android.view.ViewGroup" bounds="[48,1167][160,1279]" />
    </node>
  </node></hierarchy>`
  assert.deepEqual(miniAppReferenceProductsTrigger(scaled, [0, 214, 720, 1343]), [660, 927])
})

test('头条入口按真实搜索框和“查看更多/查看全文”卡片结构定位', () => {
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
  assert.deepEqual(toutiaoViewMoreBounds(xml.replace('查看更多', '查看全文')), [72, 1323, 1008, 1464])
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

test('头条WebView不暴露文字时以品牌标题和全文入口的OCR几何关系定位', () => {
  const recognition = (width, height, scale = 1, entryText = '查看更多') => ({
    image: { width, height },
    results: [
      { text: '小荷AI医生・智能总结', normalizedText: '小荷AI医生智能总结', confidence: 0.988, bounds: [156, 433, 630, 489].map(value => value * scale) },
      { text: `${entryText}>`, normalizedText: entryText, confidence: 0.978, bounds: [420, 1254, 656, 1313].map(value => value * scale) },
      { text: '小荷AI医生', normalizedText: '小荷AI医生', confidence: 0.99, bounds: [68, 1681, 279, 1732].map(value => value * scale) },
    ],
  })

  const full = toutiaoOcrViewMoreTarget(recognition(1080, 2400), { width: 1080, height: 2400 })
  assert.deepEqual(full.bounds, [420, 1254, 656, 1313])
  assert.equal(full.summaryConfidence, 0.988)

  const currentHuawei = toutiaoOcrViewMoreTarget(recognition(1080, 2400, 1, '查看全文'), { width: 1080, height: 2400 })
  assert.deepEqual(currentHuawei.bounds, [420, 1254, 656, 1313])

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

test('新会话连续两次向上无变化且本题问题气泡完整可见才确认顶部', async () => {
  const frames = ['中部', '顶部', '顶部', '顶部']
  const touchpoints = []
  let initialCaptureCalls = 0
  const result = await scrollSingleQuestionSessionToTop({
    initialCapture: { frame: '底部' },
    capture: async () => { initialCaptureCalls += 1; return { frame: '不应读取' } },
    swipeUp: async attempt => { touchpoints.push(attempt % 2 ? 0.68 : 0.84); return {} },
    settle: async () => ({ frame: frames.shift(), xml: '<question text="本题" />' }),
    framesStable: async (before, after) => before === after,
    verifyTop: capture => capture.xml.includes('text="本题"'),
  })

  assert.equal(result.confirmed, true)
  assert.equal(result.swipes, 4)
  assert.equal(initialCaptureCalls, 0)
  assert.deepEqual(touchpoints, [0.84, 0.68, 0.84, 0.68])
})

test('ADB原图可在不同竖屏尺寸识别一行和三行小荷用户问题气泡', async () => {
  const cases = [
    { width: 720, height: 1600, bubble: [420, 260, 250, 64] },
    { width: 1080, height: 2400, bubble: [610, 410, 400, 210] },
  ]
  for (const sample of cases) {
    const frame = await sharp({ create: { width: sample.width, height: sample.height, channels: 3, background: '#ffffff' } })
      .composite([{
        input: await sharp({ create: { width: sample.bubble[2], height: sample.bubble[3], channels: 3, background: '#00c090' } }).png().toBuffer(),
        left: sample.bubble[0],
        top: sample.bubble[1],
      }])
      .png()
      .toBuffer()
    const detected = await detectXiaoheUserQuestionBubble(frame, [0, 333, 1080, 2001], { width: 1080, height: 2400 })
    assert.ok(detected, `${sample.width}x${sample.height} 应识别用户气泡`)
    assert.equal(detected.detectionMethod, 'adb_png_right_aligned_turquoise_bubble')
    assert.equal(detected.fullyVisible, true)
  }
})

test('ADB原图不会把右侧绿色小按钮或正文彩色细线误判为问题气泡', async () => {
  const patch = color => sharp({ create: { width: 90, height: 8, channels: 3, background: color } }).png().toBuffer()
  const frame = await sharp({ create: { width: 1080, height: 2400, channels: 3, background: '#ffffff' } })
    .composite([
      { input: await sharp({ create: { width: 72, height: 72, channels: 3, background: '#00c090' } }).png().toBuffer(), left: 950, top: 520 },
      { input: await patch('#00c090'), left: 760, top: 740 },
      { input: await patch('#00c090'), left: 760, top: 760 },
    ])
    .png()
    .toBuffer()
  assert.equal(await detectXiaoheUserQuestionBubble(frame, [0, 333, 1080, 2001], { width: 1080, height: 2400 }), null)
})

test('ADB原图不会把聊天区边界处的绿色气泡残片误判为完整问题气泡', async () => {
  const frame = await sharp({ create: { width: 1080, height: 2400, channels: 3, background: '#ffffff' } })
    .composite([{
      input: await sharp({ create: { width: 525, height: 13, channels: 3, background: '#00c090' } }).png().toBuffer(),
      left: 486,
      top: 333,
    }])
    .png()
    .toBuffer()
  assert.equal(await detectXiaoheUserQuestionBubble(frame, [0, 333, 1080, 2001], { width: 1080, height: 2400 }), null)
})

test('完整问题气泡跨出Compose聊天区上边界时仍记录为完全露出', async () => {
  const frame = await sharp({ create: { width: 1080, height: 2400, channels: 3, background: '#ffffff' } })
    .composite([{
      input: await sharp({ create: { width: 430, height: 120, channels: 3, background: '#00c090' } }).png().toBuffer(),
      left: 590,
      top: 210,
    }])
    .png()
    .toBuffer()
  const detected = await detectXiaoheUserQuestionBubble(frame, [0, 333, 1080, 2001], { width: 1080, height: 2400 })
  assert.ok(detected)
  assert.deepEqual(detected.physicalBounds, [590, 210, 1020, 330])
  assert.equal(detected.fullyVisible, true)
})

test('问题气泡被物理可见区域上边界裁切时记录为未完全露出', async () => {
  const frame = await sharp({ create: { width: 1080, height: 2400, channels: 3, background: '#ffffff' } })
    .composite([{
      input: await sharp({ create: { width: 430, height: 120, channels: 3, background: '#00c090' } }).png().toBuffer(),
      left: 590,
      top: 40,
    }])
    .png()
    .toBuffer()
  const detected = await detectXiaoheUserQuestionBubble(frame, [0, 333, 1080, 2001], { width: 1080, height: 2400 })
  assert.ok(detected)
  assert.equal(detected.physicalBounds[1], Math.floor(2400 * 0.032))
  assert.equal(detected.fullyVisible, false)
})

test('画面仍有动态提示时只要完整用户问题气泡出现就立即确认顶部', async () => {
  const frames = ['动态提示1', '动态提示2', '动态提示3']
  let stableChecks = 0
  const result = await scrollSingleQuestionSessionToTop({
    initialCapture: { frame: '回答中部' },
    capture: async () => ({ frame: '不应读取' }),
    swipeUp: async () => ({}),
    settle: async () => ({ frame: frames.shift() }),
    framesStable: async () => { stableChecks += 1; return false },
    verifyVisibleTop: capture => capture.frame === '动态提示1',
    verifyTop: () => false,
  })
  assert.equal(result.confirmed, true)
  assert.equal(result.visibleQuestionBubbleVerified, true)
  assert.equal(result.swipes, 1)
  assert.equal(stableChecks, 1)
})

test('新会话画面连续无变化但未看到本题问题气泡时拒绝误判到顶', async () => {
  const logs = []
  let swipes = 0
  await assert.rejects(scrollSingleQuestionSessionToTop({
    initialCapture: { frame: '回答尾部', xml: '<tail />' },
    capture: async () => ({ frame: '回答尾部', xml: '<tail />' }),
    swipeUp: async () => { swipes += 1; return {} },
    settle: async () => ({ frame: '回答尾部', xml: '<tail />' }),
    framesStable: async (before, after) => before === after,
    verifyTop: () => false,
    log: message => logs.push(message),
  }), /未确认完整问题气泡/)
  assert.equal(swipes, 4)
  assert.match(logs.join('\n'), /切换安全回顶手势/)
})

test('回顶手势被底部浮层拦截后切换安全触点并继续确认真实顶部', async () => {
  const frames = ['回答尾部', '回答尾部', '回答中部', '回答顶部', '回答顶部', '回答顶部']
  const contexts = []
  const logs = []
  const result = await scrollSingleQuestionSessionToTop({
    initialCapture: { frame: '回答尾部', xml: '<tail />' },
    capture: async () => ({ frame: '不应读取' }),
    swipeUp: async (attempt, context) => { contexts.push({ attempt, ...context }); return {} },
    settle: async () => {
      const frame = frames.shift()
      return { frame, xml: frame === '回答顶部' ? '<question text="本题" />' : '<tail />' }
    },
    framesStable: async (before, after) => before === after,
    verifyTop: capture => capture.xml.includes('text="本题"'),
    log: message => logs.push(message),
  })

  assert.equal(result.confirmed, true)
  assert.equal(result.swipes, 6)
  assert.deepEqual(contexts.map(item => item.unverifiedBoundaries), [0, 0, 1, 1, 1, 1])
  assert.match(logs.join('\n'), /切换安全回顶手势/)
})

test('回顶画面已静止但Compose层级暂时稀疏时有限重读确认本题气泡', async () => {
  const sparse = '<hierarchy><node text="在这里查看「历史对话」" bounds="[0,300][1080,400]" /></hierarchy>'
  const complete = '<hierarchy><node class="android.view.View" bounds="[0,333][1080,2001]">'
    + '<node class="android.view.View" bounds="[55,549][1025,687]"><node class="android.view.View" bounds="[549,552][981,684]">'
    + '<node class="android.widget.TextView" text="体重超重吃什么药" content-desc="体重超重吃什么药" visible-to-user="true" bounds="[549,582][981,654]" />'
    + '</node></node></node></hierarchy>'
  const capture = { frame: '顶部画面', xml: sparse }
  const reads = [sparse, complete]
  let delays = 0

  const verified = await confirmQuestionAtTop({
    capture,
    question: '体重超重吃什么药',
    chatBounds: [0, 333, 1080, 2001],
    source: async () => reads.shift(),
    delay: async () => { delays += 1 },
  })

  assert.equal(verified, true)
  assert.equal(delays, 2)
  assert.equal(capture.xml, complete)
})

test('有限重读仍为稀疏层级时只重启一次sidecar再确认本题气泡', async () => {
  const sparse = '<hierarchy><node package="com.aurora.xiaohe.aidoctor" text="在这里查看「历史对话」" bounds="[0,300][1080,400]" /></hierarchy>'
  const complete = '<hierarchy><node class="android.view.View" bounds="[0,333][1080,2001]">'
    + '<node class="android.view.View" bounds="[55,549][1025,687]"><node class="android.view.View" bounds="[549,552][981,684]">'
    + '<node class="android.widget.TextView" text="体重超重吃什么药" content-desc="体重超重吃什么药" visible-to-user="true" bounds="[549,582][981,654]" />'
    + '</node></node></node></hierarchy>'
  const capture = { frame: '顶部画面', xml: sparse }
  let reads = 0
  let recoveries = 0

  const verified = await confirmQuestionAtTop({
    capture,
    question: '体重超重吃什么药',
    chatBounds: [0, 333, 1080, 2001],
    source: async () => { reads += 1; return sparse },
    recoverSource: async () => { recoveries += 1; return complete },
    delay: async () => {},
  })

  assert.equal(verified, true)
  assert.equal(reads, 3)
  assert.equal(recoveries, 1)
  assert.equal(capture.xml, complete)
})

test('sidecar重启后的稀疏首帧继续有限轮询直到问题气泡恢复', async () => {
  const sparse = '<hierarchy><node package="com.aurora.xiaohe.aidoctor" bounds="[0,0][1080,2400]" /></hierarchy>'
  const complete = '<hierarchy><node class="android.view.View" bounds="[0,333][1080,2001]">'
    + '<node class="android.view.View" bounds="[55,549][1025,687]"><node class="android.view.View" bounds="[549,552][981,684]">'
    + '<node class="android.widget.TextView" text="体重超重吃什么药" content-desc="体重超重吃什么药" visible-to-user="true" bounds="[549,582][981,654]" />'
    + '</node></node></node></hierarchy>'
  const capture = { frame: '顶部画面', xml: sparse }
  const normalReads = [sparse, sparse, sparse, sparse, complete]
  let recoveries = 0
  let delays = 0

  const verified = await confirmQuestionAtTop({
    capture,
    question: '体重超重吃什么药',
    chatBounds: [0, 333, 1080, 2001],
    source: async () => normalReads.shift(),
    recoverSource: async () => { recoveries += 1; return sparse },
    delay: async () => { delays += 1 },
  })

  assert.equal(verified, true)
  assert.equal(recoveries, 1)
  assert.equal(delays, 5)
  assert.equal(capture.xml, complete)
})

test('小荷新会话复用到底确认帧并用事件驱动稳定截图回顶', async () => {
  const width = 240
  const viewportHeight = 360
  const shift = 120
  const raw = Buffer.alloc(width * (viewportHeight + shift) * 3)
  for (let y = 0; y < viewportHeight + shift; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3
      const value = 35 + ((y * 31 + x * 17 + (x * y) % 101) % 190)
      raw[offset] = value
      raw[offset + 1] = (value + 37) % 240
      raw[offset + 2] = (value + 73) % 240
    }
  }
  const content = sharp(raw, { raw: { width, height: viewportHeight + shift, channels: 3 } })
  const top = await content.clone().extract({ left: 0, top: 0, width, height: viewportHeight }).png().toBuffer()
  const bottom = await content.clone().extract({ left: 0, top: shift, width, height: viewportHeight }).png().toBuffer()
  const full = await sharp({ create: { width, height: 500, channels: 3, background: '#f4f4f4' } }).png().toBuffer()
  const bottomXml = '<hierarchy><node class="android.view.View" scrollable="true" visible-to-user="true" bounds="[0,80][240,440]">'
    + '<node class="android.view.View" clickable="true" bounds="[7,80][233,130]">'
    + '<node class="android.widget.TextView" text="对我的回答满意吗？" bounds="[12,84][228,105]" />'
    + '<node class="android.widget.TextView" text="期待你的反馈" bounds="[12,106][228,126]" />'
    + '</node></node></hierarchy>'
  const topXml = '<hierarchy><node class="android.view.View" scrollable="true" visible-to-user="true" bounds="[0,80][240,440]">'
    + '<node class="android.view.View" bounds="[12,120][228,200]"><node class="android.view.View" bounds="[120,122][220,198]">'
    + '<node class="android.widget.TextView" text="测试问题" content-desc="测试问题" visible-to-user="true" bounds="[122,140][218,180]" />'
    + '</node></node></node></hierarchy>'
  const currentXml = () => position === 'top' ? topXml : bottomXml
  let position = 'top'
  let observedStableCaptures = 0
  let strictStableCaptures = 0
  const upwardOptions = []
  const upwardFractions = []
  const capture = createReplyCapture({
    log: () => {},
    source: async () => currentXml(),
    screenshot: async () => full,
    windowSize: async () => ({ width, height: 500 }),
    waitForVisualQuiet: async () => {},
    waitForFinalVisualQuiet: async () => {},
    waitForStableReplyRegion: async (_bounds, _timeout, options = {}) => {
      observedStableCaptures += 1
      if (position === 'top' && upwardOptions.length > 0) assert.ok(options.settleSince || observedStableCaptures > 3)
      return { frame: position === 'top' ? top : bottom, xml: currentXml(), stable: true, attempts: 1, observer: true }
    },
    waitForStableReplyRegionDirect: async () => {
      strictStableCaptures += 1
      throw new Error('正常回顶不应使用双PNG直接夹心')
    },
    captureReplyRegionSnapshot: async () => ({
      frame: position === 'top' ? top : bottom,
      xml: currentXml(),
      stable: true,
      attempts: 1,
    }),
    swipeChat: async (_bounds, direction, fraction, options = {}) => {
      position = direction === 'up' ? 'top' : 'bottom'
      if (direction === 'up') {
        upwardOptions.push(options)
        upwardFractions.push(fraction)
      }
      return {
        distance: shift,
        canScrollMore: null,
        activityMark: options.eventDrivenSettle ? { frameCount: upwardOptions.length } : null,
        x: 204,
        durationMs: 75,
      }
    },
    tap: async () => {},
    captureReferenceProductsAtTrigger: async () => { throw new Error('不应采集药品') },
    ocr: {
      recognize: async () => ({ image: { width, height: 500 }, results: [], engine: 'test', elapsedMs: 0 }),
    },
    setLastOcrDiagnostic: () => {},
    xiaoheCompletionConfirmationOptions: {
      quietMs: 0,
      probeInterval: 0,
      timeout: 1_000,
      delay: async () => {},
    },
  })

  const result = await capture.captureFullReplyFrames('测试问题', 30, { singleQuestionSession: true })

  assert.equal(result.frames.length, 2)
  assert.equal(result.transitions.length, 1)
  assert.equal(result.captureMetadata.reply_completion_confirmed_before_capture, true)
  assert.equal(result.captureMetadata.reply_top_navigation_method, 'new_session_scroll_boundary_and_exact_question_bubble')
  assert.equal(result.captureMetadata.reply_question_structure_validation_required, true)
  assert.equal(strictStableCaptures, 0)
  assert.ok(observedStableCaptures >= 4)
  assert.ok(upwardOptions.length >= 3)
  assert.ok(upwardOptions.every(options => options.eventDrivenSettle === true))
  assert.ok(upwardFractions.every(fraction => fraction === 0.55))
})

test('正式截图前以持续不可滚动和画面稳定确认回答已完整生成', async () => {
  let now = 0
  const frames = ['生成中', '新内容', '底部', '底部', '底部', '底部', '底部']
  const result = await confirmPersistentScrollEnd({
    capture: async () => ({ frame: frames.shift(), xml: '<stable />' }),
    swipeDown: async () => ({}),
    settle: async () => ({ frame: frames.shift() || '底部', xml: '<stable />' }),
    framesStable: async (before, after) => before === after,
    quietMs: 900,
    probeInterval: 300,
    delay: async milliseconds => { now += milliseconds },
    now: () => now,
  })

  assert.equal(result.confirmed, true)
  assert.equal(result.resets, 2)
  assert.ok(result.probes >= 5)
  assert.ok(result.quietMs >= 900)
})

test('抖音回答完成事件记录平台、稳定时长和探测重置次数', () => {
  assert.deepEqual(
    classifyAutomationLog('waiting: 抖音小荷AI全文底部已持续6秒不可继续滚动且内容无变化，确认生成完成（探测=18，重置=2）'),
    {
      event: 'reply_completion_confirmed',
      category: 'waiting',
      details: { platform: '抖音', quiet_seconds: 6, probes: 18, resets: 2, method: 'persistent_scroll_end' },
    },
  )
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

test('scrcpy静止后慢速ADB截图使用独立确认预算且不重复降级', async () => {
  let now = 0
  const events = []
  const observer = {
    waitForSettleSince: async (_mark, options) => {
      events.push(['settle', options.hardTimeout])
      now += 1_550
      return { settled: true, activity: true }
    },
    waitForNoActivity: async options => {
      events.push(['confirm', options])
      now += options.minWaitMs
      return { quiet: true }
    },
    mark: () => ({ activityFrameCount: 5 }),
  }
  const result = await captureStableObserved({
    observer,
    settleSince: { at: 0, activityFrameCount: 1 },
    capture: async () => {
      events.push(['capture'])
      now += 1_500
      return Buffer.from('png')
    },
    hierarchy: async () => {
      events.push(['hierarchy'])
      now += 200
      return '<hierarchy />'
    },
    hierarchyLoading: () => false,
    now: () => now,
  }, 3_200)

  assert.equal(result.stable, true)
  assert.ok(result.frame.equals(Buffer.from('png')))
  assert.deepEqual(events, [
    ['settle', 2_500],
    ['hierarchy'],
    ['capture'],
    ['confirm', { timeout: 800, quietMs: 300, minWaitMs: 300 }],
  ])
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
  assert.equal(result.reason, 'post_capture_confirmation_timeout')
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
  assert.deepEqual(observerRegionFallbackOptions({ reason: 'post_capture_confirmation_timeout', frame }), {
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

test('新会话顶部问题必须规范化后完整相等，不能只匹配公共前缀', () => {
  const bubble = (text, bounds = '[700,260][1020,340]') => '<hierarchy><node class="android.view.View" bounds="[0,200][1080,1800]">'
    + `<node class="android.view.View" bounds="[0,240][1080,460]"><node class="android.view.View" bounds="[690,240][1030,460]"><node class="android.widget.TextView" text="${text}" content-desc="${text}" visible-to-user="true" bounds="${bounds}" />`
    + '</node></node></node></hierarchy>'
  assert.equal(questionVisibleExact(bubble('奥利司他有副作用吗？'), '奥利司他有副作用吗', CHAT_BOUNDS), true)
  assert.equal(questionVisibleExact(bubble('奥利司他有副作用吗，需要停药吗'), '奥利司他有副作用吗', CHAT_BOUNDS), false)
})

test('720宽竖屏中完整可见且精确匹配的问题气泡可以确认顶部', () => {
  const bounds = [0, 240, 720, 1320]
  const xml = '<hierarchy><node class="android.view.View" bounds="[0,240][720,1320]">'
    + '<node class="android.view.View" bounds="[36,360][684,480]"><node class="android.view.View" bounds="[366,360][654,480]">'
    + '<node class="android.widget.TextView" text="体重超重吃什么药" content-desc="体重超重吃什么药" visible-to-user="true" bounds="[366,386][654,454]" />'
    + '</node></node></node></hierarchy>'
  assert.equal(questionVisibleExact(xml, '体重超重吃什么药', bounds), true)
})

test('问题文字完整但气泡父容器被聊天区裁切时不能确认顶部', () => {
  const bounds = [0, 240, 720, 1320]
  const xml = '<hierarchy><node class="android.view.View" bounds="[0,240][720,1320]">'
    + '<node class="android.view.View" bounds="[36,220][684,390]"><node class="android.view.View" bounds="[366,220][654,390]">'
    + '<node class="android.widget.TextView" text="体重超重吃什么药" content-desc="体重超重吃什么药" visible-to-user="true" bounds="[366,280][654,350]" />'
    + '</node></node></node></hierarchy>'
  assert.equal(questionVisibleExact(xml, '体重超重吃什么药', bounds), false)
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

test('当前真机较宽的问题气泡仍可在响应超时前确认对应问题', () => {
  const xml = '<hierarchy><node class="android.view.View" bounds="[0,333][1080,2010]">'
    + '<node class="android.view.View" bounds="[55,439][1025,577]">'
    + '<node class="android.view.View" bounds="[225,442][981,574]">'
    + '<node class="android.widget.TextView" text="类风湿性关节炎用什么中成药？" content-desc="类风湿性关节炎用什么中成药？" visible-to-user="true" bounds="[225,472][981,544]" />'
    + '</node></node></node></hierarchy>'
  assert.equal(currentQuestionText(xml, [0, 384, 1080, 1968]), '类风湿性关节炎用什么中成药？')
})

test('仅在聊天区同时出现响应超时提示和可点击重试按钮时识别重试目标', () => {
  const physical1080 = '<hierarchy><node package="com.aurora.xiaohe.aidoctor" class="android.view.View" bounds="[0,200][1080,2200]">'
    + '<node package="com.aurora.xiaohe.aidoctor" class="android.widget.TextView" text="响应超时，点击重新生成回答。" bounds="[55,643][811,726]" />'
    + '<node package="com.aurora.xiaohe.aidoctor" class="android.widget.Button" text="重试" content-desc="重试" clickable="true" bounds="[55,754][1025,887]" />'
    + '</node></hierarchy>'
  assert.deepEqual(responseTimeoutRetryTarget(physical1080, [0, 200, 1080, 2200]), {
    promptBounds: [55, 643, 811, 726],
    retryBounds: [55, 754, 1025, 887],
    tap: [540, 820],
  })

  const logical720 = '<hierarchy><node package="com.aurora.xiaohe.aidoctor" class="android.view.View" bounds="[0,120][720,1460]">'
    + '<node package="com.aurora.xiaohe.aidoctor" class="android.widget.TextView" content-desc="响应超时，请重新生成回答" bounds="[36,420][542,478]" />'
    + '<node package="com.aurora.xiaohe.aidoctor" class="android.widget.Button" content-desc="重试" clickable="true" bounds="[36,495][684,585]" />'
    + '</node></hierarchy>'
  assert.deepEqual(responseTimeoutRetryTarget(logical720, [0, 120, 720, 1460]), {
    promptBounds: [36, 420, 542, 478],
    retryBounds: [36, 495, 684, 585],
    tap: [360, 540],
  })

  const unrelatedRetry = '<hierarchy><node class="android.widget.Button" text="重试" clickable="true" bounds="[40,500][680,590]" /></hierarchy>'
  assert.equal(responseTimeoutRetryTarget(unrelatedRetry, [0, 120, 720, 1460]), null)
})

test('当前已有回答响应超时时刷新坐标并且只点击一次重试', async () => {
  const timeoutXml = '<hierarchy><node package="com.aurora.xiaohe.aidoctor" class="android.widget.TextView" text="响应超时，点击重新生成回答。" bounds="[55,643][811,726]" />'
    + '<node package="com.aurora.xiaohe.aidoctor" class="android.widget.Button" text="重试" clickable="true" bounds="[55,754][1025,887]" /></hierarchy>'
  const stableXml = '<hierarchy><node package="com.aurora.xiaohe.aidoctor" class="android.widget.TextView" text="回答正文" bounds="[55,643][1025,887]" /></hierarchy>'
  const events = []
  const result = await recoverTimedOutExistingReply({
    xml: timeoutXml,
    chatBounds: [0, 200, 1080, 2200],
    timeout: 90_000,
    source: async () => { events.push('source'); return timeoutXml },
    tap: async (x, y) => { events.push(['tap', x, y]) },
    waitForStableReply: async (timeout, options) => {
      events.push(['wait', timeout, Number.isFinite(options.startedAt)])
      return { status: 'stable', xml: stableXml }
    },
    log: message => events.push(['log', message]),
    record: async (event, details) => events.push(['record', event, details.retry_bounds || null]),
  })

  assert.equal(result.xml, stableXml)
  assert.deepEqual(result.meta, {
    existing_reply_timeout_detected: true,
    existing_reply_retry_performed: true,
    existing_reply_retry_attempts: 1,
    existing_reply_retry_succeeded: true,
  })
  assert.deepEqual(events.filter(event => Array.isArray(event) && event[0] === 'tap'), [['tap', 540, 820]])
  assert.equal(events.some(event => Array.isArray(event) && event[1] === 'existing_reply_timeout_detected'), true)
  assert.equal(events.some(event => Array.isArray(event) && event[1] === 'existing_reply_timeout_retry_completed'), true)
})

test('当前已有回答唯一一次重试后仍响应超时则明确失败且不二次点击', async () => {
  const timeoutXml = '<hierarchy><node class="android.widget.TextView" text="响应超时，点击重新生成回答。" bounds="[36,420][542,478]" />'
    + '<node class="android.widget.Button" content-desc="重试" clickable="true" bounds="[36,495][684,585]" /></hierarchy>'
  let taps = 0
  await assert.rejects(recoverTimedOutExistingReply({
    xml: timeoutXml,
    chatBounds: [0, 120, 720, 1460],
    timeout: 1_000,
    source: async () => timeoutXml,
    tap: async () => { taps += 1 },
    waitForStableReply: async () => ({ status: 'stable', xml: timeoutXml }),
  }), /唯一一次重试后仍显示响应超时/)
  assert.equal(taps, 1)
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

test('引用资料高度比较只绑定包含OCR标题的同一张Compose卡片', () => {
  const xml = '<hierarchy>'
    + '<androidx.compose.ui.viewinterop.ViewFactoryHolder class="androidx.compose.ui.viewinterop.ViewFactoryHolder" displayed="true" bounds="[20,250][1060,620]" />'
    + '<androidx.compose.ui.viewinterop.ViewFactoryHolder class="androidx.compose.ui.viewinterop.ViewFactoryHolder" displayed="true" bounds="[40,680][1040,840]" />'
    + '</hierarchy>'
  assert.deepEqual(evidencePanelBoundsForTitle(xml, [64, 705, 774, 761], 100), [40, 680, 1040, 840])
})

test('同一卡片明显增高且标题变为上箭头时确认引用资料展开', async () => {
  const collapsedXml = '<hierarchy><androidx.compose.ui.viewinterop.ViewFactoryHolder class="androidx.compose.ui.viewinterop.ViewFactoryHolder" displayed="true" bounds="[40,340][1040,470]" /></hierarchy>'
  const expandedXml = '<hierarchy><androidx.compose.ui.viewinterop.ViewFactoryHolder class="androidx.compose.ui.viewinterop.ViewFactoryHolder" displayed="true" bounds="[40,340][1040,780]" /></hierarchy>'
  const collapsed = {
    engine: 'rapidocr', elapsedMs: 400, image: { width: 1080, height: 2400 },
    results: [{ text: '参考9篇医学文献和1篇药品说明v', normalizedText: '参考9篇医学文献和1篇药品说明v', confidence: 0.999, bounds: [64, 375, 774, 427] }],
  }
  const expanded = {
    ...collapsed,
    results: [{ text: '参考9篇医学文献和1篇药品说明^', normalizedText: '参考9篇医学文献和1篇药品说明^', confidence: 0.999, bounds: [64, 375, 774, 427] }],
  }
  const recognitions = [collapsed, expanded]
  let taps = 0
  const result = await prepareEmbeddedEvidence({
    screenshot: async () => Buffer.from('confirmation'),
    ocr: { recognize: async () => recognitions.shift() },
    windowSize: async () => ({ width: 1080, height: 2400 }),
    initialCapture: { frame: Buffer.from('initial'), xml: collapsedXml },
    tap: async () => { taps += 1 },
    delay: async () => {},
    waitForStable: async () => ({ frame: Buffer.from('expanded'), xml: expandedXml }),
    log: () => {},
  }, CHAT_BOUNDS)
  assert.equal(result.expanded, true)
  assert.equal(taps, 1)
})

test('初始聊天区裁剪帧不参与引用点击坐标换算', async () => {
  const collapsed = {
    engine: 'rapidocr', elapsedMs: 300, image: { width: 1080, height: 2400 },
    results: [{ text: '参考1篇医学文献', normalizedText: '参考1篇医学文献', confidence: 0.999, bounds: [64, 707, 480, 760] }],
  }
  const expanded = {
    ...collapsed,
    results: [{ text: '参考1篇医学文献^', normalizedText: '参考1篇医学文献^', confidence: 0.999, bounds: [64, 707, 500, 760] }],
  }
  const recognitions = [collapsed, expanded]
  const taps = []
  const result = await prepareEmbeddedEvidence({
    screenshot: async () => Buffer.from('full-screen'),
    ocr: { recognize: async () => recognitions.shift() },
    windowSize: async () => ({ width: 1080, height: 2400 }),
    initialCapture: { frame: Buffer.from('cropped-chat-frame'), xml: '<hierarchy />' },
    tap: async (x, y) => { taps.push([x, y]) },
    delay: async () => {},
    waitForStable: async () => ({ frame: Buffer.from('stable'), xml: '<hierarchy />' }),
    log: () => {},
  }, CHAT_BOUNDS)

  assert.deepEqual(taps, [[272, 733.5]])
  assert.equal(result.expanded, true)
})

test('明确上箭头在Compose卡片层级缺失时也立即确认展开', async () => {
  const recognitions = [
    {
      engine: 'rapidocr', elapsedMs: 300, image: { width: 1080, height: 2400 },
      results: [{ text: '参考1篇医学文献', normalizedText: '参考1篇医学文献', confidence: 0.999, bounds: [64, 707, 480, 760] }],
    },
    {
      engine: 'rapidocr', elapsedMs: 300, image: { width: 1080, height: 2400 },
      results: [{ text: '参考1篇医学文献^', normalizedText: '参考1篇医学文献^', confidence: 0.999, bounds: [64, 707, 500, 760] }],
    },
  ]
  let taps = 0
  const result = await prepareEmbeddedEvidence({
    screenshot: async () => Buffer.from('full-screen'),
    ocr: { recognize: async () => recognitions.shift() },
    windowSize: async () => ({ width: 1080, height: 2400 }),
    initialCapture: { frame: Buffer.from('cropped'), xml: '<hierarchy />' },
    tap: async () => { taps += 1 },
    delay: async () => {},
    waitForStable: async () => ({ frame: Buffer.from('stable'), xml: '<hierarchy />' }),
    log: () => {},
  }, CHAT_BOUNDS)

  assert.equal(taps, 1)
  assert.equal(result.expanded, true)
})

test('卡片增高但没有上箭头或紧邻资料行时不能误判展开', async () => {
  const collapsedXml = '<hierarchy><androidx.compose.ui.viewinterop.ViewFactoryHolder class="androidx.compose.ui.viewinterop.ViewFactoryHolder" displayed="true" bounds="[40,340][1040,470]" /></hierarchy>'
  const expandedXml = '<hierarchy><androidx.compose.ui.viewinterop.ViewFactoryHolder class="androidx.compose.ui.viewinterop.ViewFactoryHolder" displayed="true" bounds="[40,340][1040,780]" /></hierarchy>'
  const recognition = {
    engine: 'rapidocr', elapsedMs: 400, image: { width: 1080, height: 2400 },
    results: [{ text: '参考9篇医学文献和1篇药品说明v', normalizedText: '参考9篇医学文献和1篇药品说明v', confidence: 0.999, bounds: [64, 375, 774, 427] }],
  }
  let taps = 0
  await assert.rejects(prepareEmbeddedEvidence({
    screenshot: async () => Buffer.from('confirmation'),
    ocr: { recognize: async () => recognition },
    windowSize: async () => ({ width: 1080, height: 2400 }),
    initialCapture: { frame: Buffer.from('initial'), xml: collapsedXml },
    tap: async () => { taps += 1 },
    delay: async () => {},
    waitForStable: async () => ({ frame: Buffer.from('grown'), xml: expandedXml }),
    log: () => {},
  }, CHAT_BOUNDS), /未确认资料展开/)
  assert.equal(taps, 1)
})

test('到顶后通过OCR识别引用资料标题并按物理与逻辑尺寸映射点击', async () => {
  const expanded = '<hierarchy><androidx.compose.ui.viewinterop.ViewFactoryHolder class="androidx.compose.ui.viewinterop.ViewFactoryHolder" displayed="true" bounds="[0,466][720,900]" /></hierarchy>'
  const events = []
  const capture = { frame: Buffer.from('expanded-frame'), xml: expanded, stable: true }
  let ocrCalls = 0
  const result = await prepareEmbeddedEvidence({
    screenshot: async () => { events.push('screenshot'); return Buffer.from('raw-screen') },
    ocr: {
      recognize: async () => {
        events.push('ocr')
        ocrCalls += 1
        return {
          engine: 'rapidocr',
          elapsedMs: 420,
          image: { width: 1080, height: 2400 },
          results: [
            {
              text: '根据 3 篇资料为你总结',
              normalizedText: '根据3篇资料为你总结',
              confidence: 0.998,
              bounds: [90, 600, 600, 660],
            },
            ...(ocrCalls > 1 ? [{
              text: '医学文献',
              normalizedText: '医学文献',
              confidence: 0.999,
              bounds: [850, 700, 1000, 750],
            }] : []),
          ],
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
    'delay',
    ['tap', 230, 420],
    'delay',
    'stable',
    'screenshot',
    'ocr',
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

test('新版参考医学文献标题可在不同物理与逻辑尺寸下严格识别', () => {
  const recognition = {
    image: { width: 1080, height: 2400 },
    results: [
      { text: '参考 1 篇医学文献', normalizedText: '参考1篇医学文献', confidence: 0.9999, bounds: [65, 818, 479, 868] },
      { text: '正文中参考医学文献后再决定', normalizedText: '正文中参考医学文献后再决定', confidence: 0.9999, bounds: [65, 1100, 800, 1150] },
    ],
  }

  const target = evidenceSummaryOcrTarget(recognition, { width: 720, height: 1600 }, [0, 222, 720, 1334])

  assert.equal(target.text, '参考 1 篇医学文献')
  assert.equal(target.variant, 'medical_references')
  assert.deepEqual(target.logicalBounds, [43, 545, 319, 579])
})

test('历史药品题的参考药品说明书标题可识别并确认展开箭头', () => {
  const recognition = {
    image: { width: 1080, height: 2400 },
    results: [
      { text: '参考 1 篇药品说明书', normalizedText: '参考1篇药品说明书', confidence: 0.9997, bounds: [66, 375, 526, 426] },
      { text: '正文提到药品说明书', normalizedText: '正文提到药品说明书', confidence: 0.999, bounds: [66, 800, 500, 850] },
    ],
  }
  const target = evidenceSummaryOcrTarget(recognition, { width: 720, height: 1600 }, [0, 200, 720, 1400])

  assert.equal(target.text, '参考 1 篇药品说明书')
  assert.equal(target.variant, 'drug_instructions')
  assert.deepEqual(target.logicalBounds, [44, 250, 351, 284])
  assert.equal(evidenceSummaryExpandedByOcr(recognition, target), false)
  assert.equal(evidenceSummaryExpandedByOcr(recognition, {
    ...target,
    normalizedText: '参考1篇药品说明书^',
  }), true)
})

test('真实组合标题可识别医学文献与药品说明并拒绝相似正文', () => {
  const recognition = {
    image: { width: 1080, height: 2400 },
    results: [
      { text: '参考9篇医学文献和1篇药品说明', normalizedText: '参考9篇医学文献和1篇药品说明', confidence: 0.99978, bounds: [64, 375, 774, 427] },
      { text: '参考9篇医学文献说明该药可用于急救', normalizedText: '参考9篇医学文献说明该药可用于急救', confidence: 0.999, bounds: [64, 600, 900, 652] },
    ],
  }
  const target = evidenceSummaryOcrTarget(recognition, { width: 1080, height: 2400 }, CHAT_BOUNDS)
  assert.equal(target.text, '参考9篇医学文献和1篇药品说明')
  assert.equal(target.variant, 'combined_references_and_instructions')

  const bodyOnly = { ...recognition, results: [recognition.results[1]] }
  assert.equal(evidenceSummaryOcrTarget(bodyOnly, { width: 1080, height: 2400 }, CHAT_BOUNDS), null)
  assert.equal(suspiciousEvidenceSummaryOcrTarget(bodyOnly, { width: 1080, height: 2400 }, CHAT_BOUNDS)?.text, recognition.results[1].text)
})

test('顶部出现未知参考资料标题时明确失败而不是按无引用继续截图', async () => {
  const recognition = {
    engine: 'rapidocr',
    elapsedMs: 500,
    image: { width: 1080, height: 2400 },
    results: [{
      text: '参考3篇医学文献另附1项药品信息',
      normalizedText: '参考3篇医学文献另附1项药品信息',
      confidence: 0.999,
      bounds: [64, 375, 900, 427],
    }],
  }
  let stableCalls = 0
  await assert.rejects(prepareEmbeddedEvidence({
    screenshot: async () => Buffer.from('screen'),
    ocr: { recognize: async () => recognition },
    windowSize: async () => ({ width: 1080, height: 2400 }),
    tap: async () => {},
    delay: async () => {},
    waitForStable: async () => { stableCalls += 1; return { frame: Buffer.from('stable'), xml: '' } },
    log: () => {},
  }, CHAT_BOUNDS), /疑似引用资料标题/)
  assert.equal(stableCalls, 0)
})

test('新版医学文献标题通过上箭头或同排文献来源确认已展开', () => {
  const base = {
    image: { width: 1080, height: 2400 },
    results: [],
  }
  const arrowTarget = {
    normalizedText: '参考1篇医学文献^',
    variant: 'medical_references',
    physicalBounds: [65, 818, 479, 868],
  }
  assert.equal(evidenceSummaryExpandedByOcr(base, arrowTarget), true)
  assert.equal(evidenceSummaryExpandedByOcr(base, {
    ...arrowTarget,
    normalizedText: '参考1篇医学文献へ',
  }), true)

  const rowTarget = { ...arrowTarget, normalizedText: '参考1篇医学文献' }
  const withCitationRow = {
    ...base,
    results: [
      { text: '1. 肥胖患者的长期体重管理及药物临...', normalizedText: '1.肥胖患者的长期体重管理及药物临...', confidence: 0.991, bounds: [66, 903, 765, 951] },
      { text: '中华医学会', normalizedText: '中华医学会', confidence: 0.999, bounds: [823, 903, 1017, 953] },
    ],
  }
  assert.equal(evidenceSummaryExpandedByOcr(withCitationRow, rowTarget), true)
})

test('展开后标题单次OCR漏识别时沿用点击前位置复核紧邻文献行', async () => {
  const recognitions = [
    {
      engine: 'rapidocr',
      elapsedMs: 500,
      image: { width: 1080, height: 2400 },
      results: [{
        text: '参考1篇医学文献',
        normalizedText: '参考1篇医学文献',
        confidence: 0.999,
        bounds: [62, 705, 480, 761],
      }],
    },
    {
      engine: 'rapidocr',
      elapsedMs: 500,
      image: { width: 1080, height: 2400 },
      results: [{
        text: '1. 中国脑血管病临床管理指南（第2版）（节选）..',
        normalizedText: '1.中国脑血管病临床管理指南(第2版)(节选)..',
        confidence: 0.96153,
        bounds: [63, 791, 1002, 842],
      }],
    },
  ]
  let taps = 0
  const capture = { frame: Buffer.from('expanded'), xml: '<hierarchy />', stable: true }
  const result = await prepareEmbeddedEvidence({
    screenshot: async () => Buffer.from('screen'),
    ocr: { recognize: async () => recognitions.shift() },
    windowSize: async () => ({ width: 1080, height: 2400 }),
    tap: async () => { taps += 1 },
    delay: async () => {},
    waitForStable: async () => capture,
    log: () => {},
  }, CHAT_BOUNDS)

  assert.equal(result.expanded, true)
  assert.equal(taps, 1)
})

test('OCR将文献标题与右侧来源标签合并为一行时仍确认资料已展开', () => {
  const target = {
    normalizedText: '参考1篇医学文献',
    variant: 'medical_references',
    physicalBounds: [62, 705, 481, 761],
  }
  const recognition = {
    image: { width: 1080, height: 2400 },
    results: [{
      text: '1. Ramulus mori (Sangzhi) alkaloids reg... 国际研究',
      normalizedText: '1.Ramulusmori(Sangzhi)alkaloidsreg...国际研究',
      confidence: 0.9898,
      bounds: [62, 792, 1018, 846],
    }],
  }

  assert.equal(evidenceSummaryExpandedByOcr(recognition, target), true)
})

test('展开文献只有紧邻标题的整行截断条目时仍可确认', () => {
  const target = {
    normalizedText: '参考1篇医学文献',
    variant: 'medical_references',
    physicalBounds: [62, 705, 481, 761],
  }
  const recognition = {
    image: { width: 1080, height: 2400 },
    results: [{
      text: '1. 中国脑血管病临床管理指南（第2版）（节选）..',
      normalizedText: '1.中国脑血管病临床管理指南(第2版)(节选)..',
      confidence: 0.96153,
      bounds: [63, 791, 1002, 842],
    }],
  }

  assert.equal(evidenceSummaryExpandedByOcr(recognition, target), true)
})

test('组合引用卡无来源标签且OCR漏掉上箭头时用紧邻连续文献行确认展开', () => {
  const target = {
    normalizedText: '参考9篇医学文献和1篇药品说明',
    variant: 'combined_references_and_instructions',
    physicalBounds: [63, 707, 802, 760],
  }
  const recognition = {
    image: { width: 1080, height: 2400 },
    results: [
      { text: '1. 糖尿病心肌病病证结合诊疗指南', normalizedText: '1.糖尿病心肌病病证结合诊疗指南', confidence: 0.999, bounds: [63, 792, 700, 840] },
      { text: '2. 急性心肌梗死中西医结合诊疗指南', normalizedText: '2.急性心肌梗死中西医结合诊疗指南', confidence: 0.999, bounds: [63, 855, 740, 903] },
    ],
  }
  assert.equal(evidenceSummaryExpandedByOcr(recognition, target), true)
})

test('紧邻标题的超宽编号文献行即使OCR漏掉省略号仍可确认', () => {
  const target = {
    normalizedText: '参考1篇医学文献',
    variant: 'medical_references',
    physicalBounds: [63, 706, 478, 759],
  }
  const recognition = {
    image: { width: 1080, height: 2400 },
    results: [{
      text: '1. 盐酸二甲双胍肠溶胶囊对患糖尿病肥胖症者ISI、',
      normalizedText: '1.盐酸二甲双胍肠溶胶囊对患糖尿病肥胖症者ISI、',
      confidence: 0.98302,
      bounds: [66, 792, 983, 840],
    }],
  }

  assert.equal(evidenceSummaryExpandedByOcr(recognition, target), true)
})

test('紧邻标题的完整指南题名无需省略号或来源标签也可确认展开', () => {
  for (const scale of [1, 2 / 3]) {
    const target = {
      normalizedText: '参考1篇医学文献',
      variant: 'medical_references',
      physicalBounds: [62, 704, 479, 760].map(value => Math.round(value * scale)),
    }
    const recognition = {
      image: { width: Math.round(1080 * scale), height: Math.round(2400 * scale) },
      results: [{
        text: '1. 中国超重/肥胖医学营养治疗指南(2021)',
        normalizedText: '1.中国超重/肥胖医学营养治疗指南(2021)',
        confidence: 0.99274,
        bounds: [65, 793, 831, 842].map(value => Math.round(value * scale)),
      }],
    }

    assert.equal(evidenceSummaryExpandedByOcr(recognition, target), true)
  }
})

test('紧邻标题的完整研究进展题名无需来源标签也可确认展开', () => {
  const target = {
    normalizedText: '参考1篇医学文献',
    variant: 'medical_references',
    physicalBounds: [63, 816, 480, 869],
  }
  const recognition = {
    image: { width: 1080, height: 2400 },
    results: [{
      text: '1. 替扎尼定预防治疗慢性每日头痛的研究进展',
      normalizedText: '1.替扎尼定预防治疗慢性每日头痛的研究进展',
      confidence: 0.9926,
      bounds: [66, 903, 901, 951],
    }],
  }

  assert.equal(evidenceSummaryExpandedByOcr(recognition, target), true)
})

test('完整指南题名在首次点击后确认展开且不会再次切换', async () => {
  const collapsed = {
    engine: 'rapidocr', elapsedMs: 300, image: { width: 1080, height: 2400 },
    results: [{ text: '参考1篇医学文献', normalizedText: '参考1篇医学文献', confidence: 0.999, bounds: [62, 704, 479, 760] }],
  }
  const expanded = {
    ...collapsed,
    results: [
      collapsed.results[0],
      {
        text: '1. 中国超重/肥胖医学营养治疗指南(2021)',
        normalizedText: '1.中国超重/肥胖医学营养治疗指南(2021)',
        confidence: 0.99274,
        bounds: [65, 793, 831, 842],
      },
    ],
  }
  const recognitions = [collapsed, expanded]
  let taps = 0
  const result = await prepareEmbeddedEvidence({
    screenshot: async () => Buffer.from('screen'),
    ocr: { recognize: async () => recognitions.shift() },
    windowSize: async () => ({ width: 1080, height: 2400 }),
    tap: async () => { taps += 1 },
    delay: async () => {},
    waitForStable: async () => ({ frame: Buffer.from('expanded'), xml: '<hierarchy />' }),
    log: () => {},
  }, CHAT_BOUNDS)

  assert.equal(result.expanded, true)
  assert.equal(taps, 1)
})

test('新版医学文献标题下只有编号回答正文时不能误判为展开', () => {
  const target = {
    normalizedText: '参考1篇医学文献',
    variant: 'medical_references',
    physicalBounds: [65, 818, 479, 868],
  }
  const recognition = {
    image: { width: 1080, height: 2400 },
    results: [
      { text: '1. 先进行生活方式干预', normalizedText: '1.先进行生活方式干预', confidence: 0.999, bounds: [66, 930, 700, 980] },
    ],
  }
  assert.equal(evidenceSummaryExpandedByOcr(recognition, target), false)

  const laterTruncatedParagraph = {
    ...recognition,
    results: [{
      text: '1. 先进行生活方式干预..',
      normalizedText: '1.先进行生活方式干预..',
      confidence: 0.999,
      bounds: [66, 930, 700, 980],
    }],
  }
  assert.equal(evidenceSummaryExpandedByOcr(laterTruncatedParagraph, target), false)
})

test('首次点击后状态不明确时仅做只读OCR复核且不再次切换', async () => {
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
  let ocrReads = 0
  let stableReads = 0
  const result = await prepareEmbeddedEvidence({
    screenshot: async () => Buffer.from('raw-screen'),
    ocr: {
      recognize: async () => {
        ocrReads += 1
        return ocrReads < 4 ? collapsedRecognition : {
          ...collapsedRecognition,
          results: [
            ...collapsedRecognition.results,
            { text: '医学文献', normalizedText: '医学文献', confidence: 0.999, bounds: [850, 800, 1000, 850] },
          ],
        }
      },
    },
    windowSize: async () => ({ width: 1080, height: 2400 }),
    tap: async (x, y) => { taps.push([x, y]) },
    delay: async () => {},
    waitForStable: async () => ({
      frame: Buffer.from('frame'),
      xml: stableReads++ < 2 ? collapsedXml : expandedXml,
      stable: true,
    }),
    log: () => {},
  }, CHAT_BOUNDS)

  assert.equal(taps.length, 1)
  assert.deepEqual(taps[0], [300, 725])
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

test('完成确认和顶部定位使用长距离快速滚动，正式回答采集保持较高重叠', () => {
  const bounds = [0, 333, 1080, 2001]
  const capture = chatSwipePlan(bounds, 0.45, { speed: 1400 })
  const navigation = chatSwipePlan(bounds, 0.78, { maxFraction: 0.82, speed: 4000 })
  assert.equal(capture.distance, 750)
  assert.equal(navigation.distance, 1301)
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

test('分组产物只有品牌一层，入口和题目保留顺序', () => {
  const batch = batchArtifactDirectories('/captures/batch_1')
  const artifacts = groupedQuestionArtifactDirectories(batch, 2, '抖音搜索框', {
    brand: '诺和诺德',
    question: '有哪些副作用？',
    question_index_in_brand: 3,
  })
  assert.equal(artifacts.deliveryDirectory, path.join('/captures/batch_1', '交付图片', '诺和诺德', '02_抖音搜索框', '003_有哪些副作用？'))
  assert.equal(artifacts.diagnosticDirectory, path.join('/captures/batch_1', '调试产物', '诺和诺德', '02_抖音搜索框', '003_有哪些副作用？'))
})

test('品牌汇总按入口数量计算计划、成功和失败', () => {
  const brands = groupedBrandSummaries([
    { brand: '诺和诺德', questions: ['问题一', '问题二'] },
  ], [{ id: 'a' }, { id: 'b' }], [
    { brand_index: 1, status: 'completed', search_result_only: true },
    { brand_index: 1, status: 'failed' },
  ])
  assert.deepEqual(brands, [{
    name: '诺和诺德', brand_index: 1, directory_name: '诺和诺德',
    question_count: 2, planned: 4, completed: 1, failed: 1, search_results_only: 1,
  }])
})

test('结构化事件日志记录参考药品关键阶段和单题上下文', async () => {
  assert.deepEqual(classifyAutomationLog('capture: 抖音未召回智能总结或小荷入口，搜索结果已保存 /tmp/回答_搜索结果.png'), {
    event: 'search_results_only_captured',
    category: 'capture',
    details: { platform: '抖音', screenshot: '/tmp/回答_搜索结果.png', xiaohe_result_detected: false },
  })
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
    logger.recordMessage('waiting: 小荷回答底部已持续6秒不可继续滚动且内容无变化，确认生成完成（探测=4，重置=1）')
    logger.recordMessage('capture: 推荐药品截图完成，共 4 屏，图片已全部加载')
    await logger.flush()
    const records = (await fs.readFile(filePath, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.deepEqual(records.map(item => item.sequence), [1, 2, 3])
    assert.deepEqual(records.map(item => item.event), ['stage', 'reply_completion_confirmed', 'reference_products_capture_completed'])
    assert.equal(records[1].details.method, 'persistent_scroll_end')
    assert.equal(records[1].details.resets, 1)
    assert.equal(records[2].question, '测试')
    assert.equal(records[2].details.pages, 4)
    assert.equal(records[2].details.images_status, '已全部加载')
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
  await assert.rejects(() => verifyReplyFrameOverlap(previous, current, 210), /区域.*不一致|连续性/)
})

test('小荷正文接缝以多区域多数共识容忍单个局部动态区', async () => {
  const width = 400
  const height = 500
  const shift = 140
  const overlap = height - shift
  const raw = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3
      const value = 35 + ((y * 31 + x * 17 + (x * y) % 101) % 190)
      raw[offset] = value
      raw[offset + 1] = (value + 37) % 240
      raw[offset + 2] = (value + 73) % 240
    }
  }
  const previous = await sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer()
  const currentBase = await sharp(previous).extract({ left: 0, top: shift, width, height: overlap })
    .extend({ bottom: shift, background: '#f4f4f4' }).png().toBuffer()
  const changedBand = await sharp({ create: { width: 80, height: overlap, channels: 3, background: '#f39a53' } }).png().toBuffer()
  const current = await sharp(currentBase).composite([{ input: changedBand, left: 16, top: 0 }]).png().toBuffer()

  assert.equal(await verifyReplyFrameOverlap(previous, current, overlap), overlap)
})

test('小荷正文局部样式整行变化时可用层级位移和图像候选双重确认接缝', async () => {
  const width = 400
  const height = 500
  const shift = 140
  const overlap = height - shift
  const raw = Buffer.alloc(width * height * 3)
  for (let index = 0; index < raw.length; index += 1) raw[index] = (index * 47 + Math.floor(index / 13) * 19) % 256
  const previous = await sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer()
  const currentBase = await sharp(previous).extract({ left: 0, top: shift, width, height: overlap })
    .extend({ bottom: shift, background: '#f4f4f4' }).png().toBuffer()
  const changedRow = await sharp({ create: { width, height: 72, channels: 3, background: '#ff8a45' } }).png().toBuffer()
  const current = await sharp(currentBase).composite([{ input: changedRow, left: 0, top: 110 }]).png().toBuffer()

  await assert.rejects(() => verifyReplyFrameOverlap(previous, current, overlap), /局部内容发生变化|连续性/)
  assert.equal(await verifyReplyFrameOverlap(previous, current, overlap, { measuredShift: shift }), overlap)
})

test('小荷全文末屏实际滚动较短时仍在名义重叠上方找到真实接缝', async () => {
  const width = 320
  const height = 600
  const shift = 90
  const overlap = height - shift
  const raw = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3
      const value = 30 + ((y * 41 + x * 19 + (x * y) % 113) % 200)
      raw[offset] = value
      raw[offset + 1] = (value + 31) % 240
      raw[offset + 2] = (value + 67) % 240
    }
  }
  const previous = await sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer()
  const current = await sharp(previous)
    .extract({ left: 0, top: shift, width, height: overlap })
    .extend({ bottom: shift, background: '#f3f4f5' })
    .png().toBuffer()

  assert.equal(await verifyReplyFrameOverlap(previous, current, 180), overlap)
})

test('小荷正文三个区域在比例容差内一致时取最小重叠保留安全重复', async () => {
  const width = 400
  const height = 500
  const raw = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3
      const value = (y * 37 + x * 17 + (y * x) % 97) % 256
      raw[offset] = value
      raw[offset + 1] = (value * 3) % 256
      raw[offset + 2] = (value * 7) % 256
    }
  }
  const previous = await sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer()
  const shifts = [140, 144, 148, 80]
  const bands = await Promise.all(shifts.map((shift, index) => sharp(previous)
    .extract({ left: index * 100, top: shift, width: 100, height: height - shift })
    .extend({ bottom: shift, background: '#f2f2f2' }).png().toBuffer()))
  const current = await sharp({ create: { width, height, channels: 3, background: '#f2f2f2' } })
    .composite(bands.map((input, index) => ({ input, left: index * 100, top: 0 }))).png().toBuffer()

  assert.equal(await verifyReplyFrameOverlap(previous, current, 360), 352)
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
  assert.deepEqual(result.bounds, [[73, 1454, 529, 1839], [619, 1454, 1075, 1839]])
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
  assert.deepEqual(result.bounds, [[63, 783, 453, 1091]])
})

test('两张药品卡片只有一张暴露ImageView时缺图卡仍必须参与就绪检查', async () => {
  const frame = await sharp({ create: { width: 400, height: 500, channels: 3, background: '#fff' } })
    .composite([{ input: await sharp({ create: { width: 140, height: 120, channels: 3, background: '#d71945' } }).png().toBuffer(), left: 20, top: 20 }])
    .png().toBuffer()
  const xml = '<hierarchy><node class="androidx.recyclerview.widget.RecyclerView" bounds="[0,100][400,600]">'
    + '<node class="android.view.ViewGroup" bounds="[10,110][190,450]">'
    + '<node class="android.widget.ImageView" bounds="[20,120][180,260]" />'
    + '<node class="android.widget.TextView" text="查看说明书" bounds="[30,400][170,440]" /></node>'
    + '<node class="android.view.ViewGroup" bounds="[210,110][390,450]">'
    + '<node class="android.widget.TextView" text="查看说明书" bounds="[230,400][370,440]" /></node>'
    + '</node></hierarchy>'

  const result = await referenceProductViewportReadiness(frame, xml, [0, 100, 400, 600])
  assert.equal(result.ready, false)
  assert.equal(result.cards, 2)
  assert.equal(result.images, 2)
  assert.equal(result.loaded, 1)
  assert.equal(result.unloaded, 1)
})

test('药品当前视口仍有缺图时不允许继续向下滚动', async () => {
  let swipes = 0
  const capture = createReferenceProductCapture({
    checkCancelled: () => {},
    observer: { active: false },
    screenshot: async () => Buffer.alloc(0),
    source: async () => '<hierarchy />',
    recoverObserver: async () => false,
    waitForVisualQuiet: async () => {},
    swipe: async () => { swipes += 1 },
    log: () => {},
    tap: async () => {},
    ui: { press: async () => {} },
    getMaxLongImageHeight: () => 12_000,
    incrementObserverRegionFallbacks: () => {},
  })

  await assert.rejects(capture.captureScrollingRegion([0, 0, 400, 500], {
    frame: await sharp({ create: { width: 400, height: 500, channels: 3, background: '#fff' } }).png().toBuffer(),
    xml: '<hierarchy />',
    readiness: { ready: false, cards: 2, images: 2, loaded: 1, unloaded: 1 },
  }), /逐卡图片仅确认 1\/2/)
  assert.equal(swipes, 0)
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
