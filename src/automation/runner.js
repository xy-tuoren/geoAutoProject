const fs = require('node:fs/promises')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { sleep, createBatchDirectory, batchArtifactDirectories, entryArtifactDirectories, questionArtifactDirectories, taskArtifactDirectories } = require('./utils')
const { normalizeQuestionPlan, brandExecutionUnits, safeDirectorySegment } = require('../question-plan')
const { EventLog } = require('./event-log')
const { iterNodes, nodeAttr, nodeIsVisible, parseBounds, currentQuestionText, findChatScrollBounds, validateCaptureViewport, visibleLabelBounds, boundsForNodeAttribute, responseTimeoutRetryTarget } = require('./hierarchy')
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
  confirmQuestionAtTop,
  scrollSingleQuestionSessionToTop,
  confirmPersistentScrollEnd,
  buildReplyImages,
  prepareEmbeddedEvidence,
  fillQuestionInput,
  captureStableSandwich,
  captureStableObserved,
  observerRegionFallbackOptions,
} = require('./capture-primitives')
const { createCaptureStability } = require('./capture-stability')
const { createReferenceProductCapture } = require('./reference-product-capture')
const { createReplyCapture, miniAppQuestionFirstFrameCropBounds } = require('./reply-capture')
const { createQuestionInputWorkflow } = require('./question-input-workflow')
const { createDouyinSearchWorkflow } = require('./douyin-search-workflow')
const { createToutiaoSearchWorkflow } = require('./toutiao-search-workflow')
const { recoverTimedOutExistingReply } = require('./existing-reply-recovery')
const { createArtifactWriter, ARTIFACT_LAYOUT_VERSION } = require('./artifact-writer')
const { OperationTelemetry } = require('./operation-telemetry')
const { ConsoleLogFormatter } = require('./console-log-formatter')
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

const DEVICE_UNLOCK_TIMEOUT_MS = 60_000
const DEVICE_UNLOCK_POLL_MS = 1_000

async function prepareDeviceForAutomation({
  ui,
  log = () => {},
  record = async () => {},
  onPrepared = () => {},
  checkCancelled = () => {},
  delay = sleep,
  now = Date.now,
  unlockTimeout = DEVICE_UNLOCK_TIMEOUT_MS,
  unlockPollMs = DEVICE_UNLOCK_POLL_MS,
}) {
  const preparation = await ui.prepareDevicePower()
  onPrepared(preparation)
  await record('device_power_prepared', {
    wake_performed: Boolean(preparation.wake_performed),
    screen_was_on: Boolean(preparation.screen_was_on),
    screen_on: Boolean(preparation.screen_on),
    stay_awake_applied: preparation.stay_awake_applied,
    lock_detection_method: preparation.lock_state?.method || 'unknown',
  })
  if (!preparation.screen_on) throw new Error('无法确认手机屏幕已经唤醒，已停止执行。')

  let lockState = preparation.lock_state || { locked: null, method: 'unknown' }
  if (lockState.locked === null || lockState.locked === undefined) {
    throw new Error('无法可靠判断手机是否已经解锁，已停止执行；请先人工解锁手机后重试。')
  }
  log(`device: 手机已唤醒并设置为USB连接期间常亮${preparation.wake_performed ? '（本次已自动亮屏）' : ''}`)
  if (!lockState.locked) return preparation

  log(`waiting: 手机仍处于锁屏状态，请先在设备上完成解锁；将在${Math.round(unlockTimeout / 1_000)}秒内自动继续检测`)
  await record('device_unlock_required', {
    timeout_ms: unlockTimeout,
    detection_method: lockState.method,
  })
  const deadline = now() + unlockTimeout
  while (now() < deadline) {
    checkCancelled()
    await delay(Math.min(unlockPollMs, Math.max(0, deadline - now())))
    checkCancelled()
    lockState = await ui.deviceLockState()
    if (lockState.locked === false) {
      log('device: 已确认手机解锁，继续执行自动化任务')
      await record('device_unlocked', { detection_method: lockState.method })
      return preparation
    }
  }
  throw new Error(`手机仍处于锁屏状态；已等待${Math.round(unlockTimeout / 1_000)}秒，请先解锁手机后重新开始任务。`)
}

function seamDiagnosticsForError(error) {
  const value = error?.replySeamDiagnostics
  if (!value) return {}
  return {
    reply_seam_diagnostics: {
      summary: value.summary,
      diagnostic_directories: value.diagnostics?.map(item => item.directory) || [],
      frame_count: value.details?.frame_count ?? null,
      transition_count: value.details?.transition_count ?? null,
      expected_transition_count: value.details?.expected_transition_count ?? null,
      frame_transition_invariant_valid: value.details?.frame_transition_invariant_valid ?? null,
    },
  }
}

function groupedBrandSummaries(brandGroups, entries, results) {
  return brandGroups.map((brand, brandOffset) => {
    const matches = results.filter(result => result.brand_index === brandOffset + 1)
    return {
      name: brand.brand,
      brand_index: brandOffset + 1,
      directory_name: safeDirectorySegment(brand.brand),
      question_count: brand.questions.length,
      planned: brand.questions.length * entries.length,
      completed: matches.filter(result => result.status === 'completed').length,
      failed: matches.filter(result => result.status === 'failed').length,
      search_results_only: matches.filter(result => result.search_result_only).length,
    }
  })
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
  let currentStage = null
  let preparedDevicePower = null
  const consoleLogFormatter = new ConsoleLogFormatter()
  const telemetry = new OperationTelemetry({
    record: item => {
      batchEventLog?.record(item.event, {
        category: item.category,
        details: item.details,
        context: activeQuestionContext,
      })
      activeQuestionEventLog?.record(item.event, { category: item.category, details: item.details })
    },
  })
  const log = text => {
    const message = String(text)
    const stage = message.match(/^stage:\s*(.+)$/m)
    if (stage) {
      currentStage = stage[1].trim()
      telemetry.markStage(currentStage)
    }
    batchEventLog?.recordMessage(message, activeQuestionContext)
    activeQuestionEventLog?.recordMessage(message)
    const formatted = consoleLogFormatter.format(message)
    if (formatted) options.log(`${formatted}\n`)
  }
  const rawUi = options.uiClient || new U2Client({
    root: options.root,
    isPackaged: options.isPackaged,
    resourcesPath: options.resourcesPath,
    adbPath: options.adbPath,
    log,
  })
  const uiOperations = {
    start: 'ui.start',
    stop: 'ui.stop',
    restart: 'ui.restart',
    dumpHierarchy: 'ui.dump_hierarchy',
    health: 'ui.health',
    currentApp: 'ui.current_app',
    foregroundWindow: 'ui.foreground_window',
    prepareDevicePower: 'ui.prepare_device_power',
    deviceLockState: 'ui.device_lock_state',
    restoreDevicePower: 'ui.restore_device_power',
    ocrRecognize: 'ui.ocr_recognize',
    click: 'ui.click',
    sendKeys: 'ui.send_keys',
    setFocusedText: 'ui.set_focused_text',
    press: 'ui.press',
    appStart: 'ui.app_start',
    appStop: 'ui.app_stop',
  }
  const uiDetails = (method, args) => {
    if (method === 'click') return { x: Math.round(args[0]), y: Math.round(args[1]), coordinate_space: 'uiautomator2_logical_pixels' }
    if (method === 'sendKeys' || method === 'setFocusedText') return { text_length: String(args[0] || '').length, clear: Boolean(args[1]?.clear) }
    if (method === 'press') return { key: args[0] }
    if (method === 'appStart' || method === 'appStop') return { package: args[0] }
    if (method === 'ocrRecognize') return { image_bytes: Buffer.isBuffer(args[0]) ? args[0].length : 0, region: args[1]?.region || null }
    return {}
  }
  const measuredProxy = (target, backend, operations, detailsFor = () => ({})) => new Proxy(target, {
    get(object, property) {
      const value = Reflect.get(object, property, object)
      const operation = operations[property]
      if (!operation || typeof value !== 'function') return typeof value === 'function' ? value.bind(object) : value
      return (...args) => telemetry.measure(operation, () => value.apply(object, args), {
        backend,
        details: detailsFor(property, args),
      })
    },
  })
  const ui = measuredProxy(rawUi, 'python_uiautomator2', uiOperations, uiDetails)
  const ocr = options.ocrRecognizer || new OcrRecognizer({ transport: ui })
  const rawObserver = options.scrcpyObserver || new ScrcpyObserver({
    adbPath: options.adbPath,
    serverPath: bundledScrcpyServer(options),
    log,
  })
  const observer = measuredProxy(rawObserver, 'scrcpy_observer', {
    start: 'scrcpy.start',
    stop: 'scrcpy.stop',
    waitForQuiet: 'scrcpy.wait_quiet',
    waitForNoActivity: 'scrcpy.wait_no_activity',
    waitForActivity: 'scrcpy.wait_activity',
    waitForSettleSince: 'scrcpy.wait_settle',
  }, (_method, args) => ({ options: args.at(-1) && typeof args.at(-1) === 'object' ? args.at(-1) : {} }))
  const checkCancelled = () => { if (cancelled) throw new CancelledError() }
  const emitProgress = value => {
    try { options.progress?.(value) } catch {}
  }

  async function waitForDevice(timeout = 30_000) {
    return telemetry.measure('adb.wait_for_device', () => waitForAdbDevice(options.adbPath, activeSerial, timeout), {
      backend: 'adb',
      details: { timeout_ms: timeout },
    })
  }

  async function prepareConnectedDevice() {
    await prepareDeviceForAutomation({
      ui,
      log,
      checkCancelled,
      onPrepared: preparation => { preparedDevicePower = preparation },
      record: (event, details) => batchEventLog?.record(event, { category: 'device', details }),
    })
  }

  async function restoreConnectedDevice() {
    const preparation = preparedDevicePower
    preparedDevicePower = null
    if (!preparation) return
    let method = 'uiautomator2_sidecar'
    try {
      await ui.restoreDevicePower(preparation.stay_awake_original)
    } catch (sidecarError) {
      // Ctrl+C reaches the CLI and its Python child simultaneously. The
      // sidecar may already be gone, so use ADB only for this idempotent system
      // setting cleanup; never as a click/input/hierarchy fallback.
      const settingArgs = preparation.stay_awake_original === null
        ? ['shell', 'settings', 'delete', 'global', 'stay_on_while_plugged_in']
        : ['shell', 'settings', 'put', 'global', 'stay_on_while_plugged_in', String(preparation.stay_awake_original)]
      await telemetry.measure('adb.restore_device_power', () => adbCommandWithReconnect(options.adbPath, activeSerial, settingArgs), {
        backend: 'adb',
        details: { reason: 'uiautomator2_sidecar_unavailable_during_cleanup' },
      })
      method = 'adb_cleanup_fallback'
      log(`device: uiautomator2退出前未能恢复常亮设置，已通过ADB清理路径恢复（${sidecarError.message}）`)
    }
    log('device: 已恢复任务开始前的屏幕常亮设置')
    await batchEventLog?.record('device_power_restored', {
      category: 'device',
      details: { stay_awake_original: preparation.stay_awake_original, method },
    })
  }

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
    currentStage = null
    activeQuestionContext = { ...context }
    telemetry.beginQuestion(context)
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
    emitProgress({ type: 'question_started', ...context })
  }

  function performanceReportPath(artifacts) {
    return artifacts ? path.join(artifacts.diagnosticDirectory, '性能分析.json') : null
  }

  async function writePerformanceReport(artifacts, status) {
    const performancePath = performanceReportPath(artifacts)
    if (!performancePath) return null
    const performance = { ...telemetry.report({ status }), current_stage: currentStage }
    await fs.mkdir(artifacts.diagnosticDirectory, { recursive: true })
    await fs.writeFile(performancePath, JSON.stringify(performance, null, 2), 'utf8')
    return { path: performancePath, report: performance }
  }

  async function finishQuestionLogging(event, details = {}) {
    if (!activeQuestionEventLog) return
    let performanceResult = null
    let performanceError = null
    try {
      performanceResult = await writePerformanceReport(activeQuestionArtifacts, event === 'question_failed' ? 'failed' : 'completed')
    } catch (error) {
      performanceError = diagnosticError(error)
    }
    const finalDetails = {
      ...details,
      performance_report: performanceResult?.path || performanceReportPath(activeQuestionArtifacts),
      ...(performanceResult ? { performance_summary: performanceResult.report.summary } : {}),
      ...(performanceError ? { performance_report_error: performanceError } : {}),
    }
    await batchEventLog?.record(event, {
      category: event === 'question_failed' ? 'error' : 'lifecycle',
      details: finalDetails,
      context: activeQuestionContext,
    })
    await activeQuestionEventLog.record(event, { category: event === 'question_failed' ? 'error' : 'lifecycle', details: finalDetails })
    await activeQuestionEventLog.flush()
    emitProgress({ type: event, ...activeQuestionContext })
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
      await waitForDevice(10_000)
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
    await telemetry.measure('wait.fallback_sleep', () => sleep(fallbackMs), {
      backend: 'node',
      details: { requested_duration_ms: fallbackMs, reason: 'scrcpy_unavailable_or_unconfirmed' },
    })
    return false
  }

  async function screenshot() {
    checkCancelled()
    adbPngCaptures += 1
    return telemetry.measure('adb.screenshot', () => adbScreenshot(options.adbPath, activeSerial), {
      backend: 'adb',
      details: { format: 'png', coordinate_space: 'adb_screenshot_physical_pixels' },
    })
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
      if (attempt < 2) {
        await telemetry.measure('wait.hierarchy_retry_backoff', () => sleep(120), {
          backend: 'node',
          details: { requested_duration_ms: 120, attempt: attempt + 1 },
        })
      }
    }
    throw new Error(`当前前台页面不是${activePackageLabel()}（层级中缺少 ${activePackageName()}），已停止UI操作。`)
  }

  async function recoverHierarchySource() {
    checkCancelled()
    await ui.restart()
    return source()
  }

  async function tap(x, y) {
    checkCancelled()
    await ui.click(x, y)
  }

  async function swipe(x, fromY, toY, duration = 250) {
    checkCancelled()
    await telemetry.measure('adb.swipe', () => adbCommandWithReconnect(options.adbPath, activeSerial, ['shell', 'input', 'swipe', String(Math.round(x)), String(Math.round(fromY)), String(Math.round(x)), String(Math.round(toY)), String(Math.round(duration))]), {
      backend: 'adb',
      details: { x: Math.round(x), from_y: Math.round(fromY), to_y: Math.round(toY), requested_duration_ms: Math.round(duration), coordinate_space: 'uiautomator2_logical_pixels' },
    })
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
        operationTelemetry: { ...telemetry.snapshot(), current_stage: currentStage },
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
    waitForStableReplyRegionDirect,
    captureReplyRegionSnapshot,
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

  const replyCapture = createReplyCapture({
    source,
    recoverHierarchySource,
    swipeChat,
    windowSize,
    waitForStableReplyRegion,
    waitForStableReplyRegionDirect,
    captureReplyRegionSnapshot,
    tap,
    log,
    captureReferenceProductsAtTrigger,
    screenshot,
    waitForFinalVisualQuiet,
    waitForVisualQuiet,
    ocr,
    setLastOcrDiagnostic: value => { lastOcrDiagnostic = value },
  })
  const {
    scrollQuestionIntoView,
    waitForMiniAppStableRegion,
    captureMiniAppFullAnswerFrames,
  } = replyCapture
  const capturePhase = (operation, stage, capture) => (...args) => {
    currentStage = stage
    telemetry.markStage(stage)
    return telemetry.measure(operation, () => capture(...args), {
      backend: 'automation_state_machine',
      kind: 'phase',
    })
  }
  const captureFullReplyFrames = capturePhase('capture.xiaohe_full_answer', '正在采集小荷回答正文', replyCapture.captureFullReplyFrames)
  const captureDouyinFullAnswerFrames = capturePhase('capture.douyin_full_answer', '正在采集抖音小荷全文', replyCapture.captureDouyinFullAnswerFrames)
  const captureDouyinMiniAppEntryAnswerFrames = capturePhase('capture.douyin_miniapp_answer', '正在采集抖音小程序回答', replyCapture.captureDouyinMiniAppEntryAnswerFrames)
  const captureToutiaoFullAnswerFrames = capturePhase('capture.toutiao_full_answer', '正在采集头条小荷全文', replyCapture.captureToutiaoFullAnswerFrames)


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
    windowSize,
    recordResponseTimeoutRecovery: async (event, details) => {
      await Promise.all([
        batchEventLog?.record(event, { category: 'recovery', details, context: activeQuestionContext }),
        activeQuestionEventLog?.record(event, { category: 'recovery', details }),
      ])
    },
    captureFullReplyFrames,
    getActiveEntry: () => activeEntry,
    getActivePackageName: activePackageName,
    restartDouyinEntry: async () => {
      const entry = activeEntry
      await ui.appStop(entry.packageName)
      await sleep(800)
      await prepareEntry(entry)
    },
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
      throw new Error('当前已有回答采集模式已移除；请提供问题并由程序为每题新建会话后发送。')
      /* c8 ignore start -- retained only to make old packaged callers fail closed during upgrade */
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
      emitProgress({ type: 'initialized', entries: [{ id: requestedEntry.id, label: requestedEntry.label }], question_count: 1, results: [] })
      emitProgress({ type: 'entry_started', entry_id: requestedEntry.id })
      try {
        await waitForDevice()
        await ui.start(payload.serial)
        await prepareConnectedDevice()
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
        let existingReplyRecoveryMeta = {
          existing_reply_timeout_detected: false,
          existing_reply_retry_performed: false,
          existing_reply_retry_attempts: 0,
          existing_reply_retry_succeeded: null,
        }
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
            captureMethod = () => captureDouyinMiniAppEntryAnswerFrames(xml, bounds, question)
          } else captureMethod = () => captureToutiaoFullAnswerFrames(xml, bounds)
        } else {
          const chatBounds = findChatScrollBounds(xml, size)
          validateCaptureViewport(size, chatBounds)
          question = String(payload.questions?.[0] || '').trim()
          if (!question) question = currentQuestionText(xml, chatBounds) || ''
          if (responseTimeoutRetryTarget(xml, chatBounds) && !question) {
            throw new Error('当前已有回答显示响应超时，但无法先确认它对应的问题；为避免对错误会话重新生成，本次未点击重试。')
          }
          const recovery = await recoverTimedOutExistingReply({
            xml,
            chatBounds,
            timeout: payload.timeout * 1_000,
            source,
            tap,
            waitForStableReply,
            log,
            record: (event, details) => batchEventLog.record(event, {
              category: 'recovery',
              details,
              context: {
                entry_id: activeEntry.id,
                entry_label: activeEntry.label,
                question,
                question_index: 1,
              },
            }),
          })
          xml = recovery.xml
          existingReplyRecoveryMeta = recovery.meta
          if (question) {
            if (payload.questions?.[0]) captureMethod = currentQuestion => captureFullReplyFrames(currentQuestion, 30, { singleQuestionSession: true })
          } else {
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
            ...existingReplyRecoveryMeta,
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
        await writePerformanceReport(activeQuestionArtifacts || batchArtifacts, 'failed').catch(() => {})
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
          ...seamDiagnosticsForError(error),
          failure_diagnostics: diagnostics,
          operation_telemetry: { ...telemetry.snapshot(), current_stage: currentStage },
          performance_report: performanceReportPath(activeQuestionArtifacts || batchArtifacts),
        }, null, 2), 'utf8').catch(() => {})
        throw error
      } finally {
        await observer.stop().catch(() => {})
        await restoreConnectedDevice().catch(error => log(`device: 恢复屏幕常亮设置失败：${error.message}`))
        await ui.stop().catch(() => {})
        await flushArtifactLogs().catch(() => {})
      }
      /* c8 ignore stop */
    },
    async run(payload) {
      payload = { ...payload, newSession: true }
      activeSerial = payload.serial
      payloadMaxLongImageHeight = maxLongImageHeight(payload.maxLongImageHeight)
      const entries = normalizeAutomationEntries(payload.entries)
      const questionPlan = normalizeQuestionPlan(payload)
      payload.questions = questionPlan.questions
      payload.brandGroups = questionPlan.brandGroups
      const grouped = questionPlan.mode === 'grouped'
      const executionUnits = brandExecutionUnits(questionPlan)
      const outputRoot = path.resolve(payload.outputDir)
      const batchDirectory = await createBatchDirectory(outputRoot)
      const batchArtifacts = batchArtifactDirectories(batchDirectory)
      await initializeArtifactLogging(batchArtifacts, payload, 'batch_questions')
      const brandManifestPath = grouped ? path.join(batchArtifacts.diagnosticDirectory, '品牌执行清单.json') : null
      if (brandManifestPath) {
        await fs.writeFile(brandManifestPath, JSON.stringify({
          created_at: new Date().toISOString(),
          artifact_layout_version: ARTIFACT_LAYOUT_VERSION,
          execution_order: 'brand_entry_question',
          brand_directory_numbered: false,
          batch_directory: batchDirectory,
          delivery_directory: batchArtifacts.deliveryDirectory,
          diagnostic_directory: batchArtifacts.diagnosticDirectory,
          entries: entries.map((entry, index) => ({ index: index + 1, id: entry.id, label: entry.label })),
          brands: groupedBrandSummaries(questionPlan.brandGroups, entries, []),
          brand_groups: questionPlan.brandGroups,
        }, null, 2), 'utf8')
      }
      emitProgress({ type: 'initialized', entries: entries.map(entry => ({ id: entry.id, label: entry.label })), question_count: questionPlan.tasks.length, results: [] })
      try {
        await waitForDevice()
        await ui.start(payload.serial)
        await prepareConnectedDevice()
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
        for (const [unitIndex, unit] of executionUnits.entries()) {
          if (grouped) {
            log(`brand: [${unitIndex + 1}/${executionUnits.length}] ${unit.brand} questions=${unit.tasks.length}`)
            await batchEventLog.record('brand_started', {
              category: 'lifecycle',
              details: {
                brand: unit.brand,
                brand_sequence: unitIndex + 1,
                brand_count: executionUnits.length,
                question_count: unit.tasks.length,
              },
            })
            emitProgress({ type: 'brand_started', brand: unit.brand, brand_sequence: unitIndex + 1, brand_count: executionUnits.length })
          }
          for (const [entryIndex, entry] of entries.entries()) {
            checkCancelled()
            emitProgress({ type: 'entry_started', entry_id: entry.id })
            log(`entry: [${entryIndex + 1}/${entries.length}] ${entry.label} package=${entry.packageName}${grouped ? ` brand=${unit.brand}` : ''}`)
            const entryResult = await runQuestionsWithRecovery({
              questions: unit.tasks,
              beforeQuestion: async task => {
                const artifacts = taskArtifactDirectories(batchArtifacts, entryIndex + 1, entry.label, entries.length, task, grouped)
                const taskContext = grouped ? {
                  brand: task.brand,
                  brand_index: task.brand_index,
                  question_index_in_brand: task.question_index_in_brand,
                  global_question_index: task.global_question_index,
                } : {}
                await startQuestionLogging(artifacts, {
                  batch_id: path.basename(batchDirectory),
                  serial: payload.serial,
                  entry_id: entry.id,
                  entry_label: entry.label,
                  question: task.question,
                  question_index: task.question_index,
                  ...taskContext,
                })
                log(`[${entryIndex + 1}/${entries.length} ${task.question_index}/${questionPlan.tasks.length}] task ready via ${entry.label}: ${task.question}`)
              },
              prepare: () => prepareEntry(entry),
              execute: async task => {
                const artifacts = taskArtifactDirectories(batchArtifacts, entryIndex + 1, entry.label, entries.length, task, grouped)
                const taskContext = grouped ? {
                  brand: task.brand,
                  brand_index: task.brand_index,
                  question_index_in_brand: task.question_index_in_brand,
                  global_question_index: task.global_question_index,
                } : {}
                log(`[${entryIndex + 1}/${entries.length} ${task.question_index}/${questionPlan.tasks.length}] asking via ${entry.label}: ${task.question}`)
                const result = await askOnce({ ...payload, taskContext }, artifacts, task.question, task.question_index)
                log(JSON.stringify(result))
                results.push({
                  status: 'completed',
                  entry_id: entry.id,
                  entry_label: entry.label,
                  question: task.question,
                  question_index: task.question_index,
                  ...taskContext,
                  delivery_directory: artifacts.deliveryDirectory,
                  diagnostic_directory: artifacts.diagnosticDirectory,
                  event_log: path.join(artifacts.diagnosticDirectory, '执行日志.jsonl'),
                  ...result,
                })
                await finishQuestionLogging('question_completed', { screenshot: result.screenshot, metadata: result.metadata })
              },
              recordFailure: async (error, task) => {
                const artifacts = taskArtifactDirectories(batchArtifacts, entryIndex + 1, entry.label, entries.length, task, grouped)
                const taskContext = grouped ? {
                  brand: task.brand,
                  brand_index: task.brand_index,
                  question_index_in_brand: task.question_index_in_brand,
                  global_question_index: task.global_question_index,
                } : {}
                const directory = artifacts.diagnosticDirectory
                const failurePath = path.join(directory, '失败.json')
                const diagnostics = await saveFailureDiagnostics(artifacts, error)
                const failure = {
                  created_at: new Date().toISOString(),
                  status: 'failed',
                  artifact_layout_version: ARTIFACT_LAYOUT_VERSION,
                  serial: payload.serial,
                  batch_id: path.basename(batchDirectory),
                  question: task.question,
                  question_index: task.question_index,
                  ...taskContext,
                  question_directory: directory,
                  delivery_directory: artifacts.deliveryDirectory,
                  diagnostic_directory: artifacts.diagnosticDirectory,
                  event_log: path.join(directory, '执行日志.jsonl'),
                  performance_report: performanceReportPath(artifacts),
                  batch_event_log: batchEventLog.filePath,
                  entry_id: entry.id,
                  entry_label: entry.label,
                  entry_package: entry.packageName,
                  entry_hierarchy_startup_timeout_ms: entryHierarchyStartupTimeout(entry),
                  batch_continued: true,
                  error_name: error?.name || 'Error',
                  error_message: error?.message || String(error),
                  stack: error?.stack || null,
                  ...seamDiagnosticsForError(error),
                  failure_diagnostics: diagnostics,
                  operation_telemetry: { ...telemetry.snapshot(), current_stage: currentStage },
                }
                await fs.mkdir(directory, { recursive: true })
                await fs.writeFile(failurePath, JSON.stringify(failure, null, 2), 'utf8')
                failures.push({
                  entry_id: entry.id,
                  entry_label: entry.label,
                  question: task.question,
                  question_index: task.question_index,
                  ...taskContext,
                  failure: failurePath,
                  error_name: failure.error_name,
                  error_message: failure.error_message,
                  failure_diagnostics: diagnostics.manifest,
                })
                results.push({
                  status: 'failed',
                  entry_id: entry.id,
                  entry_label: entry.label,
                  question: task.question,
                  question_index: task.question_index,
                  ...taskContext,
                  delivery_directory: artifacts.deliveryDirectory,
                  diagnostic_directory: artifacts.diagnosticDirectory,
                  event_log: path.join(directory, '执行日志.jsonl'),
                  performance_report: performanceReportPath(artifacts),
                  failure: failurePath,
                  failure_diagnostics: diagnostics.manifest,
                })
                log(`failed: [${entryIndex + 1}/${entries.length} ${task.question_index}/${questionPlan.tasks.length}] ${entry.label} / ${task.question}: ${failure.error_message}`)
                log(`recovery: 本题已记录到 ${failurePath}；下一题将重新启动并校验当前入口`)
                await finishQuestionLogging('question_failed', { failure: failurePath, failure_diagnostics: diagnostics.manifest, error_name: failure.error_name, error_message: failure.error_message })
              },
              checkCancelled,
            })
            completed += entryResult.completed
            failed += entryResult.failed
          }
        }
        const total = entries.length * questionPlan.tasks.length
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
          question_plan_mode: questionPlan.mode,
          brand_groups: questionPlan.brandGroups,
          brand_manifest: brandManifestPath,
          brands: grouped ? groupedBrandSummaries(questionPlan.brandGroups, entries, results) : [],
          question_count: questionPlan.tasks.length,
          total,
          completed,
          failed,
          search_results_only: results.filter(result => result.search_result_only).length,
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
        await writePerformanceReport(activeQuestionArtifacts || batchArtifacts, 'failed').catch(() => {})
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
          ...seamDiagnosticsForError(error),
          failure_diagnostics: diagnostics,
          operation_telemetry: { ...telemetry.snapshot(), current_stage: currentStage },
          performance_report: performanceReportPath(activeQuestionArtifacts || batchArtifacts),
        }, null, 2), 'utf8').catch(() => {})
        throw error
      } finally {
        await observer.stop().catch(() => {})
        await restoreConnectedDevice().catch(error => log(`device: 恢复屏幕常亮设置失败：${error.message}`))
        await ui.stop().catch(() => {})
        await flushArtifactLogs().catch(() => {})
      }
    },
    async retryFailedBatch(payload) {
      payload = { ...payload, newSession: true }
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
      const grouped = previousSummary.question_plan_mode === 'grouped'
      const results = [...previousSummary.results]
      const retryStartedAt = new Date().toISOString()
      const retryFailures = []
      let completed = Number(previousSummary.completed) || results.filter(result => result.status === 'completed').length
      let failed = 0
      await initializeArtifactLogging(batchArtifacts, payload, 'retry_failed_questions')
      emitProgress({
        type: 'initialized',
        entries: (previousSummary.entries || []).map(entry => ({ id: entry.id, label: entry.label })),
        question_count: previousSummary.question_count || Math.max(0, ...results.map(result => Number(result.question_index) || 0)),
        results,
      })
      try {
        await waitForDevice()
        await ui.start(payload.serial)
        await prepareConnectedDevice()
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
          const task = {
            question: item.question,
            question_index: item.question_index,
            global_question_index: item.global_question_index || item.question_index,
            question_index_in_brand: item.question_index_in_brand,
            brand: item.brand,
            brand_index: item.brand_index,
          }
          const taskContext = grouped ? {
            brand: task.brand,
            brand_index: task.brand_index,
            question_index_in_brand: task.question_index_in_brand,
            global_question_index: task.global_question_index,
          } : {}
          const artifacts = taskArtifactDirectories(batchArtifacts, entryIndex + 1, entry.label, entryCount, task, grouped)
          const failurePath = path.join(artifacts.diagnosticDirectory, '失败.json')
          await startQuestionLogging(artifacts, {
            batch_id: path.basename(batchDirectory),
            serial: payload.serial,
            entry_id: entry.id,
            entry_label: entry.label,
            question: item.question,
            question_index: item.question_index,
            ...taskContext,
            retry_attempt: retryAttempt,
          })
          try {
            // A failed attempt may have produced partial delivery PNGs. They must
            // never be mistaken for the replacement result of this retry.
            await fs.rm(artifacts.deliveryDirectory, { recursive: true, force: true })
            await prepareEntry(entry)
            log(`retry: [${item.question_index}] ${entry.label} / ${item.question}`)
            const result = await askOnce({ ...payload, taskContext }, artifacts, item.question, item.question_index)
            const replacement = {
              status: 'completed',
              entry_id: entry.id,
              entry_label: entry.label,
              question: item.question,
              question_index: item.question_index,
              ...taskContext,
              delivery_directory: artifacts.deliveryDirectory,
              diagnostic_directory: artifacts.diagnosticDirectory,
              event_log: path.join(artifacts.diagnosticDirectory, '执行日志.jsonl'),
              performance_report: performanceReportPath(artifacts),
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
              ...taskContext,
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
              ...seamDiagnosticsForError(error),
              failure_diagnostics: diagnostics,
              operation_telemetry: { ...telemetry.snapshot(), current_stage: currentStage },
            }
            await fs.mkdir(artifacts.diagnosticDirectory, { recursive: true })
            await fs.writeFile(failurePath, JSON.stringify(failure, null, 2), 'utf8')
            results[item.resultIndex] = {
              status: 'failed', entry_id: entry.id, entry_label: entry.label,
              question: item.question, question_index: item.question_index,
              ...taskContext,
              delivery_directory: artifacts.deliveryDirectory, diagnostic_directory: artifacts.diagnosticDirectory,
              event_log: path.join(artifacts.diagnosticDirectory, '执行日志.jsonl'), failure: failurePath,
              performance_report: performanceReportPath(artifacts),
              retry_attempt: retryAttempt,
              failure_diagnostics: diagnostics.manifest,
            }
            retryFailures.push({ entry_id: entry.id, entry_label: entry.label, question: item.question, question_index: item.question_index, ...taskContext, failure: failurePath, failure_diagnostics: diagnostics.manifest, error_name: failure.error_name, error_message: failure.error_message })
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
          search_results_only: results.filter(result => result.search_result_only).length,
          status: remainingFailures.length ? 'completed_with_failures' : 'completed',
          results,
          brands: previousSummary.question_plan_mode === 'grouped'
            ? groupedBrandSummaries(previousSummary.brand_groups || [], previousSummary.entries || [], results)
            : [],
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
        await writePerformanceReport(activeQuestionArtifacts || batchArtifacts, 'failed').catch(() => {})
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
          ...seamDiagnosticsForError(error),
          failure_diagnostics: diagnostics,
          operation_telemetry: { ...telemetry.snapshot(), current_stage: currentStage },
          performance_report: performanceReportPath(activeQuestionArtifacts || batchArtifacts),
        }, null, 2), 'utf8').catch(() => {})
        throw error
      } finally {
        await observer.stop().catch(() => {})
        await restoreConnectedDevice().catch(error => log(`device: 恢复屏幕常亮设置失败：${error.message}`))
        await ui.stop().catch(() => {})
        await flushArtifactLogs().catch(() => {})
      }
    },
    async stop() {
      cancelled = true
      await observer.stop().catch(() => {})
      await restoreConnectedDevice().catch(error => log(`device: 恢复屏幕常亮设置失败：${error.message}`))
      await ui.stop().catch(() => {})
    },
    restoreDevicePowerOnProcessExit() {
      const preparation = preparedDevicePower
      preparedDevicePower = null
      if (!preparation || !activeSerial) return false
      const settingArgs = preparation.stay_awake_original === null
        ? ['shell', 'settings', 'delete', 'global', 'stay_on_while_plugged_in']
        : ['shell', 'settings', 'put', 'global', 'stay_on_while_plugged_in', String(preparation.stay_awake_original)]
      execFileSync(options.adbPath, ['-s', activeSerial, ...settingArgs], {
        encoding: 'utf8',
        timeout: 5_000,
        windowsHide: true,
      })
      return true
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
  groupedBrandSummaries,
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
  miniAppQuestionFirstFrameCropBounds,
  toutiaoHomeSearchBounds,
  toutiaoSearchInput,
  toutiaoSearchResultBelongsToQuestion,
  toutiaoViewMoreBounds,
  toutiaoOcrViewMoreTarget,
  waitForPackageHierarchy,
  prepareDeviceForAutomation,
  DEVICE_UNLOCK_TIMEOUT_MS,
  DEVICE_UNLOCK_POLL_MS,
  buildReplyImages,
  conservativeFallbackOverlap,
  chatSwipePlan,
  scrollEndConfirmed,
  confirmQuestionAtTop,
  scrollSingleQuestionSessionToTop,
  confirmPersistentScrollEnd,
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
