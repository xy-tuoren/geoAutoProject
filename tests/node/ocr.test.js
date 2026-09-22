const test = require('node:test')
const assert = require('node:assert/strict')
const { OcrRecognizer, findOcrText, mapPhysicalBoundsToLogical, normalizeOcrText } = require('../../src/automation/ocr')

const rawRecognition = {
  engine: 'rapidocr',
  coordinate_space: 'image_physical_pixels',
  image: { width: 1080, height: 2400 },
  region: [0, 240, 1080, 2064],
  elapsed_ms: 472.4,
  engine_elapsed_ms: 451.2,
  results: [
    { text: '小荷AI医生・智能总结', confidence: 0.988, bounds: [156, 433, 630, 489], polygon: [] },
    { text: '查看更多>', confidence: 0.978, bounds: [420, 1254, 656, 1313], polygon: [] },
  ],
}

test('通用OCR封装规范化文字并保留图片物理坐标', async () => {
  const recognizer = new OcrRecognizer({ transport: { ocrRecognize: async () => rawRecognition } })
  const result = await recognizer.recognize(Buffer.from('png'))

  assert.equal(result.coordinateSpace, 'image_physical_pixels')
  assert.equal(result.results[0].normalizedText, '小荷AI医生智能总结')
  assert.deepEqual(findOcrText(result, /小荷AI医生智能总结/, { minConfidence: 0.9 }).map(item => item.text), ['小荷AI医生・智能总结'])
  assert.equal(normalizeOcrText(' 查看更多 》 '), '查看更多')
})

test('OCR物理坐标按两个竖屏空间分别缩放到UI逻辑坐标', () => {
  assert.deepEqual(
    mapPhysicalBoundsToLogical([420, 1254, 656, 1313], { width: 1080, height: 2400 }, { width: 720, height: 1600 }),
    [280, 836, 437, 875],
  )
  assert.deepEqual(
    mapPhysicalBoundsToLogical([280, 836, 437, 875], { width: 720, height: 1600 }, { width: 1080, height: 2400 }),
    [420, 1254, 656, 1313],
  )
  assert.throws(() => mapPhysicalBoundsToLogical([1, 1, 10, 10], { width: 1600, height: 720 }, { width: 1600, height: 720 }), /竖屏/)
})

test('只复用完全相同图片和选项的OCR结果，图像变化必须重新识别', async () => {
  let calls = 0
  const recognizer = new OcrRecognizer({ transport: { ocrRecognize: async () => { calls++; return rawRecognition } } })
  const frame = Buffer.from('first')
  const first = await recognizer.recognize(frame)
  const repeat = await recognizer.recognize(Buffer.from('first'))
  assert.equal(repeat.cacheHit, true)
  assert.equal(repeat.engineElapsedMs, 0)
  assert.equal(repeat.sourceElapsedMs, rawRecognition.elapsed_ms)
  assert.ok(repeat.elapsedMs < rawRecognition.elapsed_ms)
  repeat.results[0].text = 'modified'
  assert.notEqual(first.results[0].text, 'modified')
  assert.equal(calls, 1)
  await recognizer.recognize(frame, { minConfidence: 0.8 })
  await recognizer.recognize(Buffer.from('changed'), { minConfidence: 0.8 })
  assert.equal(calls, 3)
  assert.equal(recognizer.evidenceFor(first).frame, frame)
})
