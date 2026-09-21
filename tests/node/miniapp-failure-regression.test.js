const test = require('node:test')
const assert = require('node:assert/strict')
const sharp = require('sharp')
const { mapPhysicalBoundsToLogical } = require('../../src/automation/ocr')
const { miniAppReferenceProductsOcrTrigger } = require('../../src/automation/reference-products')
const { confirmMiniAppTop, createReplyCapture } = require('../../src/automation/reply-capture')
const { differentialCitationExpansion, prepareEmbeddedEvidence } = require('../../src/automation/capture-primitives')

test('裁剪后的横向药品区域显式映射坐标，整机横屏仍拒绝', () => {
  for (const scale of [1, 2 / 3]) {
    const recognition = { image: { width: 1080, height: 890 }, results: [
      { normalizedText: '参考药品', confidence: 0.99, bounds: [70, 700, 320, 750] },
      { normalizedText: '全部药品', confidence: 0.99, bounds: [820, 700, 1000, 750] },
    ] }
    const logicalSize = { width: 1080 * scale, height: 890 * scale }
    assert.deepEqual(miniAppReferenceProductsOcrTrigger(recognition, logicalSize, { cropped: true }), [Math.round(910 * scale), Math.round(725 * scale)])
    assert.throws(() => miniAppReferenceProductsOcrTrigger(recognition, logicalSize), /竖屏/)
    assert.throws(() => mapPhysicalBoundsToLogical([10, 10, 50, 50], recognition.image, logicalSize), /竖屏/)
  }
})

test('回顶在超时、次数上限或画面未变后仍核验最后一次滚动的新画面', async () => {
  for (const limit of ['timeout', 'slow_ocr', 'attempts', 'unchanged']) {
    let now = 0, swipes = 0
    const checked = []
    const result = await confirmMiniAppTop({
      initialCapture: { frame: 'before' },
      swipeUp: async () => { swipes++; now = 101 },
      settle: async () => ({ frame: 'question' }),
      framesStable: async () => limit === 'unchanged',
      requiredUnchanged: 1, timeout: ['timeout', 'slow_ocr'].includes(limit) ? 100 : 1000,
      maxAttempts: limit === 'attempts' ? 1 : 80, now: () => now,
      findTarget: async capture => { checked.push(capture.frame); if (limit === 'slow_ocr') now = 101; return capture.frame === 'question' ? { text: '原题' } : null },
    })
    assert.deepEqual(checked, ['before', 'question'])
    assert.equal(swipes, 1)
    assert.equal(result.target.text, '原题')
  }
})

test('小程序整机横屏在滚动和点击前停止', async () => {
  const capture = createReplyCapture({
    windowSize: async () => ({ width: 1600, height: 720 }),
    swipeChat: async () => assert.fail('横屏不可滚动'), tap: async () => assert.fail('横屏不可点击'),
  })
  await assert.rejects(capture.captureMiniAppFullAnswerFrames('<hierarchy/>', [0, 100, 1600, 600], {}), /竖屏/)
})

test('单条文献插入并将原正文整体下移时确认展开，只点击一次；正文未下移则拒绝', async () => {
  for (const scale of [1, 2 / 3]) {
    const row = (text, bounds) => ({ text, normalizedText: text, confidence: 0.99, bounds: bounds.map(v => Math.round(v * scale)) })
    const heading = row('参考1篇医学文献', [80, 716, 440, 761])
    const body = [row('这是原回答的标题', [75, 794, 830, 847]), row('这是原回答的第一行正文', [75, 902, 900, 955])]
    const baseline = { image: { width: 1080 * scale, height: 2400 * scale }, results: [row('这是本题问题', [600, 440, 1000, 493]), heading, ...body] }
    const citation = row('1.示例资料题名', [84, 793, 497, 834])
    const shiftedBody = body.map(r => ({ ...r, bounds: r.bounds.map((v, i) => v + (i % 2 ? Math.round(54 * scale) : 0)) }))
    const expanded = { ...baseline, results: [...baseline.results.slice(0, 2), citation, ...shiftedBody] }
    const target = { normalizedText: heading.text, variant: 'medical_references', physicalBounds: heading.bounds }
    assert.equal(differentialCitationExpansion(baseline, target, expanded).confirmed, true)
    assert.equal(differentialCitationExpansion(baseline, target, { ...expanded, results: [...baseline.results, citation] }).confirmed, false)
    const scrolled = { ...expanded, results: expanded.results.map(r => r === heading ? { ...r, bounds: r.bounds.map((v, i) => v + (i % 2 ? 100 * scale : 0)) } : r) }
    assert.equal(differentialCitationExpansion(baseline, target, scrolled).confirmed, false)
    let taps = 0
    const result = await prepareEmbeddedEvidence({
      screenshot: async () => Buffer.from('screen'), source: async () => '<hierarchy/>',
      ocr: { recognize: async () => taps ? expanded : baseline }, windowSize: async () => baseline.image,
      tap: async () => { taps++ }, delay: async () => {}, log: () => {},
      waitForStable: async () => ({ frame: Buffer.from('expanded'), xml: '<hierarchy/>' }),
    }, [0, 316, 1080, 1958].map(v => v * scale))
    assert.equal(result.expanded, true)
    assert.equal(taps, 1)
  }
})

test('原题在首帧20%线以下且无法继续定位时按完整气泡裁剪，不误报失败', async () => {
  for (const scale of [1, 2]) {
    const width = 240 * scale, height = 500 * scale
    const full = await sharp({ create: { width, height, channels: 3, background: '#fff' } }).composite([{
      input: await sharp({ create: { width: 100 * scale, height: 40 * scale, channels: 3, background: '#00c2ae' } }).png().toBuffer(),
      left: 130 * scale, top: 183 * scale,
    }, {
      input: Buffer.from(`<svg width="${width}" height="${height}" viewBox="0 0 240 500"><circle cx="120" cy="320" r="16" fill="white"/><path d="M120 312 V328 M115 323 L120 328 L125 323" fill="none" stroke="black" stroke-width="2.5"/></svg>`), left: 0, top: 0,
    }]).png().toBuffer()
    let swipes = 0
    let navigationSteps = 0
    const bodyFrames = await Promise.all([0, 1, 2].map(index => sharp({ create: { width, height, channels: 3, background: '#fff' } }).composite([{
      input: Buffer.from(`<svg width="${width}" height="${height}" viewBox="0 0 240 500"><rect x="30" y="${150 + index * 40}" width="170" height="25" fill="black"/></svg>`), left: 0, top: 0,
    }]).png().toBuffer()))
    const productClicks = []
    const xml = '<hierarchy><node bounds="[0,0][240,500]"/></hierarchy>'
    const capture = createReplyCapture({
      source: async () => xml, windowSize: async () => ({ width, height }), log: () => {},
      screenshot: async () => bodyFrames[navigationSteps] || full, waitForVisualQuiet: async () => {},
      ocr: { recognize: async buffer => {
        assert.ok(navigationSteps >= 3, '没有问题气泡的正文页不应反复执行OCR')
        const info = await sharp(buffer).metadata()
        const top = info.height === height ? 193 : 83
        const results = [{ text: '示例问题', normalizedText: '示例问题', confidence: 0.99, bounds: [145, top, 225, top + 20].map(v => v * scale) }]
        if (info.height < info.width) results.push(
          { normalizedText: '参考药品', confidence: 0.99, bounds: [15, 120, 80, 140].map(v => v * scale) },
          { normalizedText: '全部药品', confidence: 0.99, bounds: [190, 120, 230, 140].map(v => v * scale) },
        )
        return { image: { width: info.width, height: info.height }, results }
      } },
      swipeChat: async (_bounds, direction) => { swipes++; if (direction === 'up') navigationSteps++; return { distance: 0, canScrollMore: false } },
      captureReferenceProductsAtTrigger: async point => {
        productClicks.push(point)
        return { firstViewportIncluded: true, imagesReady: true, confirmedEnd: true, continuityVerified: true }
      },
    })
    const result = await capture.captureMiniAppFullAnswerFrames(xml, [0, 110, 240, 440], {
      platformLabel: '抖音', metadataPrefix: 'douyin', openedMetadataKey: 'douyin_view_full_opened', questionStart: '示例问题',
    })
    assert.ok(swipes <= 8)
    assert.equal(result.frames.length, 1)
    assert.deepEqual(productClicks, [[210, 240]]) // Local crop mapped to logical pixels, plus viewport offset once.
    assert.equal(result.captureMetadata.douyin_current_question_navigation_ocr_skipped, 3)
    assert.ok(result.captureMetadata.douyin_current_question_first_frame_crop[1] < 73 * scale)
  }
})
