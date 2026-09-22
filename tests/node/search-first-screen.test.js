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
