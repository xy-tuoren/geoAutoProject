const fs = require('node:fs/promises')
const path = require('node:path')

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

function safeSlug(text, limit = 32) {
  return String(text).trim().replace(/\s+/g, '_').replace(/[\\/:*?"<>|]+/g, '_').slice(0, limit) || 'question'
}

async function createBatchDirectory(outputRoot, now = new Date()) {
  await fs.mkdir(outputRoot, { recursive: true })
  const stamp = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('')
    + '-' + [String(now.getHours()).padStart(2, '0'), String(now.getMinutes()).padStart(2, '0'), String(now.getSeconds()).padStart(2, '0')].join('')
  const base = `batch_${stamp}`
  for (let suffix = 1; ; suffix += 1) {
    const name = suffix === 1 ? base : `${base}_${String(suffix).padStart(2, '0')}`
    const candidate = path.join(outputRoot, name)
    try {
      await fs.mkdir(candidate)
      return candidate
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
  }
}

async function findResumableBatch(outputRoot, questions) {
  let entries
  try { entries = await fs.readdir(outputRoot, { withFileTypes: true }) } catch { return null }
  const candidates = entries.filter(entry => entry.isDirectory() && entry.name.startsWith('batch_')).map(entry => path.join(outputRoot, entry.name)).sort().reverse()
  for (const batchDirectory of candidates) {
    const completed = []
    for (const [index, question] of questions.entries()) {
      const metadata = path.join(questionArtifactDirectory(batchDirectory, index + 1, question), '回答.json')
      try {
        const artifact = JSON.parse(await fs.readFile(metadata, 'utf8'))
        const modes = new Set(['verified_overlap_long_image', 'shared_text_seam_long_image', 'separated_viewports_long_image'])
        const validMode = modes.has(artifact.reply_capture_mode)
        const validContinuity = artifact.reply_capture_mode === 'verified_overlap_long_image'
          ? artifact.reply_continuity_verified === true
          : artifact.reply_capture_mode === 'shared_text_seam_long_image'
            ? artifact.reply_text_seams_verified === true
            : artifact.reply_capture_mode === 'separated_viewports_long_image'
        const screenshots = Array.isArray(artifact.screenshot_parts) ? artifact.screenshot_parts : []
        if (artifact.status !== 'stable' || !validMode || !validContinuity || !screenshots.length) continue
        await Promise.all(screenshots.map(file => fs.access(file)))
        completed.push(index)
      } catch {}
    }
    if (completed.length > 0 && completed.length < questions.length) return { batchDirectory, completed }
  }
  return null
}

function questionArtifactDirectory(batchDirectory, index, question) {
  return path.join(batchDirectory, `${String(index).padStart(3, '0')}_${safeSlug(question)}`)
}

module.exports = { sleep, safeSlug, createBatchDirectory, findResumableBatch, questionArtifactDirectory }
