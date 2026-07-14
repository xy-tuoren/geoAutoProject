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

async function imageRegionsStable(first, second, {
  globalThreshold = 1.5,
  tileMeanThreshold = 2.5,
  changedPixelThreshold = 12,
  changedRatioThreshold = 0.02,
  tileSize = 60,
} = {}) {
  const [a, b] = await Promise.all([rawImage(first), rawImage(second)])
  if (a.width !== b.width || a.height !== b.height || a.channels !== b.channels) return false
  let globalDiff = 0
  let globalPixels = 0
  for (let top = 0; top < a.height; top += tileSize) {
    for (let left = 0; left < a.width; left += tileSize) {
      const bottom = Math.min(a.height, top + tileSize)
      const right = Math.min(a.width, left + tileSize)
      let tileDiff = 0
      let changed = 0
      let pixels = 0
      for (let y = top; y < bottom; y += 1) {
        for (let x = left; x < right; x += 1) {
          const offset = (y * a.width + x) * a.channels
          const diff = (Math.abs(a.data[offset] - b.data[offset]) + Math.abs(a.data[offset + 1] - b.data[offset + 1]) + Math.abs(a.data[offset + 2] - b.data[offset + 2])) / 3
          tileDiff += diff
          if (diff >= changedPixelThreshold) changed += 1
          pixels += 1
        }
      }
      const mean = tileDiff / Math.max(1, pixels)
      const changedRatio = changed / Math.max(1, pixels)
      if (mean > tileMeanThreshold || changedRatio > changedRatioThreshold) return false
      globalDiff += tileDiff
      globalPixels += pixels
    }
  }
  return globalDiff / Math.max(1, globalPixels) <= globalThreshold
}

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

async function alignCropToWhitespace(image, target, {
  searchBefore = null,
  searchAfter = null,
  minimumBand = 8,
  returnNullIfMissing = false,
} = {}) {
  const raw = await rawImage(image)
  const wanted = Math.max(1, Math.min(raw.height - 1, Math.round(target)))
  const before = searchBefore ?? Math.max(60, Math.round(raw.height * 0.06))
  const after = searchAfter ?? Math.max(32, Math.round(raw.height * 0.025))
  const top = Math.max(1, wanted - before)
  const bottom = Math.min(raw.height - 2, wanted + after)
  const left = Math.max(1, Math.floor(raw.width * 0.06))
  const right = Math.min(raw.width - 1, Math.ceil(raw.width * 0.94))
  const blank = []
  for (let y = top; y <= bottom; y += 1) {
    let edges = 0
    let samples = 0
    for (let x = left; x < right; x += 2) {
      const offset = (y * raw.width + x) * raw.channels
      const previous = offset - raw.channels * 2
      if (Math.abs(luminosity(raw.data, offset) - luminosity(raw.data, previous)) >= 12) edges += 1
      samples += 1
    }
    blank.push(edges / Math.max(1, samples) <= 0.004)
  }

  const halfBand = Math.floor(minimumBand / 2)
  const candidates = []
  let start = -1
  for (let index = 0; index <= blank.length; index += 1) {
    if (blank[index] && start < 0) start = index
    if ((!blank[index] || index === blank.length) && start >= 0) {
      const end = index - 1
      if (end - start + 1 >= minimumBand) {
        const low = top + start + halfBand
        const high = top + end - (minimumBand - halfBand - 1)
        candidates.push(Math.max(low, Math.min(high, wanted)))
      }
      start = -1
    }
  }
  if (!candidates.length) return returnNullIfMissing ? null : wanted
  candidates.sort((a, b) => Math.abs(a - wanted) - Math.abs(b - wanted) || b - a)
  return candidates[0]
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

function luminosity(data, offset) {
  return (data[offset] * 77 + data[offset + 1] * 150 + data[offset + 2] * 29) >> 8
}

function overlapScore(previous, current, overlap, band, { xStep, yStep }) {
  const width = Math.min(previous.width, current.width)
  const height = Math.min(overlap, previous.height, current.height)
  const previousTop = previous.height - height
  const left = Math.max(0, Math.floor(width * band[0]))
  const right = Math.min(width, Math.ceil(width * band[1]))
  let difference = 0
  let content = 0
  let samples = 0
  for (let y = 0; y < height; y += yStep) {
    for (let x = left; x < right; x += xStep) {
      const previousOffset = ((previousTop + y) * previous.width + x) * previous.channels
      const currentOffset = (y * current.width + x) * current.channels
      const a = luminosity(previous.data, previousOffset)
      const b = luminosity(current.data, currentOffset)
      difference += Math.abs(a - b)
      if (a < 245 || b < 245) content += 1
      samples += 1
    }
  }
  return { score: difference / Math.max(1, samples), contentRatio: content / Math.max(1, samples) }
}

function candidateRange(low, high, step) {
  const values = []
  for (let value = low; value <= high; value += step) values.push(value)
  if (values.at(-1) !== high) values.push(high)
  return values
}

function bestBandOverlap(previous, current, band, low, high) {
  let best = { overlap: low, score: Number.POSITIVE_INFINITY, contentRatio: 0 }
  for (const overlap of candidateRange(low, high, 4)) {
    const result = overlapScore(previous, current, overlap, band, { xStep: 8, yStep: 10 })
    if (result.score < best.score) best = { overlap, ...result }
  }
  const refineLow = Math.max(low, best.overlap - 6)
  const refineHigh = Math.min(high, best.overlap + 6)
  for (let overlap = refineLow; overlap <= refineHigh; overlap += 1) {
    const result = overlapScore(previous, current, overlap, band, { xStep: 4, yStep: 4 })
    if (result.score < best.score) best = { overlap, ...result }
  }
  return best
}

function overlapTilesStable(previous, current, overlap, band) {
  const width = Math.min(previous.width, current.width)
  const height = Math.min(overlap, previous.height, current.height)
  const previousTop = previous.height - height
  const left = Math.max(0, Math.floor(width * band[0]))
  const right = Math.min(width, Math.ceil(width * band[1]))
  const tileSize = 64
  for (let top = 0; top < height; top += tileSize) {
    for (let tileLeft = left; tileLeft < right; tileLeft += tileSize) {
      const bottom = Math.min(height, top + tileSize)
      const tileRight = Math.min(right, tileLeft + tileSize)
      let difference = 0
      let changed = 0
      let content = 0
      let pixels = 0
      for (let y = top; y < bottom; y += 2) {
        for (let x = tileLeft; x < tileRight; x += 2) {
          const previousOffset = ((previousTop + y) * previous.width + x) * previous.channels
          const currentOffset = (y * current.width + x) * current.channels
          const a = luminosity(previous.data, previousOffset)
          const b = luminosity(current.data, currentOffset)
          const diff = Math.abs(a - b)
          difference += diff
          if (diff >= 12) changed += 1
          if (a < 245 || b < 245) content += 1
          pixels += 1
        }
      }
      if (content / Math.max(1, pixels) >= 0.004
        && (difference / Math.max(1, pixels) > 3 || changed / Math.max(1, pixels) > 0.08)) return false
    }
  }
  return true
}

async function findVerticalOverlapWithScore(previous, current, expected = null) {
  const [previousRaw, currentRaw] = await Promise.all([rawImage(previous), rawImage(current)])
  const maxOverlap = Math.min(previousRaw.height, currentRaw.height) - 8
  const minOverlap = Math.min(40, Math.floor(maxOverlap / 2))
  if (maxOverlap <= minOverlap) return { overlap: Math.max(0, Math.floor(Math.min(previousRaw.height, currentRaw.height) / 3)), candidateOverlaps: [], score: 255, valid: false, reason: '截图高度不足' }
  let low = minOverlap
  let high = maxOverlap
  if (expected !== null) {
    low = Math.max(minOverlap, Math.round(expected) - 260)
    high = Math.min(maxOverlap, Math.round(expected) + 260)
    if (low >= high) { low = minOverlap; high = maxOverlap }
  }
  // The centre gap masks the app's pinned down-arrow. Both remaining text
  // regions must independently find the same vertical displacement.
  const bands = [[0.06, 0.43], [0.57, 0.94]]
  const results = bands.map(band => bestBandOverlap(previousRaw, currentRaw, band, low, high))
  const usable = results.filter(result => result.contentRatio >= 0.004)
  if (usable.length < 2) return { overlap: expected ?? results[0].overlap, candidateOverlaps: usable.map(result => result.overlap), score: Math.max(...results.map(result => result.score)), valid: false, reason: '相邻截图缺少足够的可比内容' }
  const overlaps = usable.map(result => result.overlap)
  if (Math.max(...overlaps) - Math.min(...overlaps) > 3) {
    return { overlap: Math.round(overlaps.reduce((sum, value) => sum + value, 0) / overlaps.length), candidateOverlaps: overlaps, score: Math.max(...usable.map(result => result.score)), valid: false, reason: `不同图像区域测得的滚动位移不一致（重叠 ${overlaps.join('/')}px）` }
  }
  const overlap = Math.round(overlaps.reduce((sum, value) => sum + value, 0) / overlaps.length)
  const validation = bands.map(band => overlapScore(previousRaw, currentRaw, overlap, band, { xStep: 2, yStep: 2 }))
  const score = Math.max(...validation.map(result => result.score))
  const tilesStable = bands.every(band => overlapTilesStable(previousRaw, currentRaw, overlap, band))
  const valid = score <= 8 && tilesStable
  return { overlap, candidateOverlaps: overlaps, score, valid, reason: valid ? null : (tilesStable ? `差异分数 ${score.toFixed(1)}` : '局部内容发生变化') }
}

async function verifyFrameOverlap(previous, current, expected) {
  const result = await findVerticalOverlapWithScore(previous, current, expected)
  if (!result.valid) {
    const error = new Error(`无法验证相邻截图连续性（${result.reason || `差异分数 ${result.score.toFixed(1)}`}）；已停止无缝拼接以避免叠字或漏图。`)
    error.candidateOverlaps = result.candidateOverlaps || []
    error.suggestedOverlap = result.overlap
    throw error
  }
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

async function stitchFramesWithTransitions(frames, transitions, separatorHeight = 24, separatorColor = '#eef1f4') {
  if (!frames.length) throw new Error('没有可拼接的截图。')
  if (transitions.length !== Math.max(0, frames.length - 1)) throw new Error('每对相邻截图都必须提供接缝状态。')
  let result = frames[0]
  for (let index = 1; index < frames.length; index += 1) {
    const frame = frames[index]
    const size = await imageInfo(frame)
    const transition = transitions[index - 1]
    const cropTop = Math.max(0, Math.min(
      transition.verified ? transition.overlap : transition.fallbackOverlap,
      size.height - 1,
    ))
    const addition = await cropImage(frame, [0, cropTop, size.width, size.height])
    const resultSize = await imageInfo(result)
    const additionSize = await imageInfo(addition)
    const gap = transition.verified ? 0 : separatorHeight
    const composite = [{ input: result, left: 0, top: 0 }]
    if (gap > 0) {
      const separator = await sharp({ create: { width: Math.max(resultSize.width, additionSize.width), height: gap, channels: 3, background: separatorColor } }).png().toBuffer()
      composite.push({ input: separator, left: 0, top: resultSize.height })
    }
    composite.push({ input: addition, left: 0, top: resultSize.height + gap })
    result = await (await createCanvas(Math.max(resultSize.width, additionSize.width), resultSize.height + gap + additionSize.height))
      .composite(composite).png().toBuffer()
  }
  return result
}

async function composeLongImages(frames, { overlaps = [], continuityVerified = false, transitions = null, maxHeight = 12_000, separatorHeight = 24 } = {}) {
  if (!frames.length) throw new Error('没有可拼接的截图。')
  if (!Number.isInteger(maxHeight) || maxHeight < 1_000) throw new Error('内部拼图高度必须是不小于 1000 的整数。')
  if (transitions && transitions.length !== Math.max(0, frames.length - 1)) throw new Error('每对相邻截图都必须提供接缝状态。')
  if (continuityVerified && overlaps.length !== Math.max(0, frames.length - 1)) throw new Error('每对相邻截图都必须提供已验证的重叠高度。')
  const sizes = await Promise.all(frames.map(imageInfo))
  const groups = []
  let start = 0
  let firstCrop = 0
  let height = sizes[0].height
  for (let index = 1; index < frames.length; index += 1) {
    const transition = transitions?.[index - 1]
    const cropTop = transition
      ? (transition.verified ? transition.overlap : transition.fallbackOverlap)
      : (continuityVerified ? overlaps[index - 1] : 0)
    const addition = Math.max(1, sizes[index].height - Math.max(0, cropTop))
      + ((transition && !transition.verified) || (!transitions && !continuityVerified) ? separatorHeight : 0)
    if (height + addition > maxHeight) {
      groups.push({ start, end: index, firstCrop })
      start = index
      firstCrop = transitions || continuityVerified
        ? Math.max(0, Math.min(cropTop, sizes[index].height - 1))
        : 0
      height = sizes[index].height - firstCrop
    } else height += addition
  }
  groups.push({ start, end: frames.length, firstCrop })
  const output = []
  for (const group of groups) {
    const { start: groupStart, end: groupEnd } = group
    const chunk = frames.slice(groupStart, groupEnd)
    if (group.firstCrop > 0) {
      chunk[0] = await cropImage(chunk[0], [0, group.firstCrop, sizes[groupStart].width, sizes[groupStart].height])
    }
    if (transitions) {
      output.push(await stitchFramesWithTransitions(chunk, transitions.slice(groupStart, groupEnd - 1), separatorHeight))
    } else if (continuityVerified) {
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

module.exports = { imageInfo, cropImage, imagesMeanDiff, imagesSimilar, imageRegionsStable, imageHasVisibleContent, imageLooksLoaded, alignCropToWhitespace, stackFramesInGroups, verifyFrameOverlap, stitchFramesInGroups, stitchFramesWithOverlaps, stackFramesWithSeparators, stitchFramesWithTransitions, composeLongImages, cropFramesAtTextSeams, textSeamsAreValid }
