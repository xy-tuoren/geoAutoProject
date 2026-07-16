const fs = require('node:fs/promises')
const path = require('node:path')
const { sleep, createBatchDirectory, batchArtifactDirectories, entryArtifactDirectories, questionArtifactDirectories } = require('./utils')
const { EventLog } = require('./event-log')
const { iterNodes, nodeAttr, nodeIsVisible, parseBounds, currentQuestionText, findChatScrollBounds, validateCaptureViewport, visibleLabelBounds, boundsForNodeAttribute } = require('./hierarchy')
const { imageInfo, cropImage, imagesSimilar } = require('./images')
const { U2Client } = require('./u2-client')
const { OcrRecognizer } = require('./ocr')
const { ScrcpyObserver, SCRCPY_VERSION } = require('./scrcpy-observer')
const {
  DEFAULT_PACKAGE,
  DEFAULT_ENTRY_ID,
  ENTRY_DEFINITIONS,
  automationEntries,
  normalizeAutomationEntries,
  hierarchyBelongsToPackage,
  entryHierarchyStartupTimeout,
} = require('./entry-catalog')
const { bundledScrcpyServer } = require('../runtime-paths')
const { adbCommand, adbConnectionLost, waitForAdbDevice, adbScreenshot, adbCommandWithReconnect } = require('./device-bridge')
const { CancelledError, fatalBatchError, runQuestionsWithRecovery, failedRetryItems, retryAttemptCount } = require('./batch-recovery')
const { captureFailureDiagnostics, diagnosticError } = require('./failure-diagnostics')
const {
  miniAppReferenceProductsTrigger,
  referenceProductsTrigger,
  refreshedReferenceProductsTrigger,
  referenceProductDrawerBounds,
  referenceProductsCaptureComplete,
  referenceProductSheetExpanded,
  calibratedProductFallbackOverlap,
  referenceProductViewportReadiness,
} = require('./reference-products')
const {
  douyinSearchInput,
  toutiaoSearchInput,
  toutiaoSearchResultBelongsToQuestion,
  toutiaoHomeSearchBounds,
  toutiaoViewMoreBounds,
  hierarchyLogicalSize,
  toutiaoOcrViewMoreTarget,
  douyinOcrViewFullTarget,
  douyinViewFullBounds,
  douyinGenericAiAnswerBounds,
  douyinMiniAppEntryBounds,
  douyinSearchResultTarget,
  douyinSearchResultsBounds,
  douyinMiniAppCaptureBounds,
  toutiaoGenericConsultationPage,
} = require('./miniapp-locators')
const {
  DEFAULT_MAX_LONG_IMAGE_HEIGHT,
  maxLongImageHeight,
  historyOnboardingVisible,
  conservativeFallbackOverlap,
  chatSwipePlan,
  scrollEndConfirmed,
  requireQuestionLocated,
  buildReplyImages,
  prepareEmbeddedEvidence,
  fillQuestionInput,
  captureStableSandwich,
  captureStableObserved,
  observerRegionFallbackOptions,
} = require('./capture-primitives')
const { createCaptureStability } = require('./capture-stability')
const { createReferenceProductCapture } = require('./reference-product-capture')
const { createReplyCapture } = require('./reply-capture')
const { createQuestionInputWorkflow } = require('./question-input-workflow')
const { createDouyinSearchWorkflow } = require('./douyin-search-workflow')
const { createToutiaoSearchWorkflow } = require('./toutiao-search-workflow')
const { createArtifactWriter, ARTIFACT_LAYOUT_VERSION } = require('./artifact-writer')
const {
  createQuestionWorkflows,
  DOUYIN_SEARCH_SUMMARY_FILENAME,
  DOUYIN_MINIAPP_ENTRY_FILENAME,
  TOUTIAO_SEARCH_SUMMARY_FILENAME,
} = require('./question-workflows')

async function waitForPackageHierarchy({
  dumpHierarchy,
  packageName = DEFAULT_PACKAGE,
  packageLabel = '目标App',
  delay = sleep,
  now = Date.now,
  timeout = 8_000,
  interval = 250,
}) {
  const deadline = now() + timeout
  let xml = ''
  while (now() < deadline) {
    xml = await dumpHierarchy()
    if (hierarchyBelongsToPackage(xml, packageName)) return xml
    await delay(Math.min(interval, Math.max(0, deadline - now())))
  }
  throw new Error(`当前前台页面不是${packageLabel}（层级中缺少 ${packageName}），已停止UI操作。`)
}

function createRunner(options) {
  let cancelled = false
  let activeSerial = null
  let activeEntry = ENTRY_DEFINITIONS[DEFAULT_ENTRY_ID]
  let cachedInputBounds = null
  let cachedSendBounds = null
  let observerFallbackReason = null
  let observerFallbackLogged = false
  let observerRecoveryAttempts = 0
  let observerRecoverySuccesses = 0
  let observerRecoveryFailures = 0
  let observerRegionFallbacks = 0
  let observerActivityRegionChecks = 0
  let adbPngCaptures = 0
  let batchEventLog = null
  let activeQuestionEventLog = null
  let activeQuestionContext = {}
  let activeQuestionArtifacts = null
  let lastOcrDiagnostic = null
  const log = text => {
    const message = String(text)
    options.log(`${message}${message.endsWith('\n') ? '' : '\n'}`)
    batchEventLog?.recordMessage(message, activeQuestionContext)
    activeQuestionEventLog?.recordMessage(message)
  }
  const ui = options.uiClient || new U2Client({
    root: options.root,
    isPackaged: options.isPackaged,
    resourcesPath: options.resourcesPath,
    adbPath: options.adbPath,
    log,
  })
  const ocr = options.ocrRecognizer || new OcrRecognizer({ transport: ui })
  const observer = options.scrcpyObserver || new ScrcpyObserver({
    adbPath: options.adbPath,
    serverPath: bundledScrcpyServer(options),
    log,
  })
  const checkCancelled = () => { if (cancelled) throw new CancelledError() }

  async function initializeArtifactLogging(artifacts, payload, mode) {
    await Promise.all([
      fs.mkdir(artifacts.deliveryDirectory, { recursive: true }),
      fs.mkdir(artifacts.diagnosticDirectory, { recursive: true }),
    ])
    batchEventLog = new EventLog({
      filePath: path.join(artifacts.diagnosticDirectory, '执行日志.jsonl'),
      scope: 'batch',
      context: { batch_id: path.basename(artifacts.batchDirectory), serial: payload.serial, mode },
    })
    await batchEventLog.record('batch_started', {
      category: 'lifecycle',
      details: {
        artifact_layout_version: ARTIFACT_LAYOUT_VERSION,
        delivery_directory: artifacts.deliveryDirectory,
        diagnostic_directory: artifacts.diagnosticDirectory,
      },
    })
  }

  async function startQuestionLogging(artifacts, context) {
    activeQuestionArtifacts = artifacts
    lastOcrDiagnostic = null
    activeQuestionContext = { ...context }
    activeQuestionEventLog = new EventLog({
      filePath: path.join(artifacts.diagnosticDirectory, '执行日志.jsonl'),
      scope: 'question',
      context,
    })
    await activeQuestionEventLog.record('question_context_ready', {
      category: 'lifecycle',
      details: {
        delivery_directory: artifacts.deliveryDirectory,
        diagnostic_directory: artifacts.diagnosticDirectory,
      },
    })
  }

  async function finishQuestionLogging(event, details = {}) {
    if (!activeQuestionEventLog) return
    await batchEventLog?.record(event, {
      category: event === 'question_failed' ? 'error' : 'lifecycle',
      details,
      context: activeQuestionContext,
    })
    await activeQuestionEventLog.record(event, { category: event === 'question_failed' ? 'error' : 'lifecycle', details })
    await activeQuestionEventLog.flush()
    activeQuestionEventLog = null
    activeQuestionContext = {}
    activeQuestionArtifacts = null
  }

  async function flushArtifactLogs() {
    await activeQuestionEventLog?.flush()
    await batchEventLog?.flush()
  }

  function resetEntryState(entry) {
    activeEntry = entry
    cachedInputBounds = null
    cachedSendBounds = null
  }

  function activePackageName() {
    return activeEntry.packageName || DEFAULT_PACKAGE
  }

  function activePackageLabel() {
    return activeEntry.packageLabel || activeEntry.label || activePackageName()
  }

  function boundsForResourceId(xml, name) {
    const packages = [activeEntry.resourcePackage, activePackageName(), DEFAULT_PACKAGE].filter(Boolean)
    for (const packageName of [...new Set(packages)]) {
      const exact = boundsForNodeAttribute(xml, 'resource-id', `${packageName}:id/${name}`)
      if (exact) return exact
    }
    const suffix = `:id/${name}`
    for (const attrs of iterNodes(xml)) {
      if (!nodeIsVisible(attrs) || !nodeAttr(attrs, 'resource-id').endsWith(suffix)) continue
      const rawBounds = nodeAttr(attrs, 'bounds')
      if (rawBounds) return parseBounds(rawBounds)
    }
    return null
  }

  function findSubmitBounds(xml) {
    const labels = activeEntry.submitLabels || ['发送']
    for (const label of labels) {
      const byDescription = boundsForNodeAttribute(xml, 'content-desc', label)
      if (byDescription) return byDescription
      const byText = visibleLabelBounds(xml, label)
      if (byText) return byText
    }
    return null
  }

  function recoverySnapshot() {
    return {
      attempts: observerRecoveryAttempts,
      successes: observerRecoverySuccesses,
      failures: observerRecoveryFailures,
      regionFallbacks: observerRegionFallbacks,
      activityRegionChecks: observerActivityRegionChecks,
      adbPngCaptures,
    }
  }

  function observerMetadata(baseline = null, recoveryBaseline = null) {
    const snapshot = typeof observer.snapshot === 'function'
      ? observer.snapshot()
      : { active: Boolean(observer.active), version: SCRCPY_VERSION, frames: 0 }
    const metadata = {
      scrcpy_observer_requested: true,
      scrcpy_observer_active: Boolean(snapshot.active),
      scrcpy_observer_version: snapshot.version || SCRCPY_VERSION,
      scrcpy_observer_frames: snapshot.frames || 0,
      scrcpy_observer_activity_frames: snapshot.activity_frames || 0,
      scrcpy_observer_burst_activity_frames: snapshot.burst_activity_frames || 0,
      scrcpy_observer_sparse_activity_frames: snapshot.sparse_activity_frames || 0,
      scrcpy_observer_noise_frames: snapshot.noise_frames || 0,
      scrcpy_observer_frames_last_second: snapshot.frames_last_second || 0,
      scrcpy_observer_activity_frames_last_second: snapshot.activity_frames_last_second || 0,
      scrcpy_observer_bytes_last_second: snapshot.bytes_last_second || 0,
      scrcpy_observer_quiet_checks: snapshot.quiet_checks || 0,
      scrcpy_observer_quiet_successes: snapshot.quiet_successes || 0,
      scrcpy_observer_quiet_timeouts: snapshot.quiet_timeouts || 0,
      scrcpy_observer_no_activity_checks: snapshot.no_activity_checks || 0,
      scrcpy_observer_no_activity_successes: snapshot.no_activity_successes || 0,
      scrcpy_observer_no_activity_timeouts: snapshot.no_activity_timeouts || 0,
      scrcpy_observer_no_activity_wait_ms: snapshot.no_activity_wait_ms || 0,
      scrcpy_observer_activity_checks: snapshot.activity_checks || 0,
      scrcpy_observer_activity_successes: snapshot.activity_successes || 0,
      scrcpy_observer_activity_timeouts: snapshot.activity_timeouts || 0,
      scrcpy_observer_settle_checks: snapshot.settle_checks || 0,
      scrcpy_observer_settle_successes: snapshot.settle_successes || 0,
      scrcpy_observer_settle_timeouts: snapshot.settle_timeouts || 0,
      scrcpy_observer_settle_fast_successes: snapshot.settle_fast_successes || 0,
      scrcpy_observer_settle_conservative_successes: snapshot.settle_conservative_successes || 0,
      scrcpy_observer_settle_no_activity: snapshot.settle_no_activity || 0,
      scrcpy_observer_settle_wait_ms: snapshot.settle_wait_ms || 0,
      scrcpy_observer_recovery_attempts: observerRecoveryAttempts,
      scrcpy_observer_recovery_successes: observerRecoverySuccesses,
      scrcpy_observer_recovery_failures: observerRecoveryFailures,
      scrcpy_observer_region_fallbacks: observerRegionFallbacks,
      scrcpy_observer_activity_region_checks: observerActivityRegionChecks,
      adb_png_captures: adbPngCaptures,
      ...(observerFallbackReason ? { scrcpy_observer_fallback_reason: observerFallbackReason } : {}),
    }
    if (baseline) {
      for (const key of ['frames', 'activity_frames', 'burst_activity_frames', 'sparse_activity_frames', 'noise_frames', 'quiet_checks', 'quiet_successes', 'quiet_timeouts', 'no_activity_checks', 'no_activity_successes', 'no_activity_timeouts', 'no_activity_wait_ms', 'activity_checks', 'activity_successes', 'activity_timeouts', 'settle_checks', 'settle_successes', 'settle_timeouts', 'settle_fast_successes', 'settle_conservative_successes', 'settle_no_activity', 'settle_wait_ms']) {
        metadata[`scrcpy_observer_question_${key}`] = Math.max(0, Number(snapshot[key] || 0) - Number(baseline[key] || 0))
      }
    }
    if (recoveryBaseline) {
      metadata.scrcpy_observer_question_recovery_attempts = observerRecoveryAttempts - recoveryBaseline.attempts
      metadata.scrcpy_observer_question_recovery_successes = observerRecoverySuccesses - recoveryBaseline.successes
      metadata.scrcpy_observer_question_recovery_failures = observerRecoveryFailures - recoveryBaseline.failures
      metadata.scrcpy_observer_question_region_fallbacks = observerRegionFallbacks - recoveryBaseline.regionFallbacks
      metadata.scrcpy_observer_question_activity_region_checks = observerActivityRegionChecks - recoveryBaseline.activityRegionChecks
      metadata.adb_png_captures_question = adbPngCaptures - recoveryBaseline.adbPngCaptures
    }
    return metadata
  }

  async function disableObserver(error) {
    observerFallbackReason ||= error?.message || String(error)
    if (!observerFallbackLogged) {
      log(`scrcpy画面观察器不可用，稳定性判断改用双ADB PNG校验（UI仍严格使用Python uiautomator2）：${observerFallbackReason}`)
      observerFallbackLogged = true
    }
    await observer.stop().catch(() => {})
  }

  async function recoverObserver(error) {
    // captureStableObserved also executes hierarchy and PNG callbacks. If
    // scrcpy itself is still healthy, preserve those errors instead of masking
    // them with an unrelated observer restart.
    if (observer.active && !observer.failure) throw error
    if (cancelled || !activeSerial || observerRecoveryAttempts >= 1) {
      await disableObserver(error)
      return false
    }
    observerRecoveryAttempts += 1
    log(`scrcpy观察器连接中断，正在自动恢复（1/1）：${error?.message || error}`)
    await observer.stop().catch(() => {})
    try {
      await waitForAdbDevice(options.adbPath, activeSerial, 10_000)
      checkCancelled()
      await observer.start(activeSerial)
      observerRecoverySuccesses += 1
      log('scrcpy观察器已自动恢复，继续使用画面活动检测')
      return true
    } catch (recoveryError) {
      observerRecoveryFailures += 1
      await disableObserver(new Error(`${error?.message || error}；自动恢复失败：${recoveryError.message}`))
      return false
    }
  }

  async function waitForVisualQuiet({ timeout = 1_200, fallbackMs = 600 } = {}) {
    checkCancelled()
    for (let attempt = 0; attempt < 2 && observer.active; attempt += 1) {
      try {
        const quiet = await observer.waitForQuiet({
          timeout,
          windowMs: 400,
          quietMs: 250,
          maxFrames: 1,
          minWaitMs: 120,
        })
        if (quiet.quiet) return true
        break
      } catch (error) {
        if (!(await recoverObserver(error))) break
      }
    }
    checkCancelled()
    await sleep(fallbackMs)
    return false
  }

  async function screenshot() {
    checkCancelled()
    adbPngCaptures += 1
    return adbScreenshot(options.adbPath, activeSerial)
  }

  async function source() {
    checkCancelled()
    let xml = ''
    // During bottom-sheet attach/detach UiAutomator can briefly serialize an
    // empty transitional root even though WindowManager still reports the app
    // in front. Retry only this read-only operation; clicks are never replayed.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      xml = await ui.dumpHierarchy()
      if (hierarchyBelongsToPackage(xml, activePackageName())) return xml
      if (attempt < 2) await sleep(120)
    }
    throw new Error(`当前前台页面不是${activePackageLabel()}（层级中缺少 ${activePackageName()}），已停止UI操作。`)
  }

  async function tap(x, y) {
    checkCancelled()
    await ui.click(x, y)
  }

  async function swipe(x, fromY, toY, duration = 250) {
    checkCancelled()
    await adbCommandWithReconnect(options.adbPath, activeSerial, ['shell', 'input', 'swipe', String(Math.round(x)), String(Math.round(fromY)), String(Math.round(x)), String(Math.round(toY)), String(Math.round(duration))])
  }

  async function windowSize() {
    const { width, height } = await imageInfo(await screenshot())
    return { width, height }
  }

  async function diagnosticDeviceState() {
    const read = async args => {
      try {
        return { status: 'captured', value: (await adbCommand(options.adbPath, activeSerial, args)).trim() }
      } catch (error) {
        return { status: 'failed', error: diagnosticError(error) }
      }
    }
    const [wmSize, wmDensity, orientation, autoRotation] = await Promise.all([
      read(['shell', 'wm', 'size']),
      read(['shell', 'wm', 'density']),
      read(['shell', 'settings', 'get', 'system', 'user_rotation']),
      read(['shell', 'settings', 'get', 'system', 'accelerometer_rotation']),
    ])
    return { wm_size: wmSize, wm_density: wmDensity, user_rotation: orientation, accelerometer_rotation: autoRotation }
  }

  async function saveFailureDiagnostics(artifacts, error, { stem = '失败现场' } = {}) {
    try {
      const diagnostics = await captureFailureDiagnostics({
        directory: artifacts.diagnosticDirectory,
        stem,
        serial: activeSerial,
        entry: activeEntry,
        context: activeQuestionContext,
        error,
        captureScreenshot: () => adbScreenshot(options.adbPath, activeSerial),
        dumpHierarchy: () => ui.dumpHierarchy(),
        currentApp: () => ui.currentApp(),
        foregroundWindow: () => ui.foregroundWindow(),
        deviceState: diagnosticDeviceState,
        observerSnapshot: () => typeof observer.snapshot === 'function' ? observer.snapshot() : { active: Boolean(observer.active), version: SCRCPY_VERSION },
        ocrDiagnostic: lastOcrDiagnostic,
      })
      log(`diagnostic: 失败现场已保存 ${diagnostics.manifest}`)
      return diagnostics
    } catch (diagnosticFailure) {
      log(`diagnostic: 失败现场采集器自身失败，但保留原始任务错误：${diagnosticFailure.message}`)
      return { manifest: null, screenshot: null, hierarchy: null, ocr: null, capture_error: diagnosticError(diagnosticFailure) }
    }
  }

  const {
    waitForInput,
    inputQuestion,
    tapSend,
    tapNewSession,
    waitForDouyinSearchInput,
    inputDouyinQuestion,
    waitForToutiaoSearchInput,
    inputToutiaoQuestion,
  } = createQuestionInputWorkflow({
    checkCancelled,
    source,
    windowSize,
    tap,
    log,
    ui,
    waitForVisualQuiet,
    findSubmitBounds,
    boundsForResourceId,
    getActiveEntry: () => activeEntry,
    getCachedInputBounds: () => cachedInputBounds,
    setCachedInputBounds: value => { cachedInputBounds = value },
    getCachedSendBounds: () => cachedSendBounds,
    setCachedSendBounds: value => { cachedSendBounds = value },
  })


  const {
    normalizedHierarchy,
    waitForStableReplyPixels,
    waitForStableReply,
    waitForFinalVisualQuiet,
    swipeChat,
    waitForRegionPixelsStable,
    waitForStableReplyRegion,
  } = createCaptureStability({
    source,
    screenshot,
    windowSize,
    checkCancelled,
    log,
    observer,
    recoverObserver,
    swipe,
    incrementObserverRegionFallbacks: () => { observerRegionFallbacks += 1 },
    incrementObserverActivityRegionChecks: () => { observerActivityRegionChecks += 1 },
  })

  const {
    waitForDouyinSearchResult,
    refreshDouyinSearchResults,
    captureDouyinSearchTarget,
    openDouyinFullAnswer,
    openDouyinMiniAppEntry,
    waitForDouyinMiniAppAnswer,
  } = createDouyinSearchWorkflow({
    source,
    windowSize,
    log,
    screenshot,
    ocr,
    setLastOcrDiagnostic: value => { lastOcrDiagnostic = value },
    swipeChat,
    waitForVisualQuiet,
    tap,
    ui,
    getActivePackageName: activePackageName,
    checkCancelled,
    waitForStableReply,
  })

  const {
    waitForToutiaoAnswerCard,
    captureToutiaoSearchSummary,
    openToutiaoFullAnswer,
  } = createToutiaoSearchWorkflow({
    source,
    windowSize,
    log,
    screenshot,
    ocr,
    setLastOcrDiagnostic: value => { lastOcrDiagnostic = value },
    waitForVisualQuiet,
    tap,
    ui,
    getActivePackageName: activePackageName,
  })

  let payloadMaxLongImageHeight = DEFAULT_MAX_LONG_IMAGE_HEIGHT

  const {
    captureProductViewport,
    captureScrollingRegion,
    closeReferenceProductsDrawer,
    captureReferenceProductsAtTrigger,
  } = createReferenceProductCapture({
    checkCancelled,
    observer,
    screenshot,
    source,
    recoverObserver,
    waitForVisualQuiet,
    swipe,
    log,
    tap,
    ui,
    getMaxLongImageHeight: () => payloadMaxLongImageHeight,
    incrementObserverRegionFallbacks: () => { observerRegionFallbacks += 1 },
  })

  const {
    scrollQuestionIntoView,
    captureFullReplyFrames,
    waitForMiniAppStableRegion,
    captureMiniAppFullAnswerFrames,
    captureDouyinFullAnswerFrames,
    captureDouyinMiniAppEntryAnswerFrames,
    captureToutiaoFullAnswerFrames,
  } = createReplyCapture({
    source,
    swipeChat,
    windowSize,
    waitForStableReplyRegion,
    tap,
    log,
    captureReferenceProductsAtTrigger,
    screenshot,
    waitForFinalVisualQuiet,
    waitForVisualQuiet,
  })


  const { saveArtifacts } = createArtifactWriter({
    defaultCaptureMethod: captureFullReplyFrames,
    getMaxLongImageHeight: () => payloadMaxLongImageHeight,
    screenshot,
    normalizedHierarchy,
    observerMetadata,
    getBatchEventLog: () => batchEventLog,
    log,
  })


  const { askOnceDouyin, askOnceToutiao, askOnce } = createQuestionWorkflows({
    observer,
    recoverySnapshot,
    log,
    inputDouyinQuestion,
    tap,
    waitForDouyinSearchResult,
    refreshDouyinSearchResults,
    source,
    screenshot,
    captureDouyinSearchTarget,
    openDouyinFullAnswer,
    captureDouyinFullAnswerFrames,
    openDouyinMiniAppEntry,
    waitForDouyinMiniAppAnswer,
    captureDouyinMiniAppEntryAnswerFrames,
    saveArtifacts,
    inputToutiaoQuestion,
    waitForToutiaoAnswerCard,
    captureToutiaoSearchSummary,
    openToutiaoFullAnswer,
    captureToutiaoFullAnswerFrames,
    tapNewSession,
    inputQuestion,
    tapSend,
    recoverObserver,
    waitForStableReply,
    captureFullReplyFrames,
    getActiveEntry: () => activeEntry,
    getActivePackageName: activePackageName,
  })


  async function prepareEntry(entry) {
    resetEntryState(entry)
    await ui.appStart(entry.packageName)
    await waitForPackageHierarchy({
      dumpHierarchy: async () => {
        checkCancelled()
        return ui.dumpHierarchy()
      },
      packageName: activePackageName(),
      packageLabel: activePackageLabel(),
      timeout: entryHierarchyStartupTimeout(entry),
    })
    await waitForVisualQuiet({ timeout: 1_200, fallbackMs: 800 })
    if (entry.workflow === 'douyin-search') await waitForDouyinSearchInput(15_000)
    else if (entry.workflow === 'toutiao-search') await waitForToutiaoSearchInput(15_000)
    else await waitForInput(15_000)
  }

  return {
    async captureCurrentAnswer(payload) {
      activeSerial = payload.serial
      if ((payload.entries || []).length > 1) throw new Error('当前已有回答模式一次只能指定一个入口。')
      const requestedEntry = (payload.entries || []).length
        ? normalizeAutomationEntries(payload.entries)[0]
        : ENTRY_DEFINITIONS['xiaohe-app']
      resetEntryState(requestedEntry)
      payloadMaxLongImageHeight = maxLongImageHeight(payload.maxLongImageHeight)
      const outputRoot = path.resolve(payload.outputDir)
      const batchDirectory = await createBatchDirectory(outputRoot)
      const batchArtifacts = batchArtifactDirectories(batchDirectory)
      await initializeArtifactLogging(batchArtifacts, payload, 'capture_current_existing_reply')
      try {
        await waitForAdbDevice(options.adbPath, payload.serial)
        await ui.start(payload.serial)
        try {
          await observer.start(payload.serial)
        } catch (error) {
          await disableObserver(error)
        }
        await waitForVisualQuiet({ timeout: 1_200, fallbackMs: 600 })
        const observerBaseline = typeof observer.snapshot === 'function' ? observer.snapshot() : {}
        const recoveryBaseline = recoverySnapshot()
        let xml = await source()
        const alreadyOpen = Boolean(referenceProductDrawerBounds(xml).sheet)
        if (alreadyOpen) throw new Error('当前药品抽屉已经打开，无法证明仍位于第一项；为避免漏药，本次未继续操作，也未输入或发送新问题。')
        const size = await windowSize()
        let question = ''
        let captureMethod = captureFullReplyFrames
        if (activeEntry.workflow === 'douyin-search' || activeEntry.workflow === 'toutiao-search') {
          question = String(payload.questions?.[0] || '').trim()
          if (!question) throw new Error('小程序当前已有回答模式需要在命令末尾提供当前问题文字，仅用于文件夹命名；不会输入或发送。')
          const bounds = douyinMiniAppCaptureBounds(xml, size)
          if (!bounds) throw new Error(`当前页面不是${activeEntry.label}的已打开全文页；本次未输入或发送。`)
          if (activeEntry.workflow === 'douyin-search') {
            const foreground = await ui.foregroundWindow()
            if (foreground?.package !== activePackageName() || !/MiniAppHostActivity/.test(foreground?.activity || '')) {
              throw new Error(`当前前台不是抖音小程序宿主页；本次未输入或发送（activity=${foreground?.activity || 'unknown'}）。`)
            }
            captureMethod = () => captureDouyinMiniAppEntryAnswerFrames(xml, bounds)
          } else captureMethod = () => captureToutiaoFullAnswerFrames(xml, bounds)
        } else {
          const chatBounds = findChatScrollBounds(xml, size)
          validateCaptureViewport(size, chatBounds)
          question = String(payload.questions?.[0] || '').trim()
          if (question) {
            captureMethod = currentQuestion => captureFullReplyFrames(currentQuestion, 30, { singleQuestionSession: true })
          } else {
            question = currentQuestionText(xml, chatBounds)
            let unchangedAtTop = 0
            let locateFrame = question ? null : await cropImage(await screenshot(), chatBounds)
            while (!question && unchangedAtTop < 2) {
              const scroll = await swipeChat(chatBounds, 'up', 0.45, { speed: 2_600, settle: 100, eventDrivenSettle: true })
              const settled = await waitForStableReplyRegion(chatBounds, 3_000, { settleSince: scroll.activityMark })
              xml = settled.xml || await source()
              question = currentQuestionText(xml, chatBounds)
              unchangedAtTop = await imagesSimilar(locateFrame, settled.frame, 3) ? unchangedAtTop + 1 : 0
              locateFrame = settled.frame
            }
            if (!question) {
              await waitForVisualQuiet({ timeout: 900, fallbackMs: 300 })
              xml = await source()
              question = currentQuestionText(xml, chatBounds)
            }
          }
          if (!question) throw new Error('无法从当前已有回答向上定位对应问题；本次未输入、未发送，也未新建会话。')
        }
        const artifacts = questionArtifactDirectories(batchArtifacts, 1, question)
        await startQuestionLogging(artifacts, {
          batch_id: path.basename(batchDirectory),
          serial: payload.serial,
          entry_id: activeEntry.id,
          entry_label: activeEntry.label,
          question,
          question_index: 1,
        })
        log(`${payload.questions?.[0]
          ? `capture: 使用调用方提供的已知问题文字“${question}”`
          : `capture: 已从当前已有回答识别问题“${question}”`}，开始执行正文、引用资料和完整参考药品归档；不会输入或发送内容`)
        const result = await saveArtifacts({
          artifacts,
          stem: '回答',
          question,
          status: 'existing_reply',
          xml,
          meta: {
            serial: payload.serial,
            batch_id: path.basename(batchDirectory),
            question_index: 1,
            question_directory: artifacts.diagnosticDirectory,
            entry_id: activeEntry.id,
            entry_label: activeEntry.label,
            entry_package: activePackageName(),
            existing_reply_capture: true,
            input_performed: false,
            send_performed: false,
            new_session_performed: false,
            ui_backend: 'python_uiautomator2_strict',
            ui_fallback_enabled: false,
          },
          captureMethod,
          observerBaseline,
          recoveryBaseline,
        })
        await finishQuestionLogging('question_completed', { status: 'existing_reply', screenshot: result.screenshot, metadata: result.metadata })
        const summaryPath = path.join(batchArtifacts.diagnosticDirectory, 'batch-summary.json')
        const summary = {
          created_at: new Date().toISOString(),
          serial: payload.serial,
          mode: 'capture_current_existing_reply',
          question_count: 1,
          total: 1,
          completed: 1,
          failed: 0,
          status: 'completed',
          artifact_layout_version: ARTIFACT_LAYOUT_VERSION,
          batch_directory: batchDirectory,
          delivery_directory: batchArtifacts.deliveryDirectory,
          diagnostic_directory: batchArtifacts.diagnosticDirectory,
          event_log: batchEventLog.filePath,
          summary: summaryPath,
          results: [{
            status: 'completed',
            entry_id: activeEntry.id,
            entry_label: activeEntry.label,
            question,
            question_index: 1,
            delivery_directory: artifacts.deliveryDirectory,
            diagnostic_directory: artifacts.diagnosticDirectory,
            event_log: path.join(artifacts.diagnosticDirectory, '执行日志.jsonl'),
            ...result,
          }],
        }
        await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf8')
        await batchEventLog.record('batch_completed', { category: 'lifecycle', details: { completed: 1, failed: 0, summary: summaryPath } })
        return { ...result, summary: summaryPath }
      } catch (error) {
        const diagnostics = await saveFailureDiagnostics(activeQuestionArtifacts || batchArtifacts, error, {
          stem: activeQuestionArtifacts ? '失败现场' : '自动化失败现场',
        })
        await finishQuestionLogging('question_failed', {
          error_name: error?.name || 'Error',
          error_message: error?.message || String(error),
          failure_diagnostics: diagnostics.manifest,
        }).catch(() => {})
        await batchEventLog.record('batch_failed', { category: 'error', details: { error_name: error?.name || 'Error', error_message: error?.message || String(error), failure_diagnostics: diagnostics.manifest } }).catch(() => {})
        await fs.writeFile(path.join(batchArtifacts.diagnosticDirectory, 'automation-failure.json'), JSON.stringify({
          created_at: new Date().toISOString(),
          serial: payload.serial,
          mode: 'capture_current_existing_reply',
          artifact_layout_version: ARTIFACT_LAYOUT_VERSION,
          batch_directory: batchDirectory,
          delivery_directory: batchArtifacts.deliveryDirectory,
          diagnostic_directory: batchArtifacts.diagnosticDirectory,
          event_log: batchEventLog.filePath,
          input_performed: false,
          send_performed: false,
          new_session_performed: false,
          error_name: error?.name || 'Error',
          error_message: error?.message || String(error),
          stack: error?.stack || null,
          failure_diagnostics: diagnostics,
        }, null, 2), 'utf8').catch(() => {})
        throw error
      } finally {
        await observer.stop().catch(() => {})
        await ui.stop().catch(() => {})
        await flushArtifactLogs().catch(() => {})
      }
    },
    async run(payload) {
      activeSerial = payload.serial
      payloadMaxLongImageHeight = maxLongImageHeight(payload.maxLongImageHeight)
      const entries = normalizeAutomationEntries(payload.entries)
      const outputRoot = path.resolve(payload.outputDir)
      const batchDirectory = await createBatchDirectory(outputRoot)
      const batchArtifacts = batchArtifactDirectories(batchDirectory)
      await initializeArtifactLogging(batchArtifacts, payload, 'batch_questions')
      try {
        await waitForAdbDevice(options.adbPath, payload.serial)
        await ui.start(payload.serial)
        try {
          await observer.start(payload.serial)
        } catch (error) {
          await disableObserver(error)
        }
        log(`device=${payload.serial} entries=${entries.map(entry => entry.id).join(',')} batch=${batchDirectory}`)
        let completed = 0
        let failed = 0
        const results = []
        const failures = []
        for (const [entryIndex, entry] of entries.entries()) {
          checkCancelled()
          log(`entry: [${entryIndex + 1}/${entries.length}] ${entry.label} package=${entry.packageName}`)
          const entryArtifacts = entryArtifactDirectories(batchArtifacts, entryIndex + 1, entry.label, entries.length)
          const entryResult = await runQuestionsWithRecovery({
            questions: payload.questions,
            beforeQuestion: async (question, index) => {
              const artifacts = questionArtifactDirectories(entryArtifacts, index, question)
              await startQuestionLogging(artifacts, {
                batch_id: path.basename(batchDirectory),
                serial: payload.serial,
                entry_id: entry.id,
                entry_label: entry.label,
                question,
                question_index: index,
              })
              log(`[${entryIndex + 1}/${entries.length} ${index}/${payload.questions.length}] task ready via ${entry.label}: ${question}`)
            },
            prepare: () => prepareEntry(entry),
            execute: async (question, index) => {
              const artifacts = questionArtifactDirectories(entryArtifacts, index, question)
              log(`[${entryIndex + 1}/${entries.length} ${index}/${payload.questions.length}] asking via ${entry.label}: ${question}`)
              const result = await askOnce(payload, artifacts, question, index)
              log(JSON.stringify(result))
              results.push({
                status: 'completed',
                entry_id: entry.id,
                entry_label: entry.label,
                question,
                question_index: index,
                delivery_directory: artifacts.deliveryDirectory,
                diagnostic_directory: artifacts.diagnosticDirectory,
                event_log: path.join(artifacts.diagnosticDirectory, '执行日志.jsonl'),
                ...result,
              })
              await finishQuestionLogging('question_completed', { screenshot: result.screenshot, metadata: result.metadata })
            },
            recordFailure: async (error, question, index) => {
              const artifacts = questionArtifactDirectories(entryArtifacts, index, question)
              const directory = artifacts.diagnosticDirectory
              const failurePath = path.join(directory, '失败.json')
              const diagnostics = await saveFailureDiagnostics(artifacts, error)
              const failure = {
                created_at: new Date().toISOString(),
                status: 'failed',
                artifact_layout_version: ARTIFACT_LAYOUT_VERSION,
                serial: payload.serial,
                batch_id: path.basename(batchDirectory),
                question,
                question_index: index,
                question_directory: directory,
                delivery_directory: artifacts.deliveryDirectory,
                diagnostic_directory: artifacts.diagnosticDirectory,
                event_log: path.join(directory, '执行日志.jsonl'),
                batch_event_log: batchEventLog.filePath,
                entry_id: entry.id,
                entry_label: entry.label,
                entry_package: entry.packageName,
                entry_hierarchy_startup_timeout_ms: entryHierarchyStartupTimeout(entry),
                batch_continued: true,
                error_name: error?.name || 'Error',
                error_message: error?.message || String(error),
                stack: error?.stack || null,
                failure_diagnostics: diagnostics,
              }
              await fs.mkdir(directory, { recursive: true })
              await fs.writeFile(failurePath, JSON.stringify(failure, null, 2), 'utf8')
              failures.push({
                entry_id: entry.id,
                entry_label: entry.label,
                question,
                question_index: index,
                failure: failurePath,
                error_name: failure.error_name,
                error_message: failure.error_message,
                failure_diagnostics: diagnostics.manifest,
              })
              results.push({
                status: 'failed',
                entry_id: entry.id,
                entry_label: entry.label,
                question,
                question_index: index,
                delivery_directory: artifacts.deliveryDirectory,
                diagnostic_directory: artifacts.diagnosticDirectory,
                event_log: path.join(directory, '执行日志.jsonl'),
                failure: failurePath,
                failure_diagnostics: diagnostics.manifest,
              })
              log(`failed: [${entryIndex + 1}/${entries.length} ${index}/${payload.questions.length}] ${entry.label} / ${question}: ${failure.error_message}`)
              log(`recovery: 本题已记录到 ${failurePath}；下一题将重新启动并校验当前入口`)
              await finishQuestionLogging('question_failed', { failure: failurePath, failure_diagnostics: diagnostics.manifest, error_name: failure.error_name, error_message: failure.error_message })
            },
            checkCancelled,
          })
          completed += entryResult.completed
          failed += entryResult.failed
        }
        const total = entries.length * payload.questions.length
        const summaryPath = path.join(batchArtifacts.diagnosticDirectory, 'batch-summary.json')
        const summary = {
          created_at: new Date().toISOString(),
          serial: payload.serial,
          artifact_layout_version: ARTIFACT_LAYOUT_VERSION,
          batch_directory: batchDirectory,
          delivery_directory: batchArtifacts.deliveryDirectory,
          diagnostic_directory: batchArtifacts.diagnosticDirectory,
          event_log: batchEventLog.filePath,
          entries: entries.map(entry => ({ id: entry.id, label: entry.label, package: entry.packageName })),
          question_count: payload.questions.length,
          total,
          completed,
          failed,
          status: failed ? 'completed_with_failures' : 'completed',
          results,
          failures,
          summary: summaryPath,
        }
        await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf8')
        log(`执行完成：计划=${total}，成功=${completed}，失败=${failed}，批次汇总=${summaryPath}`)
        await batchEventLog.record('batch_result_saved', { category: 'lifecycle', details: { total, completed, failed, summary: summaryPath } })
        return summary
      } catch (error) {
        const diagnostics = await saveFailureDiagnostics(activeQuestionArtifacts || batchArtifacts, error, {
          stem: activeQuestionArtifacts ? '失败现场_致命' : '自动化失败现场',
        })
        await finishQuestionLogging('question_failed', { error_name: error?.name || 'Error', error_message: error?.message || String(error), fatal: true, failure_diagnostics: diagnostics.manifest }).catch(() => {})
        await batchEventLog.record('batch_failed', { category: 'error', details: { error_name: error?.name || 'Error', error_message: error?.message || String(error), failure_diagnostics: diagnostics.manifest } }).catch(() => {})
        await fs.writeFile(path.join(batchArtifacts.diagnosticDirectory, 'automation-failure.json'), JSON.stringify({
          created_at: new Date().toISOString(),
          serial: payload.serial,
          artifact_layout_version: ARTIFACT_LAYOUT_VERSION,
          batch_directory: batchDirectory,
          delivery_directory: batchArtifacts.deliveryDirectory,
          diagnostic_directory: batchArtifacts.diagnosticDirectory,
          event_log: batchEventLog.filePath,
          entry_id: activeEntry.id,
          entry_label: activeEntry.label,
          entry_package: activePackageName(),
          entry_hierarchy_startup_timeout_ms: entryHierarchyStartupTimeout(activeEntry),
          ui_backend: 'python_uiautomator2_strict',
          ui_fallback_enabled: false,
          error_name: error?.name || 'Error',
          error_message: error?.message || String(error),
          stack: error?.stack || null,
          failure_diagnostics: diagnostics,
        }, null, 2), 'utf8').catch(() => {})
        throw error
      } finally {
        await observer.stop().catch(() => {})
        await ui.stop().catch(() => {})
        await flushArtifactLogs().catch(() => {})
      }
    },
    async retryFailedBatch(payload) {
      activeSerial = payload.serial
      payloadMaxLongImageHeight = maxLongImageHeight(payload.maxLongImageHeight)
      const batchDirectory = path.resolve(String(payload.batchDirectory || ''))
      if (!batchDirectory || batchDirectory === path.parse(batchDirectory).root) throw new Error('请选择要重试的原批次。')
      const batchArtifacts = batchArtifactDirectories(batchDirectory)
      const summaryPath = path.join(batchArtifacts.diagnosticDirectory, 'batch-summary.json')
      let previousSummary
      try {
        previousSummary = JSON.parse(await fs.readFile(summaryPath, 'utf8'))
      } catch (error) {
        throw new Error(`无法读取原批次汇总：${error.message}`)
      }
      const retryItems = failedRetryItems(previousSummary)
      if (!retryItems.length) throw new Error('该批次没有可重试的失败题。')
      if (!payload.serial) throw new Error('请选择 Android 设备后再重试失败题。')
      const entriesById = new Map(automationEntries().map(entry => [entry.id, entry]))
      for (const item of retryItems) {
        if (!entriesById.has(item.entry_id)) throw new Error(`原批次使用的入口“${item.entry_id}”已不可用，无法安全重试。`)
      }
      const retryAttempt = retryAttemptCount(previousSummary)
      const results = [...previousSummary.results]
      const retryStartedAt = new Date().toISOString()
      const retryFailures = []
      let completed = Number(previousSummary.completed) || results.filter(result => result.status === 'completed').length
      let failed = 0
      await initializeArtifactLogging(batchArtifacts, payload, 'retry_failed_questions')
      try {
        await waitForAdbDevice(options.adbPath, payload.serial)
        await ui.start(payload.serial)
        try {
          await observer.start(payload.serial)
        } catch (error) {
          await disableObserver(error)
        }
        log(`retry: batch=${batchDirectory} attempt=${retryAttempt} failed_questions=${retryItems.length}`)
        for (const item of retryItems) {
          checkCancelled()
          const entry = entriesById.get(item.entry_id)
          const entryCount = Array.isArray(previousSummary.entries) ? previousSummary.entries.length : 1
          const entryIndex = Math.max(0, (previousSummary.entries || []).findIndex(candidate => candidate.id === entry.id))
          const entryArtifacts = entryArtifactDirectories(batchArtifacts, entryIndex + 1, entry.label, entryCount)
          const artifacts = questionArtifactDirectories(entryArtifacts, item.question_index, item.question)
          const failurePath = path.join(artifacts.diagnosticDirectory, '失败.json')
          await startQuestionLogging(artifacts, {
            batch_id: path.basename(batchDirectory),
            serial: payload.serial,
            entry_id: entry.id,
            entry_label: entry.label,
            question: item.question,
            question_index: item.question_index,
            retry_attempt: retryAttempt,
          })
          try {
            // A failed attempt may have produced partial delivery PNGs. They must
            // never be mistaken for the replacement result of this retry.
            await fs.rm(artifacts.deliveryDirectory, { recursive: true, force: true })
            await prepareEntry(entry)
            log(`retry: [${item.question_index}] ${entry.label} / ${item.question}`)
            const result = await askOnce(payload, artifacts, item.question, item.question_index)
            const replacement = {
              status: 'completed',
              entry_id: entry.id,
              entry_label: entry.label,
              question: item.question,
              question_index: item.question_index,
              delivery_directory: artifacts.deliveryDirectory,
              diagnostic_directory: artifacts.diagnosticDirectory,
              event_log: path.join(artifacts.diagnosticDirectory, '执行日志.jsonl'),
              retry_attempt: retryAttempt,
              retried_at: new Date().toISOString(),
              ...result,
            }
            results[item.resultIndex] = replacement
            completed += 1
            await fs.rename(failurePath, path.join(artifacts.diagnosticDirectory, `失败_重试前_${retryAttempt}.json`)).catch(error => {
              if (error.code !== 'ENOENT') throw error
            })
            await finishQuestionLogging('question_completed', { retry_attempt: retryAttempt, screenshot: result.screenshot, metadata: result.metadata })
          } catch (error) {
            if (fatalBatchError(error)) throw error
            failed += 1
            const diagnostics = await saveFailureDiagnostics(artifacts, error, { stem: `失败现场_重试_${retryAttempt}` })
            const failure = {
              created_at: new Date().toISOString(),
              status: 'failed',
              artifact_layout_version: ARTIFACT_LAYOUT_VERSION,
              serial: payload.serial,
              batch_id: path.basename(batchDirectory),
              question: item.question,
              question_index: item.question_index,
              question_directory: artifacts.diagnosticDirectory,
              delivery_directory: artifacts.deliveryDirectory,
              diagnostic_directory: artifacts.diagnosticDirectory,
              event_log: path.join(artifacts.diagnosticDirectory, '执行日志.jsonl'),
              batch_event_log: batchEventLog.filePath,
              entry_id: entry.id,
              entry_label: entry.label,
              entry_package: entry.packageName,
              entry_hierarchy_startup_timeout_ms: entryHierarchyStartupTimeout(entry),
              retry_attempt: retryAttempt,
              error_name: error?.name || 'Error',
              error_message: error?.message || String(error),
              stack: error?.stack || null,
              failure_diagnostics: diagnostics,
            }
            await fs.mkdir(artifacts.diagnosticDirectory, { recursive: true })
            await fs.writeFile(failurePath, JSON.stringify(failure, null, 2), 'utf8')
            results[item.resultIndex] = {
              status: 'failed', entry_id: entry.id, entry_label: entry.label,
              question: item.question, question_index: item.question_index,
              delivery_directory: artifacts.deliveryDirectory, diagnostic_directory: artifacts.diagnosticDirectory,
              event_log: path.join(artifacts.diagnosticDirectory, '执行日志.jsonl'), failure: failurePath,
              retry_attempt: retryAttempt,
              failure_diagnostics: diagnostics.manifest,
            }
            retryFailures.push({ entry_id: entry.id, entry_label: entry.label, question: item.question, question_index: item.question_index, failure: failurePath, failure_diagnostics: diagnostics.manifest, error_name: failure.error_name, error_message: failure.error_message })
            log(`retry failed: [${item.question_index}] ${entry.label} / ${item.question}: ${failure.error_message}`)
            await finishQuestionLogging('question_failed', { retry_attempt: retryAttempt, failure: failurePath, failure_diagnostics: diagnostics.manifest, error_name: failure.error_name, error_message: failure.error_message })
          }
        }
        const remainingFailures = results.filter(result => result.status === 'failed')
        const summary = {
          ...previousSummary,
          updated_at: new Date().toISOString(),
          serial: payload.serial,
          completed: results.filter(result => result.status === 'completed').length,
          failed: remainingFailures.length,
          status: remainingFailures.length ? 'completed_with_failures' : 'completed',
          results,
          failures: remainingFailures.map(result => retryFailures.find(failure => failure.entry_id === result.entry_id && failure.question_index === result.question_index && failure.question === result.question) || {
            entry_id: result.entry_id, entry_label: result.entry_label, question: result.question,
            question_index: result.question_index, failure: result.failure,
          }),
          retry_count: retryAttempt,
          retry_history: [...(Array.isArray(previousSummary.retry_history) ? previousSummary.retry_history : []), {
            attempt: retryAttempt, started_at: retryStartedAt, finished_at: new Date().toISOString(),
            requested: retryItems.length, completed: retryItems.length - failed, failed,
          }],
          summary: summaryPath,
        }
        await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf8')
        log(`重试完成：本次成功=${retryItems.length - failed}，仍失败=${failed}，原批次汇总=${summaryPath}`)
        await batchEventLog.record('batch_result_saved', { category: 'lifecycle', details: { retry_attempt: retryAttempt, total: summary.total, completed: summary.completed, failed: summary.failed, summary: summaryPath } })
        return summary
      } catch (error) {
        const diagnostics = await saveFailureDiagnostics(activeQuestionArtifacts || batchArtifacts, error, {
          stem: activeQuestionArtifacts ? `失败现场_重试_${retryAttempt}_致命` : `自动化失败现场_重试_${retryAttempt}`,
        })
        await finishQuestionLogging('question_failed', { retry_attempt: retryAttempt, error_name: error?.name || 'Error', error_message: error?.message || String(error), fatal: true, failure_diagnostics: diagnostics.manifest }).catch(() => {})
        await batchEventLog.record('batch_retry_failed', { category: 'error', details: { retry_attempt: retryAttempt, error_name: error?.name || 'Error', error_message: error?.message || String(error), failure_diagnostics: diagnostics.manifest } }).catch(() => {})
        await fs.writeFile(path.join(batchArtifacts.diagnosticDirectory, `retry-automation-failure-${retryAttempt}.json`), JSON.stringify({
          created_at: new Date().toISOString(),
          serial: payload.serial,
          mode: 'retry_failed_questions',
          retry_attempt: retryAttempt,
          artifact_layout_version: ARTIFACT_LAYOUT_VERSION,
          batch_directory: batchDirectory,
          diagnostic_directory: batchArtifacts.diagnosticDirectory,
          event_log: batchEventLog.filePath,
          error_name: error?.name || 'Error',
          error_message: error?.message || String(error),
          stack: error?.stack || null,
          failure_diagnostics: diagnostics,
        }, null, 2), 'utf8').catch(() => {})
        throw error
      } finally {
        await observer.stop().catch(() => {})
        await ui.stop().catch(() => {})
        await flushArtifactLogs().catch(() => {})
      }
    },
    async stop() {
      cancelled = true
      await observer.stop().catch(() => {})
      await ui.stop().catch(() => {})
    },
  }
}

module.exports = {
  createRunner,
  CancelledError,
  DOUYIN_MINIAPP_ENTRY_FILENAME,
  DOUYIN_SEARCH_SUMMARY_FILENAME,
  TOUTIAO_SEARCH_SUMMARY_FILENAME,
  ARTIFACT_LAYOUT_VERSION,
  douyinSearchInput,
  douyinGenericAiAnswerBounds,
  douyinMiniAppEntryBounds,
  douyinOcrViewFullTarget,
  douyinSearchResultTarget,
  douyinSearchResultsBounds,
  douyinViewFullBounds,
  douyinMiniAppCaptureBounds,
  toutiaoGenericConsultationPage,
  miniAppReferenceProductsTrigger,
  toutiaoHomeSearchBounds,
  toutiaoSearchInput,
  toutiaoSearchResultBelongsToQuestion,
  toutiaoViewMoreBounds,
  toutiaoOcrViewMoreTarget,
  waitForPackageHierarchy,
  buildReplyImages,
  conservativeFallbackOverlap,
  chatSwipePlan,
  scrollEndConfirmed,
  referenceProductsTrigger,
  refreshedReferenceProductsTrigger,
  referenceProductDrawerBounds,
  referenceProductsCaptureComplete,
  referenceProductSheetExpanded,
  requireQuestionLocated,
  calibratedProductFallbackOverlap,
  referenceProductViewportReadiness,
  prepareEmbeddedEvidence,
  fillQuestionInput,
  captureStableSandwich,
  captureStableObserved,
  observerRegionFallbackOptions,
  failedRetryItems,
  retryAttemptCount,
  fatalBatchError,
  runQuestionsWithRecovery,
  captureFailureDiagnostics,
  adbConnectionLost,
  historyOnboardingVisible,
  maxLongImageHeight,
}
