const fs = require('node:fs/promises')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { sleep, createBatchDirectory, questionArtifactDirectory } = require('./utils')
const { iterNodes, nodeAttr, hierarchyIsLoading, parseBounds, boundsIntersect, boundsCenterY, estimateVerticalScrollShift, replyTailOnScreen, questionVisible, findChatScrollBounds, validateCaptureViewport, replyCaptureBounds, visibleLabelBounds, visibleLabelBoundsList, boundsForNodeAttribute, boundsListForNodeAttribute, evidencePanelBounds, evidenceMinimumHeight, referenceProductsSection } = require('./hierarchy')
const { imageInfo, cropImage, imagesSimilar, imageRegionsStable, imageLooksLoaded, alignCropToWhitespace, verifyFrameOverlap, composeLongImages } = require('./images')
const { U2Client } = require('./u2-client')

const DEFAULT_PACKAGE = 'com.aurora.xiaohe.aidoctor'
const DEFAULT_MAX_LONG_IMAGE_HEIGHT = 12_000

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

function createRunner(options) {
  let cancelled = false
  let activeSerial = null
  let cachedInputBounds = null
  let cachedSendBounds = null
  const ui = options.uiClient || new U2Client({
    root: options.root,
    isPackaged: options.isPackaged,
    resourcesPath: options.resourcesPath,
    adbPath: options.adbPath,
    log: options.log,
  })
  const checkCancelled = () => { if (cancelled) throw new CancelledError() }
  const log = text => options.log(`${text}${String(text).endsWith('\n') ? '' : '\n'}`)

  async function screenshot() {
    checkCancelled()
    return adbScreenshot(options.adbPath, activeSerial)
  }

  async function source() {
    checkCancelled()
    return ui.dumpHierarchy()
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
    await tap((edit.bounds[0] + edit.bounds[2]) / 2, (edit.bounds[1] + edit.bounds[3]) / 2)
    await sleep(300)
    // Use uiautomator2's device-level IME/clipboard input rather than a
    // WebDriver element value command. Mutating UI requests are not replayed
    // after failure, so an uncertain input state terminates the task.
    await ui.sendKeys(question, { clear: Boolean(edit.text) })
    await ui.press('back')
    await sleep(350)
    const restoredXml = await source()
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
    await sleep(1_000)
    for (const text of ['确定', '确认', '开始', '新会话']) {
      const button = visibleLabelBounds(await source(), text)
      if (button) { await tap((button[0] + button[2]) / 2, (button[1] + button[3]) / 2); await sleep(1_000); break }
    }
    return true
  }

  async function normalizedHierarchy() {
    return (await source()).replace(/focused="(?:true|false)"/g, 'focused=""').replace(/selected="(?:true|false)"/g, 'selected=""')
  }

  async function waitForStableReply(timeout) {
    const minWait = 12_000
    const stableMilliseconds = 5_000
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

  async function swipeChat(bounds, direction, fraction = 0.6, {
    maxFraction = 0.7,
    speed = 1400,
    settle = 150,
    fallbackDuration = 900,
  } = {}) {
    const [left, top, right, bottom] = bounds
    const height = bottom - top
    const { distance, percent } = chatSwipePlan(bounds, fraction, { maxFraction, speed })
    const canScrollMore = null
    const x = left + (right - left) * 0.84
    const center = Math.floor((top + bottom) / 2)
    const duration = Math.max(120, Math.round(distance / speed * 1_000))
    if (direction === 'up') await swipe(x, center - Math.floor(distance / 2), center + Math.ceil(distance / 2), duration || fallbackDuration)
    else await swipe(x, center + Math.ceil(distance / 2), center - Math.floor(distance / 2), duration || fallbackDuration)
    await sleep(settle)
    return { distance, canScrollMore }
  }

  async function waitForRegionPixelsStable(bounds, timeout = 8_000) {
    let frame = await cropImage(await screenshot(), bounds)
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      await sleep(300)
      const next = await cropImage(await screenshot(), bounds)
      if (await imagesSimilar(frame, next, 1)) return next
      frame = next
    }
    return frame
  }

  async function waitForStableReplyRegion(bounds, timeout = 8_000) {
    let before = await cropImage(await screenshot(), bounds)
    let lastXml = ''
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      await sleep(260)
      const after = await cropImage(await screenshot(), bounds)
      if (await imageRegionsStable(before, after)) {
        // screenshot → hierarchy → screenshot prevents a locally stable frame
        // from being accepted if Compose reflows during hierarchy collection.
        lastXml = await source()
        const confirmed = await cropImage(await screenshot(), bounds)
        if (!hierarchyIsLoading(lastXml) && await imageRegionsStable(after, confirmed)) return { frame: confirmed, xml: lastXml, stable: true }
        before = confirmed
        continue
      }
      before = after
    }
    return { frame: before, xml: lastXml || await source(), stable: false }
  }

  async function scrollQuestionIntoView(question, bounds, maxSwipes = 25) {
    for (let index = 0; index < maxSwipes; index += 1) {
      if (questionVisible(await source(), question, bounds)) return true
      await swipeChat(bounds, 'up', 0.65, { speed: 3200, settle: 80 })
    }
    return questionVisible(await source(), question, bounds)
  }

  async function captureFullReplyFrames(question, maxPages = 30, { scrollFraction = 0.45, allowFullRetry = true } = {}) {
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
    let productsSeen = false
    const observeAuxiliaryCards = xml => {
      productsSeen ||= Boolean(referenceProductsSection(xml)
        || visibleLabelBounds(xml, '参考药品')
        || visibleLabelBounds(xml, '推荐药品'))
    }
    let capture = initialCapture
    let frame = capture.frame
    for (let page = 0; page < maxPages; page += 1) {
      const xml = capture.xml || await source()
      observeAuxiliaryCards(xml)
      if (!frames.length || !(await imagesSimilar(frames.at(-1), frame, 3))) { frames.push(frame); log(`capture: page ${frames.length}`) }
      if (replyTailOnScreen(xml, bounds) && !hierarchyIsLoading(xml)) { log('capture: reached on-screen reply tail'); break }
      const before = frame
      const scroll = await swipeChat(bounds, 'down', scrollFraction)
      const shift = scroll.distance
      let afterCapture = await waitForStableReplyRegion(bounds)
      let after = afterCapture.frame
      if (await imagesSimilar(before, after, 3)) {
        noProgress += 1
        if (scrollEndConfirmed(scroll.canScrollMore, noProgress)) {
          log(`capture: scroll ended（${scroll.canScrollMore === false ? '设备确认已到底' : '连续两次画面无变化'}）`)
          break
        }
      } else {
        let afterXml = afterCapture.xml || await source()
        observeAuxiliaryCards(afterXml)
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
          await sleep(450)
          afterCapture = await waitForStableReplyRegion(bounds, 3_000)
          after = afterCapture.frame
          afterXml = afterCapture.xml || await source()
          observeAuxiliaryCards(afterXml)
          measuredShift = estimateVerticalScrollShift(xml, afterXml, bounds)
          reliableMeasuredShift = measuredShift !== null && measuredShift <= shift * 1.35 ? measuredShift : null
          const retryExpectedShift = reliableMeasuredShift ?? shift
          expectedOverlap = Math.max(12, frameHeight - retryExpectedShift)
          try {
            if (!afterCapture.stable) throw new Error('重采后的局部画面仍未稳定')
            transition = { verified: true, overlap: await verifyFrameOverlap(before, after, expectedOverlap) }
          } catch (retryError) {
            const reason = retryError.message || error.message
            const fallbackTarget = conservativeFallbackOverlap(frameHeight, reliableMeasuredShift, shift, retryError.candidateOverlaps)
            const fallbackOverlap = fallbackTarget > 0 ? await alignCropToWhitespace(after, fallbackTarget) : 0
            transition = { verified: false, fallbackOverlap, reason }
            fallbackReasons.push(reason)
            log(`capture: 接缝无法精确校验，下一屏安全起点=${fallbackOverlap}px，并保留重复内容和浅色留白：${reason}`)
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
        if (replyTailOnScreen(afterXml, bounds) && !hierarchyIsLoading(afterXml)) { log('capture: reached on-screen reply tail after swipe'); break }
        if (scroll.canScrollMore === false) { log('capture: reached device-reported scroll boundary'); break }
      }
    }
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
      productsSeen,
    }
    if (fallbackReasons.length && allowFullRetry) {
      log('capture: 首轮存在不可靠接缝，从问题顶部以 30% 步长整题重采一次')
      const retry = await captureFullReplyFrames(question, maxPages, { scrollFraction: 0.3, allowFullRetry: false })
      retry.recaptureCount += recaptureCount
      retry.fullRetryCount = 1
      retry.topNavigationMs += topNavigationMs
      return retry
    }
    return result
  }

  async function waitForProductImagesReady(listBounds, timeout = 12_000) {
    const deadline = Date.now() + timeout
    let consecutiveReady = 0
    let best = { ready: false, cards: 0, images: 0, loaded: 0, unloaded: 0 }
    while (Date.now() < deadline) {
      checkCancelled()
      const xml = await source()
      const cards = visibleLabelBoundsList(xml, '查看说明书').filter(bounds => boundsIntersect(bounds, listBounds))
      const imageBounds = boundsListForNodeAttribute(xml, 'class', 'android.widget.ImageView').filter(bounds => {
        const width = bounds[2] - bounds[0]
        const height = bounds[3] - bounds[1]
        return boundsIntersect(bounds, listBounds) && width >= 60 && height >= 45
      })
      const screen = await screenshot()
      const loadedFlags = await Promise.all(imageBounds.map(async bounds => imageLooksLoaded(await cropImage(screen, bounds))))
      const loaded = loadedFlags.filter(Boolean).length
      const expected = Math.max(1, cards.length)
      const ready = imageBounds.length >= expected && loaded === imageBounds.length
      best = { ready, cards: cards.length, images: imageBounds.length, loaded, unloaded: Math.max(expected - loaded, imageBounds.length - loaded, 0) }
      consecutiveReady = ready ? consecutiveReady + 1 : 0
      if (consecutiveReady >= 2) return best
      await sleep(600)
    }
    return best
  }

  async function captureScrollingRegion(bounds, maxPages = 12) {
    const readiness = []
    readiness.push(await waitForProductImagesReady(bounds))
    const frames = [await waitForRegionPixelsStable(bounds, 2_000)]
    let stalled = 0
    let confirmedEnd = false
    let continuityVerified = true
    const overlaps = []
    const [left, top, right, bottom] = bounds
    const x = left + (right - left) * 0.32
    const height = bottom - top
    while (frames.length < maxPages) {
      await swipe(x, top + height * 0.75, top + height * 0.25, 800)
      await sleep(200)
      readiness.push(await waitForProductImagesReady(bounds))
      const frame = await waitForRegionPixelsStable(bounds, 2_000)
      if (await imagesSimilar(frames.at(-1), frame, 3)) {
        stalled += 1
        if (stalled >= 2) { confirmedEnd = true; break }
      } else {
        stalled = 0
        if (continuityVerified) {
          try { overlaps.push(await verifyFrameOverlap(frames.at(-1), frame, Math.max(12, Math.floor(height / 2)))) }
          catch { continuityVerified = false }
        }
        frames.push(frame)
      }
    }
    return { frames, overlaps, readiness, confirmedEnd, continuityVerified }
  }

  async function closeReferenceProductsDrawer() {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const sheet = boundsForNodeAttribute(await source(), 'resource-id', `${DEFAULT_PACKAGE}:id/bullet_container`)
      if (!sheet) return
      const [left, top, right, bottom] = sheet
      await tap(right - Math.max(24, Math.floor((right - left) / 16)), top + Math.max(24, Math.floor((bottom - top) / 10)))
      await sleep(600)
      if (!boundsForNodeAttribute(await source(), 'resource-id', `${DEFAULT_PACKAGE}:id/bullet_container`)) return
      await ui.press('back')
      await sleep(600)
    }
  }

  async function captureReferenceProducts(question, { seenDuringReply = true } = {}) {
    if (!seenDuringReply) { log('capture: 回答滚动过程中未发现参考/推荐药品卡片，跳过重复扫描'); return null }
    const size = await windowSize()
    const chatBounds = findChatScrollBounds(await source(), size)
    validateCaptureViewport(size, chatBounds)
    const productLabels = ['参考药品', '推荐药品']
    const findTrigger = async () => {
      const xml = await source()
      // Compose renders the section label off the accessibility tree, so detect
      // the card carousel structurally first and fall back to text if present.
      const section = referenceProductsSection(xml)
      if (section) return section.tap
      for (const label of productLabels) {
        const bounds = visibleLabelBounds(xml, label)
        if (bounds) return [chatBounds[2] - Math.max(20, Math.floor((chatBounds[2] - chatBounds[0]) / 15)), boundsCenterY(bounds)]
      }
      return null
    }
    let trigger = await findTrigger()
    if (!trigger && !(await scrollQuestionIntoView(question, chatBounds))) return null
    let noProgress = 0
    let previous = await cropImage(await screenshot(), chatBounds)
    for (let index = 0; index < 12 && !trigger; index += 1) {
      trigger = await findTrigger()
      if (trigger) break
      await swipeChat(chatBounds, 'down')
      const next = await cropImage(await screenshot(), chatBounds)
      noProgress = (await imagesSimilar(previous, next, 3)) ? noProgress + 1 : 0
      if (noProgress >= 3) break
      previous = next
    }
    if (!trigger) { log('capture: 本回答未出现参考/推荐药品卡片'); return null }
    log('capture: 已发现推荐药品入口，正在展开并截图')
    await tap(trigger[0], trigger[1])
    await sleep(800)
    try {
      const xml = await source()
      const list = boundsForNodeAttribute(xml, 'class', 'androidx.recyclerview.widget.RecyclerView')
      const sheet = boundsForNodeAttribute(xml, 'resource-id', `${DEFAULT_PACKAGE}:id/bullet_container`)
      if (!list || !sheet || list[3] - list[1] < 100) {
        log('capture: 推荐药品入口已点击，但未识别到药品列表抽屉')
        return null
      }
      const header = await cropImage(await screenshot(), [sheet[0], sheet[1], sheet[2], list[1]])
      const capture = await captureScrollingRegion(list)
      const headerSize = await imageInfo(header)
      const chunks = await composeLongImages(capture.frames, {
        overlaps: capture.overlaps,
        continuityVerified: capture.continuityVerified,
        maxHeight: Math.max(1_000, maxLongImageHeight(payloadMaxLongImageHeight) - headerSize.height),
      })
      const firstSize = await imageInfo(chunks[0])
      const sharp = require('sharp')
      chunks[0] = await sharp({ create: { width: Math.max(headerSize.width, firstSize.width), height: headerSize.height + firstSize.height, channels: 3, background: '#000' } })
        .composite([{ input: header, left: 0, top: 0 }, { input: chunks[0], left: 0, top: headerSize.height }]).png().toBuffer()
      const unloaded = capture.readiness.reduce((sum, item) => sum + item.unloaded, 0)
      const imagesReady = capture.readiness.every(item => item.ready)
      log(`capture: 推荐药品截图完成，共 ${capture.frames.length} 屏，图片${imagesReady ? '已全部加载' : `仍有 ${unloaded} 处未确认加载`}`)
      return { images: chunks, pages: capture.frames.length, imagesReady, unloaded, confirmedEnd: capture.confirmedEnd, continuityVerified: capture.continuityVerified }
    } finally { await closeReferenceProductsDrawer() }
  }

  let payloadMaxLongImageHeight = DEFAULT_MAX_LONG_IMAGE_HEIGHT

  async function saveArtifacts({ outDir, stem, question, status, xml, meta, stitch = true }) {
    await fs.mkdir(outDir, { recursive: true })
    const xmlPath = path.join(outDir, `${stem}.xml`)
    const metadataPath = path.join(outDir, `${stem}.json`)
    let screenshotPath = path.join(outDir, `${stem}.png`)
    let resultMeta = { ...meta }
    if (stitch) {
      const replyCaptureStarted = Date.now()
      const capture = await captureFullReplyFrames(question)
      const { frames, transitions, bounds, recaptureCount, fullRetryCount, fallbackReasons, topNavigationMs, evidenceEmbedded, evidenceExpanded, productsSeen } = capture
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
        ...(fallbackReasons.length ? { reply_fallback_reason: fallbackReasons.join('；') } : {}),
        long_image_max_height: payloadMaxLongImageHeight,
      }
      log(`capture: 回答截图完成，帧=${frames.length}，精确接缝=${seamsVerified}/${seamsTotal}，安全重复接缝=${seamsTotal - seamsVerified}，重采=${recaptureCount}，模式=${resultMeta.reply_capture_mode}，耗时=${replyCaptureMs}ms`)
      // Evidence is already expanded into the first reply frame. Only the
      // interactive reference-products drawer still needs a separate capture.
      const products = await captureReferenceProducts(question, { seenDuringReply: productsSeen })
      if (products) {
        const paths = []
        for (const [index, image] of products.images.entries()) { const file = path.join(outDir, `${stem}_参考药品_${String(index + 1).padStart(3, '0')}.png`); await fs.writeFile(file, image); paths.push(file) }
        Object.assign(resultMeta, {
          reference_products_screenshot: paths[0],
          reference_products_parts: paths,
          reference_products_pages: products.pages,
          reference_products_capture_mode: products.continuityVerified ? 'verified_overlap_stitch' : 'separate_viewports',
          reference_products_continuity_verified: products.continuityVerified,
          reference_products_images_ready: products.imagesReady,
          reference_products_unloaded_images: products.unloaded,
          reference_products_confirmed_end: products.confirmedEnd,
          reference_products_capture_complete: products.imagesReady && products.confirmedEnd,
        })
      }
    } else await fs.writeFile(screenshotPath, await screenshot())
    await fs.writeFile(xmlPath, xml || await normalizedHierarchy(), 'utf8')
    await fs.writeFile(metadataPath, JSON.stringify({ question, status, created_at: new Date().toISOString().replace(/\.\d{3}Z$/, ''), screenshot: screenshotPath, hierarchy: xmlPath, ...resultMeta }, null, 2), 'utf8')
    return { screenshot: screenshotPath, hierarchy: xmlPath, metadata: metadataPath }
  }

  async function askOnce(payload, batchDirectory, question, index) {
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
    await tapSend()
    log('stage: 问题已发送，等待回答稳定')
    await sleep(2_000)
    const result = await waitForStableReply(payload.timeout * 1_000)
    log(`stage: 回答等待结束（${result.status}），开始截图`)
    return saveArtifacts({ outDir: directory, stem: '回答', question, status: result.status, xml: result.xml, meta })
  }

  return {
    async run(payload) {
      activeSerial = payload.serial
      payloadMaxLongImageHeight = maxLongImageHeight(payload.maxLongImageHeight)
      const outputRoot = path.resolve(payload.outputDir)
      const batchDirectory = await createBatchDirectory(outputRoot)
      try {
        await waitForAdbDevice(options.adbPath, payload.serial)
        await ui.start(payload.serial)
        await ui.appStart(DEFAULT_PACKAGE)
        log('UI节点、点击和输入严格使用Python uiautomator2；ADB仅用于无损截图和长图滚动')
        await sleep(800)
        await waitForInput(15_000)
        log(`device=${payload.serial} package=${DEFAULT_PACKAGE} batch=${batchDirectory}`)
        for (const [zeroIndex, question] of payload.questions.entries()) {
          checkCancelled()
          log(`[${zeroIndex + 1}/${payload.questions.length}] asking: ${question}`)
          log(JSON.stringify(await askOnce(payload, batchDirectory, question, zeroIndex + 1)))
        }
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
        await ui.stop().catch(() => {})
      }
    },
    async stop() {
      cancelled = true
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
  scrollEndConfirmed,
  prepareEmbeddedEvidence,
  adbConnectionLost,
  historyOnboardingVisible,
  maxLongImageHeight,
}
