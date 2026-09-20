const fs = require('node:fs/promises')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { replayRecognition } = require('../src/automation/recognition-replay')

async function main() {
  if (!process.argv[2]) throw new Error('用法：node scripts/replay-recognition.js <关键识别/证据.json>（离线，不连接手机）')
  const file = path.resolve(process.argv[2])
  const evidence = JSON.parse(await fs.readFile(file, 'utf8'))
  if (evidence.frame_file && evidence.frame_sha256) {
    const frame = await fs.readFile(path.join(path.dirname(file), path.basename(evidence.frame_file)))
    if (createHash('sha256').update(frame).digest('hex') !== evidence.frame_sha256) throw new Error('原图校验失败，图片与识别证据不对应。')
  }
  console.log(JSON.stringify(replayRecognition(evidence), null, 2))
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
