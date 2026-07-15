function normalizeOcrText(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[\s·・•|丨]/g, '')
    .replace(/[>》〉›»]+$/g, '')
}

function validSize(value, label) {
  const width = Number(value?.width)
  const height = Number(value?.height)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`${label}尺寸无效。`)
  }
  return { width, height }
}

function validBounds(value, label = 'OCR文字框') {
  if (!Array.isArray(value) || value.length !== 4 || value.some(item => !Number.isFinite(Number(item)))) {
    throw new Error(`${label}坐标无效。`)
  }
  const bounds = value.map(Number)
  if (bounds[2] <= bounds[0] || bounds[3] <= bounds[1]) throw new Error(`${label}没有可见区域。`)
  return bounds
}

function normalizeRecognition(result) {
  if (!result || result.coordinate_space !== 'image_physical_pixels') {
    throw new Error('OCR未返回明确的图片物理坐标空间。')
  }
  const image = validSize(result.image, 'OCR图片')
  const results = Array.isArray(result.results) ? result.results.map(item => ({
    text: String(item.text || ''),
    normalizedText: normalizeOcrText(item.text),
    confidence: Number(item.confidence),
    bounds: validBounds(item.bounds),
    polygon: Array.isArray(item.polygon) ? item.polygon : [],
  })).filter(item => item.text && Number.isFinite(item.confidence)) : []
  return {
    engine: String(result.engine || 'unknown'),
    coordinateSpace: result.coordinate_space,
    image,
    region: validBounds(result.region, 'OCR区域'),
    elapsedMs: Number(result.elapsed_ms) || 0,
    engineElapsedMs: Number(result.engine_elapsed_ms) || 0,
    options: result.options || {},
    results,
  }
}

class OcrRecognizer {
  constructor({ transport }) {
    if (!transport || typeof transport.ocrRecognize !== 'function') throw new Error('OCR需要支持ocrRecognize的sidecar传输层。')
    this.transport = transport
  }

  async recognize(image, options = {}) {
    return normalizeRecognition(await this.transport.ocrRecognize(image, options))
  }
}

function findOcrText(recognition, matcher, { minConfidence = 0 } = {}) {
  const predicate = typeof matcher === 'function'
    ? matcher
    : matcher instanceof RegExp
      ? item => { matcher.lastIndex = 0; return matcher.test(item.normalizedText) }
      : item => item.normalizedText === normalizeOcrText(matcher)
  return recognition.results
    .filter(item => item.confidence >= minConfidence && predicate(item))
    .sort((first, second) => second.confidence - first.confidence || first.bounds[1] - second.bounds[1])
}

function mapPhysicalBoundsToLogical(bounds, physicalSize, logicalSize) {
  const source = validSize(physicalSize, '图片物理')
  const target = validSize(logicalSize, 'UI逻辑')
  const input = validBounds(bounds)
  if (source.height <= source.width || target.height <= target.width) throw new Error('OCR坐标映射仅支持正常竖屏。')
  const scaleX = target.width / source.width
  const scaleY = target.height / source.height
  return [
    Math.max(0, Math.round(input[0] * scaleX)),
    Math.max(0, Math.round(input[1] * scaleY)),
    Math.min(target.width, Math.round(input[2] * scaleX)),
    Math.min(target.height, Math.round(input[3] * scaleY)),
  ]
}

module.exports = {
  OcrRecognizer,
  findOcrText,
  mapPhysicalBoundsToLogical,
  normalizeOcrText,
  normalizeRecognition,
}
