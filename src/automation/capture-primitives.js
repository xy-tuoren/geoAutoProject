const { sleep } = require('./utils')
const { evidencePanelBounds, evidenceMinimumHeight, questionVisibleExact } = require('./hierarchy')
const { imageRegionsStable, composeLongImages } = require('./images')
const { findOcrText, mapPhysicalBoundsToLogical } = require('./ocr')

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

function scrollEndConfirmed(_canScrollMore, unchangedCount) {
  return unchangedCount >= 2
}

function requireQuestionLocated(found, question) {
  if (!found) throw new Error(`未能在当前会话中定位刚发送的问题“${question}”，为避免截取旧回答已停止本题`)
}

async function confirmQuestionAtTop({
  capture,
  question,
  chatBounds,
  source,
  recoverSource,
  delay = sleep,
  maxReadAttempts = 3,
  interval = 250,
  maxRecoveryReadAttempts = 8,
  recoveryInterval = 500,
  log = () => {},
}) {
  if (questionVisibleExact(capture?.xml || '', question, chatBounds)) return true
  if (typeof source !== 'function') return false
  log('waiting: 回顶画面已静止，但层级暂未暴露本题问题气泡，正在有限只读复核')
  for (let attempt = 1; attempt <= maxReadAttempts; attempt += 1) {
    await delay(interval)
    const xml = await source()
    capture.xml = xml
    if (questionVisibleExact(xml || '', question, chatBounds)) {
      log(`capture: 第${attempt}次只读层级复核已确认完整问题气泡与本题严格一致`)
      return true
    }
  }
  if (typeof recoverSource === 'function') {
    log('waiting: 连续只读复核仍为稀疏层级，正在重启一次uiautomator2 sidecar后做最终确认')
    let xml = await recoverSource()
    for (let attempt = 1; attempt <= maxRecoveryReadAttempts; attempt += 1) {
      capture.xml = xml
      if (questionVisibleExact(xml || '', question, chatBounds)) {
        log(`capture: sidecar只读恢复后第${attempt}次层级确认已识别完整问题气泡与本题严格一致`)
        return true
      }
      if (attempt < maxRecoveryReadAttempts) {
        await delay(recoveryInterval)
        xml = await source()
      }
    }
  }
  return false
}

async function scrollSingleQuestionSessionToTop({
  capture,
  initialCapture = null,
  swipeUp,
  settle,
  framesStable = imageRegionsStable,
  verifyTop,
  timeout = 120_000,
  maxUnverifiedBoundaries = 2,
  log = () => {},
  now = Date.now,
}) {
  if (typeof verifyTop !== 'function') throw new Error('新会话回顶必须提供当前问题气泡校验。')
  if (!Number.isInteger(maxUnverifiedBoundaries) || maxUnverifiedBoundaries < 1) {
    throw new Error('回顶候选边界复核次数必须是正整数。')
  }
  const deadline = now() + timeout
  let current = initialCapture ?? await capture()
  let unchangedCount = 0
  let unverifiedBoundaries = 0
  let swipes = 0
  while (now() < deadline) {
    const scroll = await swipeUp(swipes, { unverifiedBoundaries })
    const next = await settle(scroll)
    swipes += 1
    if (await framesStable(current.frame, next.frame)) unchangedCount += 1
    else unchangedCount = 0
    current = next
    if (unchangedCount >= 2) {
      if (!await verifyTop(current)) {
        unverifiedBoundaries += 1
        if (unverifiedBoundaries >= maxUnverifiedBoundaries) {
          throw new Error('新会话回顶画面已连续两次无变化，但未确认完整问题气泡且文字与本题一致；为避免把回答尾部误判为顶部，已停止截图。')
        }
        unchangedCount = 0
        log('waiting: 当前静止位置未确认本题完整问题气泡，可能有浮层拦截手势，切换安全回顶手势继续有限探测')
        continue
      }
      return { capture: current, swipes, confirmed: true, questionVerified: true }
    }
  }
  throw new Error(`新会话已创建，但${Math.round(timeout / 1000)}秒内未能通过连续两次无变化确认到达会话顶部。`)
}

async function confirmPersistentScrollEnd({
  capture,
  swipeDown,
  settle,
  framesStable = imageRegionsStable,
  hierarchyLoading = () => false,
  requiredUnchanged = 3,
  quietMs = 6_000,
  probeInterval = 350,
  timeout = 90_000,
  delay = sleep,
  now = Date.now,
}) {
  if (!Number.isInteger(requiredUnchanged) || requiredUnchanged < 2) throw new Error('底部确认次数必须是不小于2的整数。')
  const deadline = now() + timeout
  let current = await capture()
  let unchangedCount = 0
  let stableSince = now()
  let probes = 0
  let resets = 0
  while (now() < deadline) {
    const scroll = await swipeDown(probes)
    const next = await settle(scroll)
    probes += 1
    const unchanged = !hierarchyLoading(next.xml || '') && await framesStable(current.frame, next.frame)
    if (unchanged) unchangedCount += 1
    else {
      unchangedCount = 0
      stableSince = now()
      resets += 1
    }
    current = next
    if (unchangedCount >= requiredUnchanged && now() - stableSince >= quietMs) {
      return { capture: current, confirmed: true, probes, resets, quietMs: now() - stableSince }
    }
    await delay(Math.min(probeInterval, Math.max(0, deadline - now())))
  }
  throw new Error(`回答底部在${Math.round(timeout / 1000)}秒内仍有新内容或可继续滚动，未开始正式截图。`)
}

async function buildReplyImages(frames, { transitions = [], maxHeight = DEFAULT_MAX_LONG_IMAGE_HEIGHT } = {}) {
  return composeLongImages(frames, { transitions, maxHeight, separatorHeight: 24 })
}

const EVIDENCE_SUMMARY_OCR_MATCHERS = [
  {
    variant: 'legacy_summary',
    pattern: /^根据.{1,6}篇资料为(?:你|您)总结(?:[\^∧︿⌃˄∨⌄vVへ])?$/,
  },
  {
    variant: 'medical_references',
    pattern: /^参考[0-9一二三四五六七八九十百千万]{1,6}篇(?:医学)?文献(?:[\^∧︿⌃˄∨⌄vVへ])?$/,
  },
  {
    variant: 'drug_instructions',
    pattern: /^参考[0-9一二三四五六七八九十百千万]{1,6}篇药品说明书(?:[\^∧︿⌃˄∨⌄vVへ])?$/,
  },
]

const EVIDENCE_EXPANDED_ARROW_PATTERN = /[\^∧︿⌃˄へ]$/

function evidenceSummaryOcrVariant(text) {
  return EVIDENCE_SUMMARY_OCR_MATCHERS.find(matcher => matcher.pattern.test(text))?.variant || null
}

function evidenceSummaryOcrTarget(recognition, logicalSize, chatBounds) {
  const maximumY = chatBounds[1] + (chatBounds[3] - chatBounds[1]) * 0.55
  return findOcrText(
    recognition,
    item => Boolean(evidenceSummaryOcrVariant(item.normalizedText)),
    { minConfidence: 0.8 },
  ).map(item => {
    const logicalBounds = mapPhysicalBoundsToLogical(item.bounds, recognition.image, logicalSize)
    return {
      ...item,
      variant: evidenceSummaryOcrVariant(item.normalizedText),
      physicalBounds: item.bounds,
      logicalBounds,
    }
  }).filter(item => {
    const [left, top, right, bottom] = item.logicalBounds
    const centerX = (left + right) / 2
    const centerY = (top + bottom) / 2
    return centerX >= chatBounds[0] && centerX <= chatBounds[2]
      && centerY >= chatBounds[1] && centerY <= maximumY
  }).sort((first, second) => first.logicalBounds[1] - second.logicalBounds[1] || second.confidence - first.confidence)[0] || null
}

function evidenceSummaryExpandedByOcr(recognition, target) {
  if (!target) return false
  if (target.variant !== 'legacy_summary' && EVIDENCE_EXPANDED_ARROW_PATTERN.test(target.normalizedText)) {
    return true
  }
  const maximumY = Math.min(
    recognition.image.height,
    target.physicalBounds[3] + recognition.image.height * 0.25,
  )
  const legacyReferenceLabel = findOcrText(recognition, /^医学文献$/, { minConfidence: 0.8 })
    .some(item => item.bounds[1] >= target.physicalBounds[3] && item.bounds[1] <= maximumY)
  if (legacyReferenceLabel) return true
  if (!['medical_references', 'drug_instructions'].includes(target.variant)) return false

  // Some OCR runs omit the small upward chevron. In that case require the
  // expanded card's two-column citation row: a numbered title on the left and
  // a source label on the same line to its right. Requiring both avoids
  // mistaking a numbered answer paragraph below a collapsed card for evidence.
  const citationMaximumY = Math.min(
    recognition.image.height,
    target.physicalBounds[3] + recognition.image.height * 0.08,
  )
  const citationRows = recognition.results.filter(item => item.confidence >= 0.8
    && /^[0-9]{1,2}[.、．]/.test(item.normalizedText)
    && item.bounds[1] >= target.physicalBounds[3]
    && item.bounds[1] <= citationMaximumY)
  // Another card variant has no source badge at all. Its citation is a
  // full-width truncated row immediately below the title. Keep the vertical
  // window narrow so a later numbered answer paragraph cannot qualify.
  const immediateCitationMaximumY = target.physicalBounds[3] + recognition.image.height * 0.025
  const truncatedCitationRow = citationRows.some(row => (
    row.bounds[1] <= immediateCitationMaximumY
    && /(?:\.{2,}|…{1,3})$/u.test(row.normalizedText)
  ))
  if (truncatedCitationRow) return true
  // The UI can draw the trailing ellipsis separately from the text layer, so
  // OCR may return only the numbered title. In that case a citation row still
  // spans most of the card width and starts immediately below the heading.
  const fullWidthCitationRow = citationRows.some(row => (
    row.bounds[1] <= immediateCitationMaximumY
    && row.bounds[2] - row.bounds[0] >= recognition.image.width * 0.78
  ))
  if (fullWidthCitationRow) return true
  // RapidOCR sometimes merges the left citation title and the right source
  // badge into one full-width line. The title is visually truncated before
  // the badge, so require both a numbered row and an ellipsis followed by a
  // short Chinese source label. A normal numbered answer paragraph does not
  // satisfy this structure.
  const mergedCitationRow = citationRows.some(row => (
    /(?:\.{3}|…{1,3})[\p{Script=Han}]{2,12}$/u.test(row.normalizedText)
  ))
  if (mergedCitationRow) return true
  return citationRows.some(row => recognition.results.some(source => {
    if (source === row || source.confidence < 0.8 || source.bounds[0] < row.bounds[2]) return false
    const verticalOverlap = Math.min(row.bounds[3], source.bounds[3]) - Math.max(row.bounds[1], source.bounds[1])
    return verticalOverlap > 0
      && source.normalizedText.length >= 2
      && source.normalizedText.length <= 30
      && !/^[0-9]{1,2}[.、．]/.test(source.normalizedText)
  }))
}

function evidenceSummaryTextCenter(target) {
  const [left, top, right, bottom] = target.logicalBounds
  return [(left + right) / 2, (top + bottom) / 2]
}

function evidenceSummaryTapPoint(target, attempt, random = Math.random) {
  if (attempt === 1) return evidenceSummaryTextCenter(target)
  const [left, top, right, bottom] = target.logicalBounds
  const width = right - left
  const height = bottom - top
  // Keep retries inside the OCR glyph box while avoiding the exact point that
  // Compose may have transiently ignored. The two retry bands sit on opposite
  // sides of the title centre and scale with the current logical resolution.
  const horizontalStart = attempt === 2 ? 0.38 : 0.52
  const horizontalFraction = horizontalStart + random() * 0.1
  const verticalFraction = 0.42 + random() * 0.16
  return [left + width * horizontalFraction, top + height * verticalFraction]
}

async function prepareEmbeddedEvidence({
  screenshot,
  ocr,
  windowSize,
  setLastOcrDiagnostic = () => {},
  tap,
  random = Math.random,
  delay,
  waitForStable,
  log,
}, bounds) {
  const minimum = evidenceMinimumHeight(bounds)
  const [frame, logicalSize] = await Promise.all([screenshot(), windowSize()])
  const recognition = await ocr.recognize(frame, { minConfidence: 0.5 })
  const target = evidenceSummaryOcrTarget(recognition, logicalSize, bounds)
  const alreadyExpanded = evidenceSummaryExpandedByOcr(recognition, target)
  const diagnostic = {
    created_at: new Date().toISOString(),
    purpose: 'xiaohe_embedded_evidence',
    matcher: {
      patterns: EVIDENCE_SUMMARY_OCR_MATCHERS.map(item => ({
        variant: item.variant,
        pattern: item.pattern.source,
      })),
      minimum_confidence: 0.8,
      top_chat_fraction: 0.55,
    },
    logical_size: logicalSize,
    recognition,
    target: target ? { ...target, alreadyExpanded, textCenter: evidenceSummaryTextCenter(target) } : null,
    confirmations: [],
  }
  setLastOcrDiagnostic(diagnostic)
  log(target
    ? `ocr: purpose=xiaohe_embedded_evidence outcome=matched engine=${recognition.engine} elapsed=${Math.round(recognition.elapsedMs)}ms confidence=${target.confidence.toFixed(3)} variant=${target.variant} expanded=${alreadyExpanded} physical_bounds=${target.physicalBounds.join(',')} logical_bounds=${target.logicalBounds.join(',')}`
    : `ocr: purpose=xiaohe_embedded_evidence outcome=not_found engine=${recognition.engine} elapsed=${Math.round(recognition.elapsedMs)}ms lines=${recognition.results.length}`)
  if (!target) return { found: false, expanded: false, capture: await waitForStable(bounds) }
  if (alreadyExpanded) {
    log('capture: OCR确认引用资料已经展开，直接纳入回答第一帧')
    return { found: true, expanded: true, capture: await waitForStable(bounds) }
  }
  const viewportHeight = bounds[3] - bounds[1]
  const clickTitle = async (currentTarget, attempt) => {
    const point = evidenceSummaryTapPoint(currentTarget, attempt, random)
    log(`capture: OCR识别到“${currentTarget.text}”，点击标题文字展开引用资料（${Math.round(point[0])},${Math.round(point[1])}，第${attempt}次）`)
    await tap(point[0], point[1])
    await delay(800)
    return waitForStable(bounds)
  }
  const hierarchyExpanded = capture => {
    const panel = evidencePanelBounds(capture.xml || '', minimum)
    return Boolean(panel && panel[3] - panel[1] > viewportHeight * 0.16)
  }
  const confirmByOcr = async (attempt, fallbackTarget) => {
    const confirmationFrame = await screenshot()
    const confirmation = await ocr.recognize(confirmationFrame, { minConfidence: 0.5 })
    const confirmationTarget = evidenceSummaryOcrTarget(confirmation, logicalSize, bounds)
    // Expansion can momentarily make the compact title harder to recognize.
    // Keep using its pre-click physical bounds to verify an immediately
    // adjacent citation row, without treating the missing title as permission
    // to click again.
    const confirmationExpanded = evidenceSummaryExpandedByOcr(
      confirmation,
      confirmationTarget || fallbackTarget,
    )
    diagnostic.confirmations.push({ attempt, recognition: confirmation, target: confirmationTarget, expanded: confirmationExpanded })
    log(`ocr: purpose=xiaohe_embedded_evidence_confirmation attempt=${attempt} outcome=${confirmationExpanded ? 'expanded' : (confirmationTarget ? 'collapsed' : 'not_found')} engine=${confirmation.engine} elapsed=${Math.round(confirmation.elapsedMs)}ms`)
    return { target: confirmationTarget, expanded: confirmationExpanded }
  }

  let capture = null
  let expanded = false
  let currentTarget = target
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    capture = await clickTitle(currentTarget, attempt)
    expanded = hierarchyExpanded(capture)
    if (expanded) break
    const confirmation = await confirmByOcr(attempt, currentTarget)
    expanded = confirmation.expanded
    if (expanded || !confirmation.target || attempt === 3) break
    log(`capture: 第${attempt}次点击后OCR仍确认引用资料处于折叠状态，重新识别位置后安全尝试第${attempt + 1}次标题文字点击`)
    currentTarget = confirmation.target
  }
  if (!expanded) throw new Error('OCR已识别并尝试点击引用资料标题最多三次，但未确认资料展开，已停止后续截图。')
  log('capture: 引用资料已展开并合并到回答截图')
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
  postCaptureConfirmTimeout = 800,
}, timeout = 3_500) {
  const deadline = now() + timeout
  const remaining = deadline - now()
  if (remaining <= 0) {
    return { frame: null, xml: '', stable: false, attempts: 0, observer: true, reason: 'observer_timeout' }
  }
  // The caller's timeout bounds only the event-driven settle gate. Once that
  // gate succeeds, hierarchy + lossless ADB PNG capture and the post-capture
  // quiet check use their own bounded phases. Slow PNG transport must not
  // consume the confirmation window and trigger a redundant sandwich capture.
  const initialWaitTimeout = Math.max(1, Math.min(settleWaitCap, remaining))
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
  const afterCaptureMark = observer.mark()
  const activityFramesDuringCapture = (afterCaptureMark.activityFrameCount ?? afterCaptureMark.frameCount)
    - (mark.activityFrameCount ?? mark.frameCount)
  if (hierarchyLoading(xml)) {
    return { frame, xml, stable: false, attempts: 1, observer: true, reason: 'hierarchy_loading' }
  }
  if (activityFramesDuringCapture > 0) {
    return { frame, xml, stable: false, attempts: 1, observer: true, reason: 'capture_activity' }
  }
  const confirmationTimeout = Math.max(confirmQuietMs, postCaptureConfirmTimeout)
  const confirmed = typeof observer.waitForNoActivity === 'function'
    ? await observer.waitForNoActivity({
        timeout: confirmationTimeout,
        quietMs: confirmQuietMs,
        minWaitMs: confirmQuietMs,
      })
    : await observer.waitForQuiet({
        timeout: confirmationTimeout,
        windowMs: confirmQuietMs,
        quietMs: confirmQuietMs,
        maxFrames: 0,
        minWaitMs: confirmQuietMs,
      })
  const currentMark = observer.mark()
  const activityFramesThroughConfirmation = (currentMark.activityFrameCount ?? currentMark.frameCount)
    - (mark.activityFrameCount ?? mark.frameCount)
  if (confirmed.quiet && activityFramesThroughConfirmation === 0) {
    return { frame, xml, stable: true, attempts: 1, observer: true }
  }
  const reason = !confirmed.quiet
    ? 'post_capture_confirmation_timeout'
    : 'capture_activity'
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

module.exports = {
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
  evidenceSummaryOcrTarget,
  evidenceSummaryExpandedByOcr,
  evidenceSummaryTextCenter,
  prepareEmbeddedEvidence,
  fillQuestionInput,
  captureStableSandwich,
  captureStableObserved,
  observerRegionFallbackOptions,
}
