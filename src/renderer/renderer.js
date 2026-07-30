const $ = selector => document.querySelector(selector)
const questions = $('#questions')
const device = $('#device')
const status = $('#status')
const log = $('#log')
const start = $('#start')
const retryFailed = $('#retry-failed')
const stop = $('#stop')
const entryList = $('#entry-list')
const updateAction = $('#update-action')
const { retryableBatchDirectory } = window.retryState
const { initializeEntryProgress, applyEntryProgress } = window.entryProgress
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
  totalLabel.textContent = `成功 ${succeeded} · 失败 ${failed}`
  const rows = entryProgressState.entries.map(entry => {
    const row = document.createElement('article')
    row.className = 'entry-progress-item'
    const label = document.createElement('strong')
    label.textContent = entry.label
    const stats = document.createElement('div')
    stats.className = 'entry-progress-stats'
    stats.innerHTML = `<span class="success">成功 ${entry.succeeded}</span><span class="failure">失败 ${entry.failed}</span>`
    row.append(label, stats)
    return row
  })
  container.replaceChildren(...rows)
}

function updateRetryFailedAvailability(result = {}) {
  retryBatchDirectory = retryableBatchDirectory(result)
  retryFailed.disabled = !retryBatchDirectory
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

function uniqueQuestions() {
  return [...new Set(questions.value.split('\n').map(line => line.trim()).filter(Boolean))]
}

function selectedEntries() {
  return [...entryList.querySelectorAll('input[name="entry"]:checked')].map(input => input.value)
}

function updatePlan() {
  const deviceCount = device.value ? 1 : 0
  const entryCount = selectedEntries().length
  const questionCount = uniqueQuestions().length
  $('#plan').textContent = `${deviceCount} 台设备 × ${entryCount} 个入口 × ${questionCount} 条问题 = ${deviceCount * entryCount * questionCount} 次计划`
  $('#question-count').textContent = `${questionCount} 条问题`
}

function appendLog(text) {
  log.textContent += text
  log.scrollTop = log.scrollHeight
}

function clearLog() {
  log.textContent = ''
}

async function refreshDevices() {
  status.textContent = '正在读取 ADB 设备…'
  try {
    const devices = await window.automation.listDevices()
    device.replaceChildren()
    if (!devices.length) device.add(new Option('未发现已授权设备', ''))
    devices.forEach(serial => device.add(new Option(serial, serial)))
    status.textContent = devices.length ? `已发现 ${devices.length} 台已授权设备` : '未发现已授权设备'
  } catch (error) {
    device.replaceChildren(new Option('读取设备失败', ''))
    status.textContent = error.message || '读取 ADB 设备失败'
  }
  updatePlan()
}

async function refreshEntries() {
  try {
    const entries = await window.automation.listEntries()
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

async function importQuestionFile(filePath) {
  if (!filePath) return
  if (!QUESTION_EXTENSIONS.has(extensionOf(filePath))) {
    status.textContent = '仅支持 TXT、CSV、JSON、XLSX、XLSM 问题文件'
    return
  }
  try {
    const imported = await window.automation.importQuestions({ file: filePath, column: $('#column-name').value })
    questions.value = [...uniqueQuestions(), ...imported].filter((item, index, list) => list.indexOf(item) === index).join('\n')
    updatePlan()
    status.textContent = `已导入 ${imported.length} 条问题`
  } catch (error) { status.textContent = error.message || '导入失败' }
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
$('#select-directory').addEventListener('click', async () => {
  const directory = await window.automation.selectDirectory()
  if (directory) $('#output-dir').value = directory
})
$('#import-questions').addEventListener('click', async () => {
  const file = await window.automation.selectQuestions()
  await importQuestionFile(file)
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
device.addEventListener('change', updatePlan)
$('#clear-log').addEventListener('click', clearLog)
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

start.addEventListener('click', async () => {
  clearLog()
  const timeout = Number($('#timeout').value)
  if (!Number.isFinite(timeout) || timeout <= 0) { status.textContent = '请输入大于 0 的超时时间'; return }
  const maxLongImageHeight = Number($('#max-long-image-height').value)
  if (!Number.isInteger(maxLongImageHeight) || maxLongImageHeight < 3000 || maxLongImageHeight > 30000) { status.textContent = '长图上限请输入 3000–30000 之间的整数'; return }
  const entries = selectedEntries()
  if (!entries.length) { status.textContent = '请至少选择一个入口'; return }
  try {
    appendLog('$ 启动自动化任务\n')
    await window.automation.start({
      questions: uniqueQuestions(),
      entries,
      serial: device.value,
      outputDir: $('#output-dir').value.trim(),
      timeout,
      newSession: true,
      maxLongImageHeight,
    })
    updateRetryFailedAvailability()
    start.disabled = true; stop.disabled = false; status.textContent = '任务正在执行…'
  } catch (error) { status.textContent = error.message || '无法启动任务' }
})
retryFailed.addEventListener('click', async () => {
  if (!retryBatchDirectory) { status.textContent = '当前没有可重试的失败批次'; return }
  const timeout = Number($('#timeout').value)
  const maxLongImageHeight = Number($('#max-long-image-height').value)
  if (!Number.isFinite(timeout) || timeout <= 0 || !Number.isInteger(maxLongImageHeight) || maxLongImageHeight < 3000 || maxLongImageHeight > 30000) {
    status.textContent = '请先检查单题超时和长图上限设置'
    return
  }
  try {
    await window.automation.retryFailed({
      serial: device.value,
      batchDirectory: retryBatchDirectory,
      timeout,
      newSession: true,
      maxLongImageHeight,
    })
    start.disabled = true; retryFailed.disabled = true; stop.disabled = false
    status.textContent = '正在重试失败项…'; appendLog(`\n$ 重试原批次失败项：${retryBatchDirectory}\n`)
  } catch (error) { status.textContent = error.message || '无法重试失败项' }
})
stop.addEventListener('click', () => window.automation.stop())
window.automation.onLog(appendLog)
window.automation.onProgress(value => {
  entryProgressState = applyEntryProgress(entryProgressState, value)
  renderEntryProgress()
})
window.automation.onFinished(({ code, summary, retried }) => {
  start.disabled = false
  stop.disabled = true
  updateRetryFailedAvailability({ code, summary })
  if (summary?.entries && summary?.results) {
    entryProgressState = initializeEntryProgress({ entries: summary.entries, question_count: summary.question_count, results: summary.results })
    renderEntryProgress()
  }
  if (code !== 0) status.textContent = `${retried ? '重试' : '任务'}结束，退出码 ${code}`
  else if (summary?.failed) status.textContent = `${retried ? '重试完成' : '执行完成'}：成功 ${summary.completed}，失败 ${summary.failed}；可点击“重试失败项”`
  else status.textContent = `${retried ? '失败项已全部重试成功' : '执行完成'}：成功 ${summary?.completed ?? 0}`
})
window.automation.onUpdateState(renderUpdateState)

window.automation.defaultOutputDirectory().then(directory => { $('#output-dir').value = directory })
window.automation.getUpdateState().then(renderUpdateState)
refreshEntries()
refreshDevices()
renderEntryProgress()
