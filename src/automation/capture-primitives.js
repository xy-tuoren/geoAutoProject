const { sleep } = require('./utils')
const { evidencePanelBounds, evidenceMinimumHeight } = require('./hierarchy')
const { imagesSimilar, composeLongImages } = require('./images')

const DEFAULT_MAX_LONG_IMAGE_HEIGHT = 12_000

function maxLongImageHeight(value) {
  const parsed = Number(value ?? DEFAULT_MAX_LONG_IMAGE_HEIGHT)
  if (!Number.isInteger(parsed) || parsed < 3_000 || parsed > 30_000) throw new Error('长截图最大高度必须是 3000–30000 之间的整数。')
  return parsed
}

function historyOnboardingVisible(xml) {
  return /在这里查看[「"]?历史对话/.test(String(xml))
}

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

function requireQuestionLocated(found, question) {
  if (!found) throw new Error(`未能在当前会话中定位刚发送的问题“${question}”，为避免截取旧回答已停止本题`)
}

async function scrollSingleQuestionSessionToTop({
  capture,
  swipeUp,
  settle,
  framesSimilar = imagesSimilar,
  timeout = 120_000,
  now = () => Date.now(),
}) {
  const startedAt = now()
  let current = await capture()
  let unchangedCount = 0
  let swipes = 0
  while (now() - startedAt < timeout) {
    const scroll = await swipeUp()
    const next = await settle(scroll)
    swipes += 1
    if (await framesSimilar(current.frame, next.frame, 3)) unchangedCount += 1
    else unchangedCount = 0
    current = next
    if (unchangedCount >= 2) return { capture: current, swipes, confirmed: true }
  }
  throw new Error(`新会话已创建，但${Math.round(timeout / 1000)}秒内未能通过连续两次无变化确认到达会话顶部。`)
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

async function fillQuestionInput({ ui, tap, source, readText, log = () => {}, delay = sleep }, edit, question) {
  await tap((edit.bounds[0] + edit.bounds[2]) / 2, (edit.bounds[1] + edit.bounds[3]) / 2)
  await delay(300)
  // Hierarchy text can lag behind the real EditText value. Always clear so a
  // stale value cannot be appended and silently sent as a different question.
  await ui.sendKeys(question, { clear: true })
  // FastInputIME has no visible keyboard on this device. Pressing Back after
  // sendKeys exits the app instead of hiding an IME, so let sendKeys restore
  // the user's original IME and confirm the target hierarchy directly.
  await delay(350)
  let xml = await source()
  if (readText && readText(xml) !== question) {
    log('stage: 输入后回读不一致，正在通过聚焦控件原子替换并再次确认')
    await tap((edit.bounds[0] + edit.bounds[2]) / 2, (edit.bounds[1] + edit.bounds[3]) / 2)
    await delay(200)
    await ui.setFocusedText(question)
    await delay(350)
    xml = await source()
  }
  return xml
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
  requiredStablePairs = 1,
}, timeout = 8_000) {
  if (!Number.isInteger(requiredStablePairs) || requiredStablePairs < 1) throw new Error('稳定帧组数必须是正整数。')
  let before = initialFrame || await capture()
  let lastXml = initialXml
  let attempts = 0
  let stablePairs = 0
  const deadline = now() + timeout
  while (now() < deadline) {
    await delay(interval)
    // The first frame is taken before hierarchy collection and the second
    // immediately after it. The default path needs one stable pair; strict
    // activity fallback asks for consecutive pairs without changing this loop.
    lastXml = await hierarchy()
    const after = await capture()
    attempts += 1
    if (!hierarchyLoading(lastXml) && await framesStable(before, after)) {
      stablePairs += 1
      if (stablePairs >= requiredStablePairs) return { frame: after, xml: lastXml, stable: true, attempts }
    } else stablePairs = 0
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

function observerRegionFallbackOptions(result) {
  const activityObserved = result?.reason === 'capture_activity'
  return {
    initialFrame: result?.frame || null,
    requiredStablePairs: activityObserved ? 2 : 1,
    activityObserved,
  }
}

function shouldRetryFullReplyCapture({ fallbackReasons = [], allowFullRetry = true, products = null } = {}) {
  return Boolean(allowFullRetry && !products && fallbackReasons.length)
}

module.exports = {
  DEFAULT_MAX_LONG_IMAGE_HEIGHT,
  maxLongImageHeight,
  historyOnboardingVisible,
  conservativeFallbackOverlap,
  chatSwipePlan,
  scrollEndConfirmed,
  requireQuestionLocated,
  scrollSingleQuestionSessionToTop,
  buildReplyImages,
  prepareEmbeddedEvidence,
  fillQuestionInput,
  captureStableSandwich,
  captureStableObserved,
  observerRegionFallbackOptions,
  shouldRetryFullReplyCapture,
}
