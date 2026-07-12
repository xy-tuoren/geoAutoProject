const fs = require('node:fs/promises')
const fsSync = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const AdmZip = require('adm-zip')
const { adbExecutableName } = require('../src/runtime-paths')

const root = path.resolve(__dirname, '..')
const downloadUrls = {
  darwin: 'https://dl.google.com/android/repository/platform-tools-latest-darwin.zip',
  win32: 'https://dl.google.com/android/repository/platform-tools-latest-windows.zip',
  linux: 'https://dl.google.com/android/repository/platform-tools-latest-linux.zip',
}

async function download(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`下载 Android Platform Tools 失败：${response.status} ${response.statusText}`)
  return Buffer.from(await response.arrayBuffer())
}

async function main() {
  const executable = adbExecutableName()
  const destination = path.join(root, 'vendor', 'platform-tools')
  if (fsSync.existsSync(path.join(destination, executable))) {
    process.stdout.write(`已找到内置 ADB：${destination}\n`)
    return
  }
  const url = downloadUrls[process.platform]
  if (!url) throw new Error(`不支持的平台：${process.platform}`)
  process.stdout.write('正在下载 Android Platform Tools…\n')
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'platform-tools-'))
  try {
    const archive = path.join(temp, 'platform-tools.zip')
    await fs.writeFile(archive, await download(url))
    new AdmZip(archive).extractAllTo(temp, true)
    await fs.mkdir(path.dirname(destination), { recursive: true })
    await fs.rm(destination, { recursive: true, force: true })
    await fs.rename(path.join(temp, 'platform-tools'), destination)
    if (process.platform !== 'win32') await fs.chmod(path.join(destination, 'adb'), 0o755)
    process.stdout.write(`已准备内置 ADB：${destination}\n`)
  } finally {
    await fs.rm(temp, { recursive: true, force: true })
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1 })
