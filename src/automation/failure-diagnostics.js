const fs = require('node:fs/promises')
const path = require('node:path')
const { iterNodes, nodeAttr, parseBounds } = require('./hierarchy')
const { imageInfo } = require('./images')

function hierarchyDiagnosticSummary(xml) {
  const packages = new Set()
  let width = 0
  let height = 0
  let nodeCount = 0
  for (const attrs of iterNodes(xml)) {
    nodeCount += 1
    const packageName = nodeAttr(attrs, 'package')
    if (packageName) packages.add(packageName)
    const rawBounds = nodeAttr(attrs, 'bounds')
    if (!rawBounds) continue
    try {
      const bounds = parseBounds(rawBounds)
      width = Math.max(width, bounds[2])
      height = Math.max(height, bounds[3])
    } catch {}
  }
  const rotation = String(xml).match(/\brotation="([^"]+)"/)?.[1] ?? null
  return {
    node_count: nodeCount,
    packages: [...packages].sort(),
    logical_size: width > 0 && height > 0 ? { width, height } : null,
    rotation,
  }
}

function diagnosticError(error) {
  return { name: error?.name || 'Error', message: error?.message || String(error), stack: error?.stack || null }
}

async function captureFailureDiagnostics({
  directory,
  stem = '失败现场',
  serial,
  entry,
  context = {},
  error,
  captureScreenshot,
  dumpHierarchy,
  currentApp,
  foregroundWindow,
  deviceState,
  observerSnapshot,
  ocrDiagnostic = null,
  inspectImage = imageInfo,
  now = () => new Date(),
}) {
  const captureStartedAt = now().toISOString()
  await fs.mkdir(directory, { recursive: true })
  const manifestPath = path.join(directory, `${stem}.json`)
  const screenshotPath = path.join(directory, `${stem}.png`)
  const hierarchyPath = path.join(directory, `${stem}.xml`)
  const ocrPath = path.join(directory, `${stem}_OCR.json`)
  const attempt = async task => {
    try { return { ok: true, value: await task() } } catch (captureError) { return { ok: false, error: diagnosticError(captureError) } }
  }
  const [frameResult, hierarchyResult, appResult, windowResult, deviceResult, observerResult] = await Promise.all([
    attempt(captureScreenshot),
    attempt(dumpHierarchy),
    attempt(currentApp),
    attempt(foregroundWindow),
    attempt(deviceState),
    attempt(async () => observerSnapshot()),
  ])

  let screenshot = { status: 'failed', path: null, error: frameResult.error || null }
  if (frameResult.ok) {
    const writeResult = await attempt(async () => {
      await fs.writeFile(screenshotPath, frameResult.value)
      return inspectImage(frameResult.value)
    })
    screenshot = writeResult.ok
      ? { status: 'captured', path: screenshotPath, coordinate_space: 'adb_screenshot_physical_pixels', ...writeResult.value }
      : { status: 'failed', path: null, error: writeResult.error }
  }

  let hierarchy = { status: 'failed', path: null, error: hierarchyResult.error || null }
  if (hierarchyResult.ok) {
    const writeResult = await attempt(async () => {
      const xml = String(hierarchyResult.value || '')
      await fs.writeFile(hierarchyPath, xml, 'utf8')
      return hierarchyDiagnosticSummary(xml)
    })
    hierarchy = writeResult.ok
      ? { status: 'captured', path: hierarchyPath, coordinate_space: 'uiautomator2_logical_pixels', ...writeResult.value }
      : { status: 'failed', path: null, error: writeResult.error }
  }

  let ocr = { status: 'not_available', path: null }
  if (ocrDiagnostic) {
    const writeResult = await attempt(async () => fs.writeFile(ocrPath, JSON.stringify(ocrDiagnostic, null, 2), 'utf8'))
    ocr = writeResult.ok ? { status: 'captured', path: ocrPath } : { status: 'failed', path: null, error: writeResult.error }
  }
  const manifest = {
    created_at: captureStartedAt,
    capture_finished_at: now().toISOString(),
    failure_diagnostic_version: 1,
    serial,
    entry_id: entry?.id || null,
    entry_label: entry?.label || null,
    entry_package: entry?.packageName || null,
    context,
    original_error: diagnosticError(error),
    screenshot,
    hierarchy,
    current_app: appResult.ok ? { status: 'captured', value: appResult.value } : { status: 'failed', error: appResult.error },
    foreground_window: windowResult.ok ? { status: 'captured', value: windowResult.value } : { status: 'failed', error: windowResult.error },
    device_state: deviceResult.ok ? { status: 'captured', value: deviceResult.value } : { status: 'failed', error: deviceResult.error },
    scrcpy_observer: observerResult.ok ? { status: 'captured', value: observerResult.value } : { status: 'failed', error: observerResult.error },
    ocr,
  }
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
  return { manifest: manifestPath, screenshot: screenshot.path, hierarchy: hierarchy.path, ocr: ocr.path, details: manifest }
}

module.exports = {
  hierarchyDiagnosticSummary,
  diagnosticError,
  captureFailureDiagnostics,
}
