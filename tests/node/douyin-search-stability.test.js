const test = require('node:test')
const assert = require('node:assert/strict')
const sharp = require('sharp')
const { imageRegionsStable } = require('../../src/automation/images')
const { douyinSearchDynamicRegions, createSearchObservation } = require('../../src/automation/douyin-search-stability')
const { createDouyinSearchWorkflow } = require('../../src/automation/douyin-search-workflow')

const BASE_SIZE = { width: 360, height: 800 }

function searchFixture({ size = BASE_SIZE, media = 'live', label = '示例内容标题', overlay = '', webView = false, liveBadgeOnly = false } = {}) {
  const bounds = (left, top, right, bottom) => `[${Math.round(left * size.width / 360)},${Math.round(top * size.height / 800)}][${Math.round(right * size.width / 360)},${Math.round(bottom * size.height / 800)}]`
  const node = (className, box, attributes = '', children = '') => `<node class="${className}" package="com.ss.android.ugc.aweme" visible-to-user="true" bounds="${bounds(...box)}" ${attributes}>${children}</node>`
  const text = (labelText, box) => node('android.widget.TextView', box, `text="${labelText}"`)
  const mediaAttributes = media === 'live' && !liveBadgeOnly ? 'content-desc="示例作者的直播间，直播中，观众16人，按钮"' : ''
  const previewChildren = `${node(media === 'surface' ? 'android.view.SurfaceView' : 'android.widget.ImageView', [18, 200, 170, 400])}${node('android.widget.ImageView', [145, 370, 163, 388], 'content-desc="音量"')}${overlay ? text(overlay, [30, 280, 160, 310]) : ''}${webView ? node('android.webkit.WebView', [18, 200, 170, 400]) : ''}`
  const preview = node('android.view.ViewGroup', [18, 200, 170, 400], mediaAttributes, previewChildren)
  const productInfo = media === 'product' ? `${text('¥ 28', [18, 450, 70, 475])}${text('已售100件', [80, 450, 170, 475])}` : ''
  const card = node('android.widget.FrameLayout', [18, 200, 170, 510], '', `${preview}${text(label, [18, 410, 170, 440])}${productInfo}${liveBadgeOnly ? text('直播中', [18, 480, 70, 500]) : ''}`)
  const results = node('androidx.recyclerview.widget.RecyclerView', [0, 150, 360, 740], '', `${card}${text('另一条示例结果', [190, 410, 340, 450])}`)
  return `<hierarchy>${node('android.widget.FrameLayout', [0, 0, 360, 800], '', `${node('android.widget.EditText', [20, 35, 310, 70], 'text="示例搜索词"')}${results}`)}</hierarchy>`
}

async function searchImage({ width = 360, height = 800, color = 'red' } = {}) {
  return sharp(Buffer.from(`<svg width="360" height="800"><rect width="360" height="800" fill="white"/><rect x="18" y="200" width="152" height="200" fill="${color}"/><rect x="190" y="200" width="150" height="200" fill="#999"/><path d="M18 415h140v20H18z M190 415h140v20H190z M18 455h120v20H18z M18 560h300v24H18z M18 630h220v24H18z"/></svg>`)).resize(width, height).png().toBuffer()
}

test('dynamic regions are limited to proven live and product previews at two portrait scales', () => {
  for (const size of [BASE_SIZE, { width: 540, height: 1200 }]) {
    for (const [media, kind] of [['live', 'live'], ['product', 'product_media']]) {
      const regions = douyinSearchDynamicRegions(searchFixture({ size, media }), size)
      assert.equal(regions.length, 1, `${media} on ${size.width}x${size.height}`)
      assert.equal(regions[0].kind, kind)
      assert.deepEqual(regions[0].bounds, [18, 200, 170, 400].map((value, index) => Math.round(value * (index % 2 ? size.height / 800 : size.width / 360))))
      assert.equal(typeof regions[0].identity, 'string')
      assert.ok(regions[0].identity)
    }
  }
})

test('a standalone live badge or an ordinary image is insufficient proof to ignore moving content', () => {
  assert.deepEqual(douyinSearchDynamicRegions(searchFixture({ media: 'unknown' }), BASE_SIZE), [])
  assert.deepEqual(douyinSearchDynamicRegions(searchFixture({ media: 'live', liveBadgeOnly: true }), BASE_SIZE), [])
  assert.deepEqual(douyinSearchDynamicRegions(searchFixture().replaceAll('com.ss.android.ugc.aweme', 'example.other.app'), BASE_SIZE), [])
})

test('media overlapping entry labels, substantive titles or WebViews cannot be masked', () => {
  for (const media of ['live', 'product']) {
    for (const overlay of ['小荷AI', '在线咨询', '查看全文', '医学数据智能总结']) {
      const regions = douyinSearchDynamicRegions(searchFixture({ media, overlay }), BASE_SIZE)
      assert.deepEqual(regions, [], `${media} must preserve ${overlay}`)
    }
    assert.deepEqual(douyinSearchDynamicRegions(searchFixture({ media, webView: true }), BASE_SIZE), [])
  }
})

test('incompatible screenshot and hierarchy proportions keep all result pixels in the comparison', async () => {
  const logicalSize = { width: 540, height: 1200 }
  const observation = await createSearchObservation(await searchImage({ width: 1080, height: 2000 }),
    searchFixture({ size: logicalSize }), { ignoreDynamicMedia: true, logicalSize })
  assert.equal(observation.dynamicRegionsIgnored, 0)
  assert.equal(observation.stabilityPolicy, 'full_first_screen')
  assert.equal(observation.fingerprint, null)
})

test('observation masks proven media only for comparison and maps logical coordinates to original PNG size', async () => {
  const sizes = [{ logicalSize: BASE_SIZE, physicalSize: BASE_SIZE },
    { logicalSize: { width: 540, height: 1200 }, physicalSize: { width: 1080, height: 2400 } }]
  for (const { logicalSize, physicalSize } of sizes) {
    const xml = searchFixture({ size: logicalSize })
    const original = await searchImage(physicalSize)
    const originalCopy = Buffer.from(original)
    const changed = await searchImage({ ...physicalSize, color: 'blue' })
    const [first, second, unmasked] = await Promise.all([
      createSearchObservation(original, xml, { ignoreDynamicMedia: true, logicalSize }),
      createSearchObservation(changed, xml, { ignoreDynamicMedia: true, logicalSize }),
      createSearchObservation(original, xml),
    ])
    assert.equal(first.dynamicRegionsIgnored, 1)
    assert.equal(first.stabilityPolicy, 'verified_media_mask')
    assert.equal(first.loaded, true)
    assert.equal(second.fingerprint, first.fingerprint)
    assert.ok(await imageRegionsStable(first.content, second.content))
    assert.equal(unmasked.dynamicRegionsIgnored, 0)
    assert.equal(unmasked.stabilityPolicy, 'full_first_screen')
    assert.equal(unmasked.fingerprint, null)
    assert.deepEqual(original, originalCopy, 'comparison masking must not modify the original screenshot')
    assert.equal(await imageRegionsStable(unmasked.content, second.content), false)
  }
})

test('result titles and unverified pixel changes still invalidate stability with dynamic media enabled', async () => {
  const original = await searchImage()
  const changed = await searchImage({ color: 'blue' })
  const first = await createSearchObservation(original, searchFixture(), { ignoreDynamicMedia: true, logicalSize: BASE_SIZE })
  const titleChanged = await createSearchObservation(original, searchFixture({ label: '新的示例入口结果' }), { ignoreDynamicMedia: true, logicalSize: BASE_SIZE })
  assert.notEqual(first.fingerprint, titleChanged.fingerprint, 'text-only changes must invalidate an OCR miss even if screenshots match')
  const liveCountChanged = await createSearchObservation(original, searchFixture().replace('观众16人', '观众42人'), { ignoreDynamicMedia: true, logicalSize: BASE_SIZE })
  assert.equal(first.fingerprint, liveCountChanged.fingerprint, 'changing viewer counts inside proven media must not block inspection')
  const unverifiedXml = searchFixture({ media: 'unknown' })
  const unknownFirst = await createSearchObservation(original, unverifiedXml, { ignoreDynamicMedia: true, logicalSize: BASE_SIZE })
  const unknownSecond = await createSearchObservation(changed, unverifiedXml, { ignoreDynamicMedia: true, logicalSize: BASE_SIZE })
  assert.equal(unknownFirst.dynamicRegionsIgnored, 0)
  assert.equal(await imageRegionsStable(unknownFirst.content, unknownSecond.content), false)
})

test('search discovery passes logical dimensions into target capture when ADB PNG dimensions differ', async () => {
  const sizes = [{ logicalSize: BASE_SIZE, physicalSize: BASE_SIZE },
    { logicalSize: { width: 540, height: 1200 }, physicalSize: { width: 1080, height: 2400 } }]
  for (const { logicalSize, physicalSize } of sizes) {
    const frames = await Promise.all(['red', 'blue'].map(color => searchImage({ ...physicalSize, color })))
    const xml = searchFixture({ size: logicalSize })
      .replace('class="android.widget.EditText"', 'class="android.widget.EditText" resource-id="com.ss.android.ugc.aweme:id/et_search_kw"')
    const physicalBounds = box => box.map((value, index) => Math.round(value * (index % 2 ? physicalSize.height / 800 : physicalSize.width / 360)))
    const logicalBounds = box => box.map((value, index) => Math.round(value * (index % 2 ? logicalSize.height / 800 : logicalSize.width / 360)))
    const recognition = {
      engine: 'rapidocr', elapsedMs: 0, image: physicalSize,
      results: [
        { text: '小荷AI医生', normalizedText: '小荷AI医生', confidence: 0.99, bounds: physicalBounds([205, 510, 320, 535]) },
        { text: '为您提供定制化建议，试试咨询', normalizedText: '为您提供定制化建议，试试咨询', confidence: 0.99, bounds: physicalBounds([185, 545, 345, 575]) },
        { text: '免费咨询', normalizedText: '免费咨询', confidence: 0.99, bounds: physicalBounds([230, 600, 300, 630]) },
      ],
    }
    let now = 0, screenshots = 0
    const workflow = createDouyinSearchWorkflow({
      source: async () => xml, windowSize: async () => physicalSize,
      screenshot: async () => frames[screenshots++ % frames.length],
      ocr: { recognize: async () => recognition }, setLastOcrDiagnostic: () => {},
      waitForVisualQuiet: async () => {}, log: () => {},
      tap: async () => assert.fail('discovery and recapture must not click'), ui: {},
      getActivePackageName: () => 'com.ss.android.ugc.aweme', checkCancelled: () => {},
      now: () => now, delay: async ms => { now += ms },
    })
    const discovered = await workflow.waitForDouyinSearchResult(15000, '示例搜索词')
    assert.deepEqual(discovered.size, logicalSize)
    assert.deepEqual(discovered.target.cardBounds, logicalBounds([185, 510, 345, 630]))
    const capture = await workflow.captureDouyinSearchTarget(discovered.size, discovered.target, '示例搜索词')
    assert.equal(capture.stable, true, 'moving left-column media must not invalidate the mapped right-column target')
    assert.deepEqual(capture.target.tapBounds, logicalBounds([230, 600, 300, 630]))
    await assert.rejects(workflow.captureDouyinSearchTarget(discovered.size, discovered.target, '另一条示例搜索词'), /搜索词已变化/)
  }
})
