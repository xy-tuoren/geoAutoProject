const { sleep } = require('./utils')
const { cropImage, imageLooksLoaded, imageRegionsStable } = require('./images')
const { captureStableSandwich } = require('./capture-primitives')
const { normalizeOcrText } = require('./ocr')
const {
  douyinSearchInput,
  hierarchyLogicalSize,
  douyinOcrViewFullTarget,
  douyinSearchResultTarget,
  douyinGenericAiAnswerBounds,
  douyinSearchResultsBounds,
  douyinMiniAppCaptureBounds,
} = require('./miniapp-locators')
const { DouyinSearchResultNotFoundError } = require('./search-recovery')

const DOUYIN_SUMMARY_PREFERENCE_MS = 3_000
const DOUYIN_INITIAL_RESULT_WAIT_MS = 12_000
const DOUYIN_SEARCH_SCAN_LIMIT = 3
const DOUYIN_POST_SCAN_WAIT_MS = 5_000
const DOUYIN_MINIAPP_CONTEXT_WAIT_MS = 15_000

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
}) {
  async function waitForDouyinSearchResult(timeout, { attempt = 1 } = {}) {
    const startedAt = Date.now()
    const initialScanDelay = Math.min(DOUYIN_INITIAL_RESULT_WAIT_MS, Math.max(5_000, Math.floor(timeout * 0.25)))
    const deadline = Date.now() + timeout
    const size = await windowSize()
    const roundLabel = attempt === 1 ? '第一轮' : '刷新后第二轮'
    let lastProgress = 0
    let stableEntrySignature = ''
    let stableEntryReads = 0
    let entryFirstSeenAt = 0
    let searchScrolls = 0
    let lastSearchScrollAt = 0
    let genericAnswerLogged = false
    let nextOcrAt = 0
    while (Date.now() < deadline) {
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
      if (!target && Date.now() >= nextOcrAt) {
        const frame = await screenshot()
        const logicalSize = hierarchyLogicalSize(xml, size)
        const recognition = await ocr.recognize(frame, { minConfidence: 0.5 })
        const ocrTarget = douyinOcrViewFullTarget(recognition, logicalSize)
        setLastOcrDiagnostic({
          created_at: new Date().toISOString(),
          purpose: 'douyin_answer_card',
          matcher: {
            brand_pattern: '^小荷AI医生(?:AI)?$',
            summary_pattern: '^(?:根据)?医学数据智能总结$',
            view_full_pattern: '^查看全文$',
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
            target: { mode: 'smart_summary', viewFull: ocrTarget.bounds },
            size,
            detectionMethod: 'rapidocr',
            ocrTarget,
            recognition,
          }
        }
        nextOcrAt = Date.now() + 2_000
      }
      if (target?.mode === 'miniapp_entry_card') {
        const signature = `${target.cardBounds.join(',')}|${target.tapBounds.join(',')}`
        if (signature === stableEntrySignature) stableEntryReads += 1
        else {
          stableEntrySignature = signature
          stableEntryReads = 1
          entryFirstSeenAt = Date.now()
        }
        if (stableEntryReads >= 2 && Date.now() - entryFirstSeenAt >= DOUYIN_SUMMARY_PREFERENCE_MS) {
          return { xml, target, size }
        }
      } else {
        stableEntrySignature = ''
        stableEntryReads = 0
        entryFirstSeenAt = 0
      }
      if (!target && searchScrolls >= DOUYIN_SEARCH_SCAN_LIMIT
        && Date.now() - lastSearchScrollAt >= DOUYIN_POST_SCAN_WAIT_MS) {
        throw new DouyinSearchResultNotFoundError(
          `${roundLabel}抖音搜索结果已完成${DOUYIN_SEARCH_SCAN_LIMIT}次向下扫描，仍未找到智能总结或小程序入口卡片。`,
          { scanScrolls: searchScrolls },
        )
      }
      if (!target && searchScrolls < DOUYIN_SEARCH_SCAN_LIMIT
        && Date.now() - startedAt >= initialScanDelay
        && Date.now() - lastSearchScrollAt >= 3_500) {
        const resultsBounds = douyinSearchResultsBounds(xml, size)
        if (resultsBounds) {
          searchScrolls += 1
          lastSearchScrollAt = Date.now()
          log(`stage: ${roundLabel}首屏未发现智能总结或入口卡片，向下扫描抖音搜索结果（${searchScrolls}/${DOUYIN_SEARCH_SCAN_LIMIT}）`)
          await swipeChat(resultsBounds, 'down', 0.34, { maxFraction: 0.42, speed: 1_700, eventDrivenSettle: true })
          await waitForVisualQuiet({ timeout: 1_200, fallbackMs: 300 })
          continue
        }
      }
      if (Date.now() - lastProgress >= 5_000) {
        log(`waiting: ${stableEntryReads ? '已发现小程序入口卡片，继续短暂等待智能总结优先出现' : '正在等待抖音智能总结或小荷AI医生小程序入口卡片'}…`)
        lastProgress = Date.now()
      }
      await sleep(500)
    }
    throw new DouyinSearchResultNotFoundError(
      `${roundLabel}抖音搜索结果中既未出现小荷AI医生智能总结，也未出现可验证的小程序入口卡片。`,
      { scanScrolls: searchScrolls },
    )
  }
  
  async function refreshDouyinSearchResults(question, scanScrolls = DOUYIN_SEARCH_SCAN_LIMIT) {
    let xml = await source()
    const size = await windowSize()
    let resultsBounds = douyinSearchResultsBounds(xml, size)
    if (!resultsBounds) throw new Error('抖音第一轮扫描无结果，但刷新前无法定位当前搜索结果列表。')
    const returnSwipes = Math.max(1, Math.ceil(Math.max(1, scanScrolls) * 0.34 / 0.55))
    log(`stage: 第一轮未找到入口，正在返回抖音搜索结果顶部（回滚=${returnSwipes}次）`)
    for (let index = 0; index < returnSwipes; index += 1) {
      await swipeChat(resultsBounds, 'up', 0.55, { maxFraction: 0.62, speed: 2_500, eventDrivenSettle: true })
      await waitForVisualQuiet({ timeout: 1_200, fallbackMs: 300 })
      xml = await source()
      resultsBounds = douyinSearchResultsBounds(xml, size) || resultsBounds
    }
    const edit = douyinSearchInput(xml)
    if (!edit || edit.text !== question) {
      throw new Error('抖音搜索结果回到顶部后未能确认当前搜索关键词；为避免刷新错误问题已停止本题。')
    }
    log('stage: 已回到顶部，正在下拉刷新当前抖音搜索结果')
    await swipeChat(resultsBounds, 'up', 0.5, { maxFraction: 0.58, speed: 700, eventDrivenSettle: true })
    await waitForVisualQuiet({ timeout: 2_500, fallbackMs: 1_200 })
    await sleep(700)
    log('stage: 当前搜索结果已刷新，开始第二轮入口识别与向下扫描')
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
    if (target) return { ...capture, target, detectionMethod: 'ui_hierarchy' }
    const logicalSize = hierarchyLogicalSize(capture.xml, size)
    const recognition = await ocr.recognize(capture.frame, { minConfidence: 0.5 })
    const ocrTarget = douyinOcrViewFullTarget(recognition, logicalSize)
    setLastOcrDiagnostic({
      created_at: new Date().toISOString(),
      purpose: 'douyin_summary_recapture',
      matcher: {
        brand_pattern: '^小荷AI医生(?:AI)?$',
        summary_pattern: '^(?:根据)?医学数据智能总结$',
        view_full_pattern: '^查看全文$',
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
      target: { mode: 'smart_summary', viewFull: ocrTarget.bounds },
      detectionMethod: 'rapidocr',
      ocrTarget,
      recognition,
    }
  }
  
  async function openDouyinFullAnswer(viewFull, size, timeout = 12_000) {
    await tap((viewFull[0] + viewFull[2]) / 2, (viewFull[1] + viewFull[3]) / 2)
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      await waitForVisualQuiet({ timeout: 1_000, fallbackMs: 400 })
      const xml = await source()
      const bounds = douyinMiniAppCaptureBounds(xml, size)
      if (bounds) return { xml, bounds }
    }
    throw new Error('已点击抖音小荷AI医生“查看全文”，但未能确认全文页打开。')
  }
  
  async function openDouyinMiniAppEntry(entry, size, timeout = 12_000) {
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
        return { xml, bounds, activity: foreground.activity, startedAt }
      }
      if (Date.now() - startedAt >= 3_000 && douyinSearchInput(xml)) {
        throw new Error('小程序入口卡片已点击，但页面仍停留在抖音搜索结果；为避免重复点击，本题已停止。')
      }
    }
    throw new Error('小程序入口卡片已点击，但未能确认抖音小程序宿主页打开。')
  }
  
  async function waitForDouyinMiniAppAnswer(full, timeout, { question = '' } = {}) {
    const deadline = full.startedAt + timeout
    const contentHeight = full.bounds[3] - full.bounds[1]
    const readinessBounds = [
      full.bounds[0],
      full.bounds[1] + Math.floor(contentHeight * 0.48),
      full.bounds[2],
      full.bounds[3] - Math.max(12, Math.floor(contentHeight * 0.03)),
    ]
    let lastProgress = 0
    let contextMismatchStartedAt = 0
    let contextMismatchReads = 0
    const recognizeQuestionContext = async (screen, phase) => {
      const recognition = await ocr.recognize(screen, { minConfidence: 0.5 })
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
      return context
    }
    while (Date.now() < deadline) {
      checkCancelled()
      const screen = await screenshot()
      const frame = await cropImage(screen, readinessBounds)
      if (await imageLooksLoaded(frame)) {
        const context = await recognizeQuestionContext(screen, 'initial_loaded_frame')
        if (!context.matched) {
          contextMismatchStartedAt ||= Date.now()
          contextMismatchReads += 1
          if (Date.now() - contextMismatchStartedAt >= DOUYIN_MINIAPP_CONTEXT_WAIT_MS && contextMismatchReads >= 3) {
            throw new Error(`抖音独立小程序入口打开后只检测到与本题无关的旧会话，${Math.round(DOUYIN_MINIAPP_CONTEXT_WAIT_MS / 1000)}秒内未出现当前问题上下文；已拒绝截取错误回答。`)
          }
          if (Date.now() - lastProgress >= 5_000) {
            log(`waiting: 抖音小程序已有内容但尚未出现本题上下文，继续等待新回答（匹配片段=${context.matchedBigrams.join('|') || '无'}）`)
            lastProgress = Date.now()
          }
          await sleep(1_000)
          continue
        }
        log('waiting: 抖音小程序回答正文已出现，继续等待画面稳定')
        const remaining = Math.max(1_000, deadline - Date.now())
        const stable = await waitForStableReply(remaining, { startedAt: full.startedAt })
        if (stable.status !== 'stable') throw new Error(`抖音小程序回答已出现，但等待稳定超时（${stable.status}）。`)
        const bounds = douyinMiniAppCaptureBounds(stable.xml, await windowSize())
        if (!bounds) throw new Error('抖音小程序回答稳定后未能重新确认正文截图区域。')
        const confirmedScreen = await screenshot()
        const confirmedContext = await recognizeQuestionContext(confirmedScreen, 'stable_frame_recheck')
        if (!confirmedContext.matched) {
          contextMismatchStartedAt ||= Date.now()
          contextMismatchReads += 1
          log('waiting: 抖音小程序稳定后未确认本题上下文，忽略进入过程残影并继续等待当前回答')
          await sleep(1_000)
          continue
        }
        return { ...full, xml: stable.xml, bounds }
      }
      if (Date.now() - lastProgress >= 5_000) {
        log('waiting: 已进入抖音小荷AI医生小程序，正在等待回答正文出现…')
        lastProgress = Date.now()
      }
      await sleep(1_000)
    }
    throw new Error('已进入抖音小荷AI医生小程序，但等待时间内未出现可截图的回答正文。')
  }
  

  return {
    waitForDouyinSearchResult,
    refreshDouyinSearchResults,
    captureDouyinSearchTarget,
    openDouyinFullAnswer,
    openDouyinMiniAppEntry,
    waitForDouyinMiniAppAnswer,
  }
}

module.exports = {
  createDouyinSearchWorkflow,
  DOUYIN_SEARCH_SCAN_LIMIT,
  significantQuestionBigrams,
  douyinMiniAppAnswerContextEvidence,
  douyinSearchTargetStabilityBounds,
}
