const fs = require('node:fs/promises')
const path = require('node:path')
const { sleep } = require('./utils')
const { entryHierarchyStartupTimeout } = require('./entry-catalog')
const { findChatScrollBounds } = require('./hierarchy')
const { recoverTimedOutReply } = require('./existing-reply-recovery')
const {
  runDouyinSearchResultAttempts,
  runToutiaoAnswerCardAttempts,
  runToutiaoFullAnswerAttempts,
} = require('./search-recovery')

const SEARCH_SUMMARY_FILENAME = '回答_智能总结.png'
const DOUYIN_SEARCH_SUMMARY_FILENAME = SEARCH_SUMMARY_FILENAME
const DOUYIN_MINIAPP_ENTRY_FILENAME = '回答_小程序入口.png'
const TOUTIAO_SEARCH_SUMMARY_FILENAME = SEARCH_SUMMARY_FILENAME

function createQuestionWorkflows({
  observer,
  recoverySnapshot,
  log,
  inputDouyinQuestion,
  tap,
  waitForDouyinSearchResult,
  refreshDouyinSearchResults,
  source,
  screenshot,
  captureDouyinSearchTarget,
  openDouyinFullAnswer,
  captureDouyinFullAnswerFrames,
  openDouyinMiniAppEntry,
  waitForDouyinMiniAppAnswer,
  captureDouyinMiniAppEntryAnswerFrames,
  saveArtifacts,
  inputToutiaoQuestion,
  waitForToutiaoAnswerCard,
  captureToutiaoSearchSummary,
  openToutiaoFullAnswer,
  captureToutiaoFullAnswerFrames,
  tapNewSession,
  inputQuestion,
  tapSend,
  recoverObserver,
  waitForStableReply,
  windowSize,
  recordResponseTimeoutRecovery = async () => {},
  captureFullReplyFrames,
  getActiveEntry,
  getActivePackageName,
}) {
  function activeEntryMetadata() {
    const entry = getActiveEntry()
    return {
      entry_id: entry.id,
      entry_label: entry.label,
      entry_package: getActivePackageName(),
      ...(entry.workflow ? { entry_workflow: entry.workflow } : {}),
      entry_hierarchy_startup_timeout_ms: entryHierarchyStartupTimeout(entry),
    }
  }

  async function askOnceDouyin(payload, artifacts, question, index) {
    const observerBaseline = typeof observer.snapshot === 'function' ? observer.snapshot() : {}
    const recoveryBaseline = recoverySnapshot()
    log('stage: 正在打开抖音搜索框并输入问题')
    const search = await inputDouyinQuestion(question)
    const directory = artifacts.diagnosticDirectory
    const meta = {
      serial: payload.serial,
      batch_id: path.basename(artifacts.batchDirectory),
      question_index: index,
      question_directory: directory,
      ...activeEntryMetadata(),
      new_session_requested: Boolean(payload.newSession),
      new_session_performed: false,
      douyin_search_performed: true,
      ui_backend: 'python_uiautomator2_strict',
      ui_fallback_enabled: false,
    }
    log('stage: 正在执行抖音搜索')
    await tap((search[0] + search[2]) / 2, (search[1] + search[3]) / 2)
    let card
    try {
      card = await runDouyinSearchResultAttempts({
        waitForResult: attempt => waitForDouyinSearchResult(payload.timeout * 1_000, { attempt }),
        refreshResults: error => refreshDouyinSearchResults(question, error.scanScrolls),
      })
      Object.assign(meta, {
        douyin_search_attempts: card.attempt,
        douyin_search_refreshed: card.refreshed,
      })
    } catch (error) {
      await fs.mkdir(directory, { recursive: true })
      const [xml, frame] = await Promise.all([source(), screenshot()])
      await Promise.all([
        fs.writeFile(path.join(directory, '搜索超时.xml'), xml, 'utf8'),
        fs.writeFile(path.join(directory, '搜索超时.png'), frame),
      ])
      log(`diagnostic: 抖音搜索超时现场已保存到 ${directory}`)
      throw error
    }
    const searchCapture = await captureDouyinSearchTarget(card.size)
    await fs.mkdir(artifacts.deliveryDirectory, { recursive: true })
    let leadingScreenshotPath
    let full
    let captureMethod
    if (searchCapture.target.mode === 'smart_summary') {
      log('stage: 已找到小荷AI医生回答卡片，正在截取搜索结果智能总结')
      leadingScreenshotPath = path.join(artifacts.deliveryDirectory, DOUYIN_SEARCH_SUMMARY_FILENAME)
      await fs.writeFile(leadingScreenshotPath, searchCapture.frame)
      Object.assign(meta, {
        douyin_result_mode: 'smart_summary',
        douyin_search_target_detection_method: searchCapture.detectionMethod,
        douyin_search_summary_captured: true,
        douyin_search_summary_screenshot: leadingScreenshotPath,
        douyin_miniapp_entry_detected: false,
        douyin_question_logical_image_count: 2,
      })
      log(`capture: 抖音搜索结果智能总结已保存 ${leadingScreenshotPath}`)
      log('stage: 已找到小荷AI医生回答卡片，正在点击查看全文')
      full = await openDouyinFullAnswer(searchCapture.target.viewFull, card.size)
      captureMethod = () => captureDouyinFullAnswerFrames(full.xml, full.bounds)
    } else {
      log('stage: 未出现智能总结，已识别小荷AI医生小程序入口卡片')
      leadingScreenshotPath = path.join(artifacts.deliveryDirectory, DOUYIN_MINIAPP_ENTRY_FILENAME)
      await fs.writeFile(leadingScreenshotPath, searchCapture.frame)
      log(`capture: 抖音小程序入口搜索页已保存 ${leadingScreenshotPath}`)
      log('stage: 正在通过独立入口卡片打开小荷AI医生小程序')
      full = await openDouyinMiniAppEntry(searchCapture.target, card.size)
      Object.assign(meta, {
        douyin_result_mode: 'miniapp_entry_card',
        douyin_search_summary_captured: false,
        douyin_miniapp_entry_detected: true,
        douyin_miniapp_entry_screenshot: leadingScreenshotPath,
        douyin_miniapp_entry_card_bounds: searchCapture.target.cardBounds,
        douyin_miniapp_entry_tap_bounds: searchCapture.target.tapBounds,
        douyin_miniapp_entry_activity: full.activity,
        douyin_question_logical_image_count: 2,
      })
      full = await waitForDouyinMiniAppAnswer(full, payload.timeout * 1_000)
      captureMethod = () => captureDouyinMiniAppEntryAnswerFrames(full.xml, full.bounds)
    }
    log('stage: 小荷AI医生全文页已打开且回答可截图，开始从上到下完整截图')
    const result = await saveArtifacts({
      artifacts,
      stem: '回答',
      question,
      status: 'stable',
      xml: full.xml,
      meta,
      captureMethod,
      observerBaseline,
      recoveryBaseline,
    })
    return searchCapture.target.mode === 'smart_summary'
      ? { summaryScreenshot: leadingScreenshotPath, ...result }
      : { entryScreenshot: leadingScreenshotPath, ...result }
  }
  
  async function askOnceToutiao(payload, artifacts, question, index) {
    const observerBaseline = typeof observer.snapshot === 'function' ? observer.snapshot() : {}
    const recoveryBaseline = recoverySnapshot()
    log('stage: 正在打开头条搜索框并输入问题')
    const search = await inputToutiaoQuestion(question)
    const directory = artifacts.diagnosticDirectory
    const meta = {
      serial: payload.serial,
      batch_id: path.basename(artifacts.batchDirectory),
      question_index: index,
      question_directory: directory,
      ...activeEntryMetadata(),
      new_session_requested: Boolean(payload.newSession),
      new_session_performed: false,
      toutiao_search_performed: true,
      ui_backend: 'python_uiautomator2_strict',
      ui_fallback_enabled: false,
    }
    log('stage: 正在执行头条搜索')
    await tap((search[0] + search[2]) / 2, (search[1] + search[3]) / 2)
    let card = await runToutiaoAnswerCardAttempts({
      waitForResult: () => waitForToutiaoAnswerCard(payload.timeout * 1_000, question),
      repeatExactSearch: async () => {
        log('stage: 头条结果未召回小荷AI医生，正在用相同问题执行一次受控重试')
        const retrySearch = await inputToutiaoQuestion(question)
        log('stage: 已再次精确确认头条搜索词，正在执行唯一一次重试')
        await tap((retrySearch[0] + retrySearch[2]) / 2, (retrySearch[1] + retrySearch[3]) / 2)
      },
    })
    log('stage: 已找到头条小荷AI医生回答卡片，正在截取搜索结果智能总结')
    let summary = await captureToutiaoSearchSummary(card.size)
    log('stage: 已找到头条小荷AI医生回答卡片，正在点击查看更多')
    const opened = await runToutiaoFullAnswerAttempts({
      initialTarget: { card, summary },
      canRepeat: card.attempt < 2,
      openFullAnswer: target => openToutiaoFullAnswer(target.summary.viewMore, target.card.size),
      repeatExactSearch: async () => {
        log('stage: 头条“查看更多”未进入本题全文，正在重新搜索相同问题并执行唯一一次路由重试')
        const retrySearch = await inputToutiaoQuestion(question)
        await tap((retrySearch[0] + retrySearch[2]) / 2, (retrySearch[1] + retrySearch[3]) / 2)
        const retryCard = await waitForToutiaoAnswerCard(payload.timeout * 1_000, question)
        const retrySummary = await captureToutiaoSearchSummary(retryCard.size)
        return { card: { ...retryCard, attempt: 2, repeated: true }, summary: retrySummary }
      },
    })
    card = opened.target.card
    summary = opened.target.summary
    Object.assign(meta, {
      toutiao_search_attempts: card.attempt,
      toutiao_search_repeated_exact_question: Boolean(card.repeated),
      toutiao_full_answer_open_attempts: opened.attempt,
      toutiao_full_answer_route_repeated: opened.repeated,
    })
    await fs.mkdir(artifacts.deliveryDirectory, { recursive: true })
    const summaryPath = path.join(artifacts.deliveryDirectory, TOUTIAO_SEARCH_SUMMARY_FILENAME)
    await fs.writeFile(summaryPath, summary.frame)
    Object.assign(meta, {
      toutiao_search_summary_captured: true,
      toutiao_search_summary_screenshot: summaryPath,
      toutiao_question_logical_image_count: 2,
      toutiao_answer_card_detection_method: summary.detectionMethod,
      ocr_backend: summary.recognition?.engine || null,
      ocr_coordinate_space: summary.recognition?.coordinateSpace || null,
      toutiao_ocr_elapsed_ms: summary.recognition?.elapsedMs || 0,
      toutiao_ocr_summary_confidence: summary.ocrTarget?.summaryConfidence || null,
      toutiao_ocr_view_more_confidence: summary.ocrTarget?.viewMoreConfidence || null,
      toutiao_ocr_view_more_physical_bounds: summary.ocrTarget?.physicalBounds || null,
      toutiao_view_more_logical_bounds: summary.viewMore,
    })
    log(`capture: 头条搜索结果智能总结已保存 ${summaryPath}`)
    const full = opened.full
    log('stage: 头条小荷AI医生全文页已打开，开始从上到下完整截图')
    const result = await saveArtifacts({
      artifacts,
      stem: '回答',
      question,
      status: 'stable',
      xml: full.xml,
      meta,
      captureMethod: () => captureToutiaoFullAnswerFrames(full.xml, full.bounds),
      observerBaseline,
      recoveryBaseline,
    })
    return { summaryScreenshot: summaryPath, ...result }
  }
  
  async function askOnce(payload, artifacts, question, index) {
    if (getActiveEntry().workflow === 'douyin-search') return askOnceDouyin(payload, artifacts, question, index)
    if (getActiveEntry().workflow === 'toutiao-search') return askOnceToutiao(payload, artifacts, question, index)
    const observerBaseline = typeof observer.snapshot === 'function' ? observer.snapshot() : {}
    const recoveryBaseline = recoverySnapshot()
    let newSessionPerformed = false
    if (payload.newSession && getActiveEntry().supportsNewSession) {
      log('stage: 正在切换到新会话')
      newSessionPerformed = await tapNewSession()
      if (!newSessionPerformed) throw new Error('本题要求新建会话，但未找到可确认的新会话入口；为避免混入旧对话，已在输入前停止本题')
    } else if (payload.newSession && !getActiveEntry().supportsNewSession) {
      log(`stage: ${getActiveEntry().label}不支持自动新建会话，已跳过该步骤`)
    }
    log('stage: 正在输入问题')
    await inputQuestion(question)
    const directory = artifacts.diagnosticDirectory
    const meta = {
      serial: payload.serial,
      batch_id: path.basename(artifacts.batchDirectory),
      question_index: index,
      question_directory: directory,
      ...activeEntryMetadata(),
      new_session_requested: Boolean(payload.newSession),
      new_session_performed: newSessionPerformed,
      ui_backend: 'python_uiautomator2_strict',
      ui_fallback_enabled: false,
    }
    log('stage: 正在发送问题')
    const sendMark = observer.active ? observer.mark() : null
    const replyStartedAt = Date.now()
    await tapSend()
    log('stage: 问题已发送，等待回答稳定')
    if (sendMark && observer.active && typeof observer.waitForActivity === 'function') {
      try {
        const activity = await observer.waitForActivity({ timeout: 2_000, since: sendMark })
        if (activity.activity) log('waiting: scrcpy已检测到回答画面开始变化')
      } catch (error) {
        await recoverObserver(error)
      }
    } else await sleep(2_000)
    let result = await waitForStableReply(payload.timeout * 1_000, { startedAt: replyStartedAt })
    let timeoutRecoveryMeta = {
      submitted_reply_timeout_detected: false,
      submitted_reply_retry_performed: false,
      submitted_reply_retry_attempts: 0,
      submitted_reply_retry_succeeded: null,
    }
    // Avoid an extra device screenshot for ordinary successful answers. The
    // full chat bounds are only needed when the hierarchy contains the timeout
    // prompt; the locator then still requires the paired clickable button.
    if (String(result.xml || '').includes('响应超时')) {
      const chatBounds = findChatScrollBounds(result.xml, await windowSize())
      const recovery = await recoverTimedOutReply({
        xml: result.xml,
        chatBounds,
        timeout: payload.timeout * 1_000,
        source,
        tap,
        waitForStableReply,
        log,
        record: recordResponseTimeoutRecovery,
        scope: 'submitted_reply',
        replyLabel: '本题回答',
        completionMessage: '继续本题回答采集',
      })
      result = { ...result, status: 'stable', xml: recovery.xml }
      timeoutRecoveryMeta = recovery.meta
    }
    Object.assign(meta, timeoutRecoveryMeta)
    log(`stage: 回答等待结束（${result.status}），开始截图`)
    return saveArtifacts({
      artifacts,
      stem: '回答',
      question,
      status: result.status,
      xml: result.xml,
      meta,
      captureMethod: newSessionPerformed
        ? currentQuestion => captureFullReplyFrames(currentQuestion, 30, { singleQuestionSession: true })
        : captureFullReplyFrames,
      observerBaseline,
      recoveryBaseline,
    })
  }
  

  return { askOnceDouyin, askOnceToutiao, askOnce }
}

module.exports = {
  createQuestionWorkflows,
  DOUYIN_SEARCH_SUMMARY_FILENAME,
  DOUYIN_MINIAPP_ENTRY_FILENAME,
  TOUTIAO_SEARCH_SUMMARY_FILENAME,
}
