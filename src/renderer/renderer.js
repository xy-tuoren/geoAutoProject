const $ = selector => document.querySelector(selector)
const questions = $('#questions')
const device = $('#device')
const status = $('#status')
const log = $('#log')
const start = $('#start')
const stop = $('#stop')

function uniqueQuestions() {
  return [...new Set(questions.value.split('\n').map(line => line.trim()).filter(Boolean))]
}

function updatePlan() {
  const deviceCount = device.value ? 1 : 0
  const questionCount = uniqueQuestions().length
  $('#plan').textContent = `${deviceCount} 台设备 × ${questionCount} 条问题 = ${deviceCount * questionCount} 次计划`
  $('#question-count').textContent = `${questionCount} 条问题`
}

function appendLog(text) {
  log.textContent += text
  log.scrollTop = log.scrollHeight
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

$('#refresh-devices').addEventListener('click', refreshDevices)
$('#select-directory').addEventListener('click', async () => {
  const directory = await window.automation.selectDirectory()
  if (directory) $('#output-dir').value = directory
})
$('#import-questions').addEventListener('click', async () => {
  const file = await window.automation.selectQuestions()
  if (!file) return
  try {
    const imported = await window.automation.importQuestions({ file, column: $('#column-name').value })
    questions.value = [...uniqueQuestions(), ...imported].filter((item, index, list) => list.indexOf(item) === index).join('\n')
    updatePlan()
    status.textContent = `已导入 ${imported.length} 条问题`
  } catch (error) { status.textContent = error.message || '导入失败' }
})
questions.addEventListener('input', updatePlan)
device.addEventListener('change', updatePlan)
$('#clear-log').addEventListener('click', () => { log.textContent = '' })

start.addEventListener('click', async () => {
  const timeout = Number($('#timeout').value)
  if (!Number.isFinite(timeout) || timeout <= 0) { status.textContent = '请输入大于 0 的超时时间'; return }
  try {
    await window.automation.start({ questions: uniqueQuestions(), serial: device.value, outputDir: $('#output-dir').value.trim(), timeout, newSession: $('#new-session').checked })
    start.disabled = true; stop.disabled = false; status.textContent = '任务正在执行…'; appendLog('\n$ 启动自动化任务\n')
  } catch (error) { status.textContent = error.message || '无法启动任务' }
})
stop.addEventListener('click', () => window.automation.stop())
window.automation.onLog(appendLog)
window.automation.onFinished(({ code }) => { start.disabled = false; stop.disabled = true; status.textContent = code === 0 ? '执行完成' : `任务结束，退出码 ${code}` })

window.automation.defaultOutputDirectory().then(directory => { $('#output-dir').value = directory })
refreshDevices()
