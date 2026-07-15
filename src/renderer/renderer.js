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
let updateState = null
let retryBatchDirectory = null

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
const questionsPanel = $('#questions-panel')
let dragDepth = 0

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
      newSession: $('#new-session').checked,
      maxLongImageHeight,
    })
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
      newSession: $('#new-session').checked,
      maxLongImageHeight,
    })
    start.disabled = true; retryFailed.disabled = true; stop.disabled = false
    status.textContent = '正在重试失败项…'; appendLog(`\n$ 重试原批次失败项：${retryBatchDirectory}\n`)
  } catch (error) { status.textContent = error.message || '无法重试失败项' }
})
stop.addEventListener('click', () => window.automation.stop())
window.automation.onLog(appendLog)
window.automation.onFinished(({ code, summary, retried }) => {
  start.disabled = false
  stop.disabled = true
  retryBatchDirectory = summary?.failed ? summary.batch_directory : null
  retryFailed.disabled = !retryBatchDirectory
  if (code !== 0) status.textContent = `${retried ? '重试' : '任务'}结束，退出码 ${code}`
  else if (summary?.failed) status.textContent = `${retried ? '重试完成' : '执行完成'}：成功 ${summary.completed}，失败 ${summary.failed}；可点击“重试失败项”`
  else status.textContent = `${retried ? '失败项已全部重试成功' : '执行完成'}：成功 ${summary?.completed ?? 0}`
})
window.automation.onUpdateState(renderUpdateState)

window.automation.defaultOutputDirectory().then(directory => { $('#output-dir').value = directory })
window.automation.getUpdateState().then(renderUpdateState)
refreshEntries()
refreshDevices()
