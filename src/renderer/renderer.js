const $ = selector => document.querySelector(selector)
const questions = $('#questions')
const device = $('#device')
const status = $('#status')
const log = $('#log')
const start = $('#start')
const retryFailed = $('#retry-failed')
const resumeBatch = $('#resume-batch')
const stop = $('#stop')
const entryList = $('#entry-list')
const updateAction = $('#update-action')
const { retryableBatchDirectory } = window.retryState
const { initializeEntryProgress, applyEntryProgress } = window.entryProgress
const { parseQuestionInput } = window.questionPlan
const {
  FIXED_FIELDS: generatorFixedFields,
  defaultTopicGroup,
  defaultConfig: defaultGeneratorConfig,
  normalizeTopicGroup: normalizeGeneratorTopicGroup,
  normalizeConfig: normalizeGeneratorConfig,
  generateQuestions,
  canonicalQuestion,
} = window.questionGenerator
let updateState = null
let retryBatchDirectory = null
let entryProgressState = initializeEntryProgress()
const { createSession, retainLog, acceptEvent, screenLayout } = window.deviceState
const sessions = new Map()
const deviceCards = new Map()
let selectedSerial = ''
let defaultOutputDir = ''
let defaultEntries = []
let previewEpoch = 0
let activeView = 'screens'
const generatorDialog = $('#question-generator-dialog')
const GENERATOR_STORAGE_KEY = 'question-generator-config-v1'
let generatorConfig = loadGeneratorConfig()
let generatorPreviewGroups = []
let generatorImportedFile = ''
let generatorIdSequence = 0

function loadGeneratorConfig() {
  try {
    return normalizeGeneratorConfig(JSON.parse(localStorage.getItem(GENERATOR_STORAGE_KEY)))
  } catch (_error) {
    return defaultGeneratorConfig()
  }
}

function saveGeneratorConfig() {
  try {
    localStorage.setItem(GENERATOR_STORAGE_KEY, JSON.stringify(generatorConfig))
    $('#generator-save-state').textContent = '配置已保存在本机'
  } catch (_error) {
    $('#generator-save-state').textContent = '配置保存失败，当前编辑仍可使用'
  }
}

function generatorId(prefix) {
  generatorIdSequence += 1
  return `${prefix}-${Date.now()}-${generatorIdSequence}`
}

function iconButton(label, symbol, action, disabled = false) {
  const button = document.createElement('button')
  button.className = 'icon-button small'
  button.type = 'button'
  button.title = label
  button.setAttribute('aria-label', label)
  button.textContent = symbol
  button.disabled = disabled
  button.addEventListener('click', action)
  return button
}

function generatorInput(value, ariaLabel, onInput, options = {}) {
  const input = document.createElement('input')
  input.type = options.type || 'text'
  input.value = value ?? ''
  input.setAttribute('aria-label', ariaLabel)
  if (options.placeholder) input.placeholder = options.placeholder
  input.addEventListener('input', event => onInput(event.target.value))
  return input
}

function invalidateGeneratorPreview() {
  generatorPreviewGroups = []
  renderGeneratorPreview()
  saveGeneratorConfig()
}

function moveGeneratorItem(list, index, offset) {
  const target = index + offset
  if (target < 0 || target >= list.length) return
  ;[list[index], list[target]] = [list[target], list[index]]
  invalidateGeneratorPreview()
  renderGeneratorEditor()
}

function renderGeneratorFields() {
  const rows = generatorConfig.topicGroups.map((topic, topicIndex) => {
    const row = document.createElement('tr')
    const numberCell = document.createElement('th')
    numberCell.scope = 'row'
    numberCell.textContent = String(topicIndex + 1)
    row.append(numberCell)
    for (const [fieldIndex, field] of generatorFixedFields.entries()) {
      const cell = document.createElement('td')
      const inputId = `generator-topic-${topicIndex}-field-${fieldIndex}`
      const input = generatorInput(topic[field.token], `话题 ${topicIndex + 1} ${field.label}，必填`, value => {
        topic[field.token] = value
        invalidateGeneratorPreview()
      }, { placeholder: `请输入${field.label}` })
      input.id = inputId
      input.required = true
      cell.append(input)
      row.append(cell)
    }
    const actionCell = document.createElement('td')
    actionCell.className = 'generator-topic-action'
    if (generatorConfig.topicGroups.length > 1) {
      actionCell.append(iconButton(`删除话题 ${topicIndex + 1}`, '×', () => {
        generatorConfig.topicGroups.splice(topicIndex, 1)
        invalidateGeneratorPreview()
        renderGeneratorEditor()
      }))
    }
    row.append(actionCell)
    return row
  })
  $('#generator-fields').replaceChildren(...rows)
}

function renderGeneratorImportState() {
  const state = $('#generator-import-state')
  const clear = $('#clear-generator-products')
  const dropzone = $('#generator-product-dropzone')
  if (generatorImportedFile) {
    const name = generatorImportedFile.split(/[\\/]/).pop() || 'XLSX 表格'
    state.textContent = `已将 ${name} 的 ${generatorConfig.topicGroups.length} 组写入下方表格，可继续编辑。`
    dropzone.classList.add('is-imported')
    clear.hidden = false
  } else {
    state.textContent = '未导入，当前使用下方话题组'
    dropzone.classList.remove('is-imported')
    clear.hidden = true
  }
}

function renderGeneratorVariableHint() {
  const tokens = generatorFixedFields.map(field => `{${field.token}}`)
  $('#generator-variable-hint').textContent = `可用变量：${tokens.join('  ')}`
}

function renderGeneratorTemplates() {
  const rows = generatorConfig.templates.map((template, index) => {
    const row = document.createElement('div')
    row.className = 'generator-row generator-template-row'
    const enabledWrap = document.createElement('label')
    enabledWrap.className = 'generator-enabled'
    const enabled = document.createElement('input')
    enabled.type = 'checkbox'
    enabled.checked = template.enabled
    enabled.setAttribute('aria-label', `启用模板 ${template.name || index + 1}`)
    enabled.addEventListener('change', () => { template.enabled = enabled.checked; invalidateGeneratorPreview() })
    enabledWrap.append(enabled)
    row.append(
      enabledWrap,
      generatorInput(template.name, `第 ${index + 1} 条模板名`, value => { template.name = value; invalidateGeneratorPreview() }),
      generatorInput(template.content, `第 ${index + 1} 条模板内容`, value => { template.content = value; invalidateGeneratorPreview() }, { placeholder: '例：{适应症}吃{通用名}有效吗' }),
    )
    const order = document.createElement('div')
    order.className = 'generator-row-actions'
    order.append(
      iconButton('上移模板', '↑', () => moveGeneratorItem(generatorConfig.templates, index, -1), index === 0),
      iconButton('下移模板', '↓', () => moveGeneratorItem(generatorConfig.templates, index, 1), index === generatorConfig.templates.length - 1),
    )
    const remove = document.createElement('div')
    remove.className = 'generator-row-actions'
    remove.append(iconButton('删除模板', '×', () => {
      generatorConfig.templates.splice(index, 1)
      invalidateGeneratorPreview()
      renderGeneratorEditor()
    }))
    row.append(order, remove)
    return row
  })
  $('#generator-templates').replaceChildren(...rows)
}

function renderGeneratorEditor() {
  renderGeneratorImportState()
  renderGeneratorFields()
  renderGeneratorVariableHint()
  renderGeneratorTemplates()
}

function setGeneratorMessages(errors = [], warnings = []) {
  const messages = []
  for (const message of errors) {
    const item = document.createElement('p')
    item.className = 'generator-message error'
    item.textContent = message
    messages.push(item)
  }
  for (const message of warnings) {
    const item = document.createElement('p')
    item.className = 'generator-message warning'
    item.textContent = message
    messages.push(item)
  }
  $('#generator-messages').replaceChildren(...messages)
}

function allGeneratorPreviewQuestions() {
  return generatorPreviewGroups.flatMap(group => group.questions)
}

function refreshGeneratorPreviewState() {
  const questions = allGeneratorPreviewQuestions()
  const reviewed = questions.map(item => item.trim()).filter(Boolean)
  $('#generator-preview-count').textContent = `${reviewed.length} 条 · ${generatorPreviewGroups.length} 组`
  $('#confirm-generated-questions').disabled = reviewed.length === 0 || reviewed.length !== questions.length
}

function renderGeneratorPreview() {
  const list = $('#generator-preview-list')
  if (!generatorPreviewGroups.length) {
    const empty = document.createElement('p')
    empty.className = 'generator-empty'
    empty.textContent = '填写产品信息并生成后，在这里审核问题。'
    list.replaceChildren(empty)
    setGeneratorMessages()
    refreshGeneratorPreviewState()
    return
  }
  const groups = generatorPreviewGroups.map((group, groupIndex) => {
    const section = document.createElement('section')
    section.className = 'generator-preview-group'
    const heading = document.createElement('header')
    heading.className = 'generator-preview-group-heading'
    const identity = document.createElement('div')
    identity.className = 'generator-preview-group-identity'
    const label = document.createElement('span')
    label.className = 'generator-preview-group-label'
    label.textContent = `第 ${groupIndex + 1} 组`
    const title = document.createElement('strong')
    title.textContent = [group.topic['商品名'], group.topic['通用名']].filter(Boolean).join(' · ') || `话题 ${groupIndex + 1}`
    const detail = document.createElement('span')
    detail.className = 'generator-preview-group-detail'
    detail.textContent = [group.topic['适应症'], group.topic['药品类型']].filter(Boolean).join(' · ')
    identity.append(label, title, detail)
    heading.append(identity, iconButton(`在第 ${groupIndex + 1} 组新增问题`, '+', () => {
      group.questions.push('')
      renderGeneratorPreview()
      const currentGroup = list.querySelectorAll('.generator-preview-group')[groupIndex]
      const inputs = currentGroup?.querySelectorAll('input') || []
      inputs[inputs.length - 1]?.focus()
    }))
    const rows = document.createElement('div')
    rows.className = 'generator-preview-group-questions'
    if (!group.questions.length) {
      const empty = document.createElement('p')
      empty.className = 'generator-preview-group-empty'
      empty.textContent = '本组问题已被前面话题去重，可点击 + 补充。'
      rows.append(empty)
    } else {
      rows.append(...group.questions.map((question, questionIndex) => {
        const row = document.createElement('div')
        row.className = 'generator-preview-row'
        const number = document.createElement('span')
        number.className = 'generator-preview-number'
        number.textContent = String(questionIndex + 1)
        const input = generatorInput(question, `第 ${groupIndex + 1} 组第 ${questionIndex + 1} 条预览问题`, value => {
          group.questions[questionIndex] = value
          refreshGeneratorPreviewState()
        })
        const actions = document.createElement('div')
        actions.className = 'generator-row-actions'
        actions.append(
          iconButton('上移问题', '↑', () => { movePreviewQuestion(groupIndex, questionIndex, -1) }, questionIndex === 0),
          iconButton('下移问题', '↓', () => { movePreviewQuestion(groupIndex, questionIndex, 1) }, questionIndex === group.questions.length - 1),
          iconButton('删除问题', '×', () => { group.questions.splice(questionIndex, 1); renderGeneratorPreview() }),
        )
        row.append(number, input, actions)
        return row
      }))
    }
    section.append(heading, rows)
    return section
  })
  list.replaceChildren(...groups)
  refreshGeneratorPreviewState()
}

function movePreviewQuestion(groupIndex, questionIndex, offset) {
  const questions = generatorPreviewGroups[groupIndex]?.questions
  const target = questionIndex + offset
  if (!questions || target < 0 || target >= questions.length) return
  ;[questions[questionIndex], questions[target]] = [questions[target], questions[questionIndex]]
  renderGeneratorPreview()
}

function renderEntryProgress() {
  const container = $('#entry-progress')
  const totalLabel = $('#entry-progress-total')
  if (!entryProgressState.entries.length) {
    totalLabel.textContent = '尚未开始'
    const empty = document.createElement('p')
    empty.className = 'entry-progress-empty'
    empty.textContent = '开始任务后显示各入口成功与失败数量'
    container.replaceChildren(empty)
    return
  }
  const succeeded = entryProgressState.entries.reduce((sum, entry) => sum + entry.succeeded, 0)
  const failed = entryProgressState.entries.reduce((sum, entry) => sum + entry.failed, 0)
  totalLabel.textContent = entryProgressState.current_brand
    ? `${entryProgressState.current_brand}（${entryProgressState.brand_sequence}/${entryProgressState.brand_count}） · 成功 ${succeeded} · 失败 ${failed}`
    : `成功 ${succeeded} · 失败 ${failed}`
  const rows = entryProgressState.entries.map(entry => {
    const row = document.createElement('article')
    row.className = 'entry-progress-item'
    const label = document.createElement('strong')
    label.textContent = entry.label
    const stats = document.createElement('div')
    stats.className = 'entry-progress-stats'
    stats.innerHTML = `<span class="success">成功 ${entry.succeeded}</span><span class="failure">失败 ${entry.failed}</span>`
    const quality = document.createElement('small')
    quality.textContent = `仅搜索结果 ${entry.search_results_only || 0} · 应用提示 ${entry.app_limited || 0} · 建议核图 ${entry.needs_review || 0}`
    stats.append(quality)
    row.append(label, stats)
    return row
  })
  container.replaceChildren(...rows)
}

function sessionFor(serial) {
  if (!sessions.has(serial)) sessions.set(serial, createSession({ text: '', entries: defaultEntries, outputDir: defaultOutputDir, timeout: '90', maxLongImageHeight: '15000', column: '问题' }))
  return sessions.get(serial)
}

function saveDraft() {
  if (!selectedSerial) return
  sessionFor(selectedSerial).draft = { text: questions.value, entries: selectedEntries(), outputDir: $('#output-dir').value,
    timeout: $('#timeout').value, maxLongImageHeight: $('#max-long-image-height').value, column: $('#column-name').value }
}

function selectDevice(serial) {
  saveDraft()
  selectedSerial = serial
  device.value = serial
  const session = serial ? sessionFor(serial) : null
  const draft = session?.draft || { text: '', entries: [], outputDir: defaultOutputDir, timeout: '90', maxLongImageHeight: '15000', column: '问题' }
  questions.value = draft.text
  $('#output-dir').value = draft.outputDir
  $('#timeout').value = draft.timeout
  $('#max-long-image-height').value = draft.maxLongImageHeight
  $('#column-name').value = draft.column
  entryList.querySelectorAll('input').forEach(input => { input.checked = draft.entries.includes(input.value) })
  clearLog()
  for (const item of session?.logs || []) appendLog(item.text)
  entryProgressState = session?.progress || initializeEntryProgress()
  renderEntryProgress()
  status.textContent = session?.message || '请连接并选择手机'
  updatePlan()
}

function renderDeviceControls() {
  const session = sessions.get(selectedSerial)
  const busy = Boolean(session?.running || session?.importing)
  start.disabled = !session?.connected || busy
  resumeBatch.disabled = !session?.connected || busy
  retryBatchDirectory = retryableBatchDirectory(session?.result || {})
  retryFailed.disabled = !session?.connected || busy || !retryBatchDirectory
  stop.disabled = !session?.running || session.stopping
  stop.textContent = session?.stopping ? '正在停止…' : '停止此手机'
  for (const selector of ['#questions', '#output-dir', '#timeout', '#max-long-image-height', '#column-name', '#import-questions', '#select-directory', '#open-question-generator']) $(selector).disabled = !session || busy
  entryList.querySelectorAll('input').forEach(input => { input.disabled = !session || busy })
  $('#start-all').disabled = ![...sessions.values()].some(item => item.connected && !item.running && !item.importing && item.draft.text.trim())
  $('#stop-all').disabled = ![...sessions.values()].some(item => item.running && !item.stopping)
  $('#screens-stop-all').disabled = $('#stop-all').disabled
  $('#queue-device').textContent = selectedSerial ? `${selectedSerial} 的独立题目队列` : '先选择手机 · 可分别导入不同题目'
  $('#log-device').textContent = selectedSerial ? `${selectedSerial} · 保留全部失败及最近 100 条过程日志` : '请选择手机查看日志'
}

function showWorkspace(view) {
  activeView = view
  for (const name of ['screens', 'tasks']) {
    $(`#view-${name}`).hidden = name !== view
    $(`#tab-${name}`).setAttribute('aria-selected', String(name === view))
    $(`#tab-${name}`).tabIndex = name === view ? 0 : -1
  }
  renderDeviceControls()
  refreshPreviewState()
  layoutDeviceCards()
}

function layoutDeviceCards() {
  if (activeView !== 'screens') return
  const container = $('#device-cards')
  const { width, height } = container.getBoundingClientRect()
  const layout = screenLayout(width, height, [...deviceCards.values()].map(card => card.aspect || 9 / 20))
  container.style.setProperty('--device-columns', layout.widths.map(value => `${value}px`).join(' ') || '1fr')
  container.style.setProperty('--device-screen-height', `${layout.screenHeight}px`)
}

function addDeviceLog(serial, text) {
  const session = sessionFor(serial)
  retainLog(session, text, logEntryKind(text))
  if (selectedSerial === serial) appendLog(text)
}

function canPreview(card) {
  return $('#preview-enabled').checked && !document.hidden && sessions.get(card.serial)?.connected
    && activeView === 'screens'
}

function stopCardPreview(card) {
  const streamId = card.streamId
  card.streamId = null
  clearTimeout(card.timer)
  card.player?.close()
  card.player = null
  if (streamId) void window.automation.stopPreview(card.serial, streamId).catch(() => {})
  card.screen.classList.add('is-stale')
}

function previewFailed(card, message) {
  stopCardPreview(card)
  card.freshness.textContent = message
  card.freshness.title = message
  if (card.canvas.hidden) card.placeholder.textContent = '预览不可用，请刷新设备重试'
}

function startCardPreview(card) {
  if (!canPreview(card) || card.streamId) return
  const streamId = `${++previewEpoch}:${card.serial}`
  card.streamId = streamId
  card.freshness.textContent = '正在连接实时画面…'
  card.placeholder.textContent = '正在连接实时画面…'
  try {
    card.player = window.previewPlayer.createPreviewPlayer({ canvas: card.canvas,
      onFrame: frame => {
        if (card.streamId !== streamId || !canPreview(card)) return
        clearTimeout(card.timer)
        card.canvas.hidden = false
        card.placeholder.hidden = true
        card.screen.classList.remove('is-stale')
        card.freshness.textContent = `实时 · ${new Date().toLocaleTimeString()}`
        card.freshness.title = `${frame.width} × ${frame.height} · scrcpy 视频流 · 最高 15 帧/秒`
        if (card.aspect !== frame.width / frame.height) { card.aspect = frame.width / frame.height; layoutDeviceCards() }
      },
      onError: error => { if (card.streamId === streamId) previewFailed(card, `视频无法显示：${error.message}。请刷新设备重试。`) },
    })
    card.timer = setTimeout(() => { if (card.streamId === streamId) previewFailed(card, '未收到可显示的画面，请检查手机连接后刷新设备。') }, 15_000)
    void window.automation.startPreview(card.serial, streamId).catch(error => {
      if (card.streamId === streamId) previewFailed(card, error.message)
    })
  } catch (error) { previewFailed(card, error.message) }
}

function refreshPreviewState() {
  for (const card of deviceCards.values()) {
    stopCardPreview(card)
    if (canPreview(card)) startCardPreview(card)
    else card.freshness.textContent = sessions.get(card.serial)?.connected ? '画面同步已暂停' : '设备已断开，画面不再更新'
  }
}

window.automation.onPreview(event => {
  const card = deviceCards.get(event.serial)
  try {
    if (!card || card.streamId !== event.streamId || !canPreview(card)) return
    if (event.type === 'error') previewFailed(card, event.message)
    else card.player?.push(event)
  } finally {
    if (event.type === 'packet') window.automation.acknowledgePreview(event.serial, event.streamId, event.sequence)
  }
})

function renderDeviceCards() {
  const container = $('#device-cards')
  if (sessions.size && !deviceCards.size) container.replaceChildren()
  for (const [serial, session] of sessions) {
    let card = deviceCards.get(serial)
    if (!card) {
      const element = document.createElement('article')
      element.className = 'device-card'
      element.innerHTML = '<header class="device-card-header"><strong></strong><span class="device-task-status"></span></header><div class="device-screen"><span>等待画面</span><canvas hidden role="img"></canvas></div><p class="device-freshness">等待更新…</p><p class="device-task-detail"></p><div class="device-card-actions"><button class="secondary" type="button">配置 / 日志</button><button class="danger" type="button">停止</button></div>'
      element.querySelector('strong').textContent = serial
      element.querySelector('strong').title = serial
      const screen = element.querySelector('.device-screen')
      const canvas = screen.querySelector('canvas')
      canvas.setAttribute('aria-label', `${serial} 当前屏幕，只读实时画面`)
      card = { serial, element, screen, canvas, placeholder: screen.querySelector('span'), freshness: element.querySelector('.device-freshness'), streamId: null, player: null, timer: null }
      const buttons = element.querySelectorAll('.device-card-actions button')
      buttons[0].setAttribute('aria-label', `配置 ${serial} 并查看日志`)
      buttons[0].addEventListener('click', () => { selectDevice(serial); showWorkspace('tasks') })
      buttons[1].setAttribute('aria-label', `停止 ${serial} 的任务`)
      buttons[1].addEventListener('click', () => stopDevice(serial))
      container.append(element)
      deviceCards.set(serial, card)
      startCardPreview(card)
    }
    card.element.classList.toggle('is-selected', serial === selectedSerial)
    card.element.querySelector('.device-card-actions .secondary').setAttribute('aria-pressed', String(serial === selectedSerial))
    const label = card.element.querySelector('.device-task-status')
    label.textContent = session.stopping ? '正在停止' : session.running ? '执行中' : !session.connected ? '已断开' : session.result ? (session.result.code === 130 ? '已停止' : session.result.code || session.result.summary?.failed ? '有失败' : '已完成') : '待执行'
    label.dataset.state = session.running ? 'running' : session.result?.code || session.result?.summary?.failed ? 'failure' : 'idle'
    const entries = session.progress?.entries || []
    const done = entries.reduce((sum, entry) => sum + entry.succeeded + entry.failed, 0)
    const total = entries.reduce((sum, entry) => sum + entry.total, 0)
    const active = entries.find(entry => entry.active_question)?.active_question
    const detail = card.element.querySelector('.device-task-detail')
    detail.textContent = total ? `${done}/${total} 已处理${active ? ` · ${active}` : ''}` : `${parseQuestionInput(session.draft.text).questions.length} 题 · ${session.draft.entries.length} 个入口`
    detail.title = detail.textContent
    card.element.querySelector('.device-card-actions .danger').disabled = !session.running || session.stopping
  }
  const list = [...sessions.values()]
  $('#device-overview').textContent = `${list.filter(item => item.connected).length} 台已连接 · ${list.filter(item => item.running).length} 台执行中 · 从左到右 · 画面适应窗口`
  $('#screen-count').textContent = list.filter(item => item.connected).length
  layoutDeviceCards()
}

function renderUpdateState(next) {
  updateState = next
  if (!next?.supported) {
    updateAction.hidden = true
    return
  }
  updateAction.hidden = false
  updateAction.classList.toggle('has-update', ['available', 'downloaded'].includes(next.status))
  updateAction.classList.toggle('has-error', next.status === 'error')
  updateAction.disabled = ['checking', 'downloading'].includes(next.status)
    || (next.status === 'downloaded' && !next.canInstall)
  updateAction.title = next.message || ''

  const version = next.version || next.currentVersion
  if (next.status === 'checking') updateAction.textContent = `v${next.currentVersion} · 正在检查…`
  else if (next.status === 'available') updateAction.textContent = `发现 v${version} · 点击下载`
  else if (next.status === 'downloading') updateAction.textContent = `正在下载 v${version} · ${Math.round(next.percent || 0)}%`
  else if (next.status === 'downloaded' && next.taskActive) updateAction.textContent = `v${version} 已下载 · 等待任务结束`
  else if (next.status === 'downloaded') updateAction.textContent = `重启并安装 v${version}`
  else if (next.status === 'not-available') updateAction.textContent = `v${next.currentVersion} · 已是最新`
  else if (next.status === 'error') updateAction.textContent = '更新检查失败 · 点击重试'
  else updateAction.textContent = `v${next.currentVersion} · 检查更新`
}

function currentQuestionPlan() {
  return parseQuestionInput(questions.value)
}

function uniqueQuestions() {
  return currentQuestionPlan().questions
}

function renderQuestionPlan(plan = currentQuestionPlan()) {
  const preview = $('#question-plan-preview')
  preview.classList.toggle('is-grouped', plan.mode === 'grouped')
  preview.classList.toggle('has-errors', plan.errors.length > 0)
  if (plan.errors.length) {
    preview.replaceChildren(...plan.errors.map(message => {
      const error = document.createElement('p')
      error.className = 'question-plan-error'
      error.textContent = message
      return error
    }))
    return
  }
  if (plan.mode !== 'grouped') {
    const empty = document.createElement('p')
    empty.className = 'question-plan-empty'
    empty.textContent = plan.questions.length
      ? `普通问题列表 · ${plan.questions.length} 条问题 · 结果沿用原目录结构`
      : '每行输入一题；需要分品牌存档时，在每组问题前直接填写“#品牌名”。'
    preview.replaceChildren(empty)
    return
  }
  const summary = document.createElement('p')
  summary.className = 'question-plan-summary'
  summary.textContent = `${plan.brandGroups.length} 个品牌 · ${plan.tasks.length} 条问题；品牌目录不加序号`
  const brands = plan.brandGroups.map(group => {
    const brand = document.createElement('div')
    brand.className = 'question-plan-brand'
    const title = document.createElement('strong')
    title.textContent = group.brand
    const count = document.createElement('span')
    count.className = 'question-plan-brand-count'
    count.textContent = `${group.questions.length} 题`
    brand.append(title, count)
    return brand
  })
  preview.replaceChildren(summary, ...brands)
}

function selectedEntries() {
  return [...entryList.querySelectorAll('input[name="entry"]:checked')].map(input => input.value)
}

function updatePlan() {
  saveDraft()
  const plan = currentQuestionPlan()
  const deviceCount = device.value ? 1 : 0
  const entryCount = selectedEntries().length
  const questionCount = plan.questions.length
  const grouping = plan.mode === 'grouped'
    ? `${plan.brandGroups.length} 品牌 · `
    : ''
  $('#plan').textContent = plan.errors.length
    ? `分组输入有 ${plan.errors.length} 项需要修正`
    : `${grouping}${deviceCount} 台设备 × ${entryCount} 个入口 × ${questionCount} 条问题 = ${deviceCount * entryCount * questionCount} 次计划`
  $('#question-count').textContent = `${questionCount} 条问题`
  renderQuestionPlan(plan)
  renderDeviceControls()
  renderDeviceCards()
}

const MAX_ROUTINE_LOG_ENTRIES = 100
const routineLogEntries = []

function logEntryKind(text) {
  const value = String(text)
  if (/(?:^|\n)\s*(?:错误|失败)(?:\s{2,}|[:：])|Traceback|(?:Error|Exception):|任务失败|重试失败/i.test(value)) return 'failure'
  if (/(?:^|\n)\s*(?:完成\s{2,}|执行完成|重试完成|失败项已全部重试成功)|成功[:：]/.test(value)) return 'success'
  return 'routine'
}

function appendLog(text) {
  const kind = logEntryKind(text)
  const entry = document.createElement('span')
  entry.className = `log-entry log-entry-${kind}`
  entry.textContent = String(text)
  log.append(entry)
  if (kind !== 'failure') {
    routineLogEntries.push(entry)
    while (routineLogEntries.length > MAX_ROUTINE_LOG_ENTRIES) routineLogEntries.shift().remove()
  }
  log.scrollTop = log.scrollHeight
}

function clearLog() {
  log.replaceChildren()
  routineLogEntries.length = 0
}

async function refreshDevices() {
  status.textContent = '正在读取 ADB 设备…'
  try {
    const devices = await window.automation.listDevices()
    saveDraft()
    for (const session of sessions.values()) session.connected = false
    devices.forEach(serial => { sessionFor(serial).connected = true })
    device.replaceChildren()
    if (!sessions.size) device.add(new Option('未发现已授权设备', ''))
    for (const [serial, session] of sessions) device.add(new Option(`${serial}${session.connected ? '' : '（已断开）'}`, serial))
    selectDevice(sessions.has(selectedSerial) ? selectedSerial : devices[0] || '')
    refreshPreviewState()
    status.textContent = devices.length ? `已发现 ${devices.length} 台已授权设备` : '未发现已授权设备'
  } catch (error) {
    status.textContent = error.message || '读取 ADB 设备失败'
  }
  updatePlan()
}

async function refreshEntries() {
  try {
    const entries = await window.automation.listEntries()
    defaultEntries = entries.filter(entry => entry.defaultSelected).map(entry => entry.id)
    entryList.replaceChildren()
    entries.forEach(entry => {
      const label = document.createElement('label')
      label.className = 'option entry-option'
      const input = document.createElement('input')
      input.type = 'checkbox'
      input.name = 'entry'
      input.value = entry.id
      input.checked = Boolean(entry.defaultSelected)
      input.addEventListener('change', updatePlan)
      const text = document.createElement('span')
      text.textContent = entry.label
      label.append(input, text)
      entryList.append(label)
    })
  } catch (error) {
    status.textContent = error.message || '读取入口失败'
  }
  updatePlan()
}

const QUESTION_EXTENSIONS = new Set(['.txt', '.csv', '.json', '.xlsx', '.xlsm'])
const PRODUCT_WORKBOOK_EXTENSIONS = new Set(['.xlsx'])
const questionsPanel = $('#questions-panel')
const generatorProductDropzone = $('#generator-product-dropzone')
let dragDepth = 0
let generatorProductDragDepth = 0

function extensionOf(filePath) {
  const match = /\.[^.\\/]+$/.exec(filePath || '')
  return match ? match[0].toLowerCase() : ''
}

async function importQuestionFile(filePath, serial = selectedSerial) {
  if (!filePath) return
  const session = sessions.get(serial)
  if (!session || session.running || session.importing) return
  saveDraft()
  if (!QUESTION_EXTENSIONS.has(extensionOf(filePath))) {
    status.textContent = '仅支持 TXT、CSV、JSON、XLSX、XLSM 问题文件'
    return
  }
  try {
    if (parseQuestionInput(session.draft.text).mode === 'grouped') {
      status.textContent = '当前为品牌分组模式，请把导入的问题放到对应“#品牌名”标题下'
      return
    }
    session.importing = true
    renderDeviceControls()
    const imported = await window.automation.importQuestions({ file: filePath, column: session.draft.column })
    session.draft.text = [...parseQuestionInput(session.draft.text).questions, ...imported].filter((item, index, list) => list.indexOf(item) === index).join('\n')
    if (selectedSerial === serial) questions.value = session.draft.text
    status.textContent = `已导入 ${imported.length} 条问题`
  } catch (error) { status.textContent = error.message || '导入失败' }
  finally { session.importing = false; updatePlan() }
}

async function importGeneratorProductFile(filePath) {
  if (!filePath) return
  if (!PRODUCT_WORKBOOK_EXTENSIONS.has(extensionOf(filePath))) {
    const message = '商品信息批量导入仅支持 XLSX 文件。'
    setGeneratorMessages([message])
    status.textContent = message
    return
  }
  try {
    const products = await window.automation.importProductWorkbook(filePath)
    generatorConfig.topicGroups = products.map(normalizeGeneratorTopicGroup)
    generatorImportedFile = filePath
    generatorPreviewGroups = []
    saveGeneratorConfig()
    renderGeneratorEditor()
    renderGeneratorPreview()
    setGeneratorMessages([])
    status.textContent = `已导入 ${products.length} 组完整话题`
  } catch (error) {
    setGeneratorMessages([error.message || '商品信息表格导入失败。'])
    status.textContent = '商品信息表格导入失败'
  }
}

function setDropActive(active) {
  questionsPanel.classList.toggle('is-drop-active', active)
}

$('#refresh-devices').addEventListener('click', refreshDevices)
$('#refresh-screens').addEventListener('click', refreshDevices)
for (const [index, view] of ['screens', 'tasks'].entries()) {
  $(`#tab-${view}`).addEventListener('click', () => showWorkspace(view))
  $(`#tab-${view}`).addEventListener('keydown', event => {
    const views = ['screens', 'tasks']
    const target = event.key === 'ArrowRight' ? (index + 1) % views.length : event.key === 'ArrowLeft' ? (index + views.length - 1) % views.length : event.key === 'Home' ? 0 : event.key === 'End' ? views.length - 1 : -1
    if (target < 0) return
    event.preventDefault()
    showWorkspace(views[target]); $(`#tab-${views[target]}`).focus()
  })
}
$('#screens-stop-all').addEventListener('click', () => Promise.allSettled([...sessions.keys()].map(stopDevice)))
new ResizeObserver(layoutDeviceCards).observe($('#device-cards'))
$('#select-directory').addEventListener('click', async () => {
  const serial = selectedSerial
  const directory = await window.automation.selectDirectory()
  if (directory && sessions.has(serial)) {
    sessionFor(serial).draft.outputDir = directory
    if (selectedSerial === serial) $('#output-dir').value = directory
  }
  updatePlan()
})
$('#import-questions').addEventListener('click', async () => {
  const serial = selectedSerial
  const file = await window.automation.selectQuestions()
  await importQuestionFile(file, serial)
})

$('#open-question-generator').addEventListener('click', () => {
  renderGeneratorEditor()
  renderGeneratorPreview()
  if (!generatorDialog.open) generatorDialog.showModal()
})
$('#close-question-generator').addEventListener('click', () => generatorDialog.close())
$('#add-generator-topic').addEventListener('click', () => {
  generatorConfig.topicGroups.push(defaultTopicGroup())
  invalidateGeneratorPreview()
  renderGeneratorEditor()
})
$('#add-generator-template').addEventListener('click', () => {
  generatorConfig.templates.push({
    id: generatorId('template'),
    name: '新模板',
    enabled: true,
    content: '',
  })
  invalidateGeneratorPreview()
  renderGeneratorEditor()
})
generatorProductDropzone.addEventListener('click', async () => {
  const file = await window.automation.selectProductWorkbook()
  await importGeneratorProductFile(file)
})
generatorProductDropzone.addEventListener('keydown', async event => {
  if (event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  const file = await window.automation.selectProductWorkbook()
  await importGeneratorProductFile(file)
})
$('#clear-generator-products').addEventListener('click', () => {
  generatorConfig.topicGroups = [defaultTopicGroup()]
  generatorImportedFile = ''
  generatorPreviewGroups = []
  saveGeneratorConfig()
  renderGeneratorEditor()
  renderGeneratorPreview()
  status.textContent = '已清空导入内容，可重新填写或导入'
})
$('#reset-question-generator').addEventListener('click', () => {
  generatorConfig = defaultGeneratorConfig()
  generatorPreviewGroups = []
  generatorImportedFile = ''
  saveGeneratorConfig()
  renderGeneratorEditor()
  renderGeneratorPreview()
  status.textContent = '已恢复默认问题生成配置'
})
$('#generate-product-questions').addEventListener('click', () => {
  const result = generateQuestions(generatorConfig)
  generatorConfig = result.config
  generatorPreviewGroups = result.questionGroups.map(group => ({
    topicIndex: group.topicIndex,
    topic: { ...group.topic },
    questions: [...group.questions],
  }))
  saveGeneratorConfig()
  renderGeneratorEditor()
  renderGeneratorPreview()
  setGeneratorMessages(result.errors, result.warnings)
  if (result.errors.length) status.textContent = `问题生成配置有 ${result.errors.length} 项需要处理`
  else status.textContent = `已生成 ${result.questions.length} 条问题，请审核后加入队列`
})
$('#confirm-generated-questions').addEventListener('click', () => {
  const previewQuestions = allGeneratorPreviewQuestions()
  const reviewed = previewQuestions.map(item => item.trim()).filter(Boolean)
  if (!reviewed.length || reviewed.length !== previewQuestions.length) {
    setGeneratorMessages(['请删除或填写空白的预览问题。'])
    return
  }
  if (currentQuestionPlan().mode === 'grouped') {
    setGeneratorMessages(['当前队列使用品牌分组，请关闭生成器后把问题加入对应“#品牌名”标题下。'])
    return
  }
  const existing = uniqueQuestions()
  const seen = new Set(existing.map(canonicalQuestion))
  const additions = []
  for (const item of reviewed) {
    const key = canonicalQuestion(item)
    if (seen.has(key)) continue
    seen.add(key)
    additions.push(item)
  }
  questions.value = [...existing, ...additions].join('\n')
  updatePlan()
  generatorDialog.close()
  status.textContent = additions.length
    ? `已审核并加入 ${additions.length} 条问题`
    : '审核问题已全部存在于队列中'
})

// Keep the window from navigating when a file is dropped outside the drop zone.
;['dragover', 'drop'].forEach(type => {
  window.addEventListener(type, event => { event.preventDefault() })
})

questionsPanel.addEventListener('dragenter', event => {
  event.preventDefault()
  if (![...event.dataTransfer.types].includes('Files')) return
  dragDepth += 1
  setDropActive(true)
})
questionsPanel.addEventListener('dragover', event => {
  event.preventDefault()
  if (![...event.dataTransfer.types].includes('Files')) return
  event.dataTransfer.dropEffect = 'copy'
})
questionsPanel.addEventListener('dragleave', event => {
  event.preventDefault()
  dragDepth = Math.max(0, dragDepth - 1)
  if (dragDepth === 0) setDropActive(false)
})
questionsPanel.addEventListener('drop', async event => {
  event.preventDefault()
  event.stopPropagation()
  dragDepth = 0
  setDropActive(false)
  const file = event.dataTransfer.files?.[0]
  if (!file) return
  await importQuestionFile(window.automation.getPathForFile(file))
}, true)
generatorProductDropzone.addEventListener('dragenter', event => {
  event.preventDefault()
  event.stopPropagation()
  if (![...event.dataTransfer.types].includes('Files')) return
  generatorProductDragDepth += 1
  generatorProductDropzone.classList.add('is-drop-active')
})
generatorProductDropzone.addEventListener('dragover', event => {
  event.preventDefault()
  event.stopPropagation()
  if (![...event.dataTransfer.types].includes('Files')) return
  event.dataTransfer.dropEffect = 'copy'
})
generatorProductDropzone.addEventListener('dragleave', event => {
  event.preventDefault()
  event.stopPropagation()
  generatorProductDragDepth = Math.max(0, generatorProductDragDepth - 1)
  if (generatorProductDragDepth === 0) generatorProductDropzone.classList.remove('is-drop-active')
})
generatorProductDropzone.addEventListener('drop', async event => {
  event.preventDefault()
  event.stopPropagation()
  generatorProductDragDepth = 0
  generatorProductDropzone.classList.remove('is-drop-active')
  const file = event.dataTransfer.files?.[0]
  if (!file) return
  await importGeneratorProductFile(window.automation.getPathForFile(file))
}, true)
questions.addEventListener('input', updatePlan)
device.addEventListener('change', () => selectDevice(device.value))
$('#clear-log').addEventListener('click', () => {
  if (selectedSerial) { sessionFor(selectedSerial).logs = []; sessionFor(selectedSerial).routineCount = 0 }
  clearLog()
})
$('#preview-enabled').addEventListener('change', refreshPreviewState)
document.addEventListener('visibilitychange', refreshPreviewState)
$('#copy-log').addEventListener('click', async () => {
  const text = log.textContent
  if (!text) { status.textContent = '日志为空，无内容可复制'; return }
  try {
    await window.automation.copyText(text)
    status.textContent = '日志已复制到剪贴板'
  } catch (error) { status.textContent = error.message || '复制失败' }
})
$('#export-log').addEventListener('click', async () => {
  const text = log.textContent
  if (!text) { status.textContent = '日志为空，无内容可导出'; return }
  try {
    const file = await window.automation.exportLog(text)
    status.textContent = file ? `日志已导出：${file}` : '已取消导出'
  } catch (error) { status.textContent = error.message || '导出失败' }
})

updateAction.addEventListener('click', async () => {
  if (!updateState?.supported) return
  try {
    if (updateState.status === 'available') await window.automation.downloadUpdate()
    else if (updateState.status === 'downloaded') await window.automation.installUpdate()
    else await window.automation.checkForUpdate()
  } catch (error) {
    status.textContent = error.message || '更新操作失败'
  }
})

function devicePayload(serial) {
  const session = sessionFor(serial)
  if (!session.connected) throw new Error(`手机 ${serial} 未连接`)
  const { draft } = session
  const questionPlan = parseQuestionInput(draft.text)
  if (questionPlan.errors.length) throw new Error(`请修正 ${serial} 的题目：${questionPlan.errors[0]}`)
  const timeout = Number(draft.timeout), maxLongImageHeight = Number(draft.maxLongImageHeight)
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('单题超时需大于 0')
  if (!Number.isInteger(maxLongImageHeight) || maxLongImageHeight < 3000 || maxLongImageHeight > 30000) throw new Error('长图上限需为 3000–30000 之间的整数')
  return { serial, questions: questionPlan.questions, brandGroups: questionPlan.brandGroups, entries: draft.entries, outputDir: draft.outputDir.trim(), timeout, maxLongImageHeight, newSession: true }
}

async function launchDevice(serial, retry = null) {
  const session = sessionFor(serial)
  if (session.running || session.importing) return
  let payload
  try {
    payload = devicePayload(serial)
    if (!retry && (!payload.questions.length || !payload.entries.length || !payload.outputDir)) throw new Error('请填写题目、选择入口并设置截图目录')
  } catch (error) { status.textContent = `${serial}：${error.message}`; throw error }
  const previousTaskId = session.taskId
  session.taskId = null
  session.running = true; session.stopping = false; session.message = '正在启动…'
  if (!retry) {
    session.logs = []; session.routineCount = 0; session.progress = initializeEntryProgress(); session.result = null
    if (serial === selectedSerial) { clearLog(); entryProgressState = session.progress; renderEntryProgress() }
  }
  renderDeviceControls(); renderDeviceCards()
  try {
    addDeviceLog(serial, retry ? '\n$ 继续或重试原批次\n' : '$ 启动自动化任务\n')
    const accepted = retry ? await window.automation.retryFailed({ ...payload, ...retry }) : await window.automation.start(payload)
    if (accepted === false) { session.running = false; session.stopping = false; session.taskId = previousTaskId; session.message = '已取消继续批次'; return }
    session.taskId ||= accepted.taskId
    if (session.stopping && session.running) { session.stopping = false; await stopDevice(serial) }
    else if (session.running) session.message = '任务正在执行…'
  } catch (error) {
    session.running = false; session.stopping = false; session.taskId = previousTaskId; session.message = error.message || '无法启动任务'
    addDeviceLog(serial, `错误：${session.message}\n`)
  } finally {
    if (selectedSerial === serial) status.textContent = session.message
    renderDeviceControls(); renderDeviceCards()
  }
}

start.addEventListener('click', () => { saveDraft(); void launchDevice(selectedSerial).catch(() => {}) })
$('#start-all').addEventListener('click', async () => {
  saveDraft()
  const serials = [...sessions].filter(([, session]) => session.connected && !session.running && !session.importing && session.draft.text.trim()).map(([serial]) => serial)
  await Promise.allSettled(serials.map(serial => launchDevice(serial)))
})
retryFailed.addEventListener('click', () => {
  saveDraft()
  if (retryBatchDirectory) void launchDevice(selectedSerial, { batchDirectory: retryBatchDirectory }).catch(() => {})
})
resumeBatch.addEventListener('click', async () => {
  const serial = selectedSerial
  if (!serial) { status.textContent = '请先选择手机'; return }
  saveDraft()
  try {
    const directory = await window.automation.selectDirectory()
    if (!directory) return
    await launchDevice(serial, { batchDirectory: directory, resume: true })
  } catch (error) { status.textContent = error.message || '无法继续原批次' }
})

async function stopDevice(serial) {
  const session = sessions.get(serial)
  if (!session?.running || session.stopping) return
  session.stopping = true
  session.message = '正在停止手机操作，保存进度并恢复设备设置…'
  if (selectedSerial === serial) status.textContent = session.message
  renderDeviceControls(); renderDeviceCards()
  if (!session.taskId) return // The start IPC will forward this stop as soon as it receives its task id.
  try { await window.automation.stop(serial) }
  catch (error) {
    session.stopping = false; session.message = `停止请求失败：${error.message}，请再次点击停止。`
    addDeviceLog(serial, `错误：${session.message}\n`)
    if (selectedSerial === serial) status.textContent = session.message
  }
  renderDeviceControls(); renderDeviceCards()
}
stop.addEventListener('click', () => stopDevice(selectedSerial))
$('#stop-all').addEventListener('click', () => Promise.allSettled([...sessions.keys()].map(stopDevice)))
window.automation.onLog(value => {
  if (acceptEvent(sessionFor(value.serial), value)) addDeviceLog(value.serial, value.text)
})
window.automation.onProgress(value => {
  const session = sessionFor(value.serial)
  if (!acceptEvent(session, value)) return
  if (value.type === 'stopping') { session.stopping = true; session.message = '正在停止手机操作，保存进度并恢复设备设置…' }
  session.progress = applyEntryProgress(session.progress || initializeEntryProgress(), value)
  if (selectedSerial === value.serial) { entryProgressState = session.progress; renderEntryProgress(); status.textContent = session.message }
  renderDeviceControls(); renderDeviceCards()
})
window.automation.onFinished(result => {
  const { code, summary, error, retried, serial } = result
  const session = sessionFor(serial)
  if (!acceptEvent(session, result)) return
  session.running = false; session.stopping = false; session.result = result
  if (summary?.entries && summary?.results) {
    session.progress = initializeEntryProgress({ entries: summary.entries, question_count: summary.question_count, results: summary.results })
  }
  if (code === 130) session.message = `任务已停止，已完成 ${summary?.completed || 0} 题；可用“继续原批次”恢复。`
  else if (summary?.needs_confirmation) session.message = `本轮结束，${summary.needs_confirmation} 题操作状态待确认；可用“继续原批次”处理。`
  else if (code !== 0 && error) session.message = `${error.title}：${error.message} ${error.action}`
  else if (code !== 0) session.message = `${retried ? '重试' : '任务'}结束，退出码 ${code}`
  else if (summary?.failed) session.message = `执行完成：成功 ${summary.completed}，失败 ${summary.failed}；可点击“重试失败项”`
  else session.message = `执行完成：成功 ${summary?.completed ?? 0}`
  if (selectedSerial === serial) { entryProgressState = session.progress || initializeEntryProgress(); renderEntryProgress(); status.textContent = session.message }
  renderDeviceControls(); renderDeviceCards()
})
window.automation.onUpdateState(renderUpdateState)

window.automation.getUpdateState().then(renderUpdateState)
async function initializeWorkspace() {
  defaultOutputDir = await window.automation.defaultOutputDirectory()
  await refreshEntries()
  for (const task of await window.automation.listTasks()) {
    const session = sessionFor(task.serial)
    session.taskId = task.taskId; session.running = true; session.stopping = task.status === 'stopping'; session.message = '任务正在执行…'
    if (task.progress) session.progress = task.progress
  }
  await refreshDevices()
}
void initializeWorkspace().catch(error => { status.textContent = error.message })
renderEntryProgress()
