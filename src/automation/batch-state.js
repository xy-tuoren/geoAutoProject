const fs = require('node:fs/promises')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2), 'utf8')
    await fs.rename(temporary, file)
  } finally { await fs.unlink(temporary).catch(() => {}) }
}

function questionKey(item) { return `${item.brand_index || 0}:${item.entry_id}:${item.question_index}` }
function updateResult(results, result) {
  const index = results.findIndex(item => questionKey(item) === questionKey(result))
  if (index < 0) results.push(result)
  else results[index] = { ...results[index], ...result }
}
function refreshSummary(summary, status = summary.status) {
  const results = summary.results || []
  const count = state => results.filter(item => item.status === state).length
  Object.assign(summary, {
    updated_at: new Date().toISOString(), status,
    completed: count('completed'), failed: count('failed'), pending: count('pending'),
    needs_confirmation: count('needs_confirmation'), running: count('running'),
    search_results_only: results.filter(item => item.status === 'completed' && item.search_result_only).length,
    app_limited: results.filter(item => item.status === 'completed' && item.content_type === 'app_limited').length,
    needs_visual_review: results.filter(item => item.status === 'completed' && item.quality_status === 'needs_review').length,
    failures: results.filter(item => item.status === 'failed').map(item => ({ ...item })),
  })
  return summary
}
function interruptRunning(summary) {
  for (const result of summary.results || []) {
    if (result.status === 'running') {
      result.status = result.submission_started === false ? 'pending' : 'needs_confirmation'
      result.result_label = result.status === 'pending' ? '已中断：尚未提交，可继续' : '已中断：操作结果待确认'
    }
  }
  return refreshSummary(summary)
}
function resumeItems(summary, { includeUncertain = false, resume = false } = {}) {
  return summary.results.map((item, resultIndex) => ({ ...item, resultIndex }))
    .filter(item => item.status === 'failed' || (resume && item.status === 'pending')
      || (resume && includeUncertain && item.status === 'needs_confirmation'))
}

async function createQuestionAttempt(artifacts) {
  const root = artifacts.diagnosticDirectory
  await fs.mkdir(root, { recursive: true })
  for (let attempt = 1; ; attempt++) {
    const directory = path.join(root, `尝试_${String(attempt).padStart(3, '0')}`)
    try { await fs.mkdir(directory) } catch (error) { if (error.code === 'EEXIST') continue; throw error }
    return {
      ...artifacts, questionDiagnosticDirectory: root, diagnosticDirectory: directory,
      finalDeliveryDirectory: artifacts.deliveryDirectory,
      deliveryDirectory: path.join(directory, '待交付'),
      attempt_id: randomUUID(), attempt_number: attempt,
    }
  }
}

function remapPaths(value, from, to) {
  if (typeof value === 'string') return value === from || value.startsWith(from + path.sep) ? to + value.slice(from.length) : value
  if (Array.isArray(value)) return value.map(item => remapPaths(item, from, to))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remapPaths(item, from, to)]))
  return value
}
async function publishQuestion(artifacts, result) {
  const target = artifacts.finalDeliveryDirectory
  // All PNGs are ready before exposing the question's delivery directory.
  // Legacy failed batches may have partial PNGs: preserve them as evidence.
  await fs.mkdir(path.dirname(target), { recursive: true })
  try { await fs.rename(target, path.join(artifacts.diagnosticDirectory, '旧交付现场')) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  const metadata = JSON.parse(await fs.readFile(result.metadata, 'utf8'))
  await writeJsonAtomic(result.metadata, remapPaths(metadata, artifacts.deliveryDirectory, target))
  await fs.rename(artifacts.deliveryDirectory, target)
  return remapPaths(result, artifacts.deliveryDirectory, target)
}

module.exports = { writeJsonAtomic, questionKey, updateResult, refreshSummary, interruptRunning, resumeItems, createQuestionAttempt, publishQuestion }
