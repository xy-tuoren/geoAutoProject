#!/usr/bin/env node

const { createRunner } = require('./automation/runner')
const { bundledAdbPath, projectRoot, vendorAppiumHome } = require('./runtime-paths')

function usage() {
  console.log('用法：npm run run:android -- --serial <设备序列号> --output-dir <目录> [--timeout <秒>] [--max-long-image-height <像素>] [--new-session] [--resume] <问题>')
}

function parseArguments(argv) {
  const options = { questions: [], timeout: 90, newSession: false }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--serial') options.serial = argv[++index]
    else if (value === '--output-dir') options.outputDir = argv[++index]
    else if (value === '--timeout') options.timeout = Number(argv[++index])
    else if (value === '--max-long-image-height') options.maxLongImageHeight = Number(argv[++index])
    else if (value === '--new-session') options.newSession = true
    else if (value === '--resume') options.resume = true
    else if (value === '--help' || value === '-h') options.help = true
    else options.questions.push(value)
  }
  return options
}

async function main() {
  const payload = parseArguments(process.argv.slice(2))
  if (payload.help || !payload.serial || !payload.outputDir || !payload.questions.length || !Number.isFinite(payload.timeout) || payload.timeout <= 0) {
    usage()
    process.exitCode = payload.help ? 0 : 2
    return
  }
  const root = projectRoot()
  const adb = bundledAdbPath({ root })
  const runner = createRunner({
    root,
    appiumHome: vendorAppiumHome(root),
    adbPath: adb,
    log: text => process.stdout.write(text),
  })
  await runner.run(payload)
}

main().catch(error => {
  console.error(error.stack || error.message)
  process.exitCode = 1
})
