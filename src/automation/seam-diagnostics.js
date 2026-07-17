const fs = require('node:fs/promises')
const path = require('node:path')

const REPLY_SEAM_DIAGNOSTIC_VERSION = 2

function jsonError(error) {
  if (!error) return null
  return {
    name: error.name || 'Error',
    message: error.message || String(error),
    candidate_overlaps: Array.isArray(error.candidateOverlaps) ? error.candidateOverlaps : [],
    suggested_overlap: Number.isFinite(error.suggestedOverlap) ? error.suggestedOverlap : null,
  }
}

async function writeSnapshot(directory, label, snapshot) {
  if (!snapshot) return null
  const result = {
    stable: snapshot.stable ?? null,
    attempts: snapshot.attempts ?? null,
    observer: snapshot.observer ?? null,
    reason: snapshot.reason || null,
    frame: null,
    hierarchy: null,
  }
  if (Buffer.isBuffer(snapshot.frame)) {
    result.frame = path.join(directory, `${label}.png`)
    await fs.writeFile(result.frame, snapshot.frame)
  }
  if (snapshot.xml !== undefined && snapshot.xml !== null) {
    result.hierarchy = path.join(directory, `${label}.xml`)
    await fs.writeFile(result.hierarchy, String(snapshot.xml), 'utf8')
  }
  return result
}

async function writeReplySeamDiagnostics(diagnosticDirectory, capture, now = () => new Date()) {
  const summaryPath = path.join(diagnosticDirectory, '接缝汇总.json')
  const seamRoot = path.join(diagnosticDirectory, '接缝诊断')
  const diagnostics = Array.isArray(capture.seamDiagnostics) ? capture.seamDiagnostics : []
  const seamDiagnosticDirectories = []
  await fs.mkdir(diagnosticDirectory, { recursive: true })

  for (const diagnostic of diagnostics) {
    const seamNumber = Number.isInteger(diagnostic.index) ? diagnostic.index : seamDiagnosticDirectories.length + 1
    const directory = path.join(seamRoot, `接缝_${String(seamNumber).padStart(3, '0')}`)
    await fs.mkdir(directory, { recursive: true })
    const snapshots = {
      previous: await writeSnapshot(directory, '上一帧', diagnostic.previous),
      after_scroll: await writeSnapshot(directory, '滚动后', diagnostic.afterScroll),
      recapture: await writeSnapshot(directory, '重采', diagnostic.recapture),
    }
    const detailsPath = path.join(directory, '详情.json')
    await fs.writeFile(detailsPath, JSON.stringify({
      reply_seam_diagnostic_version: REPLY_SEAM_DIAGNOSTIC_VERSION,
      created_at: diagnostic.createdAt || now().toISOString(),
      index: seamNumber,
      from_page: diagnostic.fromPage ?? null,
      to_page: diagnostic.toPage ?? null,
      bounds: capture.bounds || null,
      scroll: diagnostic.scroll || null,
      initial_measurement: diagnostic.initialMeasurement || null,
      retry_measurement: diagnostic.retryMeasurement || null,
      first_error: jsonError(diagnostic.firstError),
      retry_error: jsonError(diagnostic.retryError),
      transition: diagnostic.transition || null,
      new_content_evidence: diagnostic.newContentEvidence || null,
      snapshots,
    }, null, 2), 'utf8')
    seamDiagnosticDirectories.push({ index: seamNumber, directory, details: detailsPath, snapshots })
  }

  const frameCount = Array.isArray(capture.frames) ? capture.frames.length : 0
  const transitions = Array.isArray(capture.transitions) ? capture.transitions : []
  const expectedTransitionCount = Math.max(0, frameCount - 1)
  const summary = {
    reply_seam_diagnostic_version: REPLY_SEAM_DIAGNOSTIC_VERSION,
    created_at: now().toISOString(),
    frame_count: frameCount,
    expected_transition_count: expectedTransitionCount,
    transition_count: transitions.length,
    frame_transition_invariant_valid: transitions.length === expectedTransitionCount,
    verified_transition_count: transitions.filter(item => item?.verified).length,
    fallback_transition_count: transitions.filter(item => item && !item.verified).length,
    bounds: capture.bounds || null,
    recapture_count: capture.recaptureCount || 0,
    fallback_reasons: capture.fallbackReasons || [],
    seams: capture.seamRecords || [],
    scroll_decisions: capture.scrollDecisions || [],
    diagnostic_directories: seamDiagnosticDirectories,
  }
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf8')
  return { summary: summaryPath, diagnostics: seamDiagnosticDirectories, details: summary }
}

module.exports = {
  REPLY_SEAM_DIAGNOSTIC_VERSION,
  jsonError,
  writeReplySeamDiagnostics,
}
