const { sleep } = require('./utils')
const { cropImage, imageInfo, imageLooksLoaded, imageRegionsStable } = require('./images')
const { captureStableSandwich } = require('./capture-primitives')
const { inspectSearchFirstScreen } = require('./search-first-screen')
const {
  toutiaoSearchInput,
  toutiaoViewMoreBounds,
  hierarchyLogicalSize,
  toutiaoOcrViewMoreTarget,
  toutiaoOcrMiniAppEntryTarget,
  douyinMiniAppCaptureBounds,
  toutiaoGenericConsultationPage,
  toutiaoLegacyFullAnswerPage,
} = require('./miniapp-locators')
const {
  ToutiaoAnswerCardNotFoundError,
  ToutiaoFullAnswerNotOpenedError,
} = require('./search-recovery')

async function toutiaoAnswerRegionLooksReady(frame, logicalBounds, logicalSize) {
  const physical = await imageInfo(frame)
  if (!logicalSize?.width || !logicalSize?.height || physical.width <= 0 || physical.height <= 0) return false
  const scaleX = physical.width / logicalSize.width
  const scaleY = physical.height / logicalSize.height
  const [left, top, right, bottom] = logicalBounds
  const viewportWidth = right - left
  const viewportHeight = bottom - top
  if (viewportWidth <= 0 || viewportHeight <= 0) return false
  // Inspect the upper-middle body rather than the shell edges or bottom quick
  // actions. A routed-but-empty consultation page is nearly uniform here;
  // an answer card has enough text edges to pass imageLooksLoaded().
  const bodyBounds = [
    Math.round((left + viewportWidth * 0.08) * scaleX),
    Math.round((top + viewportHeight * 0.05) * scaleY),
    Math.round((right - viewportWidth * 0.08) * scaleX),
    Math.round((top + viewportHeight * 0.58) * scaleY),
  ]
  return imageLooksLoaded(await cropImage(frame, bodyBounds))
}

function createToutiaoSearchWorkflow({
  source,
  windowSize,
  log,
  screenshot,
  ocr,
  setLastOcrDiagnostic,
  waitForVisualQuiet,
  tap,
  ui,
  getActivePackageName,
  activateAnswerRoute,
  now = Date.now,
  delay = sleep,
}) {
  async function waitForToutiaoAnswerCard(timeout, question) {
    const size = await windowSize()
    const result = await inspectSearchFirstScreen({ source, screenshot, timeout, now, delay, log,
      queryMatches: xml => toutiaoSearchInput(xml)?.text === question,
      hierarchyTarget: xml => {
        const viewMore = toutiaoViewMoreBounds(xml)
        return viewMore ? { target: viewMore, viewMore, size, mode: 'smart_summary', detectionMethod: 'ui_hierarchy' } : null
      },
      recognize: async (frame, xml) => {
        const logicalSize = hierarchyLogicalSize(xml, size)
        const recognition = await ocr.recognize(frame, {
          minConfidence: 0.5,
        })
        const ocrTarget = toutiaoOcrViewMoreTarget(recognition, logicalSize) || toutiaoOcrMiniAppEntryTarget(recognition, logicalSize)
        setLastOcrDiagnostic({
          created_at: new Date().toISOString(),
          purpose: 'toutiao_answer_card',
          matcher: {
            summary_pattern: '^小荷AI医生(?:AI)?智能总结$',
            view_more_pattern: '^查看(?:更多|全文)$',
            minimum_confidence: 0.85,
            requires_summary_above_button: true,
            requires_horizontal_overlap: true,
          },
          logical_size: logicalSize,
          recognition,
          target: ocrTarget,
        })
        log(ocrTarget
          ? `ocr: purpose=toutiao_answer_card outcome=matched engine=${recognition.engine} elapsed=${Math.round(recognition.elapsedMs)}ms lines=${recognition.results.length} cache_hit=${Boolean(recognition.cacheHit)} engine_elapsed_ms=${Math.round(recognition.engineElapsedMs || 0)} summary_confidence=${ocrTarget.summaryConfidence.toFixed(3)} view_more_confidence=${ocrTarget.viewMoreConfidence.toFixed(3)} physical_bounds=${ocrTarget.physicalBounds.join(',')} logical_bounds=${ocrTarget.bounds.join(',')}`
          : `ocr: purpose=toutiao_answer_card outcome=not_found engine=${recognition.engine} elapsed=${Math.round(recognition.elapsedMs)}ms lines=${recognition.results.length} cache_hit=${Boolean(recognition.cacheHit)} engine_elapsed_ms=${Math.round(recognition.engineElapsedMs || 0)}`)
        return { target: ocrTarget, viewMore: ocrTarget?.bounds, size, mode: ocrTarget?.mode || 'smart_summary', detectionMethod: 'rapidocr', ocrTarget, recognition }
      },
    })
    if (!result.absent) return result
    throw new ToutiaoAnswerCardNotFoundError('头条搜索结果中未出现小荷AI医生全文入口卡片。', { inspection: { ocrAttempts: result.ocrAttempts, elapsedMs: result.elapsedMs, stableAbsence: true } })
  }
  
  async function captureToutiaoSearchSummary(size, expectedCard = null, question = null) {
    await waitForVisualQuiet({ timeout: 1_200, fallbackMs: 300 })
    const capture = await captureStableSandwich({
      capture: screenshot,
      hierarchy: source,
      framesStable: async (before, after) => {
        if (!expectedCard?.ocrTarget) return imageRegionsStable(before, after)
        const { summaryPhysicalBounds: title, physicalBounds: button } = expectedCard.ocrTarget
        const region = [Math.min(title[0], button[0]), Math.min(title[1], button[1]), Math.max(title[2], button[2]), Math.max(title[3], button[3])]
        return imageRegionsStable(await cropImage(before, region), await cropImage(after, region))
      },
      hierarchyLoading: () => false,
      interval: 120,
    }, 8_000)
    if (!capture.stable) throw new Error('头条搜索结果智能总结持续变化，无法取得稳定截图。')
    if (question && toutiaoSearchInput(capture.xml)?.text !== question) throw new Error('头条入口点击前搜索词已变化，已停止点击。')
    const hierarchyViewMore = toutiaoViewMoreBounds(capture.xml)
    if (hierarchyViewMore) return { ...capture, viewMore: hierarchyViewMore, size, mode: 'smart_summary', detectionMethod: 'ui_hierarchy' }
    const logicalSize = hierarchyLogicalSize(capture.xml, size)
    const recognition = await ocr.recognize(capture.frame, {
      minConfidence: 0.5,
    })
    const ocrTarget = toutiaoOcrViewMoreTarget(recognition, logicalSize) || toutiaoOcrMiniAppEntryTarget(recognition, logicalSize)
    setLastOcrDiagnostic({
      created_at: new Date().toISOString(),
      purpose: 'toutiao_summary_recapture',
      matcher: {
        summary_pattern: '^小荷AI医生(?:AI)?智能总结$',
        view_more_pattern: '^查看(?:更多|全文)$',
        minimum_confidence: 0.85,
        requires_summary_above_button: true,
        requires_horizontal_overlap: true,
      },
      logical_size: logicalSize,
      recognition,
      target: ocrTarget,
    })
    log(ocrTarget
      ? `ocr: purpose=toutiao_summary_recapture outcome=matched engine=${recognition.engine} elapsed=${Math.round(recognition.elapsedMs)}ms lines=${recognition.results.length} cache_hit=${Boolean(recognition.cacheHit)} engine_elapsed_ms=${Math.round(recognition.engineElapsedMs || 0)} summary_confidence=${ocrTarget.summaryConfidence.toFixed(3)} view_more_confidence=${ocrTarget.viewMoreConfidence.toFixed(3)} physical_bounds=${ocrTarget.physicalBounds.join(',')} logical_bounds=${ocrTarget.bounds.join(',')}`
      : `ocr: purpose=toutiao_summary_recapture outcome=not_found engine=${recognition.engine} elapsed=${Math.round(recognition.elapsedMs)}ms lines=${recognition.results.length} cache_hit=${Boolean(recognition.cacheHit)} engine_elapsed_ms=${Math.round(recognition.engineElapsedMs || 0)}`)
    if (!ocrTarget) throw new Error('截取头条智能总结后，UI层级和OCR均未能再次确认小荷AI医生全文入口，已停止点击。')
    return { ...capture, viewMore: ocrTarget.bounds, size, mode: ocrTarget.mode || 'smart_summary', detectionMethod: 'rapidocr', ocrTarget, recognition }
  }
  
  async function openToutiaoFullAnswer(viewMore, size, timeout = 12_000) {
    await tap((viewMore[0] + viewMore[2]) / 2, (viewMore[1] + viewMore[3]) / 2)
    const deadline = Date.now() + timeout
    const hardDeadline = Date.now() + Math.max(timeout, 30_000)
    let fullAnswerHostSeen = false
    let genericConsultationReads = 0
    while (Date.now() < deadline || (fullAnswerHostSeen && Date.now() < hardDeadline)) {
      await waitForVisualQuiet({ timeout: 1_000, fallbackMs: 400 })
      const current = await ui.currentApp()
      if (current?.package && current.package !== getActivePackageName()) {
        if (current.package === 'com.aurora.xiaohe.aidoctor' && activateAnswerRoute) {
          const routed = await activateAnswerRoute(current.package)
          log('stage: 头条已通过已验证的小荷入口跳转到小荷APP，切换原生回答采集并严格核验原题')
          return { ...routed, pageKind: 'xiaohe_app', answerPackage: current.package }
        }
        throw new Error(`头条全文入口点击后进入了错误应用：expected=${getActivePackageName()}, actual=${current.package}`)
      }
      if (/MiniAppHostActivity|BrowserActivity/.test(current?.activity || '')) {
        if (!fullAnswerHostSeen) log('waiting: 已确认进入头条全文宿主，正在等待全文UI层级就绪')
        fullAnswerHostSeen = true
      }
      const xml = await source()
      const bounds = douyinMiniAppCaptureBounds(xml, size)
      const hasMessageInput = toutiaoGenericConsultationPage(xml)
      let answerContentReady = false
      if (bounds && hasMessageInput) {
        answerContentReady = await toutiaoAnswerRegionLooksReady(
          await screenshot(),
          bounds,
          hierarchyLogicalSize(xml, size),
        )
      }
      if (bounds && !toutiaoGenericConsultationPage(xml, { answerContentReady })) {
        const pageKind = toutiaoLegacyFullAnswerPage(xml, size) ? 'legacy_webview' : 'miniapp'
        log(`stage: 已确认头条小荷全文页面（${pageKind}）`)
        return { xml, bounds, pageKind }
      }
      if (hasMessageInput && !answerContentReady) {
        genericConsultationReads += 1
        if (genericConsultationReads >= 3) {
          throw new ToutiaoFullAnswerNotOpenedError(bounds
            ? '头条小荷页面已打开，但连续三次截图仍未确认回答正文；已停止本题，避免交付空白页。'
            : '头条小荷页面已打开，但连续三次未识别到可靠的正文区域；尚未进行正文像素校验，已停止本题。')
        }
      } else genericConsultationReads = 0
    }
    throw new ToutiaoFullAnswerNotOpenedError('已点击头条小荷AI医生全文入口，但未能确认本题全文页打开。')
  }
  

  return {
    waitForToutiaoAnswerCard,
    captureToutiaoSearchSummary,
    openToutiaoFullAnswer,
  }
}

module.exports = { createToutiaoSearchWorkflow, toutiaoAnswerRegionLooksReady }
