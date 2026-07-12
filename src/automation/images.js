const sharp = require('sharp')

async function imageInfo(image) {
  const metadata = await sharp(image).metadata()
  if (!metadata.width || !metadata.height) throw new Error('截图缺少有效尺寸。')
  return { width: metadata.width, height: metadata.height }
}

async function cropImage(image, bounds) {
  const { width, height } = await imageInfo(image)
  const left = Math.max(0, Math.min(bounds[0], width - 1))
  const top = Math.max(0, Math.min(bounds[1], height - 1))
  const right = Math.max(left + 1, Math.min(bounds[2], width))
  const bottom = Math.max(top + 1, Math.min(bounds[3], height))
  return sharp(image).extract({ left, top, width: right - left, height: bottom - top }).png().toBuffer()
}

async function rawImage(image) {
  const result = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  return { data: result.data, width: result.info.width, height: result.info.height, channels: result.info.channels }
}

async function imagesMeanDiff(first, second) {
  const a = await rawImage(first)
  const b = await rawImage(second)
  if (a.width !== b.width || a.height !== b.height || a.channels !== b.channels) return 255
  let total = 0
  for (let index = 0; index < a.data.length; index += 1) total += Math.abs(a.data[index] - b.data[index])
  return total / a.data.length
}

async function imagesSimilar(first, second, threshold = 6) { return (await imagesMeanDiff(first, second)) <= threshold }

async function imageHasVisibleContent(image) {
  const { data } = await rawImage(image)
  let bright = 0
  for (let index = 0; index < data.length; index += 3) {
    const luminosity = Math.round(data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114)
    if (luminosity >= 32) bright += 1
  }
  return bright / Math.max(1, data.length / 3) >= 0.004
}

async function createCanvas(width, height) {
  return sharp({ create: { width, height, channels: 3, background: { r: 0, g: 0, b: 0 } } })
}

async function stackFramesInGroups(frames, groupSize = 3) {
  if (groupSize < 1) throw new Error('groupSize must be positive')
  const output = []
  for (let index = 0; index < frames.length; index += groupSize) {
    const chunk = frames.slice(index, index + groupSize)
    const sizes = await Promise.all(chunk.map(imageInfo))
    const width = Math.max(...sizes.map(size => size.width))
    const height = sizes.reduce((sum, size) => sum + size.height, 0)
    let y = 0
    const composite = chunk.map((input, frameIndex) => {
      const item = { input, left: 0, top: y }
      y += sizes[frameIndex].height
      return item
    })
    output.push(await (await createCanvas(width, height)).composite(composite).png().toBuffer())
  }
  return output
}

async function findVerticalOverlapWithScore(previous, current, expected = null) {
  const prevSize = await imageInfo(previous)
  const currSize = await imageInfo(current)
  const width = Math.min(prevSize.width, currSize.width)
  const x0 = Math.floor(width / 8)
  const x1 = width - Math.floor(width / 8)
  const prev = await cropImage(previous, [x0, 0, x1, prevSize.height])
  const curr = await cropImage(current, [x0, 0, x1, currSize.height])
  const prevCropSize = await imageInfo(prev)
  const currCropSize = await imageInfo(curr)
  const maxOverlap = Math.min(prevCropSize.height, currCropSize.height) - 8
  const minOverlap = Math.min(40, Math.floor(maxOverlap / 2))
  if (maxOverlap <= minOverlap) return { overlap: Math.max(0, Math.floor(Math.min(prevCropSize.height, currCropSize.height) / 3)), score: 255 }
  let low = minOverlap
  let high = maxOverlap
  if (expected !== null) {
    low = Math.max(minOverlap, expected - 80)
    high = Math.min(maxOverlap, expected + 80)
    if (low >= high) { low = minOverlap; high = maxOverlap }
  }
  let bestOverlap = Math.floor((low + high) / 2)
  let bestScore = 255
  for (let overlap = high; overlap >= low; overlap -= 3) {
    const prevTail = await cropImage(prev, [0, prevCropSize.height - overlap, prevCropSize.width, prevCropSize.height])
    const currHead = await cropImage(curr, [0, 0, currCropSize.width, overlap])
    const score = await imagesMeanDiff(prevTail, currHead)
    if (score < bestScore - 0.35 || (Math.abs(score - bestScore) <= 0.35 && overlap > bestOverlap)) { bestScore = score; bestOverlap = overlap }
  }
  return { overlap: bestScore > 16 ? (expected ?? Math.max(minOverlap, Math.floor(Math.min(prevCropSize.height, currCropSize.height) / 3))) : bestOverlap, score: bestScore }
}

async function verifyFrameOverlap(previous, current, expected) {
  // The swipe distance gives us a reliable narrow search window. A second
  // full-height scan is extremely expensive on high-resolution phones and is
  // unnecessary: callers preserve complete viewports when this check fails.
  const result = await findVerticalOverlapWithScore(previous, current, expected)
  if (result.score > 24) throw new Error(`无法验证相邻截图连续性（差异分数 ${result.score.toFixed(1)}）；已停止保存以避免漏图。`)
  return result.overlap
}

async function stitchVertical(frames, expectedOverlap = null) {
  if (!frames.length) throw new Error('没有可拼接的截图。')
  let result = frames[0]
  for (const frame of frames.slice(1)) {
    const overlap = await findVerticalOverlapWithScore(result, frame, expectedOverlap).then(value => value.overlap)
    const size = await imageInfo(frame)
    if (overlap >= size.height) continue
    const addition = await cropImage(frame, [0, overlap, size.width, size.height])
    const resultSize = await imageInfo(result)
    const additionSize = await imageInfo(addition)
    result = await (await createCanvas(Math.max(resultSize.width, additionSize.width), resultSize.height + additionSize.height))
      .composite([{ input: result, left: 0, top: 0 }, { input: addition, left: 0, top: resultSize.height }]).png().toBuffer()
  }
  return result
}

async function stitchFramesInGroups(frames, groupSize = 3, expectedOverlapRatio = 0.4) {
  if (groupSize < 1) throw new Error('groupSize must be positive')
  const expected = frames.length ? Math.max(12, Math.floor((await imageInfo(frames[0])).height * expectedOverlapRatio)) : null
  const groups = []
  for (let index = 0; index < frames.length; index += groupSize) groups.push(await stitchVertical(frames.slice(index, index + groupSize), expected))
  return groups
}

module.exports = { imageInfo, cropImage, imagesMeanDiff, imagesSimilar, imageHasVisibleContent, stackFramesInGroups, verifyFrameOverlap, stitchFramesInGroups }
