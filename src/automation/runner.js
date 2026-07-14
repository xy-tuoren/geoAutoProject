const fs = require('node:fs/promises')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { sleep, createBatchDirectory, questionArtifactDirectory } = require('./utils')
const { iterNodes, nodeAttr, hierarchyIsLoading, parseBounds, boundsIntersect, boundsCenterY, estimateVerticalScrollShift, questionVisible, currentQuestionText, findChatScrollBounds, validateCaptureViewport, replyCaptureBounds, visibleLabelBounds, visibleLabelBoundsList, boundsForNodeAttribute, evidencePanelBounds, evidenceMinimumHeight, referenceProductsSection, referenceProductImageBounds } = require('./hierarchy')
const { imageInfo, cropImage, imagesSimilar, imageRegionsStable, imageLooksLoaded, verifyFrameOverlap, verifyProductGridOverlap, composeLongImages } = require('./images')
const { U2Client } = require('./u2-client')
const { ScrcpyObserver, SCRCPY_VERSION } = require('./scrcpy-observer')
const { bundledScrcpyServer } = require('../runtime-paths')

const DEFAULT_PACKAGE = 'com.aurora.xiaohe.aidoctor'
const DEFAULT_MAX_LONG_IMAGE_HEIGHT = 12_000
const REPLY_STABLE_QUIET_MS = 3_000

function hierarchyBelongsToPackage(xml, packageName = DEFAULT_PACKAGE) {
  return iterNodes(String(xml)).some(node => nodeAttr(node, 'package') === packageName)
}

function maxLongImageHeight(value) {
  const parsed = Number(value ?? DEFAULT_MAX_LONG_IMAGE_HEIGHT)
  if (!Number.isInteger(parsed) || parsed < 3_000 || parsed > 30_000) throw new Error('长截图最大高度必须是 3000–30000 之间的整数。')
  return parsed
}

function historyOnboardingVisible(xml) {
  return /在这里查看[「"]?历史对话/.test(String(xml))
}

function adbCommand(adbPath, serial, args) {
  return new Promise((resolve, reject) => {
    execFile(adbPath, ['-s', serial, ...args], { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${error.message}: ${String(stderr || stdout).trim()}`))
      else resolve(String(stdout))
    })
  })
}

function adbBinaryCommand(adbPath, serial, args) {
  return new Promise((resolve, reject) => {
    execFile(adbPath, ['-s', serial, ...args], { encoding: null, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${error.message}: ${Buffer.from(stderr || stdout || '').toString('utf8').trim()}`))
      else resolve(Buffer.from(stdout))
    })
  })
}

async function adbScreenshot(adbPath, serial) {
  await waitForAdbDevice(adbPath, serial)
  try {
    return await adbBinaryCommand(adbPath, serial, ['exec-out', 'screencap', '-p'])
  } catch (error) {
    if (!adbConnectionLost(error)) throw error
    await waitForAdbDevice(adbPath, serial)
    return adbBinaryCommand(adbPath, serial, ['exec-out', 'screencap', '-p'])
  }
}

function adbConnectionLost(error) {
  return /device (?:not found|offline)|closed|no devices\/emulators found/i.test(String(error?.message || error))
}

async function waitForAdbDevice(adbPath, serial, timeout = 30_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try {
      if ((await adbCommand(adbPath, serial, ['get-state'])).trim() === 'device') return
    } catch {}
    await sleep(1_000)
  }
  throw new Error(`ADB 设备 ${serial} 未连接或未授权。请重新插拔 USB 数据线并在手机上确认“允许 USB 调试”。`)
}

async function adbCommandWithReconnect(adbPath, serial, args) {
  await waitForAdbDevice(adbPath, serial)
  try {
    return await adbCommand(adbPath, serial, args)
  } catch (error) {
    if (!adbConnectionLost(error)) throw error
    await waitForAdbDevice(adbPath, serial)
    return adbCommand(adbPath, serial, args)
  }
}

class CancelledError extends Error { constructor() { super('任务已停止。'); this.name = 'CancelledError' } }

function fallbackOverlapEstimates(frameHeight, measuredShift, candidateOverlaps = []) {
  const hasMeasuredShift = Number.isFinite(measuredShift) && measuredShift >= 0 && measuredShift < frameHeight
  const candidates = candidateOverlaps
    .filter(value => Number.isFinite(value) && value >= 0 && value < frameHeight)
    .sort((a, b) => a - b)
  const estimates = candidates.length >= 2 && candidates.at(-1) - candidates[0] <= 3 ? candidates : []
  if (hasMeasuredShift) estimates.push(frameHeight - measuredShift)
  return { estimates, hasMeasuredShift }
}

function conservativeFallbackOverlap(frameHeight, measuredShift, _requestedShift, candidateOverlaps = []) {
  const { estimates, hasMeasuredShift } = fallbackOverlapEstimates(frameHeight, measuredShift, candidateOverlaps)
  if (!estimates.length) return 0
  // Crop no farther than the smallest independent overlap estimate, leaving
  // roughly two text lines as insurance against hierarchy/layout jitter.
  const uncertainty = hasMeasuredShift
    ? Math.max(72, Math.ceil(frameHeight * 0.06))
    : Math.max(96, Math.ceil(frameHeight * 0.08))
  return Math.max(0, Math.floor(Math.min(...estimates) - uncertainty))
}

function chatSwipePlan(bounds, fraction = 0.6, { maxFraction = 0.7, speed = 1400 } = {}) {
  const height = bounds[3] - bounds[1]
  const distance = Math.max(80, Math.floor(height * Math.min(maxFraction, Math.max(0.2, fraction))))
  return { distance, percent: distance / height, speed, durationMs: distance / speed * 1_000 }
}

function scrollEndConfirmed(canScrollMore, unchangedCount) {
  return canScrollMore === false || unchangedCount >= 2
}

function referenceProductsTrigger(xml, chatBounds) {
  for (const label of ['参考药品', '推荐药品']) {
    const bounds = visibleLabelBounds(xml, label)
    if (!bounds || !boundsIntersect(bounds, chatBounds)) continue
    const centerY = boundsCenterY(bounds)
    const exact = iterNodes(xml).map(attrs => ({
      clickable: nodeAttr(attrs, 'clickable') === 'true',
      rawBounds: nodeAttr(attrs, 'bounds'),
    })).filter(item => item.clickable && item.rawBounds).map(item => parseBounds(item.rawBounds)).filter(candidate =>
      candidate[0] >= bounds[2] - 20
      && candidate[1] <= centerY
      && candidate[3] >= centerY
      && boundsIntersect(candidate, chatBounds))
      .sort((a, b) => a[0] - b[0])[0]
    if (exact) return [Math.floor((exact[0] + exact[2]) / 2), Math.floor((exact[1] + exact[3]) / 2)]
    return [chatBounds[2] - Math.max(20, Math.floor((chatBounds[2] - chatBounds[0]) / 15)), boundsCenterY(bounds)]
  }
  const section = referenceProductsSection(xml)
  if (section && boundsIntersect(section.panel, chatBounds)) return section.tap
  return null
}

function referenceProductsCaptureComplete({ detected, products }) {
  return !detected || Boolean(products?.firstViewportIncluded && products?.imagesReady && products?.confirmedEnd && products?.continuityVerified)
}

function calibratedProductFallbackOverlap(overlaps) {
  const recent = overlaps.filter(Number.isFinite).slice(-8)
  if (recent.length < 3) return null
  const low = Math.min(...recent)
  const high = Math.max(...recent)
  if (high - low > 64) return null
  // Prefer a few pixels of harmless duplicate background over cutting into a
  // product row when the current overlap contains animated/lazy artwork.
  return Math.max(0, low - 8)
}

async function referenceProductViewportReadiness(frame, xml, listBounds) {
  const candidates = referenceProductImageBounds(xml, listBounds)
  const frameSize = await imageInfo(frame)
  const relativeBounds = candidates.bounds.map(bounds => [
    Math.max(0, bounds[0] - listBounds[0]),
    Math.max(0, bounds[1] - listBounds[1]),
    Math.min(frameSize.width, bounds[2] - listBounds[0]),
    Math.min(frameSize.height, bounds[3] - listBounds[1]),
  ]).filter(bounds => bounds[2] - bounds[0] >= 60 && bounds[3] - bounds[1] >= 45)
  const loadedFlags = await Promise.all(relativeBounds.map(async bounds => imageLooksLoaded(await cropImage(frame, bounds))))
  const loaded = loadedFlags.filter(Boolean).length
  const viewportLoaded = relativeBounds.length ? true : await imageLooksLoaded(frame)
  const ready = relativeBounds.length ? loaded === relativeBounds.length : viewportLoaded
  return {
    ready,
    mode: candidates.mode,
    cards: visibleLabelBoundsList(xml, '查看说明书').filter(bounds => boundsIntersect(bounds, listBounds)).length || relativeBounds.length,
    images: relativeBounds.length,
    loaded,
    unloaded: relativeBounds.length ? relativeBounds.length - loaded : (ready ? 0 : 1),
  }
}

async function buildReplyImages(frames, { transitions = [], maxHeight = DEFAULT_MAX_LONG_IMAGE_HEIGHT } = {}) {
  return composeLongImages(frames, { transitions, maxHeight, separatorHeight: 24 })
}

async function prepareEmbeddedEvidence({ source, tap, delay, waitForStable, log }, bounds) {
  const minimum = evidenceMinimumHeight(bounds)
  const xml = await source()
  const panel = evidencePanelBounds(xml, minimum)
  if (!panel) return { found: false, expanded: false, capture: await waitForStable(bounds) }
  const viewportHeight = bounds[3] - bounds[1]
  const collapsed = panel[3] - panel[1] <= viewportHeight * 0.16
  if (collapsed) {
    log('capture: 在回答截图前展开引用资料，使其直接进入回答长图')
    await tap((panel[0] + panel[2]) / 2, (panel[1] + panel[3]) / 2)
    await delay(800)
  }
  const capture = await waitForStable(bounds)
  const finalPanel = evidencePanelBounds(capture.xml || '', minimum)
  const expanded = Boolean(finalPanel && finalPanel[3] - finalPanel[1] > viewportHeight * 0.16)
  if (expanded) log('capture: 引用资料已展开并合并到回答截图')
  else if (collapsed) log('capture: 引用资料点击后未确认展开，保留当前状态继续回答截图')
  return { found: true, expanded, capture }
}

async function fillQuestionInput({ ui, tap, source, delay = sleep }, edit, question) {
  await tap((edit.bounds[0] + edit.bounds[2]) / 2, (edit.bounds[1] + edit.bounds[3]) / 2)
  await delay(300)
  await ui.sendKeys(question, { clear: Boolean(edit.text) })
  // FastInputIME has no visible keyboard on this device. Pressing Back after
  // sendKeys exits the app instead of hiding an IME, so let sendKeys restore
  // the user's original IME and confirm the target hierarchy directly.
  await delay(350)
  return source()
}

async function captureStableSandwich({
  capture,
  hierarchy,
  framesStable,
  hierarchyLoading,
  delay = sleep,
  now = Date.now,
  interval = 80,
  initialFrame = null,
  initialXml = '',
}, timeout = 8_000) {
  let before = initialFrame || await capture()
  let lastXml = initialXml
  let attempts = 0
  const deadline = now() + timeout
  while (now() < deadline) {
    await delay(interval)
    // The first frame is taken before hierarchy collection and the second
    // immediately after it. This preserves the screenshot→XML→screenshot
    // reflow guard while avoiding a third ADB screenshot on stable pages.
    lastXml = await hierarchy()
    const after = await capture()
    attempts += 1
    if (!hierarchyLoading(lastXml) && await framesStable(before, after)) {
      return { frame: after, xml: lastXml, stable: true, attempts }
    }
    before = after
  }
  return { frame: before, xml: lastXml || await hierarchy(), stable: false, attempts }
}

async function captureStableObserved({
  observer,
  capture,
  hierarchy,
  hierarchyLoading,
  settleSince = null,
  now = Date.now,
  settleWaitCap = 2_500,
  settleQuietMs = 650,
  settleConservativeQuietMs = 1_000,
  confirmQuietMs = 300,
}, timeout = 3_500) {
  const deadline = now() + timeout
  const remaining = deadline - now()
  if (remaining <= 0) {
    return { frame: null, xml: '', stable: false, attempts: 0, observer: true, reason: 'observer_timeout' }
  }
  // scrcpy is the cheap first gate, but it must leave time for XML and PNG
  // confirmation after the quiet window; otherwise strict quiet checks turn
  // into avoidable capture_deadline fallbacks.
  const reserveForCapture = Math.min(1_000, Math.max(confirmQuietMs + 150, Math.floor(remaining * 0.28)))
  const initialWaitTimeout = Math.max(1, Math.min(settleWaitCap, remaining - reserveForCapture))
  const settled = settleSince && typeof observer.waitForSettleSince === 'function'
    ? await observer.waitForSettleSince(settleSince, {
        hardTimeout: initialWaitTimeout,
        quietMs: settleQuietMs,
        conservativeQuietMs: settleConservativeQuietMs,
      })
    : typeof observer.waitForNoActivity === 'function'
      ? await observer.waitForNoActivity({
          timeout: initialWaitTimeout,
          quietMs: settleQuietMs,
          minWaitMs: Math.min(120, initialWaitTimeout),
        })
      : await observer.waitForQuiet({
          timeout: initialWaitTimeout,
          windowMs: settleQuietMs,
          quietMs: settleQuietMs,
          maxFrames: 0,
          minWaitMs: Math.min(120, initialWaitTimeout),
        })
  if (!(settled.settled ?? settled.quiet)) {
    return { frame: null, xml: '', stable: false, attempts: 0, observer: true, reason: 'settle_timeout' }
  }

  const mark = observer.mark()
  const xml = await hierarchy()
  const frame = await capture()
  const confirmRemaining = Math.min(800, deadline - now())
  if (confirmRemaining <= 0) {
    return { frame, xml, stable: false, attempts: 1, observer: true, reason: 'capture_deadline' }
  }
  const confirmed = typeof observer.waitForNoActivity === 'function'
    ? await observer.waitForNoActivity({
        timeout: confirmRemaining,
        quietMs: confirmQuietMs,
        minWaitMs: Math.min(confirmQuietMs, confirmRemaining),
      })
    : await observer.waitForQuiet({
        timeout: confirmRemaining,
        windowMs: confirmQuietMs,
        quietMs: confirmQuietMs,
        maxFrames: 0,
        minWaitMs: Math.min(confirmQuietMs, confirmRemaining),
      })
  const currentMark = observer.mark()
  const activityFramesDuringCapture = (currentMark.activityFrameCount ?? currentMark.frameCount)
    - (mark.activityFrameCount ?? mark.frameCount)
  const loading = hierarchyLoading(xml)
  if (!loading && confirmed.quiet && activityFramesDuringCapture === 0) {
    return { frame, xml, stable: true, attempts: 1, observer: true }
  }
  const reason = loading
    ? 'hierarchy_loading'
    : (!confirmed.quiet ? 'confirmation_timeout' : 'capture_activity')
  return { frame, xml, stable: false, attempts: 1, observer: true, reason }
}

function createRunner(options) {
  let cancelled = false
  let activeSerial = null
  let cachedInputBounds = null
  let cachedSendBounds = null
  let observerFallbackReason = null
  let observerFallbackLogged = false
  let observerRecoveryAttempts = 0
  let observerRecoverySuccesses = 0
  let observerRecoveryFailures = 0
  let observerRegionFallbacks = 0
  let adbPngCaptures = 0
  const log = text => options.log(`${text}${String(text).endsWith('\n') ? '' : '\n'}`)
  const ui = options.uiClient || new U2Client({
    root: options.root,
    isPackaged: options.isPackaged,
    resourcesPath: options.resourcesPath,
    adbPath: options.adbPath,
    log: options.log,
  })
  const observer = options.scrcpyObserver || new ScrcpyObserver({
    adbPath: options.adbPath,
    serverPath: bundledScrcpyServer(options),
    log,
  })
  const checkCancelled = () => { if (cancelled) throw new CancelledError() }

  function recoverySnapshot() {
    return {
      attempts: observerRecoveryAttempts,
      successes: observerRecoverySuccesses,
      failures: observerRecoveryFailures,
      regionFallbacks: observerRegionFallbacks,
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
      if (hierarchyBelongsToPackage(xml)) return xml
      if (attempt < 2) await sleep(120)
    }
    throw new Error(`当前前台页面不是小荷App（层级中缺少 ${DEFAULT_PACKAGE}），已停止UI操作。`)
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

  async function waitForInput(timeout = 10_000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      checkCancelled()
      const xml = await source()
      if (historyOnboardingVisible(xml)) {
        const size = await windowSize()
        // The first-launch history hint is a full-screen Compose overlay. Tap
        // a neutral blank area to dismiss it before looking up the input.
        await tap(Math.floor(size.width * 0.8), Math.floor(size.height * 0.22))
        log('已关闭“历史对话”首次引导')
        await sleep(500)
        continue
      }
      const editBounds = boundsForNodeAttribute(xml, 'class', 'android.widget.EditText')
      if (editBounds) {
        cachedInputBounds = editBounds
        cachedSendBounds = boundsForNodeAttribute(xml, 'content-desc', '发送')
        const attrs = iterNodes(xml).find(item => nodeAttr(item, 'class') === 'android.widget.EditText')
        return { bounds: editBounds, text: attrs ? nodeAttr(attrs, 'text') : '' }
      }
      const hint = visibleLabelBounds(xml, '输入问题')
      if (hint) { await tap((hint[0] + hint[2]) / 2, (hint[1] + hint[3]) / 2); await sleep(500) }
      await sleep(500)
    }
    throw new Error('未能在小荷聊天页面找到输入框。')
  }

  async function inputQuestion(question) {
    const edit = await waitForInput()
    // Use uiautomator2's device-level IME/clipboard input rather than a
    // WebDriver element value command. Mutating UI requests are not replayed
    // after failure, so an uncertain input state terminates the task.
    const restoredXml = await fillQuestionInput({ ui, tap, source }, edit, question)
    cachedInputBounds = boundsForNodeAttribute(restoredXml, 'class', 'android.widget.EditText') || cachedInputBounds
    cachedSendBounds = boundsForNodeAttribute(restoredXml, 'content-desc', '发送') || cachedSendBounds
  }

  async function tapSend() {
    // The send control is already present in the hierarchy read by
    // waitForInput, so use the cached hit target without a second lookup.
    if (cachedSendBounds) {
      const x = Math.round((cachedSendBounds[0] + cachedSendBounds[2]) / 2)
      const y = Math.round((cachedSendBounds[1] + cachedSendBounds[3]) / 2)
      await tap(x, y)
      return
    }
    if (!cachedInputBounds) await waitForInput()
    const [left, top, right, bottom] = cachedInputBounds
    const height = bottom - top
    const x = Math.round(right - Math.min(80, height * 0.24))
    const y = Math.round(bottom + Math.min(48, height * 0.2))
    await tap(x, y)
  }

  async function tapNewSession() {
    // Compose exposes the icon's label on a non-clickable child while its
    // clickable hit target is the parent. Clicking the label works on some
    // devices but silently fails on others, so prefer the parent when present.
    const newSession = boundsForNodeAttribute(await source(), 'content-desc', '开启新会话')
    if (!newSession) return false
    await tap((newSession[0] + newSession[2]) / 2, (newSession[1] + newSession[3]) / 2)
    await waitForVisualQuiet({ timeout: 1_200, fallbackMs: 1_000 })
    for (const text of ['确定', '确认', '开始', '新会话']) {
      const button = visibleLabelBounds(await source(), text)
      if (button) {
        await tap((button[0] + button[2]) / 2, (button[1] + button[3]) / 2)
        await waitForVisualQuiet({ timeout: 1_200, fallbackMs: 1_000 })
        break
      }
    }
    return true
  }

  async function normalizedHierarchy() {
    return (await source()).replace(/focused="(?:true|false)"/g, 'focused=""').replace(/selected="(?:true|false)"/g, 'selected=""')
  }

  async function waitForStableReplyPixels(timeout, { minWait = 12_000 } = {}) {
    const stableMilliseconds = REPLY_STABLE_QUIET_MS
    const pollInterval = 1_500
    const start = Date.now()
    let lastChange = start
    let lastXml = ''
    let lastFrame = null
    let lastProgress = 0
    while (Date.now() - start < timeout) {
      checkCancelled()
      const frame = await screenshot()
      const now = Date.now()
      const pixelsStable = lastFrame && await imageRegionsStable(lastFrame, frame)
      lastFrame = frame
      if (!pixelsStable) lastChange = now
      if (now - lastProgress >= 5_000) { log('waiting: reply still generating…'); lastProgress = now }
      if (pixelsStable && now - start >= minWait && now - lastChange >= stableMilliseconds) {
        // Only serialize the dynamic Compose hierarchy after pixels have been
        // stable for long enough, then confirm that the UI did not reflow while
        // the hierarchy was being read.
        const xml = await normalizedHierarchy()
        const confirmedFrame = await screenshot()
        lastXml = xml
        lastFrame = confirmedFrame
        if (!hierarchyIsLoading(xml) && await imageRegionsStable(frame, confirmedFrame)) return { status: 'stable', xml }
        lastChange = Date.now()
      }
      await sleep(pollInterval)
    }
    if (!lastXml) lastXml = await normalizedHierarchy()
    return { status: hierarchyIsLoading(lastXml) ? 'loading_timeout' : 'timeout', xml: lastXml }
  }

  async function waitForStableReply(timeout, { startedAt = Date.now() } = {}) {
    const minWait = 12_000
    const initialElapsed = Math.max(0, Date.now() - startedAt)
    if (!observer.active) {
      return waitForStableReplyPixels(
        Math.max(1_000, timeout - initialElapsed),
        { minWait: Math.max(0, minWait - initialElapsed) },
      )
    }
    const started = startedAt
    let lastProgress = 0
    while (Date.now() - started < timeout) {
      checkCancelled()
      const elapsed = Date.now() - started
      if (Date.now() - lastProgress >= 5_000) {
        log('waiting: reply still generating…')
        lastProgress = Date.now()
      }
      if (elapsed < minWait) {
        await sleep(Math.min(1_000, minWait - elapsed))
        continue
      }
      try {
        const remaining = timeout - elapsed
        const quiet = await observer.waitForNoActivity({
          timeout: Math.max(100, Math.min(6_000, remaining)),
          quietMs: REPLY_STABLE_QUIET_MS,
        })
        if (!quiet.quiet) continue
        const mark = observer.mark()
        const xml = await normalizedHierarchy()
        const confirmed = await observer.waitForNoActivity({ timeout: 1_200, quietMs: 300, minWaitMs: 120 })
        const currentMark = observer.mark()
        const activityFramesDuringHierarchy = (currentMark.activityFrameCount ?? currentMark.frameCount)
          - (mark.activityFrameCount ?? mark.frameCount)
        if (!hierarchyIsLoading(xml) && confirmed.quiet && activityFramesDuringHierarchy === 0) {
          log('waiting: scrcpy已确认回答画面连续3秒无活动帧，读取最终UI层级完成')
          return { status: 'stable', xml }
        }
      } catch (error) {
        if (await recoverObserver(error)) continue
        const remaining = Math.max(1_000, timeout - (Date.now() - started))
        return waitForStableReplyPixels(remaining, { minWait: 0 })
      }
    }
    const xml = await normalizedHierarchy()
    return { status: hierarchyIsLoading(xml) ? 'loading_timeout' : 'timeout', xml }
  }

  async function swipeChat(bounds, direction, fraction = 0.6, {
    maxFraction = 0.7,
    speed = 1400,
    settle = 60,
    fallbackDuration = 900,
    eventDrivenSettle = false,
  } = {}) {
    const [left, top, right, bottom] = bounds
    const height = bottom - top
    const { distance, percent } = chatSwipePlan(bounds, fraction, { maxFraction, speed })
    const canScrollMore = null
    const x = left + (right - left) * 0.84
    const center = Math.floor((top + bottom) / 2)
    const duration = Math.max(120, Math.round(distance / speed * 1_000))
    const activityMark = eventDrivenSettle && observer.active ? observer.mark() : null
    if (direction === 'up') await swipe(x, center - Math.floor(distance / 2), center + Math.ceil(distance / 2), duration || fallbackDuration)
    else await swipe(x, center + Math.ceil(distance / 2), center - Math.floor(distance / 2), duration || fallbackDuration)
    if (!activityMark) await sleep(settle)
    return { distance, canScrollMore, activityMark }
  }

  async function waitForRegionPixelsStable(bounds, timeout = 8_000) {
    let observedFrame = null
    if (observer.active) {
      const started = Date.now()
      try {
        const observed = await captureStableObserved({
          observer,
          capture: async () => cropImage(await screenshot(), bounds),
          hierarchy: source,
          hierarchyLoading: () => false,
        }, Math.min(timeout, 3_500))
        if (observed.stable) return observed.frame
        observedFrame = observed.frame
        observerRegionFallbacks += 1
      } catch (error) {
        if (await recoverObserver(error)) {
          const remaining = Math.max(500, timeout - (Date.now() - started))
          return waitForRegionPixelsStable(bounds, remaining)
        }
      }
      timeout = Math.max(500, timeout - (Date.now() - started))
    }
    let frame = observedFrame || await cropImage(await screenshot(), bounds)
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      await sleep(300)
      const next = await cropImage(await screenshot(), bounds)
      if (await imagesSimilar(frame, next, 1)) return next
      frame = next
    }
    return frame
  }

  async function waitForStableReplyRegion(bounds, timeout = 8_000, { settleSince = null } = {}) {
    let observed = null
    if (observer.active) {
      const started = Date.now()
      try {
        observed = await captureStableObserved({
          observer,
          capture: async () => cropImage(await screenshot(), bounds),
          hierarchy: source,
          hierarchyLoading: hierarchyIsLoading,
          settleSince,
        }, Math.min(timeout, 3_500))
        if (observed.stable) return observed
        observerRegionFallbacks += 1
        const elapsed = Date.now() - started
        const reuse = observed.frame ? '，复用已取得的PNG' : ''
        log(`capture: scrcpy快速静止判断未通过（${observed.reason || 'unknown'}，${elapsed}ms）${reuse}，转ADB夹心复核`)
      } catch (error) {
        if (await recoverObserver(error)) {
          const remaining = Math.max(1_000, timeout - (Date.now() - started))
          return waitForStableReplyRegion(bounds, remaining)
        }
      }
      timeout = Math.max(1_000, timeout - (Date.now() - started))
    }
    return captureStableSandwich({
      capture: async () => cropImage(await screenshot(), bounds),
      hierarchy: source,
      framesStable: imageRegionsStable,
      hierarchyLoading: hierarchyIsLoading,
      interval: 80,
      initialFrame: observed?.frame || null,
      initialXml: observed?.xml || '',
    }, timeout)
  }

  async function scrollQuestionIntoView(question, bounds, maxSwipes = 25) {
    for (let index = 0; index < maxSwipes; index += 1) {
      if (questionVisible(await source(), question, bounds)) return true
      await swipeChat(bounds, 'up', 0.65, { speed: 3200, settle: 80 })
    }
    return questionVisible(await source(), question, bounds)
  }

  async function captureFullReplyFrames(question, maxPages = 30, { scrollFraction = 0.45 } = {}) {
    const size = await windowSize()
    const initialXml = await source()
    const navigationBounds = findChatScrollBounds(initialXml, size)
    validateCaptureViewport(size, navigationBounds)
    const topNavigationStarted = Date.now()
    if (!(await scrollQuestionIntoView(question, navigationBounds))) log('capture: question not found while scrolling up; capturing from current position')
    const topNavigationMs = Date.now() - topNavigationStarted
    log(`capture: 快速定位当前问题顶部耗时=${topNavigationMs}ms`)
    const evidence = await prepareEmbeddedEvidence({
      source,
      tap,
      delay: sleep,
      waitForStable: waitForStableReplyRegion,
      log,
    }, navigationBounds)
    const { bounds, floatingControl } = replyCaptureBounds(evidence.capture.xml || await source(), size)
    validateCaptureViewport(size, bounds)
    log(`capture: chat bounds=${bounds.join(',')}${floatingControl ? '（已在顶部稳定后避开固定向下按钮）' : ''}`)
    const contained = bounds[0] >= navigationBounds[0] && bounds[1] >= navigationBounds[1]
      && bounds[2] <= navigationBounds[2] && bounds[3] <= navigationBounds[3]
    let initialCapture = evidence.capture
    if (contained) {
      initialCapture = {
        ...evidence.capture,
        frame: await cropImage(evidence.capture.frame, [
          bounds[0] - navigationBounds[0],
          bounds[1] - navigationBounds[1],
          bounds[2] - navigationBounds[0],
          bounds[3] - navigationBounds[1],
        ]),
      }
    } else initialCapture = await waitForStableReplyRegion(bounds)
    const frames = []
    const transitions = []
    let noProgress = 0
    let recaptureCount = 0
    const fallbackReasons = []
    let productDetected = false
    let products = null
    let productCaptureAttempts = 0
    let productCaptureMs = 0
    const captureProductsIfVisible = async xml => {
      if (products) return true
      const trigger = referenceProductsTrigger(xml, bounds)
      if (!trigger) return false
      productDetected = true
      const started = Date.now()
      let lastError = null
      try {
        for (let attempt = 0; attempt < 2 && !products; attempt += 1) {
          productCaptureAttempts += 1
          try {
            const candidate = await captureReferenceProductsAtTrigger(trigger)
            if (!candidate.firstViewportIncluded) throw new Error('推荐药品首项所在视口未纳入截图')
            if (!candidate.imagesReady) throw new Error(`推荐药品图片仍有 ${candidate.unloaded} 处未确认加载`)
            if (!candidate.confirmedEnd) throw new Error('推荐药品列表未确认到底')
            if (!candidate.continuityVerified) throw new Error('推荐药品拼接连续性未通过校验')
            products = candidate
          } catch (error) {
            lastError = error
            if (attempt < 1) {
              log(`capture: 推荐药品采集未完成，在回答尾部入口直接重试（2/2）：${error.message}`)
            }
          }
        }
        if (!products) throw new Error(`推荐药品为必采内容，但两次采集均未完成：${lastError?.message || '未知错误'}`)
        log('capture: 推荐药品已按回答尾部顺序完整采集，本题截图结束')
        return true
      } finally {
        productCaptureMs += Date.now() - started
      }
    }
    let capture = initialCapture
    let frame = capture.frame
    for (let page = 0; page < maxPages; page += 1) {
      let xml = capture.xml || await source()
      if (!frames.length || !(await imagesSimilar(frames.at(-1), frame, 3))) { frames.push(frame); log(`capture: page ${frames.length}`) }
      if (await captureProductsIfVisible(xml)) break
      const before = frame
      const scroll = await swipeChat(bounds, 'down', scrollFraction, { eventDrivenSettle: true })
      const shift = scroll.distance
      let afterCapture = await waitForStableReplyRegion(bounds, 8_000, { settleSince: scroll.activityMark })
      let after = afterCapture.frame
      if (await imagesSimilar(before, after, 3)) {
        noProgress += 1
        if (scrollEndConfirmed(scroll.canScrollMore, noProgress)) {
          log(`capture: scroll ended（${scroll.canScrollMore === false ? '设备确认已到底' : '连续两次画面无变化'}）`)
          break
        }
      } else {
        let afterXml = afterCapture.xml || await source()
        const frameHeight = (await imageInfo(before)).height
        let measuredShift = estimateVerticalScrollShift(xml, afterXml, bounds)
        let reliableMeasuredShift = measuredShift !== null && measuredShift <= shift * 1.35 ? measuredShift : null
        const expectedShift = reliableMeasuredShift ?? shift
        let expectedOverlap = Math.max(12, frameHeight - expectedShift)
        let transition
        try {
          if (!afterCapture.stable) throw new Error('滚动后的局部画面未稳定')
          transition = { verified: true, overlap: await verifyFrameOverlap(before, after, expectedOverlap) }
        } catch (error) {
          recaptureCount += 1
          afterCapture = await waitForStableReplyRegion(bounds, 3_000)
          after = afterCapture.frame
          afterXml = afterCapture.xml || await source()
          measuredShift = estimateVerticalScrollShift(xml, afterXml, bounds)
          reliableMeasuredShift = measuredShift !== null && measuredShift <= shift * 1.35 ? measuredShift : null
          const retryExpectedShift = reliableMeasuredShift ?? shift
          expectedOverlap = Math.max(12, frameHeight - retryExpectedShift)
          try {
            if (!afterCapture.stable) throw new Error('重采后的局部画面仍未稳定')
            transition = { verified: true, overlap: await verifyFrameOverlap(before, after, expectedOverlap) }
          } catch (retryError) {
            const reason = retryError.message || error.message
            // Once pixel continuity cannot be proven, XML coordinates and the
            // requested swipe distance are only estimates. Cropping by either
            // can silently remove lines after a Compose reflow, so retain the
            // complete next viewport and make the duplicate boundary explicit.
            const fallbackOverlap = 0
            transition = { verified: false, fallbackOverlap, reason }
            fallbackReasons.push(reason)
            log(`capture: 接缝无法精确校验，保留下一屏完整视口、重复内容和浅色留白：${reason}`)
          }
        }
        if (!(await imagesSimilar(frames.at(-1), after, 3))) {
          frames.push(after)
          transitions.push(transition)
          log(`capture: page ${frames.length}`)
          noProgress = 0
        } else noProgress += 1
        frame = after
        capture = afterCapture
        if (await captureProductsIfVisible(afterXml)) break
        if (scroll.canScrollMore === false) { log('capture: reached device-reported scroll boundary'); break }
      }
    }
    if (!productDetected) log('capture: 回答滚动过程中未发现参考/推荐药品入口，无需完成后重复扫描')
    const result = {
      frames: frames.length ? frames : [await cropImage(await screenshot(), bounds)],
      transitions,
      bounds,
      recaptureCount,
      fullRetryCount: 0,
      fallbackReasons,
      topNavigationMs,
      evidenceEmbedded: evidence.found,
      evidenceExpanded: evidence.expanded,
      productDetected,
      products,
      productCaptureAttempts,
      productCaptureMs,
    }
    if (fallbackReasons.length) log('capture: 不可靠接缝已局部重采并安全分隔，不再整题回滚重采')
    return result
  }

  async function captureProductViewport(listBounds, timeout = 4_000, { settleSince = null } = {}) {
    const deadline = Date.now() + timeout
    let latest = null
    while (Date.now() < deadline) {
      checkCancelled()
      const remaining = Math.max(250, deadline - Date.now())
      let capture
      if (observer.active) {
        try {
          capture = await captureStableObserved({
            observer,
            capture: async () => cropImage(await screenshot(), listBounds),
            hierarchy: source,
            hierarchyLoading: () => false,
            settleSince,
          }, Math.min(2_500, remaining))
        } catch (error) {
          if (await recoverObserver(error)) continue
        }
      }
      if (!capture?.stable) {
        if (observer.active) observerRegionFallbacks += 1
        capture = await captureStableSandwich({
          capture: async () => cropImage(await screenshot(), listBounds),
          hierarchy: source,
          framesStable: imageRegionsStable,
          hierarchyLoading: () => false,
          interval: 80,
          initialFrame: capture?.frame || null,
          initialXml: capture?.xml || '',
        }, remaining)
      }
      const readiness = await referenceProductViewportReadiness(capture.frame, capture.xml, listBounds)
      latest = { ...capture, readiness }
      if (capture.stable && readiness.ready) {
        if (!observer.active) return latest
        const confirmMark = observer.mark()
        try {
          const confirmed = await observer.waitForQuiet({
            timeout: Math.min(1_200, Math.max(650, deadline - Date.now())),
            windowMs: 750,
            quietMs: 650,
            maxFrames: 1,
            minWaitMs: 650,
          })
          const currentMark = observer.mark()
          const activityFrames = (currentMark.activityFrameCount ?? currentMark.frameCount)
            - (confirmMark.activityFrameCount ?? confirmMark.frameCount)
          // Reuse the lossless PNG when the extra observation window remains
          // quiet.  If lazy artwork or scroll rebound appears, loop once more
          // and replace it instead of stitching two different render states.
          if (confirmed.quiet && activityFrames === 0) return latest
        } catch (error) {
          await recoverObserver(error)
        }
      }
      settleSince = observer.active ? observer.mark() : null
      await waitForVisualQuiet({ timeout: Math.min(700, Math.max(100, deadline - Date.now())), fallbackMs: 180 })
    }
    return latest
  }

  async function captureScrollingRegion(bounds, initialCapture = null) {
    const readiness = []
    const initial = initialCapture || await captureProductViewport(bounds)
    if (!initial) throw new Error('推荐药品首屏未能完成稳定截图')
    readiness.push(initial.readiness)
    const frames = [initial.frame]
    let confirmedEnd = false
    const transitions = []
    let unchangedCount = 0
    let seamRecaptures = 0
    let fullRangeSearches = 0
    const [left, top, right, bottom] = bounds
    // The sheet is expanded before this function starts, so a gesture inside
    // the card area now belongs to the vertical RecyclerView rather than the
    // bottom-sheet drag handle.
    const height = bottom - top
    // The product count is not bounded. Completion is defined only by the
    // RecyclerView producing the same settled viewport after repeated swipe
    // attempts; cancellation remains available to stop a genuinely stuck UI.
    while (!confirmedEnd) {
      const activityMark = observer.active ? observer.mark() : null
      const swipeFractions = [0.32, 0.5, 0.68]
      const x = left + (right - left) * swipeFractions[Math.min(unchangedCount, swipeFractions.length - 1)]
      await swipe(x, top + height * 0.82, top + height * 0.18, unchangedCount ? 800 : 520)
      let capture = await captureProductViewport(bounds, 4_000, { settleSince: activityMark })
      if (!capture) throw new Error('推荐药品滚动后未能完成稳定截图')
      readiness.push(capture.readiness)
      let frame = capture.frame
      if (await imagesSimilar(frames.at(-1), frame, 3)) {
        unchangedCount += 1
        const requiredUnchanged = frames.length === 1 ? 3 : 2
        if (unchangedCount >= requiredUnchanged) {
          confirmedEnd = true
          break
        }
        continue
      } else {
        unchangedCount = 0
        const previous = frames.at(-1)
        const expectedOverlap = Math.max(12, Math.floor(height * 0.28))
        let overlap = null
        let transition = null
        let firstError = null
        try {
          overlap = await verifyFrameOverlap(previous, frame, expectedOverlap)
        } catch (error) {
          firstError = error
          try { overlap = await verifyProductGridOverlap(previous, frame, expectedOverlap) } catch {
            fullRangeSearches += 1
            try { overlap = await verifyProductGridOverlap(previous, frame, null) } catch {}
          }
        }
        if (overlap === null) {
          seamRecaptures += 1
          capture = await captureProductViewport(bounds, 3_000)
          if (!capture) throw firstError
          readiness[readiness.length - 1] = capture.readiness
          frame = capture.frame
          try {
            overlap = await verifyFrameOverlap(previous, frame, expectedOverlap)
          } catch (error) {
            try { overlap = await verifyProductGridOverlap(previous, frame, expectedOverlap) } catch {
              fullRangeSearches += 1
              try { overlap = await verifyProductGridOverlap(previous, frame, null) } catch (retryError) {
                const fallbackOverlap = calibratedProductFallbackOverlap(transitions.filter(item => item.verified).map(item => item.overlap))
                if (fallbackOverlap === null) {
                  throw new Error(`推荐药品第 ${frames.length + 1} 屏接缝重采后仍无法验证，已拒绝生成带灰线和重复商品的长图：${retryError.message || error.message}`)
                }
                transition = { verified: false, calibrated: true, fallbackOverlap, reason: retryError.message || error.message }
                log(`capture: 推荐药品第 ${frames.length + 1} 屏含局部动态内容，按前序一致位移保守拼接（重叠 ${fallbackOverlap}px，无灰线）`)
              }
            }
          }
        }
        transitions.push(transition || { verified: true, overlap })
        frames.push(frame)
      }
    }
    const calibratedSeams = transitions.filter(item => item.calibrated).length
    const continuityVerified = transitions.length === Math.max(0, frames.length - 1)
      && transitions.every(item => item.verified || item.calibrated)
    return { frames, transitions, readiness, confirmedEnd, continuityVerified, calibratedSeams, seamRecaptures, fullRangeSearches }
  }

  async function closeReferenceProductsDrawer() {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const xml = await source()
      const sheet = boundsForNodeAttribute(xml, 'resource-id', `${DEFAULT_PACKAGE}:id/bullet_container`)
      if (!sheet) return true
      const list = boundsForNodeAttribute(xml, 'class', 'androidx.recyclerview.widget.RecyclerView')
      const [left, top, right, bottom] = sheet
      const closeY = list ? Math.floor((top + list[1]) / 2) : top + Math.max(24, Math.floor((bottom - top) / 10))
      await tap(right - Math.max(24, Math.floor((right - left) / 16)), closeY)
      await waitForVisualQuiet({ timeout: 900, fallbackMs: 600 })
      if (!boundsForNodeAttribute(await source(), 'resource-id', `${DEFAULT_PACKAGE}:id/bullet_container`)) return true
      await ui.press('back')
      await waitForVisualQuiet({ timeout: 900, fallbackMs: 600 })
    }
    return !boundsForNodeAttribute(await source(), 'resource-id', `${DEFAULT_PACKAGE}:id/bullet_container`)
  }

  async function captureReferenceProductsAtTrigger(trigger, { restoreDrawer = true } = {}) {
    log('capture: 回答滚动中发现推荐药品入口，正在从首项开始采集完整列表')
    await tap(trigger[0], trigger[1])
    await waitForVisualQuiet({ timeout: 1_200, fallbackMs: 800 })
    let result = null
    try {
      const deadline = Date.now() + 3_500
      let list = null
      let sheet = null
      while (Date.now() < deadline && (!list || !sheet)) {
        const xml = await source()
        list = boundsForNodeAttribute(xml, 'class', 'androidx.recyclerview.widget.RecyclerView')
        sheet = boundsForNodeAttribute(xml, 'resource-id', `${DEFAULT_PACKAGE}:id/bullet_container`)
        if (!list || !sheet) await sleep(100)
      }
      if (!list || !sheet || list[3] - list[1] < 100) {
        throw new Error('推荐药品入口已点击，但未识别到药品列表抽屉')
      }
      for (let attempt = 0; attempt < 3 && list[1] > list[3] * 0.2; attempt += 1) {
        const [left, top, right, bottom] = list
        const height = bottom - top
        const previousTop = top
        // Drag the sheet header/handle, not RecyclerView content. A gesture in
        // the product grid can scroll to a middle card before the first frame
        // and was the source of the missing/duplicated opening products.
        const headerHeight = Math.max(60, top - sheet[1])
        const fromY = top - Math.min(headerHeight * 0.35, 70)
        const toY = Math.max(140, top - Math.max(700, height * 0.65))
        await swipe(left + (right - left) * 0.5, fromY, toY, 350)
        const expandDeadline = Date.now() + 2_500
        while (Date.now() < expandDeadline) {
          await sleep(100)
          const expandedXml = await source()
          const expandedList = boundsForNodeAttribute(expandedXml, 'class', 'androidx.recyclerview.widget.RecyclerView')
          const expandedSheet = boundsForNodeAttribute(expandedXml, 'resource-id', `${DEFAULT_PACKAGE}:id/bullet_container`)
          if (expandedList && expandedSheet && expandedList[1] < previousTop - 40) {
            list = expandedList
            sheet = expandedSheet
            break
          }
        }
        if (list[1] >= previousTop - 40) await waitForVisualQuiet({ timeout: 700, fallbackMs: 250 })
      }
      if (list[1] > list[3] * 0.2) throw new Error(`推荐药品抽屉未完全展开（列表顶部=${list[1]}），为避免从中间药品开始已停止采集`)
      await waitForVisualQuiet({ timeout: 900, fallbackMs: 250 })
      log(`capture: 推荐药品抽屉已先展开，列表视口=${list[3] - list[1]}px`)
      const expandedInitial = await captureProductViewport(list)
      if (!expandedInitial) throw new Error('推荐药品展开后首屏未能完成稳定截图')
      const capture = await captureScrollingRegion(list, expandedInitial)
      const chunks = await composeLongImages(capture.frames, {
        transitions: capture.transitions,
        maxHeight: maxLongImageHeight(payloadMaxLongImageHeight),
        separatorHeight: 0,
      })
      const unloaded = capture.readiness.reduce((sum, item) => sum + item.unloaded, 0)
      const imagesReady = capture.readiness.every(item => item.ready)
      log(`capture: 推荐药品截图完成，共 ${capture.frames.length} 屏，图片${imagesReady ? '已全部加载' : `仍有 ${unloaded} 处未确认加载`}`)
      result = { images: chunks, pages: capture.frames.length, firstViewportIncluded: true, firstViewportStandalone: false, imagesReady, unloaded, confirmedEnd: capture.confirmedEnd, continuityVerified: capture.continuityVerified, calibratedSeams: capture.calibratedSeams, seamRecaptures: capture.seamRecaptures, fullRangeSearches: capture.fullRangeSearches, readinessModes: [...new Set(capture.readiness.map(item => item.mode))] }
    } finally {
      if (restoreDrawer && !(await closeReferenceProductsDrawer())) throw new Error('推荐药品截图完成后无法关闭药品列表抽屉')
    }
    return result
  }

  let payloadMaxLongImageHeight = DEFAULT_MAX_LONG_IMAGE_HEIGHT

  async function saveArtifacts({ outDir, stem, question, status, xml, meta, stitch = true, observerBaseline, recoveryBaseline }) {
    await fs.mkdir(outDir, { recursive: true })
    const xmlPath = path.join(outDir, `${stem}.xml`)
    const metadataPath = path.join(outDir, `${stem}.json`)
    let screenshotPath = path.join(outDir, `${stem}.png`)
    let resultMeta = { ...meta }
    if (stitch) {
      const replyCaptureStarted = Date.now()
      const capture = await captureFullReplyFrames(question)
      const { frames, transitions, bounds, recaptureCount, fullRetryCount, fallbackReasons, topNavigationMs, evidenceEmbedded, evidenceExpanded, productDetected, products, productCaptureAttempts, productCaptureMs } = capture
      if (!referenceProductsCaptureComplete({ detected: productDetected, products })) {
        throw new Error('检测到推荐药品入口，但药品截图未完整完成')
      }
      const seamsTotal = Math.max(0, frames.length - 1)
      const seamsVerified = transitions.filter(transition => transition.verified).length
      const continuityVerified = transitions.length === seamsTotal && seamsVerified === seamsTotal
      const images = await buildReplyImages(frames, { transitions, maxHeight: payloadMaxLongImageHeight })
      const replyCaptureMs = Date.now() - replyCaptureStarted
      const paths = []
      for (const [index, image] of images.entries()) { const file = path.join(outDir, `${stem}_${String(index + 1).padStart(3, '0')}.png`); await fs.writeFile(file, image); paths.push(file) }
      screenshotPath = paths[0]
      resultMeta = {
        ...resultMeta,
        stitched_pages: frames.length,
        screenshot_parts: paths,
        chat_bounds: bounds,
        reply_capture_mode: continuityVerified ? 'verified_overlap_long_image' : 'safe_overlap_long_image',
        reply_continuity_verified: continuityVerified,
        reply_seams_total: seamsTotal,
        reply_seams_verified: seamsVerified,
        reply_seams_with_safe_overlap: seamsTotal - seamsVerified,
        reply_recapture_count: recaptureCount,
        reply_full_retry_count: fullRetryCount,
        reply_top_navigation_ms: topNavigationMs,
        reply_evidence_embedded: evidenceEmbedded,
        reply_evidence_expanded: evidenceExpanded,
        reply_capture_ms: replyCaptureMs,
        reference_products_detected: productDetected,
        reference_products_capture_required: productDetected,
        reference_products_inline_capture: Boolean(products),
        reference_products_restore_required: false,
        reference_products_terminal_sequence: Boolean(products),
        reference_products_retry_count: Math.max(0, productCaptureAttempts - (productDetected ? 1 : 0)),
        reference_products_post_scan_swipes: 0,
        reference_products_capture_ms: productCaptureMs,
        ...(fallbackReasons.length ? { reply_fallback_reason: fallbackReasons.join('；') } : {}),
        long_image_max_height: payloadMaxLongImageHeight,
      }
      log(`capture: 回答截图完成，帧=${frames.length}，精确接缝=${seamsVerified}/${seamsTotal}，安全重复接缝=${seamsTotal - seamsVerified}，重采=${recaptureCount}，模式=${resultMeta.reply_capture_mode}，耗时=${replyCaptureMs}ms`)
      if (products) {
        const paths = []
        for (const [index, image] of products.images.entries()) { const file = path.join(outDir, `${stem}_参考药品_${String(index + 1).padStart(3, '0')}.png`); await fs.writeFile(file, image); paths.push(file) }
        Object.assign(resultMeta, {
          reference_products_screenshot: paths[0],
          reference_products_parts: paths,
          reference_products_pages: products.pages,
          reference_products_capture_mode: products.firstViewportStandalone ? 'standalone_first_viewport_then_verified_overlap_stitch' : (products.continuityVerified ? 'verified_overlap_stitch' : 'separate_viewports'),
          reference_products_continuity_verified: products.continuityVerified,
          reference_products_first_viewport_standalone: products.firstViewportStandalone,
          reference_products_images_ready: products.imagesReady,
          reference_products_unloaded_images: products.unloaded,
          reference_products_confirmed_end: products.confirmedEnd,
          reference_products_first_viewport_included: products.firstViewportIncluded,
          reference_products_capture_complete: products.firstViewportIncluded && products.imagesReady && products.confirmedEnd && products.continuityVerified,
          reference_products_calibrated_seams: products.calibratedSeams,
        })
      }
    } else await fs.writeFile(screenshotPath, await screenshot())
    await fs.writeFile(xmlPath, xml || await normalizedHierarchy(), 'utf8')
    resultMeta = { ...resultMeta, ...observerMetadata(observerBaseline, recoveryBaseline) }
    await fs.writeFile(metadataPath, JSON.stringify({ question, status, created_at: new Date().toISOString().replace(/\.\d{3}Z$/, ''), screenshot: screenshotPath, hierarchy: xmlPath, ...resultMeta }, null, 2), 'utf8')
    return { screenshot: screenshotPath, hierarchy: xmlPath, metadata: metadataPath }
  }

  async function askOnce(payload, batchDirectory, question, index) {
    const observerBaseline = typeof observer.snapshot === 'function' ? observer.snapshot() : {}
    const recoveryBaseline = recoverySnapshot()
    if (payload.newSession) {
      log('stage: 正在切换到新会话')
      await tapNewSession()
    }
    log('stage: 正在输入问题')
    await inputQuestion(question)
    const directory = questionArtifactDirectory(batchDirectory, index, question)
    const meta = {
      serial: payload.serial,
      batch_id: path.basename(batchDirectory),
      question_index: index,
      question_directory: directory,
      ui_backend: 'python_uiautomator2_strict',
      ui_fallback_enabled: false,
    }
    log('stage: 正在发送问题')
    const sendMark = observer.active ? observer.mark() : null
    const replyStartedAt = Date.now()
    await tapSend()
    log('stage: 问题已发送，等待回答稳定')
    if (sendMark && observer.active && typeof observer.waitForActivity === 'function') {
      try {
        const activity = await observer.waitForActivity({ timeout: 2_000, since: sendMark })
        if (activity.activity) log('waiting: scrcpy已检测到回答画面开始变化')
      } catch (error) {
        await recoverObserver(error)
      }
    } else await sleep(2_000)
    const result = await waitForStableReply(payload.timeout * 1_000, { startedAt: replyStartedAt })
    log(`stage: 回答等待结束（${result.status}），开始截图`)
    return saveArtifacts({
      outDir: directory,
      stem: '回答',
      question,
      status: result.status,
      xml: result.xml,
      meta,
      observerBaseline,
      recoveryBaseline,
    })
  }

  return {
    async captureCurrentAnswer(payload) {
      activeSerial = payload.serial
      payloadMaxLongImageHeight = maxLongImageHeight(payload.maxLongImageHeight)
      const outputRoot = path.resolve(payload.outputDir)
      const batchDirectory = await createBatchDirectory(outputRoot)
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
        const alreadyOpen = Boolean(boundsForNodeAttribute(xml, 'resource-id', `${DEFAULT_PACKAGE}:id/bullet_container`))
        if (alreadyOpen) throw new Error('当前药品抽屉已经打开，无法证明仍位于第一项；为避免漏药，本次未继续操作，也未输入或发送新问题。')
        const size = await windowSize()
        const chatBounds = findChatScrollBounds(xml, size)
        validateCaptureViewport(size, chatBounds)
        let question = currentQuestionText(xml, chatBounds)
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
        if (!question) throw new Error('无法从当前已有回答向上定位对应问题；本次未输入、未发送，也未新建会话。')
        log(`capture: 已识别当前已有问题“${question}”，开始执行正文、引用资料和完整参考药品归档；不会输入或发送内容`)
        const directory = questionArtifactDirectory(batchDirectory, 1, question)
        return await saveArtifacts({
          outDir: directory,
          stem: '回答',
          question,
          status: 'existing_reply',
          xml,
          meta: {
          serial: payload.serial,
            batch_id: path.basename(batchDirectory),
            question_index: 1,
            question_directory: directory,
            existing_reply_capture: true,
            input_performed: false,
            send_performed: false,
            new_session_performed: false,
            ui_backend: 'python_uiautomator2_strict',
            ui_fallback_enabled: false,
          },
          observerBaseline,
          recoveryBaseline,
        })
      } catch (error) {
        await fs.writeFile(path.join(batchDirectory, 'automation-failure.json'), JSON.stringify({
          created_at: new Date().toISOString(),
          serial: payload.serial,
          mode: 'capture_current_existing_reply',
          input_performed: false,
          send_performed: false,
          new_session_performed: false,
          error_name: error?.name || 'Error',
          error_message: error?.message || String(error),
          stack: error?.stack || null,
        }, null, 2), 'utf8').catch(() => {})
        throw error
      } finally {
        await observer.stop().catch(() => {})
        await ui.stop().catch(() => {})
      }
    },
    async run(payload) {
      activeSerial = payload.serial
      payloadMaxLongImageHeight = maxLongImageHeight(payload.maxLongImageHeight)
      const outputRoot = path.resolve(payload.outputDir)
      const batchDirectory = await createBatchDirectory(outputRoot)
      try {
        await waitForAdbDevice(options.adbPath, payload.serial)
        await ui.start(payload.serial)
        await ui.appStart(DEFAULT_PACKAGE)
        try {
          await observer.start(payload.serial)
        } catch (error) {
          await disableObserver(error)
        }
        await waitForVisualQuiet({ timeout: 1_200, fallbackMs: 800 })
        await waitForInput(15_000)
        log(`device=${payload.serial} package=${DEFAULT_PACKAGE} batch=${batchDirectory}`)
        for (const [zeroIndex, question] of payload.questions.entries()) {
          checkCancelled()
          log(`[${zeroIndex + 1}/${payload.questions.length}] asking: ${question}`)
          log(JSON.stringify(await askOnce(payload, batchDirectory, question, zeroIndex + 1)))
        }
        log(`执行完成：共 ${payload.questions.length} 条问题，输出目录 ${batchDirectory}`)
      } catch (error) {
        await fs.writeFile(path.join(batchDirectory, 'automation-failure.json'), JSON.stringify({
          created_at: new Date().toISOString(),
          serial: payload.serial,
          ui_backend: 'python_uiautomator2_strict',
          ui_fallback_enabled: false,
          error_name: error?.name || 'Error',
          error_message: error?.message || String(error),
          stack: error?.stack || null,
        }, null, 2), 'utf8').catch(() => {})
        throw error
      } finally {
        await observer.stop().catch(() => {})
        await ui.stop().catch(() => {})
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
  DEFAULT_PACKAGE,
  buildReplyImages,
  conservativeFallbackOverlap,
  chatSwipePlan,
  hierarchyBelongsToPackage,
  scrollEndConfirmed,
  referenceProductsTrigger,
  referenceProductsCaptureComplete,
  calibratedProductFallbackOverlap,
  referenceProductViewportReadiness,
  prepareEmbeddedEvidence,
  fillQuestionInput,
  captureStableSandwich,
  captureStableObserved,
  adbConnectionLost,
  historyOnboardingVisible,
  maxLongImageHeight,
}
