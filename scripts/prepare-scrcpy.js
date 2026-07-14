const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')

const VERSION = '4.1'
const SERVER_SHA256 = 'deacb991ed2509715160ffdc7907e47b4160eb30d1566217e9047fd5b8850cae'
const root = path.resolve(__dirname, '..')
const destination = path.join(root, 'vendor', 'scrcpy')
const serverPath = path.join(destination, `scrcpy-server-v${VERSION}`)
const licensePath = path.join(destination, 'LICENSE')

async function fetchBuffer(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`)
  return Buffer.from(await response.arrayBuffer())
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

async function validExistingServer() {
  try {
    return sha256(await fs.readFile(serverPath)) === SERVER_SHA256
  } catch {
    return false
  }
}

async function main() {
  await fs.mkdir(destination, { recursive: true })
  if (!(await validExistingServer())) {
    process.stdout.write(`正在下载 scrcpy server v${VERSION}…\n`)
    const server = await fetchBuffer(`https://github.com/Genymobile/scrcpy/releases/download/v${VERSION}/scrcpy-server-v${VERSION}`)
    const digest = sha256(server)
    if (digest !== SERVER_SHA256) throw new Error(`scrcpy server SHA-256 校验失败：${digest}`)
    await fs.writeFile(serverPath, server)
  }
  try {
    await fs.access(licensePath)
  } catch {
    await fs.writeFile(licensePath, await fetchBuffer(`https://raw.githubusercontent.com/Genymobile/scrcpy/v${VERSION}/LICENSE`))
  }
  await fs.writeFile(path.join(destination, 'version.json'), `${JSON.stringify({ version: VERSION, server_sha256: SERVER_SHA256 }, null, 2)}\n`, 'utf8')
  process.stdout.write(`已准备 scrcpy server v${VERSION}：${serverPath}\n`)
}

main().catch(error => {
  console.error(error.stack || error.message)
  process.exitCode = 1
})
