const { sleep } = require('./utils')
const {
  questionVisible,
  findChatScrollBounds,
  validateCaptureViewport,
  replyCaptureBounds,
  estimateVerticalScrollShift,
} = require('./hierarchy')
const {
  imageInfo,
  cropImage,
  imagesSimilar,
  imageRegionsStable,
  verifyFrameOverlap,
} = require('./images')
const {
  requireQuestionLocated,
  scrollSingleQuestionSessionToTop,
  prepareEmbeddedEvidence,
  scrollEndConfirmed,
  captureStableSandwich,
} = require('./capture-primitives')
const { referenceProductsTrigger, miniAppReferenceProductsTrigger } = require('./reference-products')
const { douyinMiniAppCaptureBounds } = require('./miniapp-locators')
const { REPLY_STABLE_QUIET_MS } = require('./capture-stability')

async function replyBoundaryFramesStable(first, second) {
  const firstInfo = await imageInfo(first)
  const secondInfo = await imageInfo(second)
  if (firstInfo.width !== secondInfo.width || firstInfo.height !== secondInfo.height) return false
  const width = firstInfo.width
  const height = firstInfo.height
  const top = Math.floor(height * 0.28)
  const bottom = Math.max(top + 1, Math.floor(height * 0.96))
  const bands = [
    [Math.floor(width * 0.05), Math.floor(width * 0.43)],
    [Math.floor(width * 0.57), Math.floor(width * 0.95)],
  ]
  const comparisons = await Promise.all(bands.map(async ([left, right]) => {
    const [before, after] = await Promise.all([
      cropImage(first, [left, top, right, bottom]),
      cropImage(second, [left, top, right, bottom]),
    ])
    return imageRegionsStable(before, after)
  }))
  return comparisons.every(Boolean)
}

function createReplyCapture({
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
  ocr,
  setLastOcrDiagnostic,
}) {
  async function scrollQuestionIntoView(question, bounds, maxSwipes = 25) {
    for (let index = 0; index < maxSwipes; index += 1) {
      if (questionVisible(await source(), question, bounds)) return true
      await swipeChat(bounds, 'up', 0.65, { speed: 3200, settle: 80 })
    }
    return questionVisible(await source(), question, bounds)
  }

  async function captureFullReplyFrames(question, _maxPages = 30, {
    scrollFraction = 0.45,
    singleQuestionSession = false,
  } = {}) {
    const size = await windowSize()
    const initialXml = await source()
    const navigationBounds = findChatScrollBounds(initialXml, size)
    validateCaptureViewport(size, navigationBounds)
    const topNavigationStarted = Date.now()
    let topNavigationMethod = 'question_bubble'
    let topConfirmationSwipes = 0
    if (singleQuestionSession) {
      const topBoundary = await scrollSingleQuestionSessionToTop({
        capture: () => waitForStableReplyRegion(navigationBounds),
        swipeUp: attempt => swipeChat(navigationBounds, 'up', 0.65, {
          speed: 3_200,
          settle: 80,
          eventDrivenSettle: true,
          xFraction: attempt % 2 ? 0.68 : 0.84,
        }),
        settle: scroll => waitForStableReplyRegion(navigationBounds, 8_000, { settleSince: scroll.activityMark }),
        framesStable: replyBoundaryFramesStable,
      })
      topConfirmationSwipes = topBoundary.swipes
      topNavigationMethod = 'new_session_scroll_boundary'
    } else {
      let questionLocated = questionVisible(initialXml, question, navigationBounds)
      if (!questionLocated) {
        questionLocated = await scrollQuestionIntoView(question, navigationBounds)
        topNavigationMethod = 'question_bubble_scroll'
      }
      requireQuestionLocated(questionLocated, question)
    }
    const topNavigationMs = Date.now() - topNavigationStarted
    log(singleQuestionSession
      ? `capture: 已连续两次向上滚动无变化，确认到达本题顶部（向上滚动=${topConfirmationSwipes}，耗时=${topNavigationMs}ms）`
      : `capture: 当前已有回答已定位问题顶部（耗时=${topNavigationMs}ms）`)
    const evidence = await prepareEmbeddedEvidence({
      screenshot,
      ocr,
      windowSize,
      setLastOcrDiagnostic,
      tap,
      delay: sleep,
      waitForStable: waitForStableReplyRegion,
      log,
    }, navigationBounds)
    if (!singleQuestionSession && !questionVisible(evidence.capture.xml || await source(), question, navigationBounds)) {
      requireQuestionLocated(await scrollQuestionIntoView(question, navigationBounds), question)
      evidence.capture = await waitForStableReplyRegion(navigationBounds)
      log('capture: 引用资料展开后已重新确认问题气泡完整位于首屏')
    }
    const topXml = await source()
    evidence.capture.xml = topXml
    const { bounds, floatingControl } = replyCaptureBounds(topXml, size)
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
            const candidate = await captureReferenceProductsAtTrigger(trigger, { chatBounds: bounds })
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
    const captureDeadline = Date.now() + 5 * 60_000
    for (let page = 0; ; page += 1) {
      if (Date.now() >= captureDeadline) throw new Error('回答已连续采集5分钟但仍未到达末端，为避免静默截断已停止本题')
      let xml = capture.xml || await source()
      if (!frames.length || !(await imageRegionsStable(frames.at(-1), frame))) { frames.push(frame); log(`capture: page ${frames.length}`) }
      if (await captureProductsIfVisible(xml)) break
      const before = frame
      const scroll = await swipeChat(bounds, 'down', scrollFraction, {
        eventDrivenSettle: true,
        xFraction: noProgress > 0 ? 0.68 : 0.84,
      })
      const shift = scroll.distance
      let afterCapture = await waitForStableReplyRegion(bounds, 8_000, { settleSince: scroll.activityMark })
      let after = afterCapture.frame
      if (await replyBoundaryFramesStable(before, after)) {
        noProgress += 1
        const afterXml = afterCapture.xml || await source()
        capture = afterCapture
        frame = after
        if (await captureProductsIfVisible(afterXml)) break
        if (scrollEndConfirmed(scroll.canScrollMore, noProgress)) {
          log('capture: 已连续两次向下滚动无变化，确认到达回答底部')
          break
        }
        log('capture: 第一次向下滚动无变化，切换触点再次确认底部')
      } else {
        noProgress = 0
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
        if (!(await imageRegionsStable(frames.at(-1), after))) {
          frames.push(after)
          transitions.push(transition)
          log(`capture: page ${frames.length}`)
        }
        frame = after
        capture = afterCapture
        if (await captureProductsIfVisible(afterXml)) break
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
      questionLocated: true,
      questionFullyVisible: true,
      evidenceEmbedded: evidence.found,
      evidenceExpanded: evidence.expanded,
      productDetected,
      products,
      productCaptureAttempts,
      productCaptureMs,
      captureMetadata: {
        reply_top_confirmed: true,
        reply_top_navigation_method: topNavigationMethod,
        reply_question_structure_validation_required: !singleQuestionSession,
        reply_top_confirmation_swipes: topConfirmationSwipes,
      },
    }
    if (fallbackReasons.length) log('capture: 不可靠接缝只做本屏局部重采；仍无法校验时保留完整下一视口并明确分隔，不再整题回滚')
    return result
  }
  
  async function waitForMiniAppStableRegion(bounds, platformLabel, timeout = 8_000) {
    await waitForVisualQuiet({ timeout: Math.min(1_200, timeout), fallbackMs: 180 })
    const capture = await captureStableSandwich({
      capture: async () => cropImage(await screenshot(), bounds),
      hierarchy: source,
      framesStable: imageRegionsStable,
      hierarchyLoading: () => false,
      interval: 120,
    }, timeout)
    if (!capture.stable) throw new Error(`${platformLabel}小荷AI全文正文区域持续变化，无法取得可验证的稳定截图。`)
    return capture
  }
  
  async function captureMiniAppFullAnswerFrames(initialXml, initialBounds, {
    platformLabel,
    metadataPrefix,
    openedMetadataKey,
    initialQuietMs = 0,
  }) {
    const frames = []
    const transitions = []
    const fallbackReasons = []
    let recaptureCount = 0
    let unchangedCount = 0
    let scrollAttempts = 0
    let productDetected = false
    let products = null
    let productCaptureAttempts = 0
    let productCaptureMs = 0
    if (initialQuietMs > 0) {
      log(`waiting: 正在等待${platformLabel}小荷AI全文连续${Math.round(initialQuietMs / 1000)}秒无画面活动`)
      await waitForFinalVisualQuiet({ quietMs: initialQuietMs, timeout: 25_000 })
    }
    let capture = await waitForMiniAppStableRegion(initialBounds, platformLabel, 12_000)
    let bounds = douyinMiniAppCaptureBounds(capture.xml || initialXml, await windowSize()) || initialBounds
    if (bounds.join(',') !== initialBounds.join(',')) capture = await waitForMiniAppStableRegion(bounds, platformLabel, 8_000)
  
    const captureProductsIfVisible = async xml => {
      if (products) return true
      let trigger = miniAppReferenceProductsTrigger(xml, bounds)
      if (!trigger) return false
      productDetected = true
      const started = Date.now()
      let lastError = null
      try {
        for (let attempt = 0; attempt < 2 && !products; attempt += 1) {
          productCaptureAttempts += 1
          try {
            const candidate = await captureReferenceProductsAtTrigger(trigger, {
              triggerResolver: latestXml => miniAppReferenceProductsTrigger(latestXml, bounds),
            })
            if (!candidate.firstViewportIncluded) throw new Error('参考药品首项所在视口未纳入截图')
            if (!candidate.imagesReady) throw new Error(`参考药品图片仍有 ${candidate.unloaded} 处未确认加载`)
            if (!candidate.confirmedEnd) throw new Error('参考药品列表未确认到底')
            if (!candidate.continuityVerified) throw new Error('参考药品拼接连续性未通过校验')
            products = candidate
          } catch (error) {
            lastError = error
            if (attempt < 1) {
              log(`capture: ${platformLabel}参考药品采集未完成，在回答尾部入口直接重试（2/2）：${error.message}`)
              trigger = miniAppReferenceProductsTrigger(await source(), bounds) || trigger
            }
          }
        }
        if (!products) throw new Error(`${platformLabel}参考药品为必采内容，但两次采集均未完成：${lastError?.message || '未知错误'}`)
        log(`capture: ${platformLabel}参考药品已从首项到末项完整采集，本题截图结束`)
        return true
      } finally {
        productCaptureMs += Date.now() - started
      }
    }
  
    let topUnchangedCount = 0
    let topNavigationAttempts = 0
    while (topUnchangedCount < 2) {
      topNavigationAttempts += 1
      const before = capture.frame
      await swipeChat(bounds, 'up', 0.62, { maxFraction: 0.68, speed: 2_600 })
      capture = await waitForMiniAppStableRegion(bounds, platformLabel, 6_000)
      topUnchangedCount = await imagesSimilar(before, capture.frame, 3) ? topUnchangedCount + 1 : 0
    }
    log(`capture: ${platformLabel}小荷AI全文已确认位于顶部（回滚尝试=${topNavigationAttempts}）`)
    frames.push(capture.frame)
    log(`capture: ${platformLabel}小荷AI全文 page 1`)
  
    let terminalSequence = await captureProductsIfVisible(capture.xml || await source())
  
    while (!terminalSequence && unchangedCount < 2) {
      scrollAttempts += 1
      const before = frames.at(-1)
      const scroll = await swipeChat(bounds, 'down', 0.5, { maxFraction: 0.58, speed: 1_600, eventDrivenSettle: true })
      let afterCapture = await waitForMiniAppStableRegion(bounds, platformLabel, 8_000)
      let after = afterCapture.frame
      if (await imagesSimilar(before, after, 3)) {
        unchangedCount += 1
        continue
      }
  
      unchangedCount = 0
      const frameHeight = (await imageInfo(before)).height
      const expectedOverlap = Math.max(12, frameHeight - scroll.distance)
      let transition = null
      try {
        if (!afterCapture.stable) throw new Error(`滚动后的${platformLabel}全文画面未稳定`)
        try {
          transition = { verified: true, overlap: await verifyFrameOverlap(before, after, expectedOverlap) }
        } catch {
          transition = { verified: true, overlap: await verifyFrameOverlap(before, after, null) }
        }
      } catch (error) {
        recaptureCount += 1
        afterCapture = await waitForMiniAppStableRegion(bounds, platformLabel, 3_000)
        after = afterCapture.frame
        try {
          if (!afterCapture.stable) throw new Error(`重采后的${platformLabel}全文画面仍未稳定`)
          transition = { verified: true, overlap: await verifyFrameOverlap(before, after, null) }
        } catch (retryError) {
          const reason = retryError.message || error.message
          transition = { verified: false, fallbackOverlap: 0, reason }
          fallbackReasons.push(reason)
          log(`capture: ${platformLabel}全文接缝无法精确校验，保留下一屏完整视口和浅色留白：${reason}`)
        }
      }
      if (!(await imagesSimilar(frames.at(-1), after, 3))) {
        frames.push(after)
        transitions.push(transition)
        log(`capture: ${platformLabel}小荷AI全文 page ${frames.length}`)
      }
      terminalSequence = await captureProductsIfVisible(afterCapture.xml || await source())
    }
    if (!terminalSequence) log(`capture: ${platformLabel}小荷AI全文连续两次滚动无变化，已确认到底`)
    return {
      frames,
      transitions,
      bounds,
      recaptureCount,
      fullRetryCount: 0,
      fallbackReasons,
      topNavigationMs: 0,
      evidenceEmbedded: false,
      evidenceExpanded: false,
      productDetected,
      products,
      productCaptureAttempts,
      productCaptureMs,
      captureMetadata: {
        [openedMetadataKey]: true,
        [`${metadataPrefix}_full_page_confirmed_top`]: true,
        [`${metadataPrefix}_full_page_top_navigation_attempts`]: topNavigationAttempts,
        [`${metadataPrefix}_full_page_confirmed_end`]: true,
        [`${metadataPrefix}_full_page_scroll_attempts`]: scrollAttempts,
      },
    }
  }
  
  function captureDouyinFullAnswerFrames(initialXml, initialBounds) {
    return captureMiniAppFullAnswerFrames(initialXml, initialBounds, {
      platformLabel: '抖音',
      metadataPrefix: 'douyin',
      openedMetadataKey: 'douyin_view_full_opened',
      initialQuietMs: REPLY_STABLE_QUIET_MS,
    })
  }
  
  function captureDouyinMiniAppEntryAnswerFrames(initialXml, initialBounds) {
    return captureMiniAppFullAnswerFrames(initialXml, initialBounds, {
      platformLabel: '抖音',
      metadataPrefix: 'douyin',
      openedMetadataKey: 'douyin_miniapp_entry_opened',
      initialQuietMs: REPLY_STABLE_QUIET_MS,
    })
  }
  
  function captureToutiaoFullAnswerFrames(initialXml, initialBounds) {
    return captureMiniAppFullAnswerFrames(initialXml, initialBounds, {
      platformLabel: '头条',
      metadataPrefix: 'toutiao',
      openedMetadataKey: 'toutiao_view_more_opened',
      initialQuietMs: REPLY_STABLE_QUIET_MS,
    })
  }
  

  return {
    scrollQuestionIntoView,
    captureFullReplyFrames,
    waitForMiniAppStableRegion,
    captureMiniAppFullAnswerFrames,
    captureDouyinFullAnswerFrames,
    captureDouyinMiniAppEntryAnswerFrames,
    captureToutiaoFullAnswerFrames,
  }
}

module.exports = { createReplyCapture, replyBoundaryFramesStable }
