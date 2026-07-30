const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const files = [
  'src/main/index.js',
  'src/main/preload.js',
  'src/main/updater.js',
  'src/renderer/retry-state.js',
  'src/renderer/entry-progress.js',
  'src/renderer/question-generator.js',
  'src/renderer/renderer.js',
  'src/product-question-import.js',
  'src/questions.js',
  'src/runtime-paths.js',
  'src/cli.js',
]

for (const directory of ['src/automation', 'scripts']) {
  for (const entry of fs.readdirSync(path.join(root, directory))) {
    if (entry.endsWith('.js') && entry !== 'check-syntax.js') files.push(path.join(directory, entry))
  }
}

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], {
    cwd: root,
    stdio: 'inherit',
  })
  if (result.status !== 0) process.exit(result.status || 1)
}
