const { sleep } = require('./utils')
const {
  questionVisible,
  findChatScrollBounds,
  validateCaptureViewport,
  replyCaptureBounds,
  replyTailOnScreen,
  estimateVerticalScrollShift,
  hierarchyIsLoading,
  floatingScrollControlBounds,
} = require('./hierarchy')
const {
  imageInfo,
  cropImage,
  imagesSimilar,
  imageRegionsStable,
  verifyFrameOverlap,
  verifyReplyFrameOverlap,
  analyzeReplyScrollEvidence,
  detectFloatingDownArrow,
} = require('./images')
const {
  requireQuestionLocated,
  scrollSingleQuestionSessionToTop,
  confirmPersistentScrollEnd,
  prepareEmbeddedEvidence,
  scrollEndConfirmed,
  captureStableSandwich,
} = require('./capture-primitives')
const { referenceProductsTrigger, miniAppReferenceProductsTrigger } = require('./reference-products')
const { douyinMiniAppCaptureBounds } = require('./miniapp-locators')
const { hierarchyLogicalSize } = require('./miniapp-locators')
const { mapPhysicalBoundsToLogical } = require('./ocr')
const { REPLY_STABLE_QUIET_MS } = require('./capture-stability')
const { CaptureSequence } = require('./capture-sequence')

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

function seamErrorSummary(error) {
  if (!error) return null
  return {
    message: error.message || String(error),
    candidate_overlaps: Array.isArray(error.candidateOverlaps) ? error.candidateOverlaps : [],
    suggested_overlap: Number.isFinite(error.suggestedOverlap) ? error.suggestedOverlap : null,
  }
}

function stableCaptureSummary(capture) {
  return {
    stable: capture?.stable ?? null,
    attempts: capture?.attempts ?? null,
    observer: capture?.observer ?? null,
    reason: capture?.reason || null,
  }
}

async function navigateReplyToBottomControl({
  initialXml,
  bounds,
  source,
  tap,
  log = () => {},
  delay = sleep,
  maxClicks = 3,
  settleMs = 650,
}) {
  let xml = initialXml
  let target = floatingScrollControlBounds(xml, bounds)
  let clicks = 0
  while (target && clicks < maxClicks) {
    clicks += 1
    await tap((target[0] + target[2]) / 2, (target[1] + target[3]) / 2)
    await delay(settleMs)
    xml = await source()
    target = floatingScrollControlBounds(xml, bounds)
    if (target && clicks < maxClicks) log(`waiting: 固定到底按钮第${clicks}次点击后仍存在，已从最新层级重新定位后继续直达`)
  }
  return { clicks, targetCleared: !target, lastXml: xml }
}

function shouldDiscardUnprovenCandidate({ transition, reliableMeasuredShift, newContentEvidence, bottomContext }) {
  return Boolean(transition && !transition.verified
    && bottomContext
    && !(Number.isFinite(reliableMeasuredShift) && reliableMeasuredShift > 0)
    && !newContentEvidence?.provesNewContent)
}

function createReplyCapture({
  source,
  swipeChat,
  windowSize,
  waitForStableReplyRegionDirect,
  captureReplyRegionSnapshot,
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
    let completionConfirmation = null
    let completionNavigationMethod = 'not_required'
    let completionNavigationClicks = 0
    let completionNavigationTargetCleared = null
    if (singleQuestionSession) {
      log('waiting: 正在小荷回答底部确认内容已完整生成')
      const jumpTarget = floatingScrollControlBounds(initialXml, navigationBounds)
      if (jumpTarget) {
        completionNavigationMethod = 'hierarchy_floating_control'
        log('waiting: 层级已确认固定到底按钮，正在一次直达回答底部后执行持续稳定验证')
        const navigation = await navigateReplyToBottomControl({
          initialXml,
          bounds: navigationBounds,
          source,
          tap,
          log,
        })
        completionNavigationClicks = navigation.clicks
        completionNavigationTargetCleared = navigation.targetCleared
        log(navigation.targetCleared
          ? `waiting: 固定到底按钮已消失，完成受控直达（点击=${navigation.clicks}次），继续执行持续稳定验证`
          : `waiting: 固定到底按钮连续${navigation.clicks}次点击后仍存在，停止点击并改由滚动探测完成验证`)
      } else completionNavigationMethod = 'verified_scroll_probes'
      completionConfirmation = await confirmPersistentScrollEnd({
        capture: () => jumpTarget
          ? waitForStableReplyRegionDirect(navigationBounds, 8_000)
          : captureReplyRegionSnapshot(navigationBounds, { settleMs: 0 }),
        swipeDown: attempt => swipeChat(navigationBounds, 'down', 0.78, {
          maxFraction: 0.82,
          speed: 4_000,
          settle: 60,
          xFraction: attempt % 2 ? 0.68 : 0.84,
        }),
        settle: () => captureReplyRegionSnapshot(navigationBounds),
        framesStable: replyBoundaryFramesStable,
        hierarchyLoading: hierarchyIsLoading,
      })
      log(`waiting: 小荷回答底部已持续${Math.round(completionConfirmation.quietMs / 1000)}秒不可继续滚动且内容无变化，确认生成完成（探测=${completionConfirmation.probes}，重置=${completionConfirmation.resets}）`)
    }
    const topNavigationStarted = Date.now()
    let topNavigationMethod = 'question_bubble'
    let topConfirmationSwipes = 0
    if (singleQuestionSession) {
      const topBoundary = await scrollSingleQuestionSessionToTop({
        capture: () => waitForStableReplyRegionDirect(navigationBounds),
        swipeUp: attempt => swipeChat(navigationBounds, 'up', 0.78, {
          maxFraction: 0.82,
          speed: 4_000,
          settle: 80,
          xFraction: attempt % 2 ? 0.68 : 0.84,
        }),
        settle: () => waitForStableReplyRegionDirect(navigationBounds, 8_000),
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
      waitForStable: waitForStableReplyRegionDirect,
      log,
    }, navigationBounds)
    if (!singleQuestionSession && !questionVisible(evidence.capture.xml || await source(), question, navigationBounds)) {
      requireQuestionLocated(await scrollQuestionIntoView(question, navigationBounds), question)
      evidence.capture = await waitForStableReplyRegionDirect(navigationBounds)
      log('capture: 引用资料展开后已重新确认问题气泡完整位于首屏')
    }
    const topXml = await source()
    evidence.capture.xml = topXml
    const logicalSize = hierarchyLogicalSize(topXml, size)
    const captureBounds = replyCaptureBounds(topXml, logicalSize)
    const bounds = captureBounds.bounds
    let floatingControl = captureBounds.floatingControl
    let floatingControlDetectionMethod = floatingControl ? 'hierarchy' : null
    if (!floatingControl) {
      const physicalFrame = await screenshot()
      const physicalSize = await imageInfo(physicalFrame)
      const physicalSearchBounds = [
        Math.round(bounds[0] * physicalSize.width / logicalSize.width),
        Math.round(bounds[1] * physicalSize.height / logicalSize.height),
        Math.round(bounds[2] * physicalSize.width / logicalSize.width),
        Math.round(bounds[3] * physicalSize.height / logicalSize.height),
      ]
      const detected = await detectFloatingDownArrow(physicalFrame, physicalSearchBounds)
      if (detected) {
        floatingControl = mapPhysicalBoundsToLogical(detected.bounds, physicalSize, logicalSize)
        const safeBottom = floatingControl[1] - Math.max(8, Math.floor((bounds[3] - bounds[1]) * 0.008))
        if (safeBottom - bounds[1] >= logicalSize.height * 0.3) {
          bounds[3] = safeBottom
          floatingControlDetectionMethod = 'image'
          log(`capture: UI层级未暴露固定向下按钮，图像兜底已识别并避开（score=${detected.score.toFixed(3)}，bounds=${floatingControl.join(',')}）`)
        } else floatingControl = null
      }
    }
    validateCaptureViewport(logicalSize, bounds)
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
    } else initialCapture = await waitForStableReplyRegionDirect(bounds)
    const sequence = new CaptureSequence()
    const seamRecords = []
    const seamDiagnostics = []
    const scrollDecisions = []
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
    sequence.addInitial(capture.frame)
    scrollDecisions.push({ attempt: 1, outcome: 'initial_frame_appended', frame_count: sequence.length })
    log('capture: page 1')
    const captureDeadline = Date.now() + 5 * 60_000
    for (let page = 0; ; page += 1) {
      if (Date.now() >= captureDeadline) throw new Error('回答已连续采集5分钟但仍未到达末端，为避免静默截断已停止本题')
      let xml = capture.xml || await source()
      if (await captureProductsIfVisible(xml)) break
      const screenBefore = capture.frame
      const before = sequence.lastFrame
      const scroll = await swipeChat(bounds, 'down', scrollFraction, {
        xFraction: noProgress > 0 ? 0.68 : 0.84,
      })
      const shift = scroll.distance
      let afterCapture = await captureReplyRegionSnapshot(bounds)
      let after = afterCapture.frame
      if (await replyBoundaryFramesStable(screenBefore, after)) {
        noProgress += 1
        scrollDecisions.push({
          attempt: page + 1,
          page: sequence.length,
          outcome: 'no_progress',
          unchanged_count: noProgress,
          scroll: { distance: scroll.distance, x: scroll.x ?? null, duration_ms: scroll.durationMs ?? null, can_scroll_more: scroll.canScrollMore },
          capture: stableCaptureSummary(afterCapture),
        })
        const afterXml = afterCapture.xml || await source()
        capture = afterCapture
        if (await captureProductsIfVisible(afterXml)) break
        if (scrollEndConfirmed(scroll.canScrollMore, noProgress)) {
          log('capture: 已连续两次向下滚动无变化，确认到达回答底部')
          break
        }
        log('capture: 第一次向下滚动无变化，切换触点再次确认底部')
      } else {
        const noProgressBeforeScroll = noProgress
        let afterXml = afterCapture.xml || await source()
        const frameHeight = (await imageInfo(before)).height
        let measuredShift = estimateVerticalScrollShift(xml, afterXml, bounds)
        let reliableMeasuredShift = measuredShift !== null && measuredShift <= shift * 1.35 ? measuredShift : null
        const expectedShift = reliableMeasuredShift ?? shift
        let expectedOverlap = Math.max(12, frameHeight - expectedShift)
        const initialAfterCapture = afterCapture
        const initialAfter = after
        const initialAfterXml = afterXml
        const initialMeasurement = {
          requested_scroll_distance: shift,
          measured_shift: measuredShift,
          reliable_measured_shift: reliableMeasuredShift,
          expected_shift: expectedShift,
          expected_overlap: expectedOverlap,
        }
        let retryMeasurement = null
        let firstError = null
        let retryError = null
        let recaptureSnapshot = null
        let transition
        try {
          if (!afterCapture.stable) throw new Error('滚动后的局部画面未稳定')
          transition = { verified: true, overlap: await verifyReplyFrameOverlap(before, after, expectedOverlap, { measuredShift: reliableMeasuredShift }) }
        } catch (error) {
          firstError = error
          recaptureCount += 1
          afterCapture = await waitForStableReplyRegionDirect(bounds, 3_000)
          after = afterCapture.frame
          afterXml = afterCapture.xml || await source()
          recaptureSnapshot = { ...stableCaptureSummary(afterCapture), frame: after, xml: afterXml }
          measuredShift = estimateVerticalScrollShift(xml, afterXml, bounds)
          reliableMeasuredShift = measuredShift !== null && measuredShift <= shift * 1.35 ? measuredShift : null
          const retryExpectedShift = reliableMeasuredShift ?? shift
          expectedOverlap = Math.max(12, frameHeight - retryExpectedShift)
          retryMeasurement = {
            requested_scroll_distance: shift,
            measured_shift: measuredShift,
            reliable_measured_shift: reliableMeasuredShift,
            expected_shift: retryExpectedShift,
            expected_overlap: expectedOverlap,
          }
          try {
            if (!afterCapture.stable) throw new Error('重采后的局部画面仍未稳定')
            transition = { verified: true, overlap: await verifyReplyFrameOverlap(before, after, expectedOverlap, { measuredShift: reliableMeasuredShift }) }
          } catch (retryFailure) {
            const reason = retryFailure.message || error.message
            retryError = retryFailure
            // Once pixel continuity cannot be proven, XML coordinates and the
            // requested swipe distance are only estimates. Cropping by either
            // can silently remove lines after a Compose reflow, so retain the
            // complete next viewport and make the duplicate boundary explicit.
            const fallbackOverlap = 0
            transition = { verified: false, fallbackOverlap, reason }
          }
        }
        const newContentEvidence = await analyzeReplyScrollEvidence(before, after, expectedOverlap)
        const provesNewContent = (Number.isFinite(reliableMeasuredShift) && reliableMeasuredShift > 0)
          || newContentEvidence.provesNewContent
        const bottomContext = noProgressBeforeScroll > 0 || replyTailOnScreen(afterXml, bounds)
        const discardUnproven = shouldDiscardUnprovenCandidate({
          transition,
          reliableMeasuredShift,
          newContentEvidence,
          bottomContext,
        })
        if (discardUnproven) {
          noProgress = noProgressBeforeScroll + 1
          const seamIndex = sequence.length
          const outcome = noProgressBeforeScroll > 0 ? 'bottom_bounce_discarded' : 'unproven_candidate_discarded'
          const record = {
            index: seamIndex,
            from_page: sequence.length,
            to_page: null,
            outcome,
            scroll: { distance: scroll.distance, x: scroll.x ?? null, duration_ms: scroll.durationMs ?? null, can_scroll_more: scroll.canScrollMore },
            initial_measurement: initialMeasurement,
            retry_measurement: retryMeasurement,
            first_error: seamErrorSummary(firstError),
            retry_error: seamErrorSummary(retryError),
            new_content_evidence: { ...newContentEvidence, hierarchy_shift: reliableMeasuredShift, bottom_context: bottomContext },
            transition: null,
          }
          seamRecords.push(record)
          seamDiagnostics.push({
            index: seamIndex,
            createdAt: new Date().toISOString(),
            fromPage: sequence.length,
            toPage: null,
            scroll: record.scroll,
            initialMeasurement,
            retryMeasurement,
            firstError,
            retryError,
            transition: null,
            newContentEvidence: record.new_content_evidence,
            previous: { ...stableCaptureSummary(capture), frame: before, xml },
            afterScroll: { ...stableCaptureSummary(initialAfterCapture), frame: initialAfter, xml: initialAfterXml },
            recapture: recaptureSnapshot,
          })
          scrollDecisions.push({
            attempt: page + 1,
            page: sequence.length,
            outcome,
            unchanged_count: noProgress,
            new_content_evidence: record.new_content_evidence,
          })
          capture = afterCapture
          log(noProgressBeforeScroll > 0
            ? 'capture: 第二次底部确认只出现回弹/固定控件差异，未发现一致位移和新增正文，不加入新页面'
            : 'capture: 接缝失败且没有一致位移或层级移动证据，暂按无进展确认，不加入新页面')
          if (await captureProductsIfVisible(afterXml)) break
          if (scrollEndConfirmed(scroll.canScrollMore, noProgress)) {
            log('capture: 已排除底部回弹并连续两次确认无新内容，确认到达回答底部')
            break
          }
          continue
        }
        noProgress = 0
        if (!transition.verified) {
          fallbackReasons.push(transition.reason)
          log(provesNewContent
            ? `capture: 已确认存在新页面但接缝无法精确校验，保留下一屏完整视口、重复内容和浅色留白：${transition.reason}`
            : `capture: 尚未取得到底上下文且无法证明接缝，为避免漏掉可能的新正文，保留下一屏完整视口并明确降级：${transition.reason}`)
        }
        if (!(await imageRegionsStable(sequence.lastFrame, after))) {
          const seamIndex = sequence.length
          const record = {
            index: seamIndex,
            from_page: sequence.length,
            to_page: sequence.length + 1,
            outcome: transition.verified ? (firstError ? 'verified_after_recapture' : 'verified') : 'fallback',
            scroll: { distance: scroll.distance, x: scroll.x ?? null, duration_ms: scroll.durationMs ?? null, can_scroll_more: scroll.canScrollMore },
            initial_measurement: initialMeasurement,
            retry_measurement: retryMeasurement,
            first_error: seamErrorSummary(firstError),
            retry_error: seamErrorSummary(retryError),
            new_content_evidence: { ...newContentEvidence, hierarchy_shift: reliableMeasuredShift, bottom_context: bottomContext },
            transition,
          }
          seamRecords.push(record)
          if (firstError) {
            seamDiagnostics.push({
              index: seamIndex,
              createdAt: new Date().toISOString(),
              fromPage: sequence.length,
              toPage: sequence.length + 1,
              scroll: record.scroll,
              initialMeasurement,
              retryMeasurement,
              firstError,
              retryError,
              transition,
              newContentEvidence: record.new_content_evidence,
              previous: { ...stableCaptureSummary(capture), frame: before, xml },
              afterScroll: { ...stableCaptureSummary(initialAfterCapture), frame: initialAfter, xml: initialAfterXml },
              recapture: recaptureSnapshot,
            })
          }
          sequence.append(after, transition)
          scrollDecisions.push({ attempt: page + 1, page: sequence.length, outcome: 'candidate_appended', seam_index: seamIndex, transition: record.outcome, new_content_evidence: record.new_content_evidence })
          log(`capture: page ${sequence.length}`)
        } else scrollDecisions.push({ attempt: page + 1, page: sequence.length, outcome: 'candidate_discarded_as_duplicate', capture: stableCaptureSummary(afterCapture) })
        capture = afterCapture
        if (await captureProductsIfVisible(afterXml)) break
      }
    }
    if (!productDetected) log('capture: 回答滚动过程中未发现参考/推荐药品入口，无需完成后重复扫描')
    const captured = sequence.toCaptureResult()
    const result = {
      frames: captured.frames,
      transitions: captured.transitions,
      seamRecords,
      seamDiagnostics,
      scrollDecisions,
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
        reply_floating_control_detection_method: floatingControlDetectionMethod,
        reply_floating_control_bounds: floatingControl,
        reply_completion_confirmation_method: completionConfirmation ? 'persistent_scroll_end' : 'existing_answer_stability',
        reply_completion_navigation_method: completionNavigationMethod,
        reply_completion_navigation_clicks: completionNavigationClicks,
        reply_completion_navigation_target_cleared: completionNavigationTargetCleared,
        reply_completion_confirmed_before_capture: Boolean(completionConfirmation),
        reply_completion_confirmation_probes: completionConfirmation?.probes ?? 0,
        reply_completion_confirmation_resets: completionConfirmation?.resets ?? 0,
        reply_completion_confirmation_quiet_ms: completionConfirmation?.quietMs ?? 0,
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
    const sequence = new CaptureSequence()
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
    sequence.addInitial(capture.frame)
    log(`capture: ${platformLabel}小荷AI全文 page 1`)
  
    let terminalSequence = await captureProductsIfVisible(capture.xml || await source())
  
    while (!terminalSequence && unchangedCount < 2) {
      scrollAttempts += 1
      const before = sequence.lastFrame
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
      if (!(await imagesSimilar(sequence.lastFrame, after, 3))) {
        sequence.append(after, transition)
        log(`capture: ${platformLabel}小荷AI全文 page ${sequence.length}`)
      }
      terminalSequence = await captureProductsIfVisible(afterCapture.xml || await source())
    }
    if (!terminalSequence) log(`capture: ${platformLabel}小荷AI全文连续两次滚动无变化，已确认到底`)
    const captured = sequence.toCaptureResult()
    return {
      frames: captured.frames,
      transitions: captured.transitions,
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

module.exports = { createReplyCapture, navigateReplyToBottomControl, replyBoundaryFramesStable, shouldDiscardUnprovenCandidate }
