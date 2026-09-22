const { sleep } = require('./utils')
const {
  cropImage,
  imageInfo,
  imagesSimilar,
  imageRegionsStable,
  verifyFrameOverlap,
  verifyProductGridOverlap,
  composeLongImages,
} = require('./images')
const {
  captureStableSandwich,
  captureStableObserved,
  maxLongImageHeight,
} = require('./capture-primitives')
const {
  refreshedReferenceProductsTrigger,
  referenceProductDrawerBounds,
  referenceProductSheetExpanded,
  referenceProductViewportReadiness,
  calibratedProductFallbackOverlap,
} = require('./reference-products')
const { hierarchyLogicalSize } = require('./miniapp-locators')
const { logicalBoundsToPhysical } = require('./capture-stability')
const { validateCaptureViewport } = require('./hierarchy')

function createReferenceProductCapture({
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
  getMaxLongImageHeight,
  incrementObserverRegionFallbacks,
  saveFailureEvidence = async () => {},
}) {
  let latestProductCapture = null
  let cardAspectRatios = []
  let previousReadyFrame = null
  const requireReady = (capture, page) => {
    if (!capture?.stable || !capture?.readiness?.ready) {
      const error = new Error(`推荐药品第 ${page} 屏逐卡图片仅确认 ${capture?.readiness?.loaded || 0}/${capture?.readiness?.cards || 0}，缺图或画面未稳定，已停止滚动`)
      error.productCapture = capture
      error.productPage = page
      throw error
    }
  }
  async function captureProductViewport(listBounds, timeout = 4_000, { settleSince = null } = {}) {
    const layoutXml = await source()
    let rawFrame = null
    let physicalBounds = null
    let logicalSize = null
    const captureFrame = async () => {
      rawFrame = await screenshot()
      const physicalSize = await imageInfo(rawFrame)
      logicalSize = hierarchyLogicalSize(layoutXml, physicalSize)
      validateCaptureViewport(logicalSize, listBounds)
      physicalBounds = logicalBoundsToPhysical(listBounds, logicalSize, physicalSize)
      validateCaptureViewport(physicalSize, physicalBounds)
      return cropImage(rawFrame, physicalBounds)
    }
    const deadline = Date.now() + timeout
    let latest = null
    let lastReadinessSignature = null
    while (Date.now() < deadline) {
      checkCancelled()
      const remaining = Math.max(250, deadline - Date.now())
      let capture
      if (observer.active) {
        try {
          capture = await captureStableObserved({
            observer,
            capture: captureFrame,
            hierarchy: source,
            hierarchyLoading: () => false,
            settleSince,
          }, Math.min(2_500, remaining))
        } catch (error) {
          if (await recoverObserver(error)) continue
        }
      }
      if (!capture?.stable) {
        if (observer.active) incrementObserverRegionFallbacks()
        capture = await captureStableSandwich({
          capture: captureFrame,
          hierarchy: source,
          framesStable: imageRegionsStable,
          hierarchyLoading: () => false,
          interval: 80,
          initialFrame: capture?.frame || null,
          initialXml: capture?.xml || '',
        }, remaining)
      }
      let readiness = await referenceProductViewportReadiness(capture.frame, capture.xml, listBounds, { cardAspectRatios })
      if (readiness.previousArtworkOverlapRequired && previousReadyFrame) {
        try {
          const overlap = await verifyProductGridOverlap(previousReadyFrame, capture.frame, null)
          if (overlap >= readiness.previousArtworkTailPhysicalBottom) {
            readiness = await referenceProductViewportReadiness(capture.frame, capture.xml, listBounds, { cardAspectRatios, previousArtworkVerified: true })
          }
        } catch { /* No continuity proof: retain the missing-image failure. */ }
      }
      latest = { ...capture, readiness, rawFrame, physicalBounds, logicalBounds: [...listBounds], logicalSize }
      latestProductCapture = latest
      if (!readiness.ready) {
        const signature = `${readiness.loaded}/${readiness.cards}:${readiness.images}:${readiness.mode}`
        if (signature !== lastReadinessSignature) {
          log(readiness.reason === 'previous_artwork_overlap_unverified'
            ? 'waiting: 药品末屏卡片已裁短，但与前序已加载图片的覆盖关系尚未通过像素验证，保留现场继续只读确认'
            : `waiting: 推荐药品当前视口逐卡图片仅确认 ${readiness.loaded}/${readiness.cards}（候选区域=${readiness.images}，模式=${readiness.mode}），继续等待缺图加载`)
          lastReadinessSignature = signature
        }
      }
      if (capture.stable && readiness.ready) {
        if (readiness.cardAspectRatios.length
          && Math.max(...readiness.cardAspectRatios) / Math.min(...readiness.cardAspectRatios) <= 1.08) cardAspectRatios = readiness.cardAspectRatios
        previousReadyFrame = capture.frame
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
    requireReady(initial, 1)
    readiness.push(initial.readiness)
    const frames = [initial.frame]
    log(`capture: 推荐药品 page 1，逐卡图片 ${initial.readiness.loaded}/${initial.readiness.cards} 已确认加载`)
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
      requireReady(capture, frames.length + 1)
      readiness.push(capture.readiness)
      let frame = capture.frame
      if (await imagesSimilar(frames.at(-1), frame, 3)) {
        unchangedCount += 1
        const requiredUnchanged = frames.length === 1 ? 3 : 2
        if (unchangedCount >= requiredUnchanged) {
          confirmedEnd = true
          log(`capture: 推荐药品连续 ${requiredUnchanged} 次滚动无变化，已确认真实末项`)
          break
        }
        log(`waiting: 推荐药品末端确认 ${unchangedCount}/${requiredUnchanged}`)
        continue
      } else {
        unchangedCount = 0
        const previous = frames.at(-1)
        const expectedOverlap = Math.max(1, Math.floor((await imageInfo(frame)).height * 0.28))
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
          requireReady(capture, frames.length + 1)
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
        log(`capture: 推荐药品 page ${frames.length}，逐卡图片 ${capture.readiness.loaded}/${capture.readiness.cards} 已确认加载`)
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
      const { sheet, list } = referenceProductDrawerBounds(xml)
      if (!sheet) return true
      const [left, top, right, bottom] = sheet
      const closeY = list ? Math.floor((top + list[1]) / 2) : top + Math.max(24, Math.floor((bottom - top) / 10))
      await tap(right - Math.max(24, Math.floor((right - left) / 16)), closeY)
      await waitForVisualQuiet({ timeout: 900, fallbackMs: 600 })
      if (!referenceProductDrawerBounds(await source()).sheet) return true
      await ui.press('back')
      await waitForVisualQuiet({ timeout: 900, fallbackMs: 600 })
    }
    return !referenceProductDrawerBounds(await source()).sheet
  }
  
  async function captureReferenceProductsAtTrigger(trigger, { restoreDrawer = true, chatBounds = null, triggerResolver = null } = {}) {
    latestProductCapture = null
    cardAspectRatios = []
    previousReadyFrame = null
    log('capture: 回答滚动中发现推荐药品入口，正在从首项开始采集完整列表')
    await waitForVisualQuiet({ timeout: 1_200, fallbackMs: 350 })
    let triggerRefreshed = false
    if (chatBounds || triggerResolver) {
      let latest = null
      for (let attempt = 0; attempt < 3; attempt++) {
        const latestXml = await source()
        try { latest = triggerResolver ? await triggerResolver(latestXml) : refreshedReferenceProductsTrigger(latestXml, chatBounds, trigger).trigger } catch (error) {
          if (!/入口.*离开/.test(error.message)) throw error
        }
        const height = chatBounds && chatBounds[3] - chatBounds[1]
        const nearBottom = height && (latest || trigger)[1] > chatBounds[3] - height * 0.12
        // A fresh semantic/OCR target is authoritative, including native
        // buttons below a body crop that excludes a floating control.
        if (latest) break
        if (!nearBottom || attempt === 2) break
        log(`capture: 药品入口仅在底部露出，先短距离滚动露出再重新识别（${attempt + 1}/2）`)
        await swipe(chatBounds[0] + (chatBounds[2] - chatBounds[0]) * 0.68,
          chatBounds[1] + height * 0.72, chatBounds[1] + height * 0.54, 650)
        await waitForVisualQuiet({ timeout: 900, fallbackMs: 250 })
      }
      if (!latest) throw new Error('推荐药品入口在点击前已离开当前视口；为避免点击错误位置已停止操作')
      const refreshed = { trigger: latest, moved: Math.hypot(latest[0] - trigger[0], latest[1] - trigger[1]) > (chatBounds ? (chatBounds[2] - chatBounds[0]) * 0.01 : 0) }
      trigger = refreshed.trigger
      triggerRefreshed = refreshed.moved
      if (triggerRefreshed) log(`capture: 推荐药品入口在页面稳定后发生位移，已刷新点击坐标为 ${trigger.join(',')}`)
    }
    try { await tap(trigger[0], trigger[1]) } catch (error) {
      // A transport error does not establish whether the tap reached Android.
      error.productInteractionUncertain = true
      throw error
    }
    let result = null
    let primaryError = null
    try {
      await waitForVisualQuiet({ timeout: 1_200, fallbackMs: 800 })
      const deadline = Date.now() + 6_000
      let list = null
      let sheet = null
      while (Date.now() < deadline && (!list || !sheet)) {
        const xml = await source()
        const drawer = referenceProductDrawerBounds(xml)
        list = drawer.list
        sheet = drawer.sheet
        if (!list || !sheet) await sleep(100)
      }
      if (!list || !sheet || list[3] - list[1] < (list[2] - list[0]) * 0.1) {
        throw new Error(`推荐药品入口已点击，但未识别到药品列表抽屉（sheet=${sheet ? sheet.join(',') : 'none'} list=${list ? list.join(',') : 'none'}）`)
      }
      log(`capture: 推荐药品抽屉初始边界 sheet=${sheet.join(',')} list=${list.join(',')}`)
      for (let attempt = 0; attempt < 3 && !referenceProductSheetExpanded(sheet, list); attempt += 1) {
        const [left, top, right, bottom] = list
        const height = bottom - top
        const previousTop = top
        // Drag the sheet header/handle, not RecyclerView content. A gesture in
        // the product grid can scroll to a middle card before the first frame
        // and was the source of the missing/duplicated opening products.
        const headerHeight = top - sheet[1]
        if (headerHeight <= 0) throw new Error('药品抽屉缺少可安全拖动的标题区域')
        const fromY = sheet[1] + headerHeight * 0.6
        const toY = Math.max(bottom * 0.06, fromY - height * 0.7)
        await swipe(left + (right - left) * 0.5, fromY, toY, 350)
        const expandDeadline = Date.now() + 2_500
        while (Date.now() < expandDeadline) {
          await sleep(100)
          const expandedXml = await source()
          const { list: expandedList, sheet: expandedSheet } = referenceProductDrawerBounds(expandedXml)
          if (expandedList && expandedSheet && expandedList[1] < previousTop - bottom * 0.015) {
            list = expandedList
            sheet = expandedSheet
            break
          }
        }
        if (list[1] >= previousTop - bottom * 0.015) await waitForVisualQuiet({ timeout: 700, fallbackMs: 250 })
      }
      if (!referenceProductSheetExpanded(sheet, list)) {
        throw new Error(`推荐药品抽屉未完全展开（sheet=${sheet.join(',')} list=${list.join(',')}），为避免从中间药品开始已停止采集`)
      }
      await waitForVisualQuiet({ timeout: 900, fallbackMs: 250 })
      log(`capture: 推荐药品抽屉已先展开，列表视口=${list[3] - list[1]}px`)
      const expandedInitial = await captureProductViewport(list)
      if (!expandedInitial) throw new Error('推荐药品展开后首屏未能完成稳定截图')
      const capture = await captureScrollingRegion(list, expandedInitial)
      const chunks = await composeLongImages(capture.frames, {
        transitions: capture.transitions,
        maxHeight: maxLongImageHeight(getMaxLongImageHeight()),
        separatorHeight: 0,
      })
      const unloaded = capture.readiness.reduce((sum, item) => sum + item.unloaded, 0)
      const imagesReady = capture.readiness.every(item => item.ready)
      log(`capture: 推荐药品截图完成，共 ${capture.frames.length} 屏，图片${imagesReady ? '已全部加载' : `仍有 ${unloaded} 处未确认加载`}`)
      result = { images: chunks, pages: capture.frames.length, firstViewportIncluded: true, firstViewportStandalone: false, imagesReady, unloaded, confirmedEnd: capture.confirmedEnd, continuityVerified: capture.continuityVerified, calibratedSeams: capture.calibratedSeams, seamRecaptures: capture.seamRecaptures, fullRangeSearches: capture.fullRangeSearches, readinessModes: [...new Set(capture.readiness.map(item => item.mode))], triggerRefreshed }
    } catch (error) {
      primaryError = error
      try { await saveFailureEvidence(error, error.productCapture || latestProductCapture) }
      catch (diagnosticError) { log(`diagnostic: 药品失败现场保存异常，保留原始错误：${diagnosticError.message}`) }
      throw error
    } finally {
      if (restoreDrawer) try {
        if (!(await closeReferenceProductsDrawer())) throw new Error('推荐药品截图完成后无法关闭药品列表抽屉')
      } catch (cleanupError) {
        if (!primaryError) {
          cleanupError.productCleanupError = cleanupError.message
          throw cleanupError
        }
        primaryError.productCleanupError = cleanupError.message
        log(`diagnostic: 药品抽屉清理失败，保留原始采集错误：${cleanupError.message}`)
      }
    }
    return result
  }
  

  return {
    captureProductViewport,
    captureScrollingRegion,
    closeReferenceProductsDrawer,
    captureReferenceProductsAtTrigger,
  }
}

module.exports = { createReferenceProductCapture }
