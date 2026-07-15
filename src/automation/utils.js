const fs = require('node:fs/promises')
const path = require('node:path')

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

const DELIVERY_DIRECTORY_NAME = '交付图片'
const DIAGNOSTIC_DIRECTORY_NAME = '调试产物'

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

function batchArtifactDirectories(batchDirectory) {
  return {
    batchDirectory,
    deliveryDirectory: path.join(batchDirectory, DELIVERY_DIRECTORY_NAME),
    diagnosticDirectory: path.join(batchDirectory, DIAGNOSTIC_DIRECTORY_NAME),
  }
}

function entryArtifactDirectories(batchArtifacts, index, label, entryCount) {
  if (entryCount <= 1) return batchArtifacts
  const name = `${String(index).padStart(2, '0')}_${safeSlug(label, 48)}`
  return {
    ...batchArtifacts,
    deliveryDirectory: path.join(batchArtifacts.deliveryDirectory, name),
    diagnosticDirectory: path.join(batchArtifacts.diagnosticDirectory, name),
  }
}

function questionArtifactDirectories(entryArtifacts, index, question) {
  const name = `${String(index).padStart(3, '0')}_${safeSlug(question)}`
  return {
    ...entryArtifacts,
    deliveryDirectory: path.join(entryArtifacts.deliveryDirectory, name),
    diagnosticDirectory: path.join(entryArtifacts.diagnosticDirectory, name),
  }
}

module.exports = {
  sleep,
  safeSlug,
  createBatchDirectory,
  questionArtifactDirectory,
  batchArtifactDirectories,
  entryArtifactDirectories,
  questionArtifactDirectories,
  DELIVERY_DIRECTORY_NAME,
  DIAGNOSTIC_DIRECTORY_NAME,
}
