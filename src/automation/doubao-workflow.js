const sharp = require('sharp')
const { iterNodes, nodeAttr, nodeIsVisible, parseBounds } = require('./hierarchy')
const { imageInfo, cropImage, imageRegionsStable, imageLooksLoaded, verifyReplyFrameOverlap } = require('./images')
const { fillQuestionInput, captureStableObserved, captureStableSandwich } = require('./capture-primitives')
const { CaptureSequence } = require('./capture-sequence')
const { sleep } = require('./utils')

const DOUBAO_PACKAGE = 'com.larus.nova'
const MISSING_CHAT_LAYOUT = '未识别到豆包对话页面的根节点、消息列表和输入框；已停止操作。'
const decodeText = text => String(text).replace(/&#(x[0-9a-f]+|\d+);/gi, (_, code) => String.fromCodePoint(code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code)))
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

function doubaoPage(xml, question = '') {
  const nodes = iterNodes(xml).filter(attrs => nodeIsVisible(attrs) && nodeAttr(attrs, 'package') === DOUBAO_PACKAGE)
    .map(attrs => ({ attrs, id: nodeAttr(attrs, 'resource-id').replace(`${DOUBAO_PACKAGE}:id/`, ''),
      text: decodeText(nodeAttr(attrs, 'text')), label: decodeText(nodeAttr(attrs, 'content-desc')),
      bounds: parseBounds(nodeAttr(attrs, 'bounds')) }))
  const byId = id => nodes.find(node => node.id === id)
  const root = byId('chat_root')
  const list = byId('message_list')
  const input = byId('input_text')
  if (!root || !list || !input) throw new Error(MISSING_CHAT_LAYOUT)
  const size = { width: root.bounds[2], height: root.bounds[3] }
  if (/rotation="[123]"/.test(xml) || size.height <= size.width) throw new Error('豆包仅支持正常竖屏。')
  if (root.bounds[0] !== 0 || root.bounds[1] !== 0 || size.height / size.width < 1.45 || size.height / size.width > 2.8
    || list.bounds[2] - list.bounds[0] < size.width * 0.9 || list.bounds[1] < size.height * 0.04
    || list.bounds[3] > input.bounds[1] || list.bounds[3] - list.bounds[1] < size.height * 0.3) {
    throw new Error('豆包有效视口异常，暂不支持横屏、分屏或折叠态。')
  }
  const inside = node => node.bounds[1] >= list.bounds[1] && node.bounds[3] <= list.bounds[3]
  const complete = Boolean(byId('msg_action_copy') && byId('msg_action_regenerate'))
  const questionNode = question && nodes.find(node => node.text === question && inside(node)
    && node.id !== 'input_text' && node.id !== 'title' && node.bounds[2] >= size.width * 0.85
    && node.bounds[1] >= list.bounds[1] + size.height * 0.005 && node.bounds[3] - node.bounds[1] >= size.height * 0.025)
  const clean = Boolean(byId('larus_mode_switch_welcome_title')) && !byId('message_left_container') && !complete
  const loading = nodes.some(node => /^(?:停止生成|停止回答|正在思考|思考中|正在生成|加载中)$/.test(node.label || node.text))
  const collapsed = nodes.find(node => inside(node) && /^(?:展开全文|展开全部|查看全部(?:资料|来源|药品)|参考资料\s*\d+|\d+\s*(?:篇|个)来源)$/.test(node.text || node.label))
  return { nodes, byId, size, bounds: list.bounds, input, clean, complete, loading, questionVisible: Boolean(questionNode), questionNode, collapsed }
}

function doubaoReferenceCount(page) {
  const title = page.byId('tv_reference_title')
  if (!title) return 0
  const match = title.text.match(/^(?:搜索\s*\d+\s*个关键词[，,]\s*)?参考\s*(\d+)\s*篇资料$/)
  if (!match) throw new Error(`豆包资料标题格式尚未适配：${title.text}`)
  return Number(match[1])
}

function doubaoReferences(page, viewport = page.bounds) {
  const result = []
  for (const node of page.nodes.filter(item => item.id === 'tv_reference_index')) {
    if (node.bounds[1] <= viewport[1] || node.bounds[3] >= viewport[3]) continue
    const index = Number(node.text.replace(/[.、．\s]/g, ''))
    const content = page.nodes.find(item => item.id === 'tv_reference_content' && item.text
      && Math.abs(item.bounds[1] - node.bounds[1]) <= page.size.height * 0.005
      && item.bounds[1] > viewport[1] && item.bounds[3] < viewport[3])
    if (Number.isInteger(index) && index > 0 && content) result.push({ index, title: content.text })
  }
  return result
}

function mapDoubaoBounds(bounds, logical, physical) {
  if (physical.height <= physical.width || Math.abs((physical.width / logical.width) / (physical.height / logical.height) - 1) > 0.025) {
    throw new Error('豆包截图与 UI 逻辑尺寸比例不一致，不能可靠映射坐标。')
  }
  return bounds.map((value, index) => Math.round(value * (index % 2 ? physical.height / logical.height : physical.width / logical.width)))
}

async function doubaoScrollbarOnlyChange(first, second) {
  const [a, b] = await Promise.all([imageInfo(first), imageInfo(second)])
  if (a.width !== b.width || a.height !== b.height) return false
  // Doubao's RecyclerView draws a transient grey scroll indicator at the
  // outermost edge. Compare the entire content area; only a narrow, pale,
  // monochrome rail may differ. Keep the original full-width PNG for delivery.
  const railWidth = Math.max(4, Math.min(24, Math.ceil(a.width * 0.015)))
  const contentBounds = [0, 0, a.width - railWidth, a.height]
  const [contentA, contentB] = await Promise.all([cropImage(first, contentBounds), cropImage(second, contentBounds)])
  if (!await imageRegionsStable(contentA, contentB)) return false
  const railBounds = { left: a.width - railWidth, top: 0, width: railWidth, height: a.height }
  const [railA, railB] = await Promise.all([first, second].map(frame => sharp(frame).extract(railBounds).removeAlpha().raw().toBuffer()))
  let changed = false
  for (let i = 0; i < railA.length; i += 3) {
    if (Math.max(Math.abs(railA[i] - railB[i]), Math.abs(railA[i + 1] - railB[i + 1]),
      Math.abs(railA[i + 2] - railB[i + 2])) < 12) continue
    changed = true
    for (const rail of [railA, railB]) {
      const low = Math.min(rail[i], rail[i + 1], rail[i + 2])
      const high = Math.max(rail[i], rail[i + 1], rail[i + 2])
      if (low < 150 || high - low > 10) return false
    }
  }
  return changed
}

function doubaoVisibleContentSignature(page) {
  const [left, top, right, bottom] = page.bounds
  return JSON.stringify(page.nodes.filter(node => node.bounds[2] > left && node.bounds[0] < right
    && node.bounds[3] > top && node.bounds[1] < bottom)
    .map(node => [node.id, node.text, node.label, node.bounds]))
}

async function doubaoCompletionFrameDecision(current, next) {
  if (!next.page.complete || next.page.loading) return 'completion_controls_missing'
  if (doubaoVisibleContentSignature(current.page) !== doubaoVisibleContentSignature(next.page)) return 'visible_content_changed'
  if (await imageRegionsStable(current.frame, next.frame)) return 'unchanged'
  if (await doubaoScrollbarOnlyChange(current.frame, next.frame)) return 'unchanged_scrollbar_only'
  return 'content_pixels_changed'
}

function createDoubaoWorkflow({ source, screenshot, ui, tap, swipe, observer, recoverObserver = async error => { throw error },
  log = () => {}, record = async () => {}, checkCancelled = () => {}, delay = sleep, now = Date.now }) {
  let captureBounds = null
  async function read(question = '') {
    checkCancelled()
    const xml = await source()
    return { xml, page: doubaoPage(xml, question) }
  }

  async function readAfterNewSession(timeout) {
    const started = now()
    let retries = 0
    while (true) {
      try {
        const current = await read()
        return { ...current, retries, waitedMs: now() - started }
      } catch (error) {
        if (error.message !== MISSING_CHAT_LAYOUT || now() - started >= timeout) throw error
        // A new conversation briefly renders an incomplete hierarchy. Only
        // repeat the read; never repeat the click or send while it attaches.
        await foreground()
        retries += 1
        await delay(Math.min(250, Math.max(0, timeout - (now() - started))))
      }
    }
  }

  async function foreground() {
    checkCancelled()
    if ((await ui.currentApp()).package !== DOUBAO_PACKAGE) throw new Error('前台应用不是豆包，已在 UI 操作前停止。')
  }

  async function clickNode(node) {
    if (!node || nodeAttr(node.attrs, 'enabled') === 'false') throw new Error('豆包目标控件不可用，未执行点击。')
    await foreground()
    const b = node.bounds
    await tap((b[0] + b[2]) / 2, (b[1] + b[3]) / 2)
  }

  async function prepare(timeout = 15_000) {
    const deadline = now() + timeout
    // App identity errors are never swallowed; only wait for the chat layout.
    while (now() < deadline) {
      const xml = await source()
      if (xml.includes(`${DOUBAO_PACKAGE}:id/input_text`)) return doubaoPage(xml)
      await delay(250)
    }
    throw new Error('豆包输入页未就绪，请先完成登录或关闭引导弹窗。')
  }

  async function submitQuestion(question, beforeSubmission = async () => {}) {
    log('stage: 正在确认豆包干净的新会话')
    let current = await read()
    // Check physical/logical geometry before creating a conversation or typing.
    mapDoubaoBounds(current.page.bounds, current.page.size, await imageInfo(await screenshot()))
    let newSessionClicked = false
    if (!current.page.clean) {
      await clickNode(current.page.byId('larus_chat_top_left_create_new_cvs'))
      newSessionClicked = true
    }
    const deadline = now() + 12_000
    let cleanReads = 0
    let layoutWaitReads = 0
    let layoutWaitMs = 0
    while (now() < deadline && cleanReads < 2) {
      if (newSessionClicked) {
        const settled = await readAfterNewSession(Math.min(4_000, Math.max(0, deadline - now())))
        current = settled
        layoutWaitReads += settled.retries
        if (settled.retries) layoutWaitMs += settled.waitedMs
      } else current = await read()
      cleanReads = current.page.clean ? cleanReads + 1 : 0
      if (cleanReads < 2) await delay(250)
    }
    if (cleanReads < 2) throw new Error('豆包新会话未能连续两次确认为干净页面，已在输入前停止；不重复点击。')
    await record('doubao_new_session_confirmed', { clicked: newSessionClicked, clean_reads: cleanReads,
      layout_wait_reads: layoutWaitReads, layout_wait_ms: layoutWaitMs })
    log('stage: 正在输入豆包问题并逐字回读')
    await foreground()
    const guardedInput = {
      sendKeys: async (...args) => { await foreground(); await read(); return ui.sendKeys(...args) },
      setFocusedText: async (...args) => { await foreground(); await read(); return ui.setFocusedText(...args) },
    }
    const xml = await fillQuestionInput({ ui: guardedInput, source, tap: async (x, y) => { await foreground(); await tap(x, y) }, log, delay,
      readText: value => doubaoPage(value).input.text }, {bounds: current.page.input.bounds}, question)
    if (doubaoPage(xml).input.text !== question) throw new Error('豆包输入回读与原题不一致，未发送。')
    await beforeSubmission()
    current = await read()
    if (current.page.input.text !== question) throw new Error('豆包发送前输入框内容已变化，未发送。')
    await clickNode(current.page.byId('action_send'))
    await record('doubao_question_submitted', { input_verified: true, submission_count: 1 })
    log('stage: 豆包问题已单次发送，等待回答完成与真实底部')
    return { new_session_performed: true, new_session_clicked: newSessionClicked, doubao_input_verified: true, doubao_submission_count: 1,
      doubao_new_session_layout_wait_reads: layoutWaitReads, doubao_new_session_layout_wait_ms: layoutWaitMs }
  }

  async function stable(question, timeout = 8_000) {
    let current = await read(question)
    const expectedBounds = current.page.bounds.join(',')
    let fullFrame; let physicalSize; let physicalBounds
    const hierarchy = async () => {
      current = await read(question)
      if (current.page.bounds.join(',') !== expectedBounds) throw new Error('豆包截图期间消息视口发生变化，已停止以避免裁剪错误。')
      return current.xml
    }
    const capture = async () => {
      fullFrame = await screenshot()
      physicalSize = await imageInfo(fullFrame)
      physicalBounds = mapDoubaoBounds(captureBounds || current.page.bounds, current.page.size, physicalSize)
      return cropImage(fullFrame, physicalBounds)
    }
    let result
    if (observer?.active) {
      try {
        result = await captureStableObserved({ observer, capture, hierarchy, hierarchyLoading: xml => doubaoPage(xml).loading }, Math.min(3_500, timeout))
      } catch (error) { await recoverObserver(error) }
    }
    if (!result?.stable) {
      result = await captureStableSandwich({ capture, hierarchy, framesStable: imageRegionsStable,
        hierarchyLoading: xml => doubaoPage(xml).loading, initialFrame: result?.frame || null, delay }, timeout)
    }
    if (!result.stable) throw new Error('豆包回答视口未能通过稳定像素校验。')
    return { ...result, page: doubaoPage(result.xml, question), fullFrame, physicalSize, physicalBounds,
      viewport: captureBounds || current.page.bounds }
  }

  async function scroll(current, direction, fraction, alternate = false) {
    const fresh = await read()
    if (fresh.page.bounds.join(',') !== current.page.bounds.join(',')) throw new Error('豆包滚动前视口变化，已停止。')
    await foreground()
    const [left, top, right, bottom] = current.viewport || current.page.bounds
    const distance = Math.round((bottom - top) * fraction)
    const center = (top + bottom) / 2
    const x = left + (right - left) * (alternate ? 0.72 : 0.86)
    const from = direction === 'up' ? center - distance / 2 : center + distance / 2
    const to = direction === 'up' ? center + distance / 2 : center - distance / 2
    // A duration scaled to the current viewport avoids a fling on small screens.
    await swipe(x, from, to, Math.round(1000 * fraction))
    return distance * current.physicalSize.height / current.page.size.height
  }

  async function imagesReady(current) {
    const { page, fullFrame, physicalSize } = current
    if (page.collapsed) throw new Error(`豆包出现尚未适配的折叠资料入口“${page.collapsed.text || page.collapsed.label}”，未静默跳过。`)
    const candidates = page.nodes.filter(node => nodeAttr(node.attrs, 'class') === 'android.widget.ImageView'
      && node.bounds[1] >= page.bounds[1] && node.bounds[3] <= page.bounds[3]
      && node.bounds[2] - node.bounds[0] >= page.size.width * 0.15 && node.bounds[3] - node.bounds[1] >= page.size.height * 0.06)
    for (const node of candidates) {
      if (!await imageLooksLoaded(await cropImage(fullFrame, mapDoubaoBounds(node.bounds, page.size, physicalSize)))) return false
    }
    return true
  }

  async function ready(current, question) {
    const deadline = now() + 12_000
    while (!await imagesReady(current)) {
      if (now() >= deadline) throw new Error('豆包回答中的图片仍未加载完成。')
      await delay(250)
      current = await stable(question)
    }
    return current
  }

  async function captureAnswer(question, timeout = 90_000) {
    captureBounds = null
    const started = now()
    const deadline = started + timeout
    // The answer may legitimately take the whole task budget to generate. Once
    // the completion controls appear, bound a *static* but unverifiable footer
    // separately; actual changes to visible UI content still get the full budget.
    const stalledFooterLimit = Math.min(35_000, Math.max(18_000, timeout / 3))
    let current; let unchanged = 0; let quietSince = started; let probes = 0; let lastNavigation = started
    let completionSeenAt = null; let lastVisibleProgressAt = null; let lastDecision = 'completion_controls_missing'
    let scrollbarOnlyProbesDuringCompletion = 0
    while (now() < deadline) {
      // During generation only read the UI; do not accept a brief token pause.
      const state = await read(question)
      if (!state.page.complete || state.page.loading) {
        unchanged = 0
        quietSince = now()
        current = null
        if (completionSeenAt !== null) lastVisibleProgressAt = now()
        if (now() - lastNavigation >= 4_000) {
          const physicalSize = await imageInfo(await screenshot())
          mapDoubaoBounds(state.page.bounds, state.page.size, physicalSize)
          await scroll({ page: state.page, physicalSize }, 'down', 0.65)
          lastNavigation = now()
        }
        await delay(500)
        continue
      }
      if (completionSeenAt === null) {
        completionSeenAt = now()
        lastVisibleProgressAt = completionSeenAt
        await record('doubao_reply_completion_controls_seen', { elapsed_ms: completionSeenAt - started,
          overall_timeout_ms: timeout, stalled_footer_limit_ms: stalledFooterLimit })
      }
      if (!current) { current = await stable(question); quietSince = now() }
      await scroll(current, 'down', 0.65, probes % 2 === 1)
      const next = await stable(question)
      const decision = await doubaoCompletionFrameDecision(current, next)
      const same = decision === 'unchanged' || decision === 'unchanged_scrollbar_only'
      if (decision === 'visible_content_changed') lastVisibleProgressAt = now()
      if (decision === 'unchanged_scrollbar_only') scrollbarOnlyProbesDuringCompletion++
      unchanged = same ? unchanged + 1 : 0
      if (!same) quietSince = now()
      current = next
      probes++
      lastDecision = decision
      await record('doubao_reply_completion_probe', { probe: probes, decision, consecutive_unchanged: unchanged,
        quiet_ms: now() - quietSince, stalled_ms: now() - lastVisibleProgressAt })
      if (unchanged >= 3 && now() - quietSince >= 6_000) break
      if (now() - lastVisibleProgressAt >= stalledFooterLimit) break
    }
    if (!current || unchanged < 3 || now() - quietSince < 6_000) {
      const details = { completion_controls_seen: completionSeenAt !== null, probes, consecutive_unchanged: unchanged,
        quiet_ms: now() - quietSince, stalled_ms: lastVisibleProgressAt === null ? 0 : now() - lastVisibleProgressAt,
        elapsed_ms: now() - started, last_decision: lastDecision,
        reason: completionSeenAt !== null && now() - lastVisibleProgressAt >= stalledFooterLimit
          ? 'static_footer_unverifiable' : 'overall_timeout' }
      await record('doubao_reply_completion_unverified', details)
      const reason = details.reason === 'static_footer_unverifiable' ? '完成操作栏已出现，但静态页面的像素仍持续变化'
        : '回答生成或到底确认超过总时限'
      throw new Error(`豆包回答未能确认真实到底：${reason}（${details.reason}）；探测=${probes}，连续未滚动=${unchanged}，最后变化=${lastDecision}，耗时=${Math.round(details.elapsed_ms / 1000)}秒。`)
    }
    const completionMs = now() - started
    await record('doubao_reply_completion_confirmed', { probes, unchanged, quiet_ms: now() - quietSince,
      scrollbar_only_probes: scrollbarOnlyProbesDuringCompletion, completion_controls_seen_ms: completionSeenAt - started })
    log('stage: 豆包回答已完成，正在返回本题问题顶部')
    const topStarted = now(); const topDeadline = now() + 90_000
    unchanged = 0; let topSwipes = 0
    while (now() < topDeadline) {
      await scroll(current, 'up', 0.7, topSwipes % 2 === 1)
      const next = await stable(question)
      unchanged = await imageRegionsStable(current.frame, next.frame) ? unchanged + 1 : 0
      current = next; topSwipes++
      if (unchanged >= 2) break
    }
    if (unchanged < 2 || !current.page.questionVisible) throw new Error('豆包回顶后未确认完整原题气泡，未开始交付截图。')
    const referenceCount = doubaoReferenceCount(current.page)
    if (referenceCount > 0) {
      if (!doubaoReferences(current.page).some(item => item.index === 1)) {
        await clickNode(current.page.byId('ll_reference_title') || current.page.byId('tv_reference_title'))
      }
      current = await stable(question)
      if (!current.page.questionVisible || !doubaoReferences(current.page).some(item => item.index === 1)) {
        throw new Error('豆包资料单次展开后未确认首条来源和本题问题，未开始截图；不重复点击。')
      }
      await record('doubao_references_expanded', { expected_count: referenceCount, first_reference_verified: true })
    }
    // Reserve the floating "back to bottom" control's whole shadow area. Keep
    // the same crop for every page, including the last page where it vanishes.
    const floating = current.page.byId('fast_button_icon')
    captureBounds = [...current.page.bounds]
    if (floating) captureBounds[3] = Math.min(captureBounds[3], Math.floor(floating.bounds[1] - current.page.size.width * 0.015))
    current = await stable(question)
    current = await ready(current, question)
    await record('doubao_question_top_confirmed', { swipes: topSwipes, question_exact: true, logical_size: current.page.size, physical_size: current.physicalSize })
    const topNavigationMs = now() - topStarted
    log('stage: 正在从上到下采集豆包回答并验证接缝')
    const sequence = new CaptureSequence()
    sequence.addInitial(current.frame)
    const references = new Map(doubaoReferences(current.page, current.viewport).map(item => [item.index, item]))
    const referenceHeader = current.page.byId('ll_reference_title_wrapper')
    if (referenceCount > 0 && referenceHeader) {
      // Doubao pins the reference header (including a fading mask) over the
      // scrolling list. Keep it in the first frame, then exclude its measured
      // height in every later frame so it cannot conceal a seam.
      const headerHeight = referenceHeader.bounds[3] - referenceHeader.bounds[1]
      captureBounds = [...captureBounds]
      captureBounds[1] += Math.ceil(headerHeight + current.page.size.width * 0.005)
    }
    const seamRecords = []; const scrollDecisions = []; const seamDiagnostics = []
    let recaptureCount = 0; let scans = 0; let scrollbarOnlyProbes = 0
    unchanged = 0
    const captureDeadline = now() + Math.max(180_000, timeout * 2)
    while (now() < captureDeadline) {
      const distance = await scroll(current, 'down', 0.4, scans % 2 === 1)
      let next = await ready(await stable(question), question)
      scans++
      const fullyStable = await imageRegionsStable(current.frame, next.frame)
      const scrollbarOnly = !fullyStable && await doubaoScrollbarOnlyChange(current.frame, next.frame)
      if (fullyStable || scrollbarOnly) {
        unchanged++
        if (scrollbarOnly) scrollbarOnlyProbes++
        scrollDecisions.push({ swipe: scans, decision: scrollbarOnly ? 'unchanged_scrollbar_only' : 'unchanged', consecutive: unchanged })
        if (scrollbarOnly) await record('doubao_scrollbar_only_change', { swipe: scans, consecutive: unchanged })
        current = next
        if (unchanged >= 2 && current.page.complete) break
        if (unchanged >= 3) throw new Error('豆包页面无法继续滚动，但未显示回答完成标记。')
        continue
      }
      unchanged = 0
      const expected = (await imageInfo(sequence.lastFrame)).height - distance - (next.physicalBounds[1] - current.physicalBounds[1])
      let overlap
      try { overlap = await verifyReplyFrameOverlap(sequence.lastFrame, next.frame, expected) }
      catch (firstError) {
        const afterScroll = next
        next = await ready(await stable(question), question)
        recaptureCount++
        try { overlap = await verifyReplyFrameOverlap(sequence.lastFrame, next.frame, expected) }
        catch (error) {
          // Fail closed for this initial adapter. Never publish a cropped gap.
          const { writeReplySeamDiagnostics } = require('./seam-diagnostics')
          error.doubaoSeamCapture = { ...sequence.toCaptureResult(), bounds: current.physicalBounds, recaptureCount,
            seamDiagnostics: [{ index: sequence.length, previous: current, afterScroll, recapture: next, firstError, retryError: error }] }
          error.writeDoubaoSeamDiagnostics = directory => writeReplySeamDiagnostics(directory, error.doubaoSeamCapture)
          throw error
        }
        seamDiagnostics.push({ index: sequence.length, previous: current, afterScroll, recapture: next, firstError })
      }
      const transition = { verified: true, overlap }
      sequence.append(next.frame, transition)
      for (const item of doubaoReferences(next.page, next.viewport)) references.set(item.index, item)
      seamRecords.push({ index: sequence.length - 1, overlap, verified: true, physical_scroll_distance: distance })
      scrollDecisions.push({ swipe: scans, decision: 'append', page: sequence.length })
      current = next
      await record('doubao_reply_page_captured', { page: sequence.length, overlap, images_ready: true })
      log(`capture: 豆包正文第${sequence.length}帧，接缝已验证（重叠${overlap}px）`)
    }
    if (unchanged < 2 || !current.page.complete) throw new Error('豆包正文采集超时，未确认真实末尾。')
    for (let index = 1; index <= referenceCount; index++) {
      if (!references.has(index)) throw new Error(`豆包参考资料未完整采集：缺少第${index}/${referenceCount}条。`)
    }
    // The reserved floating-control strip can contain the very last lines at
    // the real bottom. Reuse this stable raw PNG to include that strip after
    // the control disappears; no reverse scroll or unverified crop is needed.
    if (captureBounds[3] < current.page.bounds[3]) {
      if (current.page.byId('fast_button_icon')) throw new Error('豆包到底后悬浮按钮仍遮挡末尾，无法完整交付。')
      const fullBounds = mapDoubaoBounds([captureBounds[0], captureBounds[1], captureBounds[2], current.page.bounds[3]], current.page.size, current.physicalSize)
      const terminal = await cropImage(current.fullFrame, fullBounds)
      const lastSize = await imageInfo(sequence.lastFrame)
      const prefix = await cropImage(terminal, [0, 0, lastSize.width, lastSize.height])
      if (!await imageRegionsStable(sequence.lastFrame, prefix)) throw new Error('豆包末帧扩展与已采集正文不一致。')
      await ready({ ...current, physicalBounds: fullBounds }, question)
      sequence.append(terminal, { verified: true, overlap: lastSize.height })
      seamRecords.push({ index: sequence.length - 1, overlap: lastSize.height, verified: true, method: 'same_raw_png_terminal_extension' })
      scrollDecisions.push({ decision: 'terminal_extension', page: sequence.length })
    }
    await record('doubao_capture_completed', { pages: sequence.length, seams: seamRecords.length, confirmed_end: true,
      scrollbar_only_probes: scrollbarOnlyProbes })
    return { ...sequence.toCaptureResult(), xml: current.xml, bounds: current.physicalBounds, recaptureCount,
      fullRetryCount: 0, fallbackReasons: [], topNavigationMs, questionLocated: true, questionFullyVisible: true,
      evidenceEmbedded: referenceCount > 0, evidenceExpanded: referenceCount > 0, productDetected: false, products: null, productCaptureAttempts: 0, productCaptureMs: 0,
      seamRecords, scrollDecisions, seamDiagnostics,
      captureMetadata: { doubao_capture_complete: true, doubao_answer_completion_controls_verified: true,
        doubao_confirmed_top: true, doubao_confirmed_end: true, doubao_images_ready: true, doubao_reference_mode: 'expanded_inline_sources',
        doubao_reference_count: referenceCount, doubao_references_complete: true,
        doubao_references: [...references.values()].sort((a, b) => a.index - b.index),
        doubao_completion_probes: probes, doubao_completion_ms: completionMs, doubao_top_swipes: topSwipes,
        doubao_scrollbar_only_probes: scrollbarOnlyProbes,
        doubao_completion_scrollbar_only_probes: scrollbarOnlyProbesDuringCompletion,
        doubao_completion_controls_seen_ms: completionSeenAt - started,
        doubao_logical_size: current.page.size, doubao_screenshot_size: current.physicalSize,
        reply_completion_confirmed_before_capture: true, reference_products_applicable: false } }
  }

  return { prepare, submitQuestion, captureAnswer }
}

module.exports = { DOUBAO_PACKAGE, doubaoPage, mapDoubaoBounds, doubaoScrollbarOnlyChange,
  doubaoCompletionFrameDecision, doubaoReferenceCount, doubaoReferences, createDoubaoWorkflow }
