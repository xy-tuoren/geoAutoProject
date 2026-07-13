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

async function imageLooksLoaded(image) {
  const { data, width, height, channels } = await rawImage(image)
  const pixels = Math.max(1, width * height)
  let sum = 0
  let sumSquares = 0
  let bright = 0
  let edges = 0
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * channels
      const luminosity = data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114
      sum += luminosity
      sumSquares += luminosity * luminosity
      if (luminosity >= 48) bright += 1
      if (x > 0) {
        const left = index - channels
        const leftLuminosity = data[left] * 0.299 + data[left + 1] * 0.587 + data[left + 2] * 0.114
        if (Math.abs(luminosity - leftLuminosity) >= 28) edges += 1
      }
    }
  }
  const mean = sum / pixels
  const deviation = Math.sqrt(Math.max(0, sumSquares / pixels - mean * mean))
  const brightRatio = bright / pixels
  const edgeRatio = edges / pixels
  return deviation >= 10 && (brightRatio >= 0.015 || edgeRatio >= 0.008)
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
  // Ignore the centre of the viewport where the app pins a floating down-arrow
  // button. Compare two text bands and keep the better score so a fixed overlay
  // or one lazy-loaded card cannot invalidate an otherwise continuous page.
  const bands = [[0.06, 0.43], [0.57, 0.94]]
  const pairs = await Promise.all(bands.map(async ([from, to]) => ({
    previous: await cropImage(previous, [Math.floor(width * from), 0, Math.floor(width * to), prevSize.height]),
    current: await cropImage(current, [Math.floor(width * from), 0, Math.floor(width * to), currSize.height]),
  })))
  const prevCropSize = await imageInfo(pairs[0].previous)
  const currCropSize = await imageInfo(pairs[0].current)
  const maxOverlap = Math.min(prevCropSize.height, currCropSize.height) - 8
  const minOverlap = Math.min(40, Math.floor(maxOverlap / 2))
  if (maxOverlap <= minOverlap) return { overlap: Math.max(0, Math.floor(Math.min(prevCropSize.height, currCropSize.height) / 3)), score: 255 }
  let low = minOverlap
  let high = maxOverlap
  if (expected !== null) {
    low = Math.max(minOverlap, expected - 260)
    high = Math.min(maxOverlap, expected + 260)
    if (low >= high) { low = minOverlap; high = maxOverlap }
  }
  let bestOverlap = Math.floor((low + high) / 2)
  let bestScore = 255
  for (let overlap = high; overlap >= low; overlap -= 3) {
    const scores = await Promise.all(pairs.map(async pair => {
      const prevTail = await cropImage(pair.previous, [0, prevCropSize.height - overlap, prevCropSize.width, prevCropSize.height])
      const currHead = await cropImage(pair.current, [0, 0, currCropSize.width, overlap])
      return imagesMeanDiff(prevTail, currHead)
    }))
    const score = Math.min(...scores)
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

async function stitchFramesWithOverlaps(frames, overlaps, groupSize = 3) {
  if (groupSize < 1) throw new Error('groupSize must be positive')
  if (overlaps.length !== Math.max(0, frames.length - 1)) throw new Error('每对相邻截图都必须提供已验证的重叠高度。')
  const output = []
  for (let start = 0; start < frames.length; start += groupSize) {
    let result = frames[start]
    const end = Math.min(frames.length, start + groupSize)
    for (let index = start + 1; index < end; index += 1) {
      const frame = frames[index]
      const size = await imageInfo(frame)
      const overlap = Math.max(0, Math.min(overlaps[index - 1], size.height))
      if (overlap >= size.height) continue
      const addition = await cropImage(frame, [0, overlap, size.width, size.height])
      const resultSize = await imageInfo(result)
      const additionSize = await imageInfo(addition)
      result = await (await createCanvas(Math.max(resultSize.width, additionSize.width), resultSize.height + additionSize.height))
        .composite([{ input: result, left: 0, top: 0 }, { input: addition, left: 0, top: resultSize.height }]).png().toBuffer()
    }
    output.push(result)
  }
  return output
}

async function stackFramesWithSeparators(frames, separatorHeight = 24) {
  if (!frames.length) throw new Error('没有可拼接的截图。')
  const sizes = await Promise.all(frames.map(imageInfo))
  const width = Math.max(...sizes.map(size => size.width))
  const height = sizes.reduce((sum, size) => sum + size.height, 0) + separatorHeight * Math.max(0, frames.length - 1)
  let y = 0
  const composite = []
  const separator = separatorHeight > 0
    ? await sharp({ create: { width, height: separatorHeight, channels: 3, background: '#343940' } }).png().toBuffer()
    : null
  for (const [index, input] of frames.entries()) {
    composite.push({ input, left: 0, top: y })
    y += sizes[index].height
    if (separator && index < frames.length - 1) { composite.push({ input: separator, left: 0, top: y }); y += separatorHeight }
  }
  return (await createCanvas(width, height)).composite(composite).png().toBuffer()
}

async function composeLongImages(frames, { overlaps = [], continuityVerified = false, maxHeight = 12_000, separatorHeight = 24 } = {}) {
  if (!frames.length) throw new Error('没有可拼接的截图。')
  if (!Number.isInteger(maxHeight) || maxHeight < 1_000) throw new Error('内部拼图高度必须是不小于 1000 的整数。')
  if (continuityVerified && overlaps.length !== Math.max(0, frames.length - 1)) throw new Error('每对相邻截图都必须提供已验证的重叠高度。')
  const sizes = await Promise.all(frames.map(imageInfo))
  const groups = []
  let start = 0
  let height = sizes[0].height
  for (let index = 1; index < frames.length; index += 1) {
    const addition = continuityVerified
      ? Math.max(1, sizes[index].height - overlaps[index - 1])
      : sizes[index].height + separatorHeight
    if (height + addition > maxHeight) {
      groups.push([start, index])
      start = index
      height = sizes[index].height
    } else height += addition
  }
  groups.push([start, frames.length])
  const output = []
  for (const [groupStart, groupEnd] of groups) {
    const chunk = frames.slice(groupStart, groupEnd)
    if (continuityVerified) {
      const chunkOverlaps = overlaps.slice(groupStart, groupEnd - 1)
      output.push((await stitchFramesWithOverlaps(chunk, chunkOverlaps, chunk.length))[0])
    } else output.push(await stackFramesWithSeparators(chunk, separatorHeight))
  }
  return output
}

async function cropFramesAtTextSeams(frames, seams) {
  if (seams.length !== Math.max(0, frames.length - 1)) throw new Error('每对相邻截图都必须提供共享文本接缝。')
  const output = []
  for (const [index, frame] of frames.entries()) {
    const size = await imageInfo(frame)
    const top = index === 0 ? 0 : seams[index - 1].currentStart
    const bottom = index === frames.length - 1 ? size.height : seams[index].previousEnd
    if (bottom - top < 20) throw new Error('共享文本接缝产生了无效截图区间。')
    output.push(await cropImage(frame, [0, top, size.width, bottom]))
  }
  return output
}

async function textSeamsAreValid(frames, seams) {
  if (seams.length !== Math.max(0, frames.length - 1)) return false
  const sizes = await Promise.all(frames.map(imageInfo))
  return frames.every((_frame, index) => {
    const top = index === 0 ? 0 : seams[index - 1].currentStart
    const bottom = index === frames.length - 1 ? sizes[index].height : seams[index].previousEnd
    return Number.isFinite(top) && Number.isFinite(bottom) && top >= 0 && bottom <= sizes[index].height && bottom - top >= 20
  })
}

module.exports = { imageInfo, cropImage, imagesMeanDiff, imagesSimilar, imageHasVisibleContent, imageLooksLoaded, stackFramesInGroups, verifyFrameOverlap, stitchFramesInGroups, stitchFramesWithOverlaps, stackFramesWithSeparators, composeLongImages, cropFramesAtTextSeams, textSeamsAreValid }
