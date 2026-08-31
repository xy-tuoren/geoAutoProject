const { sleep } = require('./utils')
const {
  iterNodes,
  nodeAttr,
  nodeIsVisible,
  parseBounds,
  boundsForNodeAttribute,
  visibleLabelBounds,
  parseNodeTree,
} = require('./hierarchy')
const { fillQuestionInput, historyOnboardingVisible } = require('./capture-primitives')
const {
  miniAppShellCloseBounds,
  douyinSearchInput,
  toutiaoSearchInput,
  toutiaoHomeSearchBounds,
  toutiaoAddToHomeScreenCancelBounds,
} = require('./miniapp-locators')

const SESSION_FIXED_LABELS = new Set([
  '开启新会话', '新会话', '更多', '历史记录', '小荷AI医生',
  '输入问题', '输入', '输入问题 或 按住说话', '发送',
  '拍药品', '拍患处', '报告解读', '上传图片', '打开相机',
  '切换语音输入', '展开输入扩展', '朗读', '打电话',
  '不选咨询人', '不选择咨询人，随便聊聊', '本人', '本人，咨询人档案', '新建咨询人',
])
const NEW_SESSION_CONTROL_LABELS = ['开启新会话', '新会话']
const MORE_MENU_LABEL = '更多'

function sessionContentLabels(xml) {
  return iterNodes(xml).flatMap(attrs => {
    if (!nodeIsVisible(attrs) || nodeAttr(attrs, 'class') === 'android.widget.EditText') return []
    if (nodeAttr(attrs, 'package') === 'com.android.systemui') return []
    const label = (nodeAttr(attrs, 'text') || nodeAttr(attrs, 'content-desc')).replace(/\s+/g, ' ').trim()
    if (!label || SESSION_FIXED_LABELS.has(label) || /^\d{1,2}:\d{2}$/.test(label)
      || /^(?:今天|昨天|前天)(?:\s+\d{1,2}:\d{2})?$/.test(label)) return []
    return [label]
  })
}

function labeledHitBounds(xml, label) {
  const visit = (node, ancestors) => {
    const text = nodeAttr(node.attrs, 'text')
    const description = nodeAttr(node.attrs, 'content-desc')
    if (nodeIsVisible(node.attrs) && (text === label || description === label)) {
      const rawBounds = nodeAttr(node.attrs, 'bounds')
      if (!rawBounds) return null
      const labelBounds = parseBounds(rawBounds)
      const labelArea = Math.max(1, (labelBounds[2] - labelBounds[0]) * (labelBounds[3] - labelBounds[1]))
      if (nodeAttr(node.attrs, 'clickable') === 'true') return labelBounds
      for (let index = ancestors.length - 1; index >= 0; index -= 1) {
        if (nodeAttr(ancestors[index].attrs, 'clickable') !== 'true') continue
        const ancestorRaw = nodeAttr(ancestors[index].attrs, 'bounds')
        if (!ancestorRaw) continue
        const ancestorBounds = parseBounds(ancestorRaw)
        const ancestorArea = (ancestorBounds[2] - ancestorBounds[0]) * (ancestorBounds[3] - ancestorBounds[1])
        // Prefer the Compose parent hit target, but never a full-screen overlay.
        if (ancestorArea <= labelArea * 12) return ancestorBounds
      }
      return labelBounds
    }
    for (const child of node.children) {
      const found = visit(child, [...ancestors, node])
      if (found) return found
    }
    return null
  }
  return visit(parseNodeTree(xml), [])
}

function findNewSessionTarget(xml) {
  for (const label of NEW_SESSION_CONTROL_LABELS) {
    const bounds = labeledHitBounds(xml, label)
    if (bounds) return { bounds, label, kind: 'session' }
  }
  const more = labeledHitBounds(xml, MORE_MENU_LABEL)
  return more ? { bounds: more, label: MORE_MENU_LABEL, kind: 'more' } : null
}

function hierarchySize(xml) {
  let width = 0
  let height = 0
  for (const attrs of iterNodes(xml)) {
    const rawBounds = nodeAttr(attrs, 'bounds')
    if (!rawBounds) continue
    const bounds = parseBounds(rawBounds)
    width = Math.max(width, bounds[2])
    height = Math.max(height, bounds[3])
  }
  return { width, height }
}

function inputHintBounds(xml, hints = ['输入问题']) {
  const candidates = iterNodes(xml).flatMap(attrs => {
    if (!nodeIsVisible(attrs) || nodeAttr(attrs, 'class') === 'android.widget.EditText') return []
    const label = nodeAttr(attrs, 'text') || nodeAttr(attrs, 'content-desc')
    const rawBounds = nodeAttr(attrs, 'bounds')
    if (!label || !rawBounds || !hints.some(hint => label.includes(hint))) return []
    return [parseBounds(rawBounds)]
  })
  candidates.sort((a, b) => b[1] - a[1])
  return candidates[0] || null
}

function cleanNewSessionReady(xml, hints = ['输入问题']) {
  const size = hierarchySize(xml)
  if (size.height <= size.width || size.height <= 0) return false
  const inputReady = boundsForNodeAttribute(xml, 'class', 'android.widget.EditText') || inputHintBounds(xml, hints)
  if (!inputReady) return false
  const contentTop = Math.floor(size.height * 0.16)
  const contentBottom = Math.floor(size.height * 0.82)
  const conversationLabels = iterNodes(xml).filter(attrs => {
    if (!nodeIsVisible(attrs) || nodeAttr(attrs, 'class') === 'android.widget.EditText') return false
    if (nodeAttr(attrs, 'package') === 'com.android.systemui') return false
    const label = nodeAttr(attrs, 'text') || nodeAttr(attrs, 'content-desc')
    const rawBounds = nodeAttr(attrs, 'bounds')
    if (!label || !rawBounds || SESSION_FIXED_LABELS.has(label)) return false
    const bounds = parseBounds(rawBounds)
    const centerY = (bounds[1] + bounds[3]) / 2
    return centerY >= contentTop && centerY <= contentBottom
  })
  return conversationLabels.length === 0
}

function createQuestionInputWorkflow({
  checkCancelled,
  source,
  windowSize,
  tap,
  log,
  ui,
  waitForVisualQuiet,
  findSubmitBounds,
  boundsForResourceId,
  getActiveEntry,
  getCachedInputBounds,
  setCachedInputBounds,
  getCachedSendBounds,
  setCachedSendBounds,
}) {
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
        setCachedInputBounds(editBounds)
        setCachedSendBounds(findSubmitBounds(xml))
        const attrs = iterNodes(xml).find(item => nodeAttr(item, 'class') === 'android.widget.EditText')
        return { bounds: editBounds, text: attrs ? nodeAttr(attrs, 'text') : '' }
      }
      const hint = inputHintBounds(xml, getActiveEntry().inputHints || ['输入问题'])
      if (hint) {
        await tap((hint[0] + hint[2]) / 2, (hint[1] + hint[3]) / 2)
        await sleep(500)
      }
      await sleep(500)
    }
    throw new Error(`未能在${getActiveEntry().label}找到输入框。`)
  }
  
  async function inputQuestion(question) {
    const edit = await waitForInput()
    // Use uiautomator2's device-level IME/clipboard input rather than a
    // WebDriver element value command. Mutating UI requests are not replayed
    // after failure, so an uncertain input state terminates the task.
    const restoredXml = await fillQuestionInput({
      ui,
      tap,
      source,
      log,
      readText: xml => {
        const input = iterNodes(xml).find(item => nodeIsVisible(item)
          && nodeAttr(item, 'class') === 'android.widget.EditText')
        return input ? nodeAttr(input, 'text') : null
      },
    }, edit, question)
    const restoredEdit = iterNodes(restoredXml).find(item => nodeIsVisible(item)
      && nodeAttr(item, 'class') === 'android.widget.EditText')
    if (!restoredEdit || nodeAttr(restoredEdit, 'text') !== question) {
      throw new Error('小荷App输入框未能确认问题文本，已停止发送。')
    }
    setCachedInputBounds(boundsForNodeAttribute(restoredXml, 'class', 'android.widget.EditText') || getCachedInputBounds())
    setCachedSendBounds(findSubmitBounds(restoredXml) || getCachedSendBounds())
  }
  
  async function tapSend() {
    // The send control is already present in the hierarchy read by
    // waitForInput, so use the cached hit target without a second lookup.
    if (getCachedSendBounds()) {
      const x = Math.round((getCachedSendBounds()[0] + getCachedSendBounds()[2]) / 2)
      const y = Math.round((getCachedSendBounds()[1] + getCachedSendBounds()[3]) / 2)
      await tap(x, y)
      return
    }
    if (getActiveEntry().submitKey) {
      await ui.press(getActiveEntry().submitKey)
      return
    }
    if (!getCachedInputBounds()) await waitForInput()
    const [left, top, right, bottom] = getCachedInputBounds()
    const height = bottom - top
    const x = Math.round(right - Math.min(80, height * 0.24))
    const y = Math.round(bottom + Math.min(48, height * 0.2))
    await tap(x, y)
  }
  
  async function tapNewSession({ timeout = 8_000 } = {}) {
    // Compose exposes the icon's label on a non-clickable child while its
    // clickable hit target is the parent. Clicking the label works on some
    // devices but silently fails on others, so prefer the parent when present.
    const beforeXml = await source()
    const inputHints = getActiveEntry().inputHints || ['输入问题']
    if (cleanNewSessionReady(beforeXml, inputHints)) {
      log('stage: 当前已经是无历史消息的新会话输入页，无需重复点击')
      return true
    }
    const waitForCleanSession = async (attempt, allowConfirmation) => {
      const deadline = Date.now() + timeout
      let confirmationHandled = false
      let lastChangedSignature = null
      let stableChangedReads = 0
      while (Date.now() < deadline) {
        checkCancelled()
        const xml = await source()
        if (allowConfirmation && !confirmationHandled) {
          for (const text of ['确定', '确认', '开始']) {
            const button = visibleLabelBounds(xml, text)
            if (!button) continue
            await tap((button[0] + button[2]) / 2, (button[1] + button[3]) / 2)
            confirmationHandled = true
            await waitForVisualQuiet({ timeout: 1_200, fallbackMs: 1_000 })
            break
          }
          if (confirmationHandled) continue
        }
        if (cleanNewSessionReady(xml, inputHints)) {
          const signature = JSON.stringify(sessionContentLabels(xml))
          stableChangedReads = signature === lastChangedSignature ? stableChangedReads + 1 : 1
          lastChangedSignature = signature
          if (stableChangedReads >= 2) {
            log(`stage: 已确认旧会话内容消失，新会话输入页稳定（点击=${attempt}次）`)
            return true
          }
        } else {
          lastChangedSignature = null
          stableChangedReads = 0
        }
        await sleep(Math.min(200, Math.max(1, deadline - Date.now())))
      }
      return false
    }
    const maxAttempts = 3
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const currentXml = attempt === 1 ? beforeXml : await source()
      const target = findNewSessionTarget(currentXml)
      if (!target) {
        if (attempt === 1) return false
        log(`stage: 第${attempt - 1}次点击后新会话入口暂时消失，按界面转场继续等待，不盲目重点击`)
        if (await waitForCleanSession(attempt - 1, false)) return true
        break
      }
      await tap(Math.round((target.bounds[0] + target.bounds[2]) / 2), Math.round((target.bounds[1] + target.bounds[3]) / 2))
      await waitForVisualQuiet({ timeout: 1_200, fallbackMs: 1_000 })
      if (target.kind === 'more') {
        log('stage: 已打开右上角更多菜单，正在点击新会话')
        const opened = findNewSessionTarget(await source())
        if (opened?.kind === 'session') {
          await tap(Math.round((opened.bounds[0] + opened.bounds[2]) / 2), Math.round((opened.bounds[1] + opened.bounds[3]) / 2))
          await waitForVisualQuiet({ timeout: 1_200, fallbackMs: 1_000 })
        }
      }
      if (await waitForCleanSession(attempt, true)) return true
      if (attempt < maxAttempts) log(`stage: 第${attempt}次点击后旧会话仍完整存在，重新读取入口并安全尝试第${attempt + 1}次`)
    }
    log(`stage: 连续${maxAttempts}次点击新会话入口后，旧会话内容仍未确认消失`)
    return false
  }
  
  async function waitForDouyinSearchInput(timeout = 12_000) {
    const deadline = Date.now() + timeout
    let closeClickedAt = 0
    while (Date.now() < deadline) {
      const xml = await source()
      const edit = douyinSearchInput(xml)
      if (edit) return edit
      const size = await windowSize()
      const close = miniAppShellCloseBounds(xml, size)
      if (close) {
        if (!closeClickedAt) {
          log('stage: 正在关闭上一题的小荷AI全文页')
          closeClickedAt = Date.now()
          await tap((close[0] + close[2]) / 2, (close[1] + close[3]) / 2)
          await waitForVisualQuiet({ timeout: 1_500, fallbackMs: 800 })
        } else if (Date.now() - closeClickedAt >= 4_000) {
          throw new Error('已点击上一题小荷AI全文页的关闭按钮，但页面仍未退出；为避免重复点击，本题已停止。')
        } else await sleep(250)
        continue
      }
      closeClickedAt = 0
      const search = boundsForNodeAttribute(xml, 'content-desc', '搜索') || visibleLabelBounds(xml, '搜索')
      if (search) {
        await tap((search[0] + search[2]) / 2, (search[1] + search[3]) / 2)
        await waitForVisualQuiet({ timeout: 1_500, fallbackMs: 800 })
        continue
      }
      await sleep(400)
    }
    throw new Error('未能在抖音打开搜索输入框。请确认抖音首页可正常使用且没有登录、青少年模式或升级提示遮挡。')
  }
  
  async function inputDouyinQuestion(question) {
    const edit = await waitForDouyinSearchInput()
    const xml = await fillQuestionInput({
      ui,
      tap,
      source,
      log,
      readText: currentXml => douyinSearchInput(currentXml)?.text ?? null,
    }, edit, question)
    const restored = douyinSearchInput(xml)
    if (!restored || restored.text !== question) throw new Error('抖音搜索框输入后未能确认问题文本，已停止搜索。')
    const search = boundsForNodeAttribute(xml, 'content-desc', '搜索') || visibleLabelBounds(xml, '搜索')
    if (!search) throw new Error('抖音搜索框已输入问题，但未能定位“搜索”按钮；为避免误操作，本题未继续。')
    return search
  }
  
  async function waitForToutiaoSearchInput(timeout = 12_000) {
    async function readHierarchyHandlingStartupPopup() {
      try {
        return await source()
      } catch (error) {
        if (typeof ui.dumpHierarchy !== 'function') throw error
        const rawXml = await ui.dumpHierarchy()
        const cancel = toutiaoAddToHomeScreenCancelBounds(rawXml)
        if (!cancel) throw error
        log('stage: 正在取消头条冷启动的“添加到主屏幕”提示')
        await tap((cancel[0] + cancel[2]) / 2, (cancel[1] + cancel[3]) / 2)
        await waitForVisualQuiet({ timeout: 1_500, fallbackMs: 800 })
        return null
      }
    }

    async function inspectHierarchy(xml) {
      if (!xml) return { progressed: true }
      const close = boundsForNodeAttribute(xml, 'content-desc', '关闭')
      if (close) {
        log('stage: 正在关闭上一题的头条小荷AI全文页')
        await tap((close[0] + close[2]) / 2, (close[1] + close[3]) / 2)
        await waitForVisualQuiet({ timeout: 1_500, fallbackMs: 800 })
        return { progressed: true }
      }
      const edit = toutiaoSearchInput(xml)
      if (edit) {
        await tap((edit.bounds[0] + edit.bounds[2]) / 2, (edit.bounds[1] + edit.bounds[3]) / 2)
        await waitForVisualQuiet({ timeout: 1_200, fallbackMs: 500 })
        return { input: toutiaoSearchInput(await source()) || edit }
      }
      const homeSearch = toutiaoHomeSearchBounds(xml)
      if (homeSearch) {
        log('stage: 正在打开头条首页搜索入口')
        await tap((homeSearch[0] + homeSearch[2]) / 2, (homeSearch[1] + homeSearch[3]) / 2)
        await waitForVisualQuiet({ timeout: 1_500, fallbackMs: 800 })
        return { progressed: true }
      }
      const search = boundsForNodeAttribute(xml, 'content-desc', '搜索') || visibleLabelBounds(xml, '搜索')
      if (search) {
        await tap((search[0] + search[2]) / 2, (search[1] + search[3]) / 2)
        await waitForVisualQuiet({ timeout: 1_500, fallbackMs: 800 })
        return { progressed: true }
      }
      return { progressed: false }
    }

    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const result = await inspectHierarchy(await readHierarchyHandlingStartupPopup())
      if (result.input) return result.input
      await sleep(400)
    }

    // A slow home feed can expose its search node in the same few hundred
    // milliseconds between the last poll and the timeout diagnostic. Perform
    // one final read and, only when it proves forward progress, allow a short
    // bounded grace window for the real EditText to attach.
    const finalResult = await inspectHierarchy(await readHierarchyHandlingStartupPopup())
    if (finalResult.input) return finalResult.input
    if (finalResult.progressed) {
      const graceDeadline = Date.now() + 3_000
      while (Date.now() < graceDeadline) {
        const result = await inspectHierarchy(await readHierarchyHandlingStartupPopup())
        if (result.input) return result.input
        await sleep(250)
      }
    }
    throw new Error('未能在今日头条打开搜索输入框。请确认头条首页可正常使用且没有登录或升级提示遮挡。')
  }
  
  async function inputToutiaoQuestion(question) {
    const edit = await waitForToutiaoSearchInput()
    const xml = await fillQuestionInput({
      ui,
      tap,
      source,
      log,
      readText: currentXml => toutiaoSearchInput(currentXml)?.text ?? null,
    }, edit, question)
    const restored = toutiaoSearchInput(xml)
    if (!restored || restored.text !== question) throw new Error('头条搜索框输入后未能确认问题文本，已停止搜索。')
    const search = boundsForResourceId(xml, 'e0') || visibleLabelBounds(xml, '搜索')
    if (!search) throw new Error('头条搜索框已输入问题，但未能定位“搜索”按钮；为避免误操作，本题未继续。')
    return search
  }
  

  return {
    waitForInput,
    inputQuestion,
    tapSend,
    tapNewSession,
    waitForDouyinSearchInput,
    inputDouyinQuestion,
    waitForToutiaoSearchInput,
    inputToutiaoQuestion,
  }
}

module.exports = { createQuestionInputWorkflow }
