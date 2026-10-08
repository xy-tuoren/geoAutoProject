const test = require('node:test')
const assert = require('node:assert/strict')
const sharp = require('sharp')
const { inspectSearchFirstScreen } = require('../../src/automation/search-first-screen')

test('stable first-screen absence uses one OCR even when one recognition takes 14 seconds', async () => {
  for (const scale of [1, 2]) {
    const frame = await sharp(Buffer.from('<svg width="360" height="800"><rect width="360" height="800" fill="white"/><path d="M30 200h280v30H30z M30 300h200v30H30z"/></svg>')).resize(360 * scale, 800 * scale).png().toBuffer()
    let now = 0, calls = 0
    const result = await inspectSearchFirstScreen({
      source: async () => '<hierarchy/>', screenshot: async () => frame,
      hierarchyTarget: () => null, recognize: async () => { calls++; now += 14000; return { target: null } },
      now: () => now, delay: async ms => { now += ms }, log: () => {},
    })
    assert.equal(result.absent, true)
    assert.equal(result.ocrAttempts, 1)
    assert.equal(calls, 1)
    assert.ok(now < 17000)
  }
})

test('blank or stale first screen cannot be reported as a successful unmatched search', async () => {
  const frame = await sharp({ create: { width: 360, height: 800, channels: 3, background: 'white' } }).png().toBuffer()
  for (const stale of [false, true]) {
    let now = 0, calls = 0
    await assert.rejects(inspectSearchFirstScreen({
      source: async () => '<hierarchy/>', screenshot: async () => frame,
      queryMatches: () => !stale, hierarchyTarget: () => null,
      recognize: async () => { calls++; return { target: null } },
      now: () => now, delay: async ms => { now += ms }, timeout: 2000, log: () => {},
    }), /首屏.*(?:加载|稳定|当前查询)/)
    assert.equal(calls, 0)
  }
})

test('a result that changes during OCR is rechecked once and a late entry is retained', async () => {
  const make = color => sharp(Buffer.from(`<svg width="360" height="800"><rect width="360" height="800" fill="white"/><rect x="20" y="200" width="280" height="250" fill="${color}"/></svg>`)).png().toBuffer()
  const frames = await Promise.all(['red', 'blue'].map(make))
  let now = 0, calls = 0, page = 0
  const result = await inspectSearchFirstScreen({ source: async () => '<hierarchy/>', screenshot: async () => frames[page],
    hierarchyTarget: () => null,
    recognize: async () => { calls++; page = 1; return { target: calls === 2 ? { text: '小荷入口' } : null } },
    now: () => now, delay: async ms => { now += ms }, log: () => {},
  })
  assert.equal(calls, 2)
  assert.equal(result.target.text, '小荷入口')
})

function searchNode(className, bounds, attributes = '', children = '') {
  return `<node class="${className}" package="com.ss.android.ugc.aweme" visible-to-user="true" bounds="${bounds}" ${attributes}>${children}</node>`
}

function dynamicSearchXml({ width = 360, height = 800, media = 'live', title = '示例结果标题', loading = false } = {}) {
  const bounds = (left, top, right, bottom) => `[${Math.round(left * width / 360)},${Math.round(top * height / 800)}][${Math.round(right * width / 360)},${Math.round(bottom * height / 800)}]`
  const label = (text, box) => searchNode('android.widget.TextView', bounds(...box), `text="${text}"`)
  const preview = media === 'live'
    ? searchNode('android.view.ViewGroup', bounds(18, 200, 170, 400), 'content-desc="示例作者的直播间，直播中，观众16人，按钮"', searchNode('android.widget.ImageView', bounds(18, 200, 170, 400)))
    : searchNode('android.view.ViewGroup', bounds(18, 200, 170, 400), '', searchNode('android.widget.ImageView', bounds(18, 200, 170, 400)))
  const description = label(title, [18, 410, 170, 440])
  const product = media === 'product' ? `${label('¥ 28', [18, 450, 70, 475])}${label('已售100件', [80, 450, 170, 475])}` : ''
  const card = searchNode('android.widget.FrameLayout', bounds(18, 200, 170, 510), '', `${preview}${description}${product}`)
  const results = searchNode('androidx.recyclerview.widget.RecyclerView', bounds(0, 150, 360, 740), '', `${card}${label('另一个示例结果', [190, 410, 340, 450])}${loading ? label('加载中', [18, 540, 160, 565]) : ''}`)
  const input = searchNode('android.widget.EditText', bounds(20, 35, 310, 70), 'text="示例搜索词"')
  return `<hierarchy>${searchNode('android.widget.FrameLayout', bounds(0, 0, 360, 800), '', `${input}${results}`)}</hierarchy>`
}

async function dynamicSearchFrames(width = 360, height = 800) {
  return Promise.all(['red', 'blue'].map(color => sharp(Buffer.from(`<svg width="360" height="800"><rect width="360" height="800" fill="white"/><rect x="18" y="200" width="152" height="200" fill="${color}"/><rect x="190" y="200" width="150" height="200" fill="#999"/><path d="M18 415h140v20H18z M190 415h140v20H190z M18 455h70v20H18z M18 560h300v24H18z M18 630h220v24H18z"/></svg>`)).resize(width, height).png().toBuffer()))
}

test('verified live or product media may keep moving while one OCR confirms first-screen absence', async () => {
  const sizes = [{ logicalSize: { width: 360, height: 800 }, physicalSize: { width: 360, height: 800 } },
    { logicalSize: { width: 540, height: 1200 }, physicalSize: { width: 1080, height: 2400 } }]
  for (const media of ['live', 'product']) {
    for (const { logicalSize, physicalSize } of sizes) {
      const frames = await dynamicSearchFrames(physicalSize.width, physicalSize.height)
      const xml = dynamicSearchXml({ ...logicalSize, media })
      let now = 0, screenshots = 0, calls = 0
      const result = await inspectSearchFirstScreen({
        source: async () => xml, screenshot: async () => frames[screenshots++ % frames.length],
        hierarchyTarget: () => null, ignoreDynamicMedia: true, logicalSize,
        recognize: async frame => {
          calls++
          assert.ok(frames.some(original => original.equals(frame)), 'OCR must receive the unmasked original screenshot')
          return { target: null }
        },
        now: () => now, delay: async ms => { now += ms }, log: () => {},
      })
      assert.equal(result.absent, true, `${media} at ${physicalSize.width}x${physicalSize.height}`)
      assert.equal(result.xml, xml)
      assert.deepEqual(result.frame, frames[(screenshots - 1) % frames.length], 'absence must retain the original frame that passed final validation')
      assert.equal(calls, 1)
      assert.equal(result.ocrAttempts, 1)
      assert.ok(now < 15000)
    }
  }
})

test('a visible result title that changes during OCR still triggers a second recognition with media masking enabled', async () => {
  const frames = await dynamicSearchFrames()
  let now = 0, calls = 0, page = 0
  const result = await inspectSearchFirstScreen({
    source: async () => dynamicSearchXml({ title: page ? '新入口所在结果' : '旧结果标题' }),
    screenshot: async () => frames[page], hierarchyTarget: () => null,
    ignoreDynamicMedia: true, logicalSize: { width: 360, height: 800 },
    recognize: async () => {
      calls++
      page = 1
      return { target: calls === 2 ? { text: '小荷入口', bounds: [190, 410, 340, 450] } : null }
    },
    now: () => now, delay: async ms => { now += ms }, log: () => {},
  })
  assert.equal(calls, 2)
  assert.equal(result.target.text, '小荷入口')
})

test('a directly exposed entry arriving during OCR is retained without another OCR', async () => {
  const frames = await dynamicSearchFrames()
  let now = 0, calls = 0, page = 0
  const result = await inspectSearchFirstScreen({
    source: async () => dynamicSearchXml({ title: page ? '小荷AI 在线咨询' : '旧结果标题' }),
    screenshot: async () => frames[page],
    hierarchyTarget: xml => xml.includes('小荷AI 在线咨询') ? { target: { text: '小荷入口' } } : null,
    ignoreDynamicMedia: true, logicalSize: { width: 360, height: 800 },
    recognize: async () => { calls++; page = 1; return { target: null } },
    now: () => now, delay: async ms => { now += ms }, log: () => {},
  })
  assert.equal(result.target.text, '小荷入口')
  assert.equal(calls, 1)
})

test('unknown moving search content times out instead of being classified as no entry', async () => {
  const frames = await dynamicSearchFrames()
  let now = 0, screenshots = 0, calls = 0
  await assert.rejects(inspectSearchFirstScreen({
    source: async () => dynamicSearchXml({ media: 'unknown' }),
    screenshot: async () => frames[screenshots++ % frames.length], hierarchyTarget: () => null,
    ignoreDynamicMedia: true, logicalSize: { width: 360, height: 800 },
    recognize: async () => { calls++; return { target: null } },
    now: () => now, delay: async ms => { now += ms }, timeout: 2000, log: () => {},
  }), error => {
    assert.equal(error.code, 'SEARCH_FIRST_SCREEN_NOT_READY')
    assert.equal(error.inspection.reason, 'content_changed')
    assert.ok(error.inspection.ocrAttempts <= 2)
    return true
  })
  assert.ok(calls <= 2, 'a stable native layout can be read, but continued unknown motion must prevent absence')
})

test('media masking never bypasses blank, loading or wrong-query validation', async () => {
  const frames = await dynamicSearchFrames()
  const blank = await sharp({ create: { width: 360, height: 800, channels: 3, background: 'white' } }).png().toBuffer()
  for (const reason of ['blank', 'loading', 'query_mismatch']) {
    let now = 0, calls = 0
    await assert.rejects(inspectSearchFirstScreen({
      source: async () => reason === 'blank' ? '<hierarchy/>' : dynamicSearchXml({ loading: reason === 'loading' }),
      screenshot: async () => reason === 'blank' ? blank : frames[0], hierarchyTarget: () => null,
      queryMatches: () => reason !== 'query_mismatch', ignoreDynamicMedia: true, logicalSize: { width: 360, height: 800 },
      recognize: async () => { calls++; return { target: null } },
      now: () => now, delay: async ms => { now += ms }, timeout: 2000, log: () => {},
    }), error => {
      assert.equal(error.code, 'SEARCH_FIRST_SCREEN_NOT_READY')
      assert.equal(error.inspection.reason, reason)
      return true
    })
    assert.equal(calls, 0, reason)
  }
})
