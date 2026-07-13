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

function questionArtifactDirectory(batchDirectory, index, question) {
  return path.join(batchDirectory, `${String(index).padStart(3, '0')}_${safeSlug(question)}`)
}

module.exports = { sleep, safeSlug, createBatchDirectory, questionArtifactDirectory }
