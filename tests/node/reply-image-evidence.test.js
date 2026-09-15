const test = require('node:test')
const assert = require('node:assert/strict')
const sharp = require('sharp')
const { analyzeReplyScrollEvidence, detectFloatingDownArrow } = require('../../src/automation/images')
const { shouldDiscardUnprovenCandidate } = require('../../src/automation/reply-capture')

async function syntheticScrollableFrame(startRow, width = 720, height = 1200) {
  const data = Buffer.alloc(width * height * 3, 255)
  for (let y = 0; y < height; y += 1) {
    const documentY = startRow + y
    for (let x = 28; x < width - 28; x += 1) {
      const isContent = ((Math.floor(documentY / 17) * 31 + Math.floor(x / 13) * 19) % 23) < 5
      if (!isContent) continue
      const offset = (y * width + x) * 3
      data[offset] = 35
      data[offset + 1] = 35
      data[offset + 2] = 35
    }
  }
  return sharp(data, { raw: { width, height, channels: 3 } }).png().toBuffer()
}

test('reply scroll evidence requires consistent regional shift and content in the new bottom area', async () => {
  const previous = await syntheticScrollableFrame(0)
  const current = await syntheticScrollableFrame(500)
  const evidence = await analyzeReplyScrollEvidence(previous, current, 700)
  assert.equal(evidence.consistentShift, true)
  assert.equal(evidence.bottomHasContent, true)
  assert.equal(evidence.provesNewContent, true)
  assert.ok(Math.abs(evidence.overlap - 700) <= 3)
})

async function arrowImage(width, height, centerY, size) {
  const svg = Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="#fff"/>
    <g transform="translate(${width / 2},${centerY})">
      <circle r="${size * 0.48}" fill="#fff" stroke="#e7e7e7" stroke-width="2"/>
      <path d="M 0 ${-size * 0.22} L 0 ${size * 0.14} M ${-size * 0.17} ${size * 0.02} L 0 ${size * 0.2} L ${size * 0.17} ${size * 0.02}" fill="none" stroke="#202020" stroke-width="${Math.max(3, size * 0.055)}" stroke-linecap="round" stroke-linejoin="round"/>
    </g>
  </svg>`)
  return sharp(svg).png().toBuffer()
}

async function inverseArrowImage(width, height, centerY, size) {
  const svg = Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="#fff"/>
    <g transform="translate(${width / 2},${centerY})">
      <circle r="${size * 0.48}" fill="#30343a"/>
      <path d="M 0 ${-size * 0.22} L 0 ${size * 0.14} M ${-size * 0.17} ${size * 0.02} L 0 ${size * 0.2} L ${size * 0.17} ${size * 0.02}" fill="none" stroke="#fff" stroke-width="${Math.max(3, size * 0.055)}" stroke-linecap="round" stroke-linejoin="round"/>
    </g>
  </svg>`)
  return sharp(svg).png().toBuffer()
}

for (const fixture of [
  { width: 720, height: 1600, centerY: 1080, size: 72 },
  { width: 1080, height: 2400, centerY: 1580, size: 108 },
  { width: 720, height: 1600, centerY: 1310, size: 72 },
  { width: 1080, height: 2400, centerY: 2095, size: 108 },
]) {
  test(`floating down-arrow image fallback scales to ${fixture.width}x${fixture.height}`, async () => {
    const image = await arrowImage(fixture.width, fixture.height, fixture.centerY, fixture.size)
    const detected = await detectFloatingDownArrow(image, [0, 180, fixture.width, fixture.height - 260])
    assert.ok(detected)
    assert.ok(Math.abs((detected.bounds[0] + detected.bounds[2]) / 2 - fixture.width / 2) <= 2)
    assert.ok(Math.abs((detected.bounds[1] + detected.bounds[3]) / 2 - fixture.centerY) <= fixture.size * 0.15)
    assert.ok(detected.bounds[2] - detected.bounds[0] >= fixture.width * 0.11)
  })
}

test('floating down-arrow image fallback detects a light arrow on the dark Xiaohe button', async () => {
  const image = await inverseArrowImage(1272, 2800, 1920, 126)
  const detected = await detectFloatingDownArrow(image, [0, 440, 1272, 2296])
  assert.ok(detected)
  assert.equal(detected.polarity, 'light_on_dark')
  assert.ok(Math.abs((detected.bounds[1] + detected.bounds[3]) / 2 - 1920) <= 20)
})

test('floating down-arrow fallback does not report a blank viewport', async () => {
  const blank = await sharp({ create: { width: 720, height: 1600, channels: 3, background: '#fff' } }).png().toBuffer()
  assert.equal(await detectFloatingDownArrow(blank, [0, 180, 720, 1340]), null)
})

test('shaftless miniapp chevron requires a circular shadow and scales across portrait sizes', async () => {
  for (const scale of [2 / 3, 1]) {
    const width = Math.round(1080 * scale), height = Math.round(2400 * scale)
    for (const shadow of [false, true]) {
      const svg = Buffer.from(`<svg width="${width}" height="${height}" viewBox="0 0 1080 2400"><rect width="1080" height="2400" fill="white"/>
        ${shadow ? '<circle cx="540" cy="1846" r="72" fill="#dddddd"/><circle cx="540" cy="1840" r="60" fill="white"/>' : ''}
        <path d="M520 1832 L540 1852 L560 1832" stroke="#171b26" stroke-width="5" stroke-linecap="round" fill="none"/></svg>`)
      const image = await sharp(svg).png().toBuffer()
      const detected = await detectFloatingDownArrow(image, [0, height * 0.13, width, height * 0.815])
      if (!shadow) assert.equal(detected, null)
      else {
        assert.equal(detected?.shape, 'chevron')
        assert.ok(detected.bounds[1] <= 1785 * scale)
      }
    }
  }
})

test('floating down-arrow fallback rejects text strokes and gaps inside drug controls', async () => {
  for (const width of [720, 1080]) {
    const height = width * 20 / 9
    const svg = Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="white"/>
      <text x="50%" y="75%" text-anchor="middle" font-family="PingFang SC" font-weight="bold" font-size="${width * 0.042}">查看全部药品</text></svg>`)
    assert.equal(await detectFloatingDownArrow(await sharp(svg).png().toBuffer(), [0, height * 0.14, width, height * 0.82]), null)
  }
})

test('ambiguous movement without new-content evidence is not admitted into the frame sequence', () => {
  assert.equal(shouldDiscardUnprovenCandidate({
    transition: { verified: false, fallbackOverlap: 0 },
    reliableMeasuredShift: null,
    newContentEvidence: { provesNewContent: false, candidateOverlaps: [695, 899] },
    bottomContext: true,
  }), true)
  assert.equal(shouldDiscardUnprovenCandidate({
    transition: { verified: false, fallbackOverlap: 0 },
    reliableMeasuredShift: 510,
    newContentEvidence: { provesNewContent: false },
    bottomContext: true,
  }), false)
  assert.equal(shouldDiscardUnprovenCandidate({
    transition: { verified: false, fallbackOverlap: 0 },
    reliableMeasuredShift: null,
    newContentEvidence: { provesNewContent: true },
    bottomContext: true,
  }), false)
  assert.equal(shouldDiscardUnprovenCandidate({
    transition: { verified: false, fallbackOverlap: 0 },
    reliableMeasuredShift: null,
    newContentEvidence: { provesNewContent: false },
    bottomContext: false,
  }), false)
})
