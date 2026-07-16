const { sleep } = require('./utils')
const {
  iterNodes,
  nodeAttr,
  nodeIsVisible,
  boundsForNodeAttribute,
  visibleLabelBounds,
} = require('./hierarchy')
const { fillQuestionInput, historyOnboardingVisible } = require('./capture-primitives')
const {
  douyinSearchInput,
  toutiaoSearchInput,
  toutiaoHomeSearchBounds,
} = require('./miniapp-locators')

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
      for (const hintText of getActiveEntry().inputHints || ['输入问题']) {
        const hint = visibleLabelBounds(xml, hintText)
        if (hint) {
          await tap((hint[0] + hint[2]) / 2, (hint[1] + hint[3]) / 2)
          await sleep(500)
          break
        }
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
  
  async function tapNewSession() {
    // Compose exposes the icon's label on a non-clickable child while its
    // clickable hit target is the parent. Clicking the label works on some
    // devices but silently fails on others, so prefer the parent when present.
    const newSession = boundsForNodeAttribute(await source(), 'content-desc', '开启新会话')
    if (!newSession) return false
    await tap((newSession[0] + newSession[2]) / 2, (newSession[1] + newSession[3]) / 2)
    await waitForVisualQuiet({ timeout: 1_200, fallbackMs: 1_000 })
    for (const text of ['确定', '确认', '开始', '新会话']) {
      const button = visibleLabelBounds(await source(), text)
      if (button) {
        await tap((button[0] + button[2]) / 2, (button[1] + button[3]) / 2)
        await waitForVisualQuiet({ timeout: 1_200, fallbackMs: 1_000 })
        break
      }
    }
    return true
  }
  
  async function waitForDouyinSearchInput(timeout = 12_000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const xml = await source()
      const edit = douyinSearchInput(xml)
      if (edit) return edit
      const close = boundsForNodeAttribute(xml, 'content-desc', '关闭')
      if (close) {
        log('stage: 正在关闭上一题的小荷AI全文页')
        await tap((close[0] + close[2]) / 2, (close[1] + close[3]) / 2)
        await waitForVisualQuiet({ timeout: 1_500, fallbackMs: 800 })
        continue
      }
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
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const xml = await source()
      const close = boundsForNodeAttribute(xml, 'content-desc', '关闭')
      if (close) {
        log('stage: 正在关闭上一题的头条小荷AI全文页')
        await tap((close[0] + close[2]) / 2, (close[1] + close[3]) / 2)
        await waitForVisualQuiet({ timeout: 1_500, fallbackMs: 800 })
        continue
      }
      const edit = toutiaoSearchInput(xml)
      if (edit) {
        await tap((edit.bounds[0] + edit.bounds[2]) / 2, (edit.bounds[1] + edit.bounds[3]) / 2)
        await waitForVisualQuiet({ timeout: 1_200, fallbackMs: 500 })
        return toutiaoSearchInput(await source()) || edit
      }
      const homeSearch = toutiaoHomeSearchBounds(xml)
      if (homeSearch) {
        log('stage: 正在打开头条首页搜索入口')
        await tap((homeSearch[0] + homeSearch[2]) / 2, (homeSearch[1] + homeSearch[3]) / 2)
        await waitForVisualQuiet({ timeout: 1_500, fallbackMs: 800 })
        continue
      }
      const search = boundsForNodeAttribute(xml, 'content-desc', '搜索') || visibleLabelBounds(xml, '搜索')
      if (search) {
        await tap((search[0] + search[2]) / 2, (search[1] + search[3]) / 2)
        await waitForVisualQuiet({ timeout: 1_500, fallbackMs: 800 })
        continue
      }
      await sleep(400)
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

