const {
  iterNodes,
  nodeAttr,
  nodeIsVisible,
  parseBounds,
  parseNodeTree,
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

function miniAppShellCloseBounds(xml, screenSize) {
  if (!screenSize?.width || !screenSize?.height || screenSize.width >= screenSize.height) return null
  const allowedPackages = new Set([
    ENTRY_DEFINITIONS['douyin-xiaohe-miniapp'].packageName,
    ENTRY_DEFINITIONS['toutiao-xiaohe-miniapp'].packageName,
  ])
  const candidates = []
  for (const attrs of iterNodes(xml)) {
    if (!nodeIsVisible(attrs)
      || !allowedPackages.has(nodeAttr(attrs, 'package'))) continue
    const description = nodeAttr(attrs, 'content-desc').trim().toLowerCase()
    if (!['关闭', 'close'].includes(description)) continue
    const rawBounds = nodeAttr(attrs, 'bounds')
    if (!rawBounds) continue
    const bounds = parseBounds(rawBounds)
    const itemWidth = bounds[2] - bounds[0]
    const itemHeight = bounds[3] - bounds[1]
    const centerX = (bounds[0] + bounds[2]) / 2
    const centerY = (bounds[1] + bounds[3]) / 2
    if (centerX < screenSize.width * 0.82
      || centerY > screenSize.height * 0.12
      || itemWidth <= 0 || itemWidth > screenSize.width * 0.18
      || itemHeight <= 0 || itemHeight > screenSize.height * 0.1) continue
    candidates.push(bounds)
  }
  candidates.sort((first, second) => second[0] - first[0] || first[1] - second[1])
  return candidates[0] || null
}

function douyinSearchInput(xml) {
  const bounds = boundsForResourceSuffix(xml, ':id/et_search_kw')
  if (!bounds) return null
  const attrs = iterNodes(xml).find(item => nodeAttr(item, 'resource-id').endsWith(':id/et_search_kw'))
  return { bounds, text: attrs ? nodeAttr(attrs, 'text') : '' }
}

function toutiaoSearchInput(xml) {
  const attrs = iterNodes(xml).find(item => {
    if (!nodeIsVisible(item) || nodeAttr(item, 'package') !== ENTRY_DEFINITIONS['toutiao-xiaohe-miniapp'].packageName) return false
    if (nodeAttr(item, 'resource-id').endsWith(':id/cx')) return true
    if (!/^搜索框[，,]/.test(nodeAttr(item, 'text')) || nodeAttr(item, 'clickable') !== 'true') return false
    const raw = nodeAttr(item, 'bounds')
    if (!raw) return false
    const box = parseBounds(raw)
    const size = hierarchyLogicalSize(xml, null)
    return box[1] >= 0 && box[3] <= size.height * 0.16 && box[2] - box[0] >= size.width * 0.35
  })
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
  if (rawBounds) return parseBounds(rawBounds)
  for (const node of treeNodes(parseNodeTree(xml))) {
    if (!nodeIsVisible(node.attrs) || nodeAttr(node.attrs, 'package') !== ENTRY_DEFINITIONS['toutiao-xiaohe-miniapp'].packageName
      || nodeAttr(node.attrs, 'clickable') !== 'true') continue
    const children = node.children || []
    if (!children.some(child => nodeIsVisible(child.attrs)
      && nodeAttr(child.attrs, 'resource-id').endsWith(':id/search_bar_search_icon'))) continue
    const size = hierarchyLogicalSize(xml, null)
    const box = parseBounds(nodeAttr(node.attrs, 'bounds'))
    if (box[1] >= 0 && box[3] <= size.height * 0.16 && box[2] - box[0] >= size.width * 0.4) return box
  }
  return null
}

function toutiaoAddToHomeScreenCancelBounds(xml) {
  const nodes = iterNodes(xml).filter(nodeIsVisible)
  const launcherPackage = 'com.huawei.android.launcher'
  const hasTitle = nodes.some(attrs => nodeAttr(attrs, 'package') === launcherPackage
    && nodeAttr(attrs, 'text') === '添加到主屏幕')
  const hasToutiao = nodes.some(attrs => nodeAttr(attrs, 'package') === launcherPackage
    && nodeAttr(attrs, 'text') === '今日头条')
  if (!hasTitle || !hasToutiao) return null
  const cancel = nodes.find(attrs => nodeAttr(attrs, 'package') === launcherPackage
    && nodeAttr(attrs, 'class') === 'android.widget.Button'
    && nodeAttr(attrs, 'text') === '取消'
    && nodeAttr(attrs, 'clickable') === 'true')
  const rawBounds = cancel && nodeAttr(cancel, 'bounds')
  return rawBounds ? parseBounds(rawBounds) : null
}

function toutiaoViewMoreBounds(xml) {
  const nodes = iterNodes(xml)
  const hasXiaoheSummary = nodes.some(attrs => nodeIsVisible(attrs)
    && /小荷AI医生[·・]?智能总结/.test(nodeAttr(attrs, 'text')))
  if (!hasXiaoheSummary) return null
  const more = nodes.find(attrs => nodeIsVisible(attrs)
    && nodeAttr(attrs, 'package') === ENTRY_DEFINITIONS['toutiao-xiaohe-miniapp'].packageName
    && /^查看(?:更多|全文)$/.test(nodeAttr(attrs, 'text'))
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
    let bounds
    try { bounds = parseBounds(rawBounds) } catch { continue }
    if (bounds[2] <= bounds[0] || bounds[3] <= bounds[1]) continue
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
  const viewMoreItems = findOcrText(recognition, item => /^查看(?:更多|全文)$/.test(item.normalizedText), { minConfidence: 0.85 })
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

function toutiaoOcrMiniAppEntryTarget(recognition, logicalSize) {
  const size = recognition.image
  if (!size?.width || !size?.height || size.width >= size.height) return null
  const brands = findOcrText(recognition, /^小荷AI医生(?:小程序)?$/, { minConfidence: 0.85 })
  const badges = findOcrText(recognition, /^小程序$/, { minConfidence: 0.85 })
  for (const brand of brands) {
    const b = brand.bounds
    if (b[1] < size.height * 0.12 || b[3] > size.height * 0.94) continue
    const badge = badges.find(item => {
      const t = item.bounds
      const sameRow = Math.abs((t[1] + t[3] - b[1] - b[3]) / 2) <= Math.max(t[3] - t[1], b[3] - b[1])
      const below = t[1] >= b[3] && t[1] - b[3] <= size.height * 0.06 && Math.abs(t[0] - b[0]) <= size.width * 0.08
      return (sameRow && t[0] >= b[2] && t[0] - b[2] <= size.width * 0.12) || below
    })
    if (!badge && !/小程序$/.test(brand.normalizedText || brand.text)) continue
    return {
      mode: 'miniapp_entry_card', bounds: mapPhysicalBoundsToLogical(b, size, logicalSize),
      physicalBounds: b, summaryPhysicalBounds: b,
      summaryConfidence: brand.confidence, viewMoreConfidence: (badge || brand).confidence,
    }
  }
  return null
}

function douyinOcrViewFullTarget(recognition, logicalSize) {
  const physicalSize = recognition.image
  const brands = findOcrText(recognition, item => /^小荷AI医生(?:AI)?$/.test(item.normalizedText), { minConfidence: 0.85 })
  const summaries = findOcrText(recognition, item => /^(?:(?:根据)?医学数据智能总结|字节跳动旗下医疗大模型应用)$/.test(item.normalizedText), { minConfidence: 0.85 })
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
  const nodes = iterNodes(xml)
  if (!nodes.some(attrs => nodeIsVisible(attrs)
    && nodeAttr(attrs, 'package') === ENTRY_DEFINITIONS['douyin-xiaohe-miniapp'].packageName
    && [nodeAttr(attrs, 'text'), nodeAttr(attrs, 'content-desc')].some(text => /^小荷AI医生(?:AI)?$/.test(text)))) return null
  const width = screenSize.width
  const height = screenSize.height
  const candidates = []
  for (const attrs of nodes) {
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

function douyinOcrConsultEntryTarget(recognition, logicalSize) {
  const size = recognition.image
  const brands = findOcrText(recognition, /^小荷AI医生$/, { minConfidence: 0.85 })
  const subtitles = findOcrText(recognition, /^为您提供定制化建议[,，]试试咨询$/, { minConfidence: 0.85 })
  const buttons = findOcrText(recognition, /^免费咨询$/, { minConfidence: 0.85 })
  for (const brand of brands) {
    for (const subtitle of subtitles) {
      const gap = subtitle.bounds[1] - brand.bounds[3]
      const center = (brand.bounds[0] + brand.bounds[2]) / 2
      if (brand.bounds[1] < size.height * 0.1 || gap < 0 || gap > size.height * 0.04
        || subtitle.bounds[2] - subtitle.bounds[0] > size.width * 0.55
        || center < subtitle.bounds[0] || center > subtitle.bounds[2]) continue
      for (const button of buttons) {
        const buttonGap = button.bounds[1] - subtitle.bounds[3]
        const buttonCenter = (button.bounds[0] + button.bounds[2]) / 2
        if (buttonGap < 0 || buttonGap > size.height * 0.06
          || Math.abs(buttonCenter - center) > size.width * 0.06
          || button.bounds[3] > size.height * 0.94) continue
        const bounds = mapPhysicalBoundsToLogical(button.bounds, size, logicalSize)
        return {
          mode: 'miniapp_entry_card', entryKind: 'free_consult', tapBounds: bounds,
          cardBounds: mapPhysicalBoundsToLogical([subtitle.bounds[0], brand.bounds[1], subtitle.bounds[2], button.bounds[3]], size, logicalSize),
          bounds, physicalBounds: button.bounds, brandConfidence: brand.confidence,
          summaryConfidence: subtitle.confidence, viewFullConfidence: button.confidence,
        }
      }
    }
  }
  return null
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

function douyinMiniAppEntryBounds(xml, screenSize, { brandBounds = null } = {}) {
  if (!douyinSearchInput(xml) || screenSize.width >= screenSize.height) return null
  const width = screenSize.width
  const height = screenSize.height
  const resultBottom = douyinSearchResultsBounds(xml, screenSize)?.[3] || height
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
    // Bottom-clipped cards keep a full header but expose less of the body.
    // Relax height ratios only when OCR has confirmed the brand in that header.
    const clipped = brandBounds && cardBounds[3] >= resultBottom - height * 0.03
    if (cardWidth < width * 0.4 || cardWidth > width * 0.55
      || cardHeight < height * (clipped ? 0.1 : 0.18) || cardHeight > height * (brandBounds ? 0.65 : 0.4)
      || cardBounds[1] < height * (brandBounds ? 0.12 : 0.38) || cardBounds[3] > height
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
        && bounds[3] - bounds[1] >= (clipped ? height * 0.035 : cardHeight * 0.12)
        && bounds[3] - bounds[1] <= (clipped ? height * 0.1 : cardHeight * 0.3)
        && bounds[1] - cardBounds[1] <= cardHeight * 0.1
    })
    if (!header) continue
    const tapBounds = parseBounds(nodeAttr(header.attrs, 'bounds'))
    if (brandBounds && (brandBounds[0] < tapBounds[0] || brandBounds[2] > tapBounds[2]
      || brandBounds[1] < tapBounds[1] || brandBounds[3] > tapBounds[3])) continue
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

function douyinOcrBrandEntryTarget(recognition, xml, logicalSize) {
  if (!recognition.image || logicalSize.width >= logicalSize.height) return null
  for (const brand of findOcrText(recognition, /^小荷AI医生(?:AI)?$/, { minConfidence: 0.85 })) {
    const bounds = mapPhysicalBoundsToLogical(brand.bounds, recognition.image, logicalSize)
    const entry = douyinMiniAppEntryBounds(xml, logicalSize, { brandBounds: bounds })
    if (!entry) continue
    return {
      ...entry, mode: 'miniapp_entry_card', entryKind: 'brand_card',
      bounds, physicalBounds: brand.bounds, brandConfidence: brand.confidence,
      summaryConfidence: brand.confidence, viewFullConfidence: brand.confidence,
      identityConfirmed: true,
    }
  }
  return null
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

function toutiaoLegacyFullAnswerPage(xml, screenSize) {
  const nodes = iterNodes(xml).filter(attrs => nodeIsVisible(attrs)
    && nodeAttr(attrs, 'package') === ENTRY_DEFINITIONS['toutiao-xiaohe-miniapp'].packageName
    && nodeAttr(attrs, 'bounds'))
  if (!nodes.some(attrs => nodeAttr(attrs, 'class') === 'android.webkit.WebView'
    && nodeAttr(attrs, 'text') === '小荷AI医生')) return null
  const size = hierarchyLogicalSize(xml, screenSize)
  if (!size?.width || size.height <= size.width || toutiaoSearchInput(xml)) return null
  const box = attrs => parseBounds(nodeAttr(attrs, 'bounds'))
  const title = nodes.find(attrs => nodeAttr(attrs, 'resource-id').endsWith(':id/title')
    && nodeAttr(attrs, 'text') === '小荷AI医生' && box(attrs)[3] < size.height * 0.12)
  const web = nodes.find(attrs => nodeAttr(attrs, 'class') === 'android.webkit.WebView'
    && nodeAttr(attrs, 'text') === '小荷AI医生')
  const back = nodes.find(attrs => /^返回(?:[，,]按钮)?$/.test(nodeAttr(attrs, 'content-desc'))
    && nodeAttr(attrs, 'clickable') === 'true' && box(attrs)[2] <= size.width * 0.2
    && box(attrs)[3] <= size.height * 0.12)
  const notice = nodes.find(attrs => /^AI生成非医疗诊断/.test(nodeAttr(attrs, 'text'))
    && box(attrs)[3] < size.height * 0.2)
  const input = nodes.find(attrs => nodeAttr(attrs, 'class') === 'android.widget.EditText'
    && /输入问题AI免费专业解答/.test(nodeAttr(attrs, 'hint')) && box(attrs)[1] > size.height * 0.7)
  const scroll = nodes.find(attrs => nodeAttr(attrs, 'scrollable') === 'true'
    && box(attrs)[2] - box(attrs)[0] >= size.width * 0.9 && box(attrs)[3] - box(attrs)[1] >= size.height * 0.5)
  if (!title || !web || !back || !notice || !input || !scroll) return null
  const bounds = [box(scroll)[0], Math.max(box(web)[1], box(notice)[3]), box(scroll)[2],
    Math.min(box(scroll)[3], box(input)[1] - Math.ceil(size.height * 0.018))]
  if (bounds[3] - bounds[1] < size.height * 0.4) return null
  return { bounds, back: box(back) }
}

function douyinMiniAppCaptureBounds(xml, screenSize) {
  if (douyinSearchInput(xml)) return null
  const close = miniAppShellCloseBounds(xml, screenSize)
  if (!close) return toutiaoLegacyFullAnswerPage(xml, screenSize)?.bounds || null
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

function toutiaoGenericConsultationPage(xml, { answerContentReady = false } = {}) {
  const hasMessageInput = iterNodes(xml).some(attrs => nodeIsVisible(attrs)
    && nodeAttr(attrs, 'package') === ENTRY_DEFINITIONS['toutiao-xiaohe-miniapp'].packageName
    && nodeAttr(attrs, 'class') === 'android.widget.EditText'
    && /发送消息|输入问题AI免费专业解答/.test(`${nodeAttr(attrs, 'text')} ${nodeAttr(attrs, 'hint')}`))
  return hasMessageInput && !answerContentReady
}


module.exports = {
  miniAppShellCloseBounds,
  douyinSearchInput,
  toutiaoSearchInput,
  toutiaoSearchResultBelongsToQuestion,
  toutiaoHomeSearchBounds,
  toutiaoAddToHomeScreenCancelBounds,
  toutiaoViewMoreBounds,
  hierarchyLogicalSize,
  toutiaoOcrViewMoreTarget,
  toutiaoOcrMiniAppEntryTarget,
  douyinOcrViewFullTarget,
  douyinOcrConsultEntryTarget,
  douyinOcrBrandEntryTarget,
  douyinViewFullBounds,
  douyinGenericAiAnswerBounds,
  douyinMiniAppEntryBounds,
  douyinSearchResultTarget,
  douyinSearchResultsBounds,
  douyinMiniAppCaptureBounds,
  toutiaoGenericConsultationPage,
  toutiaoLegacyFullAnswerPage,
}
