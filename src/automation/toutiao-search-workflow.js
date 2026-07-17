const { sleep } = require('./utils')
const { cropImage, imageInfo, imageLooksLoaded, imageRegionsStable } = require('./images')
const { captureStableSandwich } = require('./capture-primitives')
const {
  toutiaoSearchInput,
  toutiaoViewMoreBounds,
  hierarchyLogicalSize,
  toutiaoOcrViewMoreTarget,
  douyinMiniAppCaptureBounds,
  toutiaoGenericConsultationPage,
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
}) {
  async function waitForToutiaoAnswerCard(timeout, question) {
    const deadline = Date.now() + timeout
    const size = await windowSize()
    let lastProgress = 0
    let nextOcrAt = 0
    let lastStaleQuestion = null
    while (Date.now() < deadline) {
      const xml = await source()
      const resultInput = toutiaoSearchInput(xml)
      if (!resultInput || resultInput.text !== question) {
        if (resultInput?.text && resultInput.text !== lastStaleQuestion) {
          log(`waiting: 头条仍显示旧查询“${resultInput.text}”，已忽略其回答卡片并继续等待当前问题结果`)
          lastStaleQuestion = resultInput.text
        }
        await sleep(500)
        continue
      }
      const viewMore = toutiaoViewMoreBounds(xml)
      if (viewMore) return { xml, viewMore, size, detectionMethod: 'ui_hierarchy' }
      if (Date.now() >= nextOcrAt) {
        const frame = await screenshot()
        const logicalSize = hierarchyLogicalSize(xml, size)
        const recognition = await ocr.recognize(frame, {
          region: [0, Math.floor(size.height * 0.1), size.width, Math.floor(size.height * 0.86)],
          minConfidence: 0.5,
        })
        const ocrTarget = toutiaoOcrViewMoreTarget(recognition, logicalSize)
        setLastOcrDiagnostic({
          created_at: new Date().toISOString(),
          purpose: 'toutiao_answer_card',
          matcher: {
            summary_pattern: '^小荷AI医生(?:AI)?智能总结$',
            view_more_pattern: '^查看更多$',
            minimum_confidence: 0.85,
            requires_summary_above_button: true,
            requires_horizontal_overlap: true,
          },
          logical_size: logicalSize,
          recognition,
          target: ocrTarget,
        })
        log(ocrTarget
          ? `ocr: purpose=toutiao_answer_card outcome=matched engine=${recognition.engine} elapsed=${Math.round(recognition.elapsedMs)}ms lines=${recognition.results.length} summary_confidence=${ocrTarget.summaryConfidence.toFixed(3)} view_more_confidence=${ocrTarget.viewMoreConfidence.toFixed(3)} physical_bounds=${ocrTarget.physicalBounds.join(',')} logical_bounds=${ocrTarget.bounds.join(',')}`
          : `ocr: purpose=toutiao_answer_card outcome=not_found engine=${recognition.engine} elapsed=${Math.round(recognition.elapsedMs)}ms lines=${recognition.results.length}`)
        if (ocrTarget) return { xml, viewMore: ocrTarget.bounds, size, detectionMethod: 'rapidocr', ocrTarget, recognition }
        nextOcrAt = Date.now() + 2_000
      }
      if (Date.now() - lastProgress >= 5_000) {
        log('waiting: 正在等待头条小荷AI医生搜索结果（UI层级或OCR）…')
        lastProgress = Date.now()
      }
      await sleep(500)
    }
    throw new ToutiaoAnswerCardNotFoundError('头条搜索结果中未出现小荷AI医生“查看更多”卡片。')
  }
  
  async function captureToutiaoSearchSummary(size) {
    await waitForVisualQuiet({ timeout: 1_200, fallbackMs: 300 })
    const capture = await captureStableSandwich({
      capture: screenshot,
      hierarchy: source,
      framesStable: imageRegionsStable,
      hierarchyLoading: () => false,
      interval: 120,
    }, 8_000)
    if (!capture.stable) throw new Error('头条搜索结果智能总结持续变化，无法取得稳定截图。')
    const hierarchyViewMore = toutiaoViewMoreBounds(capture.xml)
    if (hierarchyViewMore) return { ...capture, viewMore: hierarchyViewMore, size, detectionMethod: 'ui_hierarchy' }
    const logicalSize = hierarchyLogicalSize(capture.xml, size)
    const recognition = await ocr.recognize(capture.frame, {
      region: [0, Math.floor(size.height * 0.1), size.width, Math.floor(size.height * 0.86)],
      minConfidence: 0.5,
    })
    const ocrTarget = toutiaoOcrViewMoreTarget(recognition, logicalSize)
    setLastOcrDiagnostic({
      created_at: new Date().toISOString(),
      purpose: 'toutiao_summary_recapture',
      matcher: {
        summary_pattern: '^小荷AI医生(?:AI)?智能总结$',
        view_more_pattern: '^查看更多$',
        minimum_confidence: 0.85,
        requires_summary_above_button: true,
        requires_horizontal_overlap: true,
      },
      logical_size: logicalSize,
      recognition,
      target: ocrTarget,
    })
    log(ocrTarget
      ? `ocr: purpose=toutiao_summary_recapture outcome=matched engine=${recognition.engine} elapsed=${Math.round(recognition.elapsedMs)}ms lines=${recognition.results.length} summary_confidence=${ocrTarget.summaryConfidence.toFixed(3)} view_more_confidence=${ocrTarget.viewMoreConfidence.toFixed(3)} physical_bounds=${ocrTarget.physicalBounds.join(',')} logical_bounds=${ocrTarget.bounds.join(',')}`
      : `ocr: purpose=toutiao_summary_recapture outcome=not_found engine=${recognition.engine} elapsed=${Math.round(recognition.elapsedMs)}ms lines=${recognition.results.length}`)
    if (!ocrTarget) throw new Error('截取头条智能总结后，UI层级和OCR均未能再次确认小荷AI医生“查看更多”卡片，已停止点击。')
    return { ...capture, viewMore: ocrTarget.bounds, size, detectionMethod: 'rapidocr', ocrTarget, recognition }
  }
  
  async function openToutiaoFullAnswer(viewMore, size, timeout = 12_000) {
    await tap((viewMore[0] + viewMore[2]) / 2, (viewMore[1] + viewMore[3]) / 2)
    const deadline = Date.now() + timeout
    const hardDeadline = Date.now() + Math.max(timeout, 30_000)
    let miniAppHostSeen = false
    let genericConsultationReads = 0
    while (Date.now() < deadline || (miniAppHostSeen && Date.now() < hardDeadline)) {
      await waitForVisualQuiet({ timeout: 1_000, fallbackMs: 400 })
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
      if (bounds && !toutiaoGenericConsultationPage(xml, { answerContentReady })) return { xml, bounds }
      if (hasMessageInput && !answerContentReady) {
        genericConsultationReads += 1
        if (genericConsultationReads >= 3) {
          throw new ToutiaoFullAnswerNotOpenedError('头条“查看更多”已进入小程序，但连续三次未检测到回答正文像素。')
        }
      } else genericConsultationReads = 0
      const current = await ui.currentApp()
      if (current?.package && current.package !== getActivePackageName()) {
        throw new Error(`头条“查看更多”点击后进入了错误应用：expected=${getActivePackageName()}, actual=${current.package}`)
      }
      if (/MiniAppHostActivity/.test(current?.activity || '')) {
        if (!miniAppHostSeen) log('waiting: 已确认进入头条小程序宿主，正在等待全文UI层级就绪')
        miniAppHostSeen = true
      }
    }
    throw new ToutiaoFullAnswerNotOpenedError('已点击头条小荷AI医生“查看更多”，但未能确认本题全文页打开。')
  }
  

  return {
    waitForToutiaoAnswerCard,
    captureToutiaoSearchSummary,
    openToutiaoFullAnswer,
  }
}

module.exports = { createToutiaoSearchWorkflow, toutiaoAnswerRegionLooksReady }
