const fs = require('node:fs/promises')
const path = require('node:path')

const projectRoot = path.resolve(__dirname, '..')
const generatedPaths = [
  'build',
  'dist',
  '.pytest_cache',
  'python/build',
  'python/dist',
  'python/.pytest_cache',
  'image',
]
const traversalSkips = new Set(['.git', 'node_modules', 'vendor'])
const cacheNames = new Set(['.DS_Store', '__pycache__'])

if (process.argv.includes('--include-captures')) generatedPaths.push('captures', 'test_captures')

async function removeGeneratedPath(relativePath) {
  const target = path.resolve(projectRoot, relativePath)
  if (!target.startsWith(`${projectRoot}${path.sep}`)) throw new Error(`拒绝清理项目外路径：${target}`)
  await fs.rm(target, { recursive: true, force: true })
  return relativePath
}

async function removeNestedCaches(directory = projectRoot) {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  await Promise.all(entries.map(async entry => {
    if (traversalSkips.has(entry.name)) return
    const target = path.join(directory, entry.name)
    if (cacheNames.has(entry.name)) {
      await fs.rm(target, { recursive: true, force: true })
      return
    }
    if (entry.isDirectory()) await removeNestedCaches(target)
  }))
}

async function main() {
  const removed = await Promise.all(generatedPaths.map(removeGeneratedPath))
  await removeNestedCaches()
  console.log(`已清理可再生产物：${removed.join(', ')}`)
  if (!process.argv.includes('--include-captures')) {
    console.log('已保留 captures/；如需同时清理本地截图与诊断产物，请运行 npm run clean:all。')
  }
}

main().catch(error => {
  console.error(error.message)
  process.exitCode = 1
})
