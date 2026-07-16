const {
  iterNodes,
  nodeAttr,
  nodeIsVisible,
  parseBounds,
  parseNodeTree,
  boundsForNodeAttribute,
} = require('./hierarchy')
const { findOcrText, mapPhysicalBoundsToLogical } = require('./ocr')
const { ENTRY_DEFINITIONS } = require('./entry-catalog')

function boundsForResourceSuffix(xml, suffix) {
  for (const attrs of iterNodes(xml)) {
    if (!nodeIsVisible(attrs) || !nodeAttr(attrs, 'resource-id').endsWith(suffix)) continue
    const rawBounds = nodeAttr(attrs, 'bounds')
    if (rawBounds) return parseBounds(rawBounds)
  }
  return null
}

function douyinSearchInput(xml) {
  const bounds = boundsForResourceSuffix(xml, ':id/et_search_kw')
  if (!bounds) return null
  const attrs = iterNodes(xml).find(item => nodeAttr(item, 'resource-id').endsWith(':id/et_search_kw'))
  return { bounds, text: attrs ? nodeAttr(attrs, 'text') : '' }
}

function toutiaoSearchInput(xml) {
  const attrs = iterNodes(xml).find(item => nodeIsVisible(item)
    && nodeAttr(item, 'package') === ENTRY_DEFINITIONS['toutiao-xiaohe-miniapp'].packageName
    && nodeAttr(item, 'resource-id').endsWith(':id/cx'))
  if (!attrs) return null
  const rawBounds = nodeAttr(attrs, 'bounds')
  if (!rawBounds) return null
  const text = nodeAttr(attrs, 'text').replace(/^搜索框[，,]\s*/, '')
  return { bounds: parseBounds(rawBounds), text }
}

function toutiaoSearchResultBelongsToQuestion(xml, question) {
  const input = toutiaoSearchInput(xml)
  return Boolean(input && input.text === question)
}

function toutiaoHomeSearchBounds(xml) {
  const attrs = iterNodes(xml).find(item => {
    if (!nodeIsVisible(item)
      || nodeAttr(item, 'package') !== ENTRY_DEFINITIONS['toutiao-xiaohe-miniapp'].packageName) return false
    const resourceId = nodeAttr(item, 'resource-id')
    const description = nodeAttr(item, 'content-desc')
    return resourceId.endsWith(':id/kic') && /^搜索框[，,]/.test(description)
  })
  const rawBounds = attrs && nodeAttr(attrs, 'bounds')
  return rawBounds ? parseBounds(rawBounds) : null
}

function toutiaoViewMoreBounds(xml) {
  const nodes = iterNodes(xml)
  const hasXiaoheSummary = nodes.some(attrs => nodeIsVisible(attrs)
    && /小荷AI医生[·・]?智能总结/.test(nodeAttr(attrs, 'text')))
  if (!hasXiaoheSummary) return null
  const more = nodes.find(attrs => nodeIsVisible(attrs)
    && nodeAttr(attrs, 'package') === ENTRY_DEFINITIONS['toutiao-xiaohe-miniapp'].packageName
    && nodeAttr(attrs, 'text') === '查看更多'
    && nodeAttr(attrs, 'clickable') === 'true')
  const rawBounds = more && nodeAttr(more, 'bounds')
  return rawBounds ? parseBounds(rawBounds) : null
}

function hierarchyLogicalSize(xml, fallback) {
  let width = 0
  let height = 0
  for (const attrs of iterNodes(xml)) {
    const rawBounds = nodeAttr(attrs, 'bounds')
    if (!rawBounds) continue
    const bounds = parseBounds(rawBounds)
    width = Math.max(width, bounds[2])
    height = Math.max(height, bounds[3])
  }
  const result = width > 0 && height > 0 ? { width, height } : fallback
  if (!result || result.height <= result.width) throw new Error('头条OCR定位仅支持正常竖屏；当前UI逻辑视口异常。')
  return result
}

function toutiaoOcrViewMoreTarget(recognition, logicalSize) {
  const physicalSize = recognition.image
  const summaries = findOcrText(recognition, item => /^小荷AI医生(?:AI)?智能总结$/.test(item.normalizedText), { minConfidence: 0.85 })
  const viewMoreItems = findOcrText(recognition, item => /^查看更多$/.test(item.normalizedText), { minConfidence: 0.85 })
  const candidates = []
  for (const summary of summaries) {
    for (const viewMore of viewMoreItems) {
      const summaryCenterY = (summary.bounds[1] + summary.bounds[3]) / 2
      const viewMoreCenterX = (viewMore.bounds[0] + viewMore.bounds[2]) / 2
      const viewMoreWidth = viewMore.bounds[2] - viewMore.bounds[0]
      const verticalGap = viewMore.bounds[1] - summary.bounds[3]
      const horizontalOverlap = Math.min(summary.bounds[2], viewMore.bounds[2]) - Math.max(summary.bounds[0], viewMore.bounds[0])
      if (summaryCenterY < physicalSize.height * 0.1 || summaryCenterY > physicalSize.height * 0.68
        || verticalGap < 0 || verticalGap > physicalSize.height * 0.45
        || horizontalOverlap <= 0
        || viewMoreWidth < physicalSize.width * 0.08 || viewMoreWidth > physicalSize.width * 0.35
        || Math.abs(viewMoreCenterX - physicalSize.width / 2) > physicalSize.width * 0.28) continue
      candidates.push({ summary, viewMore, score: summary.confidence + viewMore.confidence })
    }
  }
  candidates.sort((first, second) => second.score - first.score || first.viewMore.bounds[1] - second.viewMore.bounds[1])
  const selected = candidates[0]
  if (!selected) return null
  return {
    bounds: mapPhysicalBoundsToLogical(selected.viewMore.bounds, physicalSize, logicalSize),
    physicalBounds: selected.viewMore.bounds,
    summaryPhysicalBounds: selected.summary.bounds,
    summaryConfidence: selected.summary.confidence,
    viewMoreConfidence: selected.viewMore.confidence,
  }
}

function douyinOcrViewFullTarget(recognition, logicalSize) {
  const physicalSize = recognition.image
  const brands = findOcrText(recognition, item => /^小荷AI医生(?:AI)?$/.test(item.normalizedText), { minConfidence: 0.85 })
  const summaries = findOcrText(recognition, item => /^(?:根据)?医学数据智能总结$/.test(item.normalizedText), { minConfidence: 0.85 })
  const viewFullItems = findOcrText(recognition, item => /^查看全文$/.test(item.normalizedText), { minConfidence: 0.85 })
  const candidates = []
  for (const brand of brands) {
    for (const summary of summaries) {
      const brandCenterY = (brand.bounds[1] + brand.bounds[3]) / 2
      const brandSummaryGap = summary.bounds[1] - brand.bounds[3]
      const brandSummaryOverlap = Math.min(brand.bounds[2], summary.bounds[2]) - Math.max(brand.bounds[0], summary.bounds[0])
      if (brandCenterY < physicalSize.height * 0.1 || brandCenterY > physicalSize.height * 0.58
        || brandSummaryGap < -physicalSize.height * 0.015 || brandSummaryGap > physicalSize.height * 0.08
        || brandSummaryOverlap <= 0) continue
      for (const viewFull of viewFullItems) {
        const viewFullWidth = viewFull.bounds[2] - viewFull.bounds[0]
        const viewFullCenterX = (viewFull.bounds[0] + viewFull.bounds[2]) / 2
        const summaryViewGap = viewFull.bounds[1] - summary.bounds[3]
        if (summaryViewGap < physicalSize.height * 0.02 || summaryViewGap > physicalSize.height * 0.3
          || viewFull.bounds[3] > physicalSize.height * 0.76
          || viewFullWidth < physicalSize.width * 0.08 || viewFullWidth > physicalSize.width * 0.35
          || Math.abs(viewFullCenterX - physicalSize.width / 2) > physicalSize.width * 0.22) continue
        candidates.push({
          brand,
          summary,
          viewFull,
          score: brand.confidence + summary.confidence + viewFull.confidence,
        })
      }
    }
  }
  candidates.sort((first, second) => second.score - first.score || first.viewFull.bounds[1] - second.viewFull.bounds[1])
  const selected = candidates[0]
  if (!selected) return null
  return {
    bounds: mapPhysicalBoundsToLogical(selected.viewFull.bounds, physicalSize, logicalSize),
    physicalBounds: selected.viewFull.bounds,
    brandPhysicalBounds: selected.brand.bounds,
    summaryPhysicalBounds: selected.summary.bounds,
    brandConfidence: selected.brand.confidence,
    summaryConfidence: selected.summary.confidence,
    viewFullConfidence: selected.viewFull.confidence,
  }
}

function douyinViewFullBounds(xml, screenSize) {
  const width = screenSize.width
  const height = screenSize.height
  const candidates = []
  for (const attrs of iterNodes(xml)) {
    if (!nodeIsVisible(attrs)
      || nodeAttr(attrs, 'package') !== ENTRY_DEFINITIONS['douyin-xiaohe-miniapp'].packageName
      || nodeAttr(attrs, 'class') !== 'android.view.ViewGroup'
      || nodeAttr(attrs, 'text')
      || nodeAttr(attrs, 'content-desc')) continue
    const rawBounds = nodeAttr(attrs, 'bounds')
    if (!rawBounds) continue
    const bounds = parseBounds(rawBounds)
    const itemWidth = bounds[2] - bounds[0]
    const itemHeight = bounds[3] - bounds[1]
    const centerX = (bounds[0] + bounds[2]) / 2
    if (itemWidth < width * 0.18 || itemWidth > width * 0.35
      || itemHeight < height * 0.035 || itemHeight > height * 0.075
      || Math.abs(centerX - width / 2) > width * 0.09
      || bounds[1] < height * 0.42 || bounds[3] > height * 0.72) continue
    candidates.push(bounds)
  }
  candidates.sort((a, b) => a[1] - b[1])
  return candidates[0] || null
}

function douyinGenericAiAnswerBounds(xml, screenSize) {
  const nodes = iterNodes(xml)
  const hasGenericAnswer = nodes.some(attrs => nodeIsVisible(attrs)
    && nodeAttr(attrs, 'package') === ENTRY_DEFINITIONS['douyin-xiaohe-miniapp'].packageName
    && /^AI生成回答$/.test(`${nodeAttr(attrs, 'text')} ${nodeAttr(attrs, 'content-desc')}`.replace(/\s+/g, '')))
  if (!hasGenericAnswer) return null
  const more = nodes.find(attrs => {
    if (!nodeIsVisible(attrs)
      || nodeAttr(attrs, 'package') !== ENTRY_DEFINITIONS['douyin-xiaohe-miniapp'].packageName
      || !/^展开更多$/.test(`${nodeAttr(attrs, 'text')} ${nodeAttr(attrs, 'content-desc')}`.replace(/\s+/g, ''))) return false
    const rawBounds = nodeAttr(attrs, 'bounds')
    if (!rawBounds) return false
    const bounds = parseBounds(rawBounds)
    const centerX = (bounds[0] + bounds[2]) / 2
    return Math.abs(centerX - screenSize.width / 2) <= screenSize.width * 0.18
      && bounds[1] >= screenSize.height * 0.35
      && bounds[3] <= screenSize.height * 0.78
  })
  return more ? parseBounds(nodeAttr(more, 'bounds')) : null
}

function treeNodes(root, result = []) {
  for (const child of root.children || []) {
    result.push(child)
    treeNodes(child, result)
  }
  return result
}

function douyinMiniAppEntryBounds(xml, screenSize) {
  if (!douyinSearchInput(xml) || screenSize.width >= screenSize.height) return null
  const width = screenSize.width
  const height = screenSize.height
  const candidates = []
  for (const node of treeNodes(parseNodeTree(xml))) {
    const attrs = node.attrs
    if (nodeAttr(attrs, 'class') !== 'android.widget.FrameLayout'
      || nodeAttr(attrs, 'resource-id')
      || nodeAttr(attrs, 'text')
      || nodeAttr(attrs, 'content-desc')) continue
    const rawBounds = nodeAttr(attrs, 'bounds')
    if (!rawBounds) continue
    const cardBounds = parseBounds(rawBounds)
    const cardWidth = cardBounds[2] - cardBounds[0]
    const cardHeight = cardBounds[3] - cardBounds[1]
    if (cardWidth < width * 0.4 || cardWidth > width * 0.55
      || cardHeight < height * 0.22 || cardHeight > height * 0.4
      || cardBounds[1] < height * 0.38 || cardBounds[3] > height
      || node.children.length < 3 || node.children.length > 6
      || node.children.some(child => nodeAttr(child.attrs, 'class') !== 'android.view.ViewGroup')) continue
    const descendants = treeNodes(node)
    if (descendants.some(child => nodeAttr(child.attrs, 'resource-id')
      || nodeAttr(child.attrs, 'text') || nodeAttr(child.attrs, 'content-desc'))) continue
    const header = node.children.find(child => {
      const childRaw = nodeAttr(child.attrs, 'bounds')
      if (!childRaw || !(child.children || []).length) return false
      const bounds = parseBounds(childRaw)
      return bounds[2] - bounds[0] >= cardWidth * 0.75
        && bounds[3] - bounds[1] >= cardHeight * 0.12
        && bounds[3] - bounds[1] <= cardHeight * 0.3
        && bounds[1] - cardBounds[1] <= cardHeight * 0.1
    })
    if (!header) continue
    const tapBounds = parseBounds(nodeAttr(header.attrs, 'bounds'))
    const actions = node.children.filter(child => {
      const childRaw = nodeAttr(child.attrs, 'bounds')
      if (!childRaw || child === header) return false
      const bounds = parseBounds(childRaw)
      return bounds[2] - bounds[0] >= cardWidth * 0.75 && bounds[1] >= tapBounds[3] - Math.round(cardHeight * 0.02)
    })
    if (actions.length < 2) continue
    candidates.push({ cardBounds, tapBounds })
  }
  candidates.sort((a, b) => a.cardBounds[1] - b.cardBounds[1] || a.cardBounds[0] - b.cardBounds[0])
  return candidates[0] || null
}

function douyinSearchResultTarget(xml, screenSize) {
  const viewFull = douyinViewFullBounds(xml, screenSize)
  const entry = douyinMiniAppEntryBounds(xml, screenSize)
  const genericAiAnswer = douyinGenericAiAnswerBounds(xml, screenSize)
  if (entry && (viewFull || genericAiAnswer)) {
    return { mode: 'miniapp_entry_card', ...entry, ignoredExpandableAnswer: true }
  }
  if (genericAiAnswer) return entry ? { mode: 'miniapp_entry_card', ...entry } : null
  if (viewFull) return { mode: 'smart_summary', viewFull }
  return entry ? { mode: 'miniapp_entry_card', ...entry } : null
}

function douyinSearchResultsBounds(xml, screenSize) {
  const candidates = []
  for (const attrs of iterNodes(xml)) {
    if (!nodeIsVisible(attrs)
      || nodeAttr(attrs, 'package') !== ENTRY_DEFINITIONS['douyin-xiaohe-miniapp'].packageName
      || nodeAttr(attrs, 'class') !== 'androidx.recyclerview.widget.RecyclerView') continue
    const rawBounds = nodeAttr(attrs, 'bounds')
    if (!rawBounds) continue
    const bounds = parseBounds(rawBounds)
    if (bounds[2] - bounds[0] < screenSize.width * 0.8
      || bounds[3] - bounds[1] < screenSize.height * 0.45) continue
    candidates.push(bounds)
  }
  candidates.sort((a, b) => (b[2] - b[0]) * (b[3] - b[1]) - (a[2] - a[0]) * (a[3] - a[1]))
  return candidates[0] || null
}

function douyinMiniAppCaptureBounds(xml, screenSize) {
  if (douyinSearchInput(xml)) return null
  const close = boundsForNodeAttribute(xml, 'content-desc', '关闭')
  if (!close) return null
  const width = screenSize.width
  const height = screenSize.height
  const fixedBottomTops = []
  for (const attrs of iterNodes(xml)) {
    if (!nodeIsVisible(attrs) || !['android.widget.ScrollView', 'android.widget.HorizontalScrollView'].includes(nodeAttr(attrs, 'class'))) continue
    const rawBounds = nodeAttr(attrs, 'bounds')
    if (!rawBounds) continue
    const bounds = parseBounds(rawBounds)
    if (bounds[2] - bounds[0] >= width * 0.8 && bounds[1] > height * 0.55) fixedBottomTops.push(bounds[1])
  }
  const bottom = fixedBottomTops.length ? Math.min(...fixedBottomTops) : Math.floor(height * 0.74)
  const shellTop = Math.max(close[3] + Math.round(height * 0.012), Math.floor(height * 0.095))
  const scrollingContentTops = iterNodes(xml).flatMap(attrs => {
    if (!nodeIsVisible(attrs) || nodeAttr(attrs, 'class') !== 'android.view.ViewGroup') return []
    const rawBounds = nodeAttr(attrs, 'bounds')
    if (!rawBounds) return []
    const bounds = parseBounds(rawBounds)
    const itemWidth = bounds[2] - bounds[0]
    const itemHeight = bounds[3] - bounds[1]
    if (itemWidth < width * 0.9
      || Math.abs(bounds[3] - bottom) > Math.max(8, Math.round(height * 0.006))
      || bounds[1] < shellTop
      || bounds[1] > height * 0.35
      || itemHeight < height * 0.4) return []
    return [bounds[1]]
  })
  // The miniapp exposes its real scrolling viewport as a full-width ViewGroup.
  // Its top sits below the pinned consultation/person selector. Cropping from
  // the shell header instead includes that fixed strip in every frame and makes
  // independent overlap bands report contradictory scroll distances.
  const top = scrollingContentTops.length ? Math.max(...scrollingContentTops) : shellTop
  if (bottom - top < height * 0.4) return null
  return [0, top, width, bottom]
}

function toutiaoGenericConsultationPage(xml) {
  return iterNodes(xml).some(attrs => nodeIsVisible(attrs)
    && nodeAttr(attrs, 'package') === ENTRY_DEFINITIONS['toutiao-xiaohe-miniapp'].packageName
    && nodeAttr(attrs, 'class') === 'android.widget.EditText'
    && /发送消息/.test(`${nodeAttr(attrs, 'text')} ${nodeAttr(attrs, 'hint')}`))
}


module.exports = {
  douyinSearchInput,
  toutiaoSearchInput,
  toutiaoSearchResultBelongsToQuestion,
  toutiaoHomeSearchBounds,
  toutiaoViewMoreBounds,
  hierarchyLogicalSize,
  toutiaoOcrViewMoreTarget,
  douyinOcrViewFullTarget,
  douyinViewFullBounds,
  douyinGenericAiAnswerBounds,
  douyinMiniAppEntryBounds,
  douyinSearchResultTarget,
  douyinSearchResultsBounds,
  douyinMiniAppCaptureBounds,
  toutiaoGenericConsultationPage,
}

