const fs = require('node:fs/promises')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { writeJsonAtomic } = require('./batch-state')

// Run only after the attempt's evidence queue has finished writing.
async function compactRecognitionFrames(directory) {
  let names
  try { names = await fs.readdir(directory) }
  catch (error) { if (error.code === 'ENOENT') return { removed_files: 0, saved_bytes: 0 }; throw error }
  const canonical = new Map()
  const rewrites = []
  const duplicates = new Map()
  // Validate every reference before changing anything. A damaged archive stays intact.
  for (const name of names.filter(name => name.endsWith('.json')).sort()) {
    const file = path.join(directory, name)
    const detail = JSON.parse(await fs.readFile(file, 'utf8'))
    if (!detail.frame_file) continue
    if (path.basename(detail.frame_file) !== detail.frame_file || !detail.frame_file.endsWith('.png')) throw new Error(`识别原图路径不合法：${name}`)
    const frame = await fs.readFile(path.join(directory, detail.frame_file))
    const hash = createHash('sha256').update(frame).digest('hex')
    if (hash !== detail.frame_sha256) throw new Error(`识别原图校验失败，保留原文件：${name}`)
    const existing = canonical.get(hash)
    if (!existing) canonical.set(hash, { name: detail.frame_file, frame })
    else if (existing.name !== detail.frame_file) {
      if (!existing.frame.equals(frame)) throw new Error(`识别原图字节不一致：${name}`)
      duplicates.set(detail.frame_file, frame.length)
      rewrites.push({ file, detail: { ...detail, frame_file: existing.name } })
    }
  }
  // Commit all local references first. Interruption can leave extra files, never missing evidence.
  for (const { file, detail } of rewrites) await writeJsonAtomic(file, detail)
  for (const name of duplicates.keys()) await fs.unlink(path.join(directory, name))
  return { removed_files: duplicates.size, saved_bytes: [...duplicates.values()].reduce((sum, size) => sum + size, 0) }
}

module.exports = { compactRecognitionFrames }
