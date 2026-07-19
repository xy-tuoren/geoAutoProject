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

function darkContentMetrics(raw, bounds = [0, 0, raw.width, raw.height]) {
  const left = Math.max(0, Math.floor(bounds[0]))
  const top = Math.max(0, Math.floor(bounds[1]))
  const right = Math.min(raw.width, Math.ceil(bounds[2]))
  const bottom = Math.min(raw.height, Math.ceil(bounds[3]))
  let dark = 0
  let edges = 0
  let samples = 0
  for (let y = top; y < bottom; y += 2) {
    for (let x = left; x < right; x += 2) {
      const offset = (y * raw.width + x) * raw.channels
      const value = luminosity(raw.data, offset)
      if (value < 225) dark += 1
      if (x >= left + 2) {
        const previous = offset - raw.channels * 2
        if (Math.abs(value - luminosity(raw.data, previous)) >= 18) edges += 1
      }
      samples += 1
    }
  }
  return {
    darkRatio: dark / Math.max(1, samples),
    edgeRatio: edges / Math.max(1, samples),
  }
}

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
  const coarse = candidateRange(low, high, 4).map(overlap => ({
    overlap,
    ...overlapScore(previous, current, overlap, band, { xStep: 8, yStep: 10 }),
  }))
  let best = coarse.reduce((winner, candidate) => candidate.score < winner.score ? candidate : winner)
  const localMinima = coarse
    .filter((candidate, index) => (index === 0 || candidate.score <= coarse[index - 1].score)
      && (index === coarse.length - 1 || candidate.score <= coarse[index + 1].score))
    .sort((a, b) => a.score - b.score)
  const refineSeeds = []
  for (const candidate of localMinima) {
    if (refineSeeds.every(seed => Math.abs(seed.overlap - candidate.overlap) > 6)) refineSeeds.push(candidate)
    if (refineSeeds.length >= 12) break
  }
  // A one-pixel-perfect seam can sit between the 4px coarse samples while a
  // quiet footer produces a deceptively better coarse score. Refine several
  // independent minima so the exact content alignment still gets measured.
  for (const seed of refineSeeds) {
    const refineLow = Math.max(low, seed.overlap - 3)
    const refineHigh = Math.min(high, seed.overlap + 3)
    for (let overlap = refineLow; overlap <= refineHigh; overlap += 1) {
      const result = overlapScore(previous, current, overlap, band, { xStep: 4, yStep: 4 })
      if (result.score < best.score) best = { overlap, ...result }
    }
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

function validateOverlapCandidate(previous, current, overlap, bands) {
  const validation = bands.map(band => overlapScore(previous, current, overlap, band, { xStep: 2, yStep: 2 }))
  const score = Math.max(...validation.map(result => result.score))
  const tilesStable = bands.every(band => overlapTilesStable(previous, current, overlap, band))
  return { overlap, score, valid: score <= 8 && tilesStable, tilesStable }
}

function refineOverlapCandidate(previous, current, overlap, bands, minOverlap, maxOverlap) {
  let best = null
  const low = Math.max(minOverlap, overlap - 6)
  const high = Math.min(maxOverlap, overlap + 6)
  for (let candidate = low; candidate <= high; candidate += 1) {
    const validation = validateOverlapCandidate(previous, current, candidate, bands)
    if (!best || validation.score < best.score) best = validation
  }
  return best
}

async function findVerticalOverlapWithScore(previous, current, expected = null, {
  bands = [[0.06, 0.43], [0.57, 0.94]],
  minimumUsable = bands.length,
} = {}) {
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
  // The default centre gap masks the app's pinned down-arrow. Both remaining
  // text regions must independently find the same vertical displacement.
  const results = bands.map(band => bestBandOverlap(previousRaw, currentRaw, band, low, high))
  const usable = results.filter(result => result.contentRatio >= 0.004)
  if (usable.length < minimumUsable) return { overlap: expected ?? results[0].overlap, candidateOverlaps: usable.map(result => result.overlap), score: Math.max(...results.map(result => result.score)), valid: false, reason: '相邻截图缺少足够的可比内容' }
  const overlaps = usable.map(result => result.overlap)
  if (Math.max(...overlaps) - Math.min(...overlaps) > 3) {
    // A mostly uniform side of a short final viewport can match many offsets
    // and choose the minimum search bound, while the text-rich side finds the
    // real near-full overlap. Recheck each distinct candidate against every
    // band and accept it only when exactly one offset satisfies all evidence.
    const candidates = [...new Set(overlaps)].map(overlap => refineOverlapCandidate(previousRaw, currentRaw, overlap, bands, minOverlap, maxOverlap))
    const validCandidates = candidates.filter(candidate => candidate.valid)
    if (validCandidates.length === 1) {
      const candidate = validCandidates[0]
      return { ...candidate, candidateOverlaps: overlaps, reason: null }
    }
    return { overlap: Math.round(overlaps.reduce((sum, value) => sum + value, 0) / overlaps.length), candidateOverlaps: overlaps, score: Math.max(...usable.map(result => result.score)), valid: false, reason: `不同图像区域测得的滚动位移不一致（重叠 ${overlaps.join('/')}px）` }
  }
  const overlap = Math.round(overlaps.reduce((sum, value) => sum + value, 0) / overlaps.length)
  const candidate = validateOverlapCandidate(previousRaw, currentRaw, overlap, bands)
  return { ...candidate, candidateOverlaps: overlaps, reason: candidate.valid ? null : (candidate.tilesStable ? `差异分数 ${candidate.score.toFixed(1)}` : '局部内容发生变化') }
}

const REPLY_OVERLAP_BANDS = [[0.04, 0.24], [0.26, 0.46], [0.54, 0.74], [0.76, 0.96]]

function largestOverlapConsensus(results, tolerance = 3) {
  let best = []
  for (const pivot of results) {
    const cluster = results.filter(result => Math.abs(result.overlap - pivot.overlap) <= tolerance)
    if (cluster.length > best.length || (cluster.length === best.length
      && cluster.reduce((sum, item) => sum + item.score, 0) < best.reduce((sum, item) => sum + item.score, 0))) best = cluster
  }
  return best
}

async function findReplyOverlapWithScore(previous, current, expected = null) {
  const [previousRaw, currentRaw] = await Promise.all([rawImage(previous), rawImage(current)])
  const maxOverlap = Math.min(previousRaw.height, currentRaw.height) - 8
  const minOverlap = Math.min(40, Math.floor(maxOverlap / 2))
  if (maxOverlap <= minOverlap) {
    return { overlap: Math.max(0, Math.floor(Math.min(previousRaw.height, currentRaw.height) / 3)), candidateOverlaps: [], score: 255, valid: false, reason: '截图高度不足' }
  }
  let low = minOverlap
  let high = maxOverlap
  if (expected !== null) {
    low = Math.max(minOverlap, Math.round(expected) - 260)
    high = Math.min(maxOverlap, Math.round(expected) + 260)
    if (low >= high) { low = minOverlap; high = maxOverlap }
  }
  const results = REPLY_OVERLAP_BANDS.map(band => ({
    band,
    ...bestBandOverlap(previousRaw, currentRaw, band, low, high),
  }))
  const usable = results.filter(result => result.contentRatio >= 0.004)
  const candidateOverlaps = usable.map(result => result.overlap)
  if (usable.length < 3) {
    return { overlap: expected ?? results[0].overlap, candidateOverlaps, score: Math.max(...results.map(result => result.score)), valid: false, reason: '相邻截图缺少足够的可比内容' }
  }
  const consensusTolerance = Math.max(3, Math.floor(Math.min(previousRaw.height, currentRaw.height) * 0.016))
  const consensus = largestOverlapConsensus(usable, consensusTolerance)
  const required = Math.floor(usable.length / 2) + 1
  const overlap = consensus.length
    ? Math.min(...consensus.map(result => result.overlap))
    : Math.round(candidateOverlaps.reduce((sum, value) => sum + value, 0) / candidateOverlaps.length)
  if (consensus.length < required) {
    return { overlap, candidateOverlaps, score: Math.max(...usable.map(result => result.score)), valid: false, consensusCount: consensus.length, consensusRequired: required, consensusTolerance, reason: `不同图像区域测得的滚动位移不一致（重叠 ${candidateOverlaps.join('/')}px）` }
  }
  const validations = consensus.map(result => validateOverlapCandidate(previousRaw, currentRaw, overlap, [result.band]))
  const stableValidations = validations.filter(result => result.valid)
  const score = Math.max(...validations.map(result => result.score))
  return {
    overlap,
    candidateOverlaps,
    score,
    valid: stableValidations.length >= required,
    consensusCount: consensus.length,
    consensusRequired: required,
    consensusTolerance,
    reason: stableValidations.length >= required ? null : '局部内容发生变化',
  }
}

async function analyzeReplyScrollEvidence(previous, current, expected = null) {
  const result = await findVerticalOverlapWithScore(previous, current, expected)
  const candidates = result.candidateOverlaps || []
  const consistentShift = candidates.length >= 2 && Math.max(...candidates) - Math.min(...candidates) <= 3
  const currentRaw = await rawImage(current)
  const overlap = Math.max(0, Math.min(currentRaw.height, Math.round(result.overlap || 0)))
  const addedHeight = currentRaw.height - overlap
  const metrics = addedHeight > 0
    ? darkContentMetrics(currentRaw, [Math.floor(currentRaw.width * 0.04), overlap, Math.ceil(currentRaw.width * 0.96), currentRaw.height])
    : { darkRatio: 0, edgeRatio: 0 }
  const bottomHasContent = addedHeight >= Math.max(12, Math.floor(currentRaw.height * 0.015))
    && (metrics.darkRatio >= 0.002 || metrics.edgeRatio >= 0.001)
  return {
    overlap: result.overlap,
    validOverlap: result.valid,
    candidateOverlaps: candidates,
    consistentShift,
    addedHeight,
    bottomHasContent,
    bottomDarkRatio: metrics.darkRatio,
    bottomEdgeRatio: metrics.edgeRatio,
    provesNewContent: consistentShift && bottomHasContent,
    reason: result.reason || null,
  }
}

async function detectFloatingDownArrow(image, searchBounds = null) {
  const raw = await rawImage(image)
  const bounds = searchBounds || [0, 0, raw.width, raw.height]
  const left = Math.max(0, Math.floor(bounds[0]))
  const top = Math.max(0, Math.floor(bounds[1]))
  const right = Math.min(raw.width, Math.ceil(bounds[2]))
  const bottom = Math.min(raw.height, Math.ceil(bounds[3]))
  const viewportWidth = right - left
  const viewportHeight = bottom - top
  if (viewportWidth <= 0 || viewportHeight <= 0) return null
  const centerX = (left + right) / 2
  const sizes = [0.075, 0.09, 0.105, 0.12].map(ratio => Math.max(28, Math.round(viewportWidth * ratio)))
  let best = null
  for (const size of sizes) {
    const half = size / 2
    const yStart = Math.round(top + viewportHeight * 0.48)
    const yEnd = Math.round(bottom - half - viewportHeight * 0.015)
    for (let centerY = yStart; centerY <= yEnd; centerY += Math.max(2, Math.round(size * 0.06))) {
      const sample = (xRatio, yRatio, radiusRatio = 0.045) => {
        const cx = centerX + xRatio * size
        const cy = centerY + yRatio * size
        const radius = Math.max(1, Math.round(size * radiusRatio))
        let dark = 0
        let count = 0
        for (let y = Math.round(cy - radius); y <= Math.round(cy + radius); y += 1) {
          for (let x = Math.round(cx - radius); x <= Math.round(cx + radius); x += 1) {
            if (x < left || x >= right || y < top || y >= bottom) continue
            if (luminosity(raw.data, (y * raw.width + x) * raw.channels) < 120) dark += 1
            count += 1
          }
        }
        return dark / Math.max(1, count)
      }
      const sampleLight = (xRatio, yRatio, radiusRatio = 0.045) => 1 - sample(xRatio, yRatio, radiusRatio)
      const shaft = (sample(0, -0.2) + sample(0, -0.08) + sample(0, 0.03)) / 3
      const arrowHead = (sample(-0.13, 0.08) + sample(-0.07, 0.14) + sample(0, 0.2)
        + sample(0.07, 0.14) + sample(0.13, 0.08)) / 5
      const clearSides = 1 - (sample(-0.28, -0.02, 0.07) + sample(0.28, -0.02, 0.07)) / 2
      const clearTop = 1 - (sample(-0.2, -0.28, 0.06) + sample(0.2, -0.28, 0.06)) / 2
      const score = shaft * 0.42 + arrowHead * 0.42 + clearSides * 0.1 + clearTop * 0.06
      if (shaft >= 0.18 && arrowHead >= 0.12 && clearSides >= 0.82 && clearTop >= 0.82
        && (!best || score > best.score)) {
        best = {
          bounds: [Math.round(centerX - half), Math.round(centerY - half), Math.round(centerX + half), Math.round(centerY + half)],
          score,
          shaftRatio: shaft,
          arrowHeadRatio: arrowHead,
        }
      }
      const lightShaft = (sampleLight(0, -0.2) + sampleLight(0, -0.08) + sampleLight(0, 0.03)) / 3
      const lightArrowHead = (sampleLight(-0.13, 0.08) + sampleLight(-0.07, 0.14) + sampleLight(0, 0.2)
        + sampleLight(0.07, 0.14) + sampleLight(0.13, 0.08)) / 5
      const darkSides = 1 - (sampleLight(-0.28, -0.02, 0.07) + sampleLight(0.28, -0.02, 0.07)) / 2
      const darkTop = 1 - (sampleLight(-0.2, -0.28, 0.06) + sampleLight(0.2, -0.28, 0.06)) / 2
      const inverseScore = lightShaft * 0.42 + lightArrowHead * 0.42 + darkSides * 0.1 + darkTop * 0.06
      if (lightShaft >= 0.52 && lightArrowHead >= 0.38 && darkSides >= 0.58 && darkTop >= 0.58
        && (!best || inverseScore > best.score)) {
        best = {
          bounds: [Math.round(centerX - half), Math.round(centerY - half), Math.round(centerX + half), Math.round(centerY + half)],
          score: inverseScore,
          shaftRatio: lightShaft,
          arrowHeadRatio: lightArrowHead,
          polarity: 'light_on_dark',
        }
      }
    }
  }
  if (!best || best.score < 0.26) return null
  const center = [(best.bounds[0] + best.bounds[2]) / 2, (best.bounds[1] + best.bounds[3]) / 2]
  const detectedSize = best.bounds[2] - best.bounds[0]
  const outerSize = Math.max(detectedSize, Math.round(viewportWidth * 0.12))
  const halfOuter = outerSize / 2
  best.bounds = [
    Math.max(left, Math.round(center[0] - halfOuter)),
    Math.max(top, Math.round(center[1] - halfOuter)),
    Math.min(right, Math.round(center[0] + halfOuter)),
    Math.min(bottom, Math.round(center[1] + halfOuter)),
  ]
  return best
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

async function verifyReplyFrameOverlap(previous, current, expected, { measuredShift = null } = {}) {
  const result = await findReplyOverlapWithScore(previous, current, expected)
  if (result.valid) return result.overlap

  if (result.consensusCount >= result.consensusRequired) return result.overlap

  const candidates = result.candidateOverlaps || []
  if (candidates.length === REPLY_OVERLAP_BANDS.length
    && Math.max(...candidates) - Math.min(...candidates) <= 3) return result.overlap

  if (Number.isFinite(measuredShift) && measuredShift >= 0) {
    const height = (await imageInfo(previous)).height
    const hierarchyOverlap = height - measuredShift
    const agreeing = candidates.filter(value => Math.abs(value - hierarchyOverlap) <= 3)
    if (agreeing.length >= 2 && agreeing.length > candidates.length / 2) return Math.round(hierarchyOverlap)
  }

  const error = new Error(`无法验证相邻截图连续性（${result.reason || `差异分数 ${result.score.toFixed(1)}`}）；已停止无缝拼接以避免叠字或漏图。`)
  error.candidateOverlaps = result.candidateOverlaps || []
  error.suggestedOverlap = result.overlap
  throw error
}

async function verifyProductGridOverlap(previous, current, expected) {
  // Product rows can legitimately contain only one card.  A blank right
  // column therefore cannot serve as an independent seam witness; compare
  // the complete grid width and still require pixel/tile continuity.
  const result = await findVerticalOverlapWithScore(previous, current, expected, {
    bands: [[0.04, 0.96]],
    minimumUsable: 1,
  })
  if (!result.valid) {
    const error = new Error(`无法验证药品网格截图连续性（${result.reason || `差异分数 ${result.score.toFixed(1)}`}）`)
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

module.exports = { imageInfo, cropImage, imagesMeanDiff, imagesSimilar, imageRegionsStable, imageHasVisibleContent, imageLooksLoaded, alignCropToWhitespace, stackFramesInGroups, verifyFrameOverlap, verifyReplyFrameOverlap, verifyProductGridOverlap, analyzeReplyScrollEvidence, detectFloatingDownArrow, stitchFramesInGroups, stitchFramesWithOverlaps, stackFramesWithSeparators, stitchFramesWithTransitions, composeLongImages, cropFramesAtTextSeams, textSeamsAreValid }
