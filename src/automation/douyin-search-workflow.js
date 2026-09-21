const { sleep } = require('./utils')
const { cropImage, imageInfo, imageLooksLoaded, imageRegionsStable, detectFloatingDownArrow } = require('./images')
const { captureStableSandwich, fillQuestionInput } = require('./capture-primitives')
const { normalizeOcrText, mapPhysicalBoundsToLogical, findOcrText } = require('./ocr')
const { iterNodes, nodeAttr, nodeIsVisible, parseBounds } = require('./hierarchy')
const {
  douyinSearchInput,
  hierarchyLogicalSize,
  douyinOcrViewFullTarget,
  douyinOcrConsultEntryTarget,
  douyinOcrBrandEntryTarget,
  douyinSearchResultTarget,
  douyinGenericAiAnswerBounds,
  douyinMiniAppCaptureBounds,
  miniAppShellCloseBounds,
} = require('./miniapp-locators')
const { DouyinSearchResultNotFoundError } = require('./search-recovery')

const DOUYIN_SUMMARY_PREFERENCE_MS = 3_000
const DOUYIN_SEARCH_SCAN_LIMIT = 0

class DouyinMiniAppNetworkError extends Error {
  constructor() {
    super('抖音小程序显示“网络不稳定，请重试”，需要退出并重新打开抖音后重试当前题。')
    this.name = 'DouyinMiniAppNetworkError'
    this.code = 'DOUYIN_MINIAPP_NETWORK_ERROR'
  }
}

const GENERIC_QUESTION_BIGRAMS = new Set([
  '什么', '怎么', '么办', '如何', '请问', '是否', '可以', '需要', '用什', '么药', '咋办',
])

function significantQuestionBigrams(question) {
  const normalized = normalizeOcrText(question).replace(/[^\p{L}\p{N}]/gu, '')
  const result = []
  for (let index = 0; index < normalized.length - 1; index += 1) {
    const bigram = normalized.slice(index, index + 2)
    if (!GENERIC_QUESTION_BIGRAMS.has(bigram) && !result.includes(bigram)) result.push(bigram)
  }
  return { normalized, bigrams: result }
}

function douyinMiniAppAnswerContextEvidence(recognition, question) {
  const { normalized, bigrams } = significantQuestionBigrams(question)
  const recognizedText = (recognition?.results || [])
    .filter(item => Number(item.confidence) >= 0.62)
    .map(item => normalizeOcrText(item.normalizedText || item.text))
    .join('')
    .replace(/[^\p{L}\p{N}]/gu, '')
  const matchedBigrams = bigrams.filter(item => recognizedText.includes(item))
  const requiredBigramCount = bigrams.length <= 1 ? bigrams.length : 2
  const exact = normalized.length >= 2 && recognizedText.includes(normalized)
  return {
    matched: Boolean(exact || (requiredBigramCount > 0 && matchedBigrams.length >= requiredBigramCount)),
    exact,
    normalizedQuestion: normalized,
    requiredBigramCount,
    matchedBigrams,
    recognizedText,
  }
}

function douyinMiniAppNetworkRetryTarget(recognition, logicalSize) {
  const results = (recognition?.results || []).filter(item => Number(item.confidence) >= 0.85)
  const errors = results.filter(item => normalizeOcrText(item.normalizedText || item.text)
    .replace(/[，,。.!！?？\s]/g, '') === '网络不稳定请重试')
  const retries = results.filter(item => normalizeOcrText(item.normalizedText || item.text)
    .replace(/\s/g, '') === '重试')
  const physicalSize = recognition?.image
  if (!physicalSize?.width || !physicalSize?.height || !logicalSize?.width || !logicalSize?.height) return null
  for (const error of errors) {
    const errorCenterX = (error.bounds[0] + error.bounds[2]) / 2
    for (const retry of retries) {
      const retryCenterX = (retry.bounds[0] + retry.bounds[2]) / 2
      const verticalGap = retry.bounds[1] - error.bounds[3]
      if (verticalGap < physicalSize.height * 0.035
        || verticalGap > physicalSize.height * 0.16
        || Math.abs(retryCenterX - errorCenterX) > physicalSize.width * 0.16
        || retry.bounds[1] < physicalSize.height * 0.35
        || retry.bounds[3] > physicalSize.height * 0.78) continue
      return {
        bounds: mapPhysicalBoundsToLogical(retry.bounds, physicalSize, logicalSize),
        physicalBounds: retry.bounds,
        errorPhysicalBounds: error.bounds,
        errorConfidence: Number(error.confidence),
        retryConfidence: Number(retry.confidence),
      }
    }
  }
  return null
}

function douyinSearchTargetStabilityBounds(target, size) {
  if (target?.mode === 'miniapp_entry_card' && Array.isArray(target.cardBounds)) return target.cardBounds
  if (target?.mode === 'smart_summary' && Array.isArray(target.viewFull)) {
    const [left, top, right, bottom] = target.viewFull
    const marginX = Math.round(size.width * 0.16)
    const marginY = Math.round(size.height * 0.08)
    return [
      Math.max(0, left - marginX),
      Math.max(0, top - marginY),
      Math.min(size.width, right + marginX),
      Math.min(size.height, bottom + marginY),
    ]
  }
  return null
}

function createDouyinSearchWorkflow({
  source,
  windowSize,
  log,
  screenshot,
  ocr,
  setLastOcrDiagnostic,
  swipeChat,
  waitForVisualQuiet,
  tap,
  ui,
  getActivePackageName,
  checkCancelled,
  waitForStableReply,
  now = Date.now,
  delay = sleep,
}) {
  async function waitForDouyinSearchResult(timeout) {
    const deadline = now() + timeout
    const size = await windowSize()
    let lastProgress = 0
    let stableEntrySignature = ''
    let stableEntryReads = 0
    let entryFirstSeenAt = 0
    let genericAnswerLogged = false
    let nextOcrAt = 0
    while (now() < deadline) {
      const xml = await source()
      const target = douyinSearchResultTarget(xml, size)
      const genericAnswer = douyinGenericAiAnswerBounds(xml, size)
      if ((genericAnswer || target?.ignoredExpandableAnswer) && !genericAnswerLogged) {
        log(target?.mode === 'miniapp_entry_card'
          ? 'stage: 已识别抖音通用AI回答，忽略“展开更多”并改走下方小荷AI医生独立小程序入口卡片'
          : 'stage: 已识别抖音通用AI回答，已忽略“展开更多”并继续查找小荷AI医生入口')
        genericAnswerLogged = true
      }
      if (target?.mode === 'smart_summary') return { xml, target, size }
      if (now() >= nextOcrAt) {
        const frame = await screenshot()
        const logicalSize = hierarchyLogicalSize(xml, size)
        const recognition = await ocr.recognize(frame, { minConfidence: 0.5 })
        const ocrTarget = douyinOcrConsultEntryTarget(recognition, logicalSize) || douyinOcrViewFullTarget(recognition, logicalSize)
          || douyinOcrBrandEntryTarget(recognition, xml, logicalSize)
        setLastOcrDiagnostic({
          created_at: new Date().toISOString(),
          purpose: 'douyin_answer_card',
          matcher: {
            brand_pattern: '^小荷AI医生(?:AI)?$',
            summary_pattern: '^(?:(?:根据)?医学数据智能总结|字节跳动旗下医疗大模型应用)$',
            view_full_pattern: '^查看全文$',
            consult_entry_requires: ['小荷AI医生', '为您提供定制化建议，试试咨询', '免费咨询', 'same_column'],
            minimum_confidence: 0.85,
            requires_brand_summary_proximity: true,
            requires_view_full_below_summary: true,
          },
          logical_size: logicalSize,
          recognition,
          target: ocrTarget,
        })
        log(ocrTarget
          ? `ocr: purpose=douyin_answer_card outcome=matched engine=${recognition.engine} elapsed=${Math.round(recognition.elapsedMs)}ms lines=${recognition.results.length} brand_confidence=${ocrTarget.brandConfidence.toFixed(3)} summary_confidence=${ocrTarget.summaryConfidence.toFixed(3)} view_full_confidence=${ocrTarget.viewFullConfidence.toFixed(3)} physical_bounds=${ocrTarget.physicalBounds.join(',')} logical_bounds=${ocrTarget.bounds.join(',')}`
          : `ocr: purpose=douyin_answer_card outcome=not_found engine=${recognition.engine} elapsed=${Math.round(recognition.elapsedMs)}ms lines=${recognition.results.length}`)
        if (ocrTarget) {
          return {
            xml,
            target: ocrTarget.mode ? ocrTarget : { mode: 'smart_summary', viewFull: ocrTarget.bounds },
            size,
            detectionMethod: 'rapidocr',
            ocrTarget,
            recognition,
          }
        }
        nextOcrAt = now() + 2_000
      }
      if (target?.mode === 'miniapp_entry_card') {
        const signature = `${target.cardBounds.join(',')}|${target.tapBounds.join(',')}`
        if (signature === stableEntrySignature) stableEntryReads += 1
        else {
          stableEntrySignature = signature
          stableEntryReads = 1
          entryFirstSeenAt = now()
        }
        // Anonymous Canvas structure is a candidate, never identity evidence.
      } else {
        stableEntrySignature = ''
        stableEntryReads = 0
        entryFirstSeenAt = 0
      }
      if (now() - lastProgress >= 5_000) {
        log(`waiting: ${stableEntryReads ? '已发现小程序入口卡片，继续短暂等待智能总结优先出现' : '正在等待抖音智能总结或小荷AI医生小程序入口卡片'}…`)
        lastProgress = now()
      }
      await delay(500)
    }
    throw new DouyinSearchResultNotFoundError(
      '抖音搜索结果首屏既未出现小荷AI医生智能总结，也未出现可验证的小程序入口卡片。',
      { scanScrolls: 0 },
    )
  }
  
  async function captureDouyinSearchTarget(size, expectedTarget = null) {
    await waitForVisualQuiet({ timeout: 1_200, fallbackMs: 300 })
    const stabilityBounds = douyinSearchTargetStabilityBounds(expectedTarget, size)
    const capture = await captureStableSandwich({
      capture: screenshot,
      hierarchy: source,
      framesStable: stabilityBounds
        ? async (first, second) => {
          const [firstTarget, secondTarget] = await Promise.all([
            cropImage(first, stabilityBounds),
            cropImage(second, stabilityBounds),
          ])
          return imageRegionsStable(firstTarget, secondTarget)
        }
        : imageRegionsStable,
      hierarchyLoading: () => false,
      interval: 120,
    }, 8_000)
    if (!capture.stable) throw new Error(stabilityBounds
      ? '抖音小荷AI目标卡片持续变化，无法取得稳定点击证据。'
      : '抖音搜索结果持续变化，无法取得稳定截图。')
    const target = douyinSearchResultTarget(capture.xml, size)
    if (target?.mode === 'smart_summary') return { ...capture, target, detectionMethod: 'ui_hierarchy' }
    const logicalSize = hierarchyLogicalSize(capture.xml, size)
    const recognition = await ocr.recognize(capture.frame, { minConfidence: 0.5 })
    const ocrTarget = douyinOcrConsultEntryTarget(recognition, logicalSize) || douyinOcrViewFullTarget(recognition, logicalSize)
      || douyinOcrBrandEntryTarget(recognition, capture.xml, logicalSize)
    setLastOcrDiagnostic({
      created_at: new Date().toISOString(),
      purpose: 'douyin_summary_recapture',
      matcher: {
        brand_pattern: '^小荷AI医生(?:AI)?$',
        summary_pattern: '^(?:(?:根据)?医学数据智能总结|字节跳动旗下医疗大模型应用)$',
        view_full_pattern: '^查看全文$',
        consult_entry_requires: ['小荷AI医生', '为您提供定制化建议，试试咨询', '免费咨询', 'same_column'],
        minimum_confidence: 0.85,
        requires_brand_summary_proximity: true,
        requires_view_full_below_summary: true,
      },
      logical_size: logicalSize,
      recognition,
      target: ocrTarget,
    })
    log(ocrTarget
      ? `ocr: purpose=douyin_summary_recapture outcome=matched engine=${recognition.engine} elapsed=${Math.round(recognition.elapsedMs)}ms lines=${recognition.results.length} brand_confidence=${ocrTarget.brandConfidence.toFixed(3)} summary_confidence=${ocrTarget.summaryConfidence.toFixed(3)} view_full_confidence=${ocrTarget.viewFullConfidence.toFixed(3)} physical_bounds=${ocrTarget.physicalBounds.join(',')} logical_bounds=${ocrTarget.bounds.join(',')}`
      : `ocr: purpose=douyin_summary_recapture outcome=not_found engine=${recognition.engine} elapsed=${Math.round(recognition.elapsedMs)}ms lines=${recognition.results.length}`)
    if (!ocrTarget) throw new Error('取得稳定搜索截图后，UI层级和OCR均未确认小荷AI医生智能总结“查看全文”，且小程序入口卡片已消失，已停止点击。')
    return {
      ...capture,
      target: ocrTarget.mode ? ocrTarget : { mode: 'smart_summary', viewFull: ocrTarget.bounds },
      detectionMethod: 'rapidocr',
      ocrTarget,
      recognition,
    }
  }
  
  async function openDouyinFullAnswer(viewFull, size, timeout = 12_000) {
    const startedAt = Date.now()
    await tap((viewFull[0] + viewFull[2]) / 2, (viewFull[1] + viewFull[3]) / 2)
    const deadline = startedAt + timeout
    const hardDeadline = startedAt + Math.max(timeout, 30_000)
    let miniAppHostSeen = false
    while (Date.now() < deadline || (miniAppHostSeen && Date.now() < hardDeadline)) {
      await waitForVisualQuiet({ timeout: 1_000, fallbackMs: 400 })
      const [xml, current, foreground] = await Promise.all([source(), ui.currentApp(), ui.foregroundWindow()])
      const expectedPackage = getActivePackageName()
      const windows = [foreground, current].filter(Boolean)
      const miniAppHost = windows.find(window => window.package === expectedPackage
        && /MiniAppHostActivity/.test(window.activity || ''))
      if (windows.length && windows.every(window => window.package && window.package !== expectedPackage)) {
        throw new Error(`抖音全文入口点击后进入了错误应用：expected=${expectedPackage}, actual=${windows.map(window => window.package).join('|')}`)
      }
      if (miniAppHost) {
        if (!miniAppHostSeen) log('waiting: 已确认进入抖音小程序宿主，正在等待全文UI层级就绪')
        miniAppHostSeen = true
      }
      const bounds = douyinMiniAppCaptureBounds(xml, size)
      if (miniAppHostSeen && bounds) return { xml, bounds, activity: miniAppHost.activity, startedAt }
    }
    throw new Error('已点击抖音小荷AI医生“查看全文”，但未能确认全文页打开。')
  }
  
  async function submitDouyinConsultQuestion(question) {
    log('waiting: 等待小程序入口加载完成，避免新会话点击被加载状态忽略')
    const ready = await waitForStableReply(90_000)
    if (ready.status !== 'stable') throw new Error(`小程序新会话操作前加载未完成（${ready.status}），未点击、输入或发送。`)
    const read = async phase => {
      const frame = await screenshot()
      const xml = await source()
      const recognition = await ocr.recognize(frame, { minConfidence: 0.5 })
      if (recognition.image.width >= recognition.image.height) throw new Error('小程序提问仅支持正常竖屏，已停止UI操作。')
      const logicalSize = hierarchyLogicalSize(xml, await windowSize())
      setLastOcrDiagnostic({ created_at: new Date().toISOString(), purpose: 'douyin_consult_question', phase, recognition, logical_size: logicalSize })
      if (douyinMiniAppNetworkRetryTarget(recognition, logicalSize)) throw new DouyinMiniAppNetworkError()
      return { xml, frame, recognition, logicalSize }
    }
    const clickText = async (item, state) => {
      const b = mapPhysicalBoundsToLogical(item.bounds, state.recognition.image, state.logicalSize)
      await tap((b[0] + b[2]) / 2, (b[1] + b[3]) / 2)
    }
    let state = await read('before_new_session')
    const close = miniAppShellCloseBounds(state.xml, state.logicalSize)
    const brand = findOcrText(state.recognition, /^[<‹〈く]?小荷AI医生$/, { minConfidence: 0.85 })
      .find(item => item.bounds[1] < state.recognition.image.height * 0.1)
    if (!close || !brand) throw new Error('免费咨询入口未确认小荷会话顶栏，已停止新建和输入。')
    log('stage: 独立入口可能复用旧会话，正在新建小程序会话（单次点击）')
    // Canvas omits this icon. Its header slot is relative to the live shell;
    // no input is allowed unless the exact confirmation dialog appears.
    await tap(state.logicalSize.width * 0.584, (close[1] + close[3]) / 2)
    let confirmed = false
    const dialogDeadline = now() + 6_000
    while (now() < dialogDeadline) {
      await delay(300)
      state = await read('new_session_dialog')
      const title = findOcrText(state.recognition, /^开启新会话$/, { minConfidence: 0.85 })[0]
      const description = findOcrText(state.recognition, /^开启新会话后[,，]当前咨询将自动结束$/, { minConfidence: 0.85 })[0]
      const button = findOcrText(state.recognition, /^确定$/, { minConfidence: 0.85 })[0]
      if (!title || !description || !button) continue
      if (description.bounds[1] < title.bounds[3] || button.bounds[1] < description.bounds[3]
        || button.bounds[1] - description.bounds[3] > state.recognition.image.height * 0.12) continue
      await clickText(button, state)
      confirmed = true
      break
    }
    if (!confirmed) throw new Error('小程序新会话确认弹窗未出现，已停止，未输入或发送。')
    const sessionDeadline = now() + 20_000
    let sessionReady = false
    while (now() < sessionDeadline) {
      await delay(250)
      state = await read('new_session_confirmation')
      if (findOcrText(state.recognition, /^已开始新会话$/, { minConfidence: 0.85 })
        .some(item => item.bounds[1] > state.recognition.image.height * 0.65)) {
        sessionReady = true
        break
      }
    }
    if (!sessionReady) throw new Error('未确认小程序“已开始新会话”提示，已停止输入。')
    log('waiting: 新会话已确认，等待转场完成后再操作文字输入')
    const inputReady = await waitForStableReply(90_000)
    if (inputReady.status !== 'stable') throw new Error(`小程序新会话转场未完成（${inputReady.status}），未操作输入。`)
    state = await read('ready_for_input')
    const editNode = xml => iterNodes(xml).find(item => nodeIsVisible(item)
      && nodeAttr(item, 'package') === getActivePackageName()
      && nodeAttr(item, 'class') === 'android.widget.EditText')
    if (!editNode(state.xml)) {
      const voice = findOcrText(state.recognition, /^按住说话$/, { minConfidence: 0.85 })
        .find(item => item.bounds[1] > state.recognition.image.height * 0.78)
      if (!voice) throw new Error('新会话没有可验证的输入区域，未输入。')
      const b = mapPhysicalBoundsToLogical(voice.bounds, state.recognition.image, state.logicalSize)
      await tap(state.logicalSize.width * 0.115, (b[1] + b[3]) / 2)
      await delay(300)
    }
    let xml = await source()
    const editDeadline = now() + 10_000
    while (!editNode(xml) && now() < editDeadline) {
      await delay(300)
      xml = await source()
    }
    const edit = editNode(xml)
    if (!edit) throw new Error('切换后未出现小程序真实文字输入框，未输入。')
    xml = await fillQuestionInput({ ui, tap, source, log, readText: hierarchy => {
      const input = editNode(hierarchy)
      return input ? nodeAttr(input, 'text') : null
    } }, { bounds: parseBounds(nodeAttr(edit, 'bounds')), text: nodeAttr(edit, 'text') }, question)
    const input = editNode(xml)
    if (!input || nodeAttr(input, 'text') !== question) throw new Error('小程序输入回读不一致，未发送。')
    const inputBounds = parseBounds(nodeAttr(input, 'bounds'))
    const logicalSize = hierarchyLogicalSize(xml, await windowSize())
    const panels = iterNodes(xml).filter(item => nodeIsVisible(item) && nodeAttr(item, 'class') === 'android.view.ViewGroup')
      .map(item => parseBounds(nodeAttr(item, 'bounds')))
      .filter(b => b[0] <= inputBounds[0] && b[2] >= inputBounds[2] && b[1] <= inputBounds[1]
        && b[3] > inputBounds[3] && b[3] - b[1] < logicalSize.height * 0.3)
      .sort((a, b) => (a[3] - a[1]) - (b[3] - b[1]))
    const panel = panels[0]
    if (!panel) throw new Error('小程序输入面板边界不明，未发送。')
    const frame = await screenshot()
    const physicalSize = await imageInfo(frame)
    const searchBounds = [panel[2] - logicalSize.width * 0.15, inputBounds[3], panel[2], panel[3]]
      .map((v, i) => v * (i % 2 ? physicalSize.height / logicalSize.height : physicalSize.width / logicalSize.width))
    const arrow = await detectFloatingDownArrow(frame, searchBounds, { direction: 'up', sizeReferenceWidth: physicalSize.width * 0.8 })
    if (!arrow || arrow.polarity !== 'light_on_dark') throw new Error('小程序输入已核对，但没有验证到发送箭头，未发送。')
    const finalInput = editNode(await source())
    if (!finalInput || nodeAttr(finalInput, 'text') !== question
      || nodeAttr(finalInput, 'bounds') !== nodeAttr(input, 'bounds')) throw new Error('发送前小程序输入内容或布局发生变化，未发送。')
    const b = mapPhysicalBoundsToLogical(arrow.bounds, physicalSize, logicalSize)
    await tap((b[0] + b[2]) / 2, (b[1] + b[3]) / 2)
    log('stage: 小程序新会话已确认，原题输入回读一致并单次发送')
    const startedAt = Date.now()
    await delay(300)
    const submissionEvidence = await read('submitted_question')
    return { startedAt, questionSubmitted: true, newSessionPerformed: true, submissionEvidence }
  }

  async function openDouyinMiniAppEntry(entry, size, timeout = 12_000, { question = '' } = {}) {
    if (!question) throw new Error('独立小程序入口需要原始问题，未点击。')
    const startedAt = Date.now()
    await tap((entry.tapBounds[0] + entry.tapBounds[2]) / 2, (entry.tapBounds[1] + entry.tapBounds[3]) / 2)
    const deadline = startedAt + timeout
    while (Date.now() < deadline) {
      await waitForVisualQuiet({ timeout: 1_000, fallbackMs: 400 })
      const [xml, foreground] = await Promise.all([source(), ui.foregroundWindow()])
      if (foreground?.package && foreground.package !== getActivePackageName()) {
        throw new Error(`小程序入口点击后进入了错误应用：expected=${getActivePackageName()}, actual=${foreground.package}`)
      }
      const bounds = douyinMiniAppCaptureBounds(xml, size)
      if (/MiniAppHostActivity/.test(foreground?.activity || '') && bounds) {
        log('stage: 小程序内仅验证和采集，不新建会话、不输入、不发送；问题只在抖音搜索框提交')
        return { xml, bounds, activity: foreground.activity, startedAt, questionSubmitted: false, newSessionPerformed: false }
      }
      if (Date.now() - startedAt >= 3_000 && douyinSearchInput(xml)) {
        throw new Error('小程序入口卡片已点击，但页面仍停留在抖音搜索结果；为避免重复点击，本题已停止。')
      }
    }
    throw new Error('小程序入口卡片已点击，但未能确认抖音小程序宿主页打开。')
  }
  
  async function waitForDouyinMiniAppAnswer(full, timeout, { question = '', networkRestartAttempts = 0 } = {}) {
    const deadline = full.startedAt + timeout
    const logicalSize = hierarchyLogicalSize(full.xml || '', await windowSize())
    const contentHeight = full.bounds[3] - full.bounds[1]
    const readinessBounds = [
      full.bounds[0],
      full.bounds[1] + Math.floor(contentHeight * 0.48),
      full.bounds[2],
      full.bounds[3] - Math.max(12, Math.floor(contentHeight * 0.03)),
    ]
    let lastProgress = 0
    let nextBlankOcrAt = 0
    const recognizeQuestionContext = async (screen, phase) => {
      const recognition = await ocr.recognize(screen, { minConfidence: 0.5 })
      const retryTarget = douyinMiniAppNetworkRetryTarget(recognition, logicalSize)
      if (retryTarget) {
        setLastOcrDiagnostic({
          created_at: new Date().toISOString(), purpose: 'douyin_miniapp_network_error',
          phase: `restart_${networkRestartAttempts}_${phase}`, recognition,
          logical_size: logicalSize, target: retryTarget,
          network_restart_attempts: networkRestartAttempts,
        })
        log(`ocr: purpose=douyin_miniapp_network_error outcome=matched engine=${recognition.engine} elapsed=${Math.round(recognition.elapsedMs || 0)}ms lines=${recognition.results.length} restart_attempts=${networkRestartAttempts}`)
        throw new DouyinMiniAppNetworkError()
      }
      const context = douyinMiniAppAnswerContextEvidence(recognition, question)
      setLastOcrDiagnostic({
        created_at: new Date().toISOString(),
        purpose: 'douyin_miniapp_answer_context',
        phase,
        matcher: {
          question,
          normalized_question: context.normalizedQuestion,
          required_bigram_count: context.requiredBigramCount,
          minimum_confidence: 0.62,
        },
        recognition,
        target: context,
      })
      return { context, recognition }
    }
    while (now() < deadline) {
      checkCancelled()
      const screen = await screenshot()
      const physicalSize = await imageInfo(screen)
      if (physicalSize.width >= physicalSize.height || logicalSize.width >= logicalSize.height) {
        throw new Error('抖音小程序回答检查仅支持正常竖屏，已停止UI操作。')
      }
      const physicalBounds = readinessBounds.map((value, index) => Math.round(value * (index % 2
        ? physicalSize.height / logicalSize.height : physicalSize.width / logicalSize.width)))
      const frame = await cropImage(screen, physicalBounds)
      const loaded = await imageLooksLoaded(frame)
      let recognition
      // Error pages can be mostly blank. Probe independently, without OCR on every blank frame.
      if (loaded || now() >= nextBlankOcrAt) {
        const checked = await recognizeQuestionContext(screen, loaded ? 'initial_loaded_frame' : 'blank_frame')
        recognition = checked.recognition
        nextBlankOcrAt = now() + 3_000
      }
      if (loaded) {
        const brand = findOcrText(recognition, /^[<‹〈く]?小荷AI医生$/, { minConfidence: 0.85 })
          .find(item => item.bounds[1] < recognition.image.height * 0.12)
        if (!brand) {
          await delay(500)
          continue
        }
        log('waiting: 小荷页面内容已出现，先等待完成；完整原题将在正式首帧严格校验')
        const remaining = Math.max(1_000, deadline - now())
        const stable = await waitForStableReply(remaining, { startedAt: full.startedAt })
        // A network page can replace the answer while waiting for stability.
        await recognizeQuestionContext(await screenshot(), 'stable_frame_recheck')
        if (stable.status !== 'stable') throw new Error(`抖音小程序回答已出现，但等待稳定超时（${stable.status}）。`)
        const bounds = douyinMiniAppCaptureBounds(stable.xml, await windowSize())
        if (!bounds) throw new Error('抖音小程序回答稳定后未能重新确认正文截图区域。')
        return { ...full, xml: stable.xml, bounds, exactQuestionValidationRequired: true }
      }
      if (now() - lastProgress >= 5_000) {
        log('waiting: 已进入抖音小荷AI医生小程序，正在等待回答正文出现…')
        lastProgress = now()
      }
      await delay(1_000)
    }
    checkCancelled()
    await recognizeQuestionContext(await screenshot(), 'deadline_recheck')
    throw new Error('已进入抖音小荷AI医生小程序，但等待时间内未出现可截图的回答正文。')
  }
  

  return {
    waitForDouyinSearchResult,
    captureDouyinSearchTarget,
    openDouyinFullAnswer,
    openDouyinMiniAppEntry,
    submitDouyinConsultQuestion,
    waitForDouyinMiniAppAnswer,
  }
}

module.exports = {
  createDouyinSearchWorkflow,
  DouyinMiniAppNetworkError,
  DOUYIN_SEARCH_SCAN_LIMIT,
  significantQuestionBigrams,
  douyinMiniAppAnswerContextEvidence,
  douyinMiniAppNetworkRetryTarget,
  douyinSearchTargetStabilityBounds,
}
