#!/usr/bin/env node

const { createRunner, CancelledError } = require('./automation/runner')
const { bundledAdbPath, projectRoot } = require('./runtime-paths')
const { loadQuestionFile } = require('./questions')

let activeRunner = null
let interruptedSignal = null
let stoppingPromise = null

async function stopForSignal(signal) {
  if (interruptedSignal) return stoppingPromise
  interruptedSignal = signal
  process.stderr.write(`\n收到 ${signal}，正在停止任务并恢复设备设置…\n`)
  try {
    if (activeRunner?.restoreDevicePowerOnProcessExit()) {
      process.stderr.write('已恢复任务开始前的屏幕常亮设置。\n')
    }
  } catch (error) {
    process.stderr.write(`立即恢复屏幕常亮设置失败：${error.message}\n`)
  }
  stoppingPromise = activeRunner?.stop() || Promise.resolve()
  await stoppingPromise
}

process.once('SIGINT', () => { void stopForSignal('SIGINT') })
process.once('SIGTERM', () => { void stopForSignal('SIGTERM') })

function usage() {
  console.log('用法：npm run run:android -- --serial <设备序列号> --output-dir <目录> [--entry <入口ID>] [--questions-file <TXT/CSV/JSON/XLSX>] [--timeout <秒>] [--max-long-image-height <像素>] [--new-session] [问题...]')
  console.log('      npm run run:android -- --serial <设备序列号> --output-dir <目录> [--entry <入口ID>] --capture-current-answer [小程序当前问题文字]')
}

function parseArguments(argv) {
  const options = { questions: [], entries: [], timeout: 90, newSession: false }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--serial') options.serial = argv[++index]
    else if (value === '--output-dir') options.outputDir = argv[++index]
    else if (value === '--entry') options.entries.push(argv[++index])
    else if (value === '--questions-file') options.questionsFile = argv[++index]
    else if (value === '--timeout') options.timeout = Number(argv[++index])
    else if (value === '--max-long-image-height') options.maxLongImageHeight = Number(argv[++index])
    else if (value === '--new-session') options.newSession = true
    else if (value === '--capture-current-answer' || value === '--capture-current-reference-products') options.captureCurrentAnswer = true
    else if (value === '--help' || value === '-h') options.help = true
    else options.questions.push(value)
  }
  return options
}

async function main() {
  const payload = parseArguments(process.argv.slice(2))
  if (payload.questionsFile) payload.questions.push(...await loadQuestionFile(payload.questionsFile))
  if (payload.help || !payload.serial || !payload.outputDir || (!payload.captureCurrentAnswer && !payload.questions.length) || !Number.isFinite(payload.timeout) || payload.timeout <= 0) {
    usage()
    process.exitCode = payload.help ? 0 : 2
    return
  }
  const root = projectRoot()
  const adb = bundledAdbPath({ root })
  const runner = createRunner({
    root,
    isPackaged: false,
    adbPath: adb,
    log: text => process.stdout.write(text),
  })
  activeRunner = runner
  try {
    if (interruptedSignal) throw new CancelledError()
    if (payload.captureCurrentAnswer) console.log(JSON.stringify(await runner.captureCurrentAnswer(payload)))
    else await runner.run(payload)
  } finally {
    activeRunner = null
  }
}

main().catch(error => {
  if (!(error instanceof CancelledError) && !interruptedSignal) console.error(error.stack || error.message)
  process.exitCode = error instanceof CancelledError || interruptedSignal ? 130 : 1
})
