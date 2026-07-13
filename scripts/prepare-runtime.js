const fs = require('node:fs/promises')
const fsSync = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const AdmZip = require('adm-zip')
const { adbExecutableName } = require('../src/runtime-paths')

const root = path.resolve(__dirname, '..')
const downloadUrls = {
  darwin: [
    'https://googledownloads.cn/android/repository/platform-tools-latest-darwin.zip',
    'https://dl.google.com/android/repository/platform-tools-latest-darwin.zip',
  ],
  win32: [
    'https://googledownloads.cn/android/repository/platform-tools-latest-windows.zip',
    'https://dl.google.com/android/repository/platform-tools-latest-windows.zip',
  ],
  linux: [
    'https://googledownloads.cn/android/repository/platform-tools-latest-linux.zip',
    'https://dl.google.com/android/repository/platform-tools-latest-linux.zip',
  ],
}

async function download(urls) {
  let lastError
  for (const url of urls) {
    try {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
      process.stdout.write(`已从 ${url} 下载 Android Platform Tools。\n`)
      return Buffer.from(await response.arrayBuffer())
    } catch (error) {
      lastError = error
      process.stderr.write(`下载失败（${url}）：${error.message}\n`)
    }
  }
  throw new Error(`下载 Android Platform Tools 失败：${lastError?.message || '无可用下载源'}`)
}

async function main() {
  for (const platform of ['darwin', 'win32']) await preparePlatformTools(platform)
}

async function preparePlatformTools(platform) {
  const executable = platform === 'win32' ? 'adb.exe' : 'adb'
  const destination = path.join(root, 'vendor', 'platform-tools', platform)
  if (fsSync.existsSync(path.join(destination, executable))) {
    process.stdout.write(`已找到 ${platform} 内置 ADB：${destination}\n`)
    return
  }
  const urls = downloadUrls[platform]
  process.stdout.write(`正在下载 ${platform} Android Platform Tools…\n`)
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), `platform-tools-${platform}-`))
  try {
    const archive = path.join(temp, 'platform-tools.zip')
    await fs.writeFile(archive, await download(urls))
    new AdmZip(archive).extractAllTo(temp, true)
    await fs.mkdir(path.dirname(destination), { recursive: true })
    await fs.rm(destination, { recursive: true, force: true })
    await fs.rename(path.join(temp, 'platform-tools'), destination)
    if (platform !== 'win32') await fs.chmod(path.join(destination, 'adb'), 0o755)
    process.stdout.write(`已准备 ${platform} 内置 ADB：${destination}\n`)
  } finally {
    await fs.rm(temp, { recursive: true, force: true })
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1 })
