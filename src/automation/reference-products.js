const {
  iterNodes,
  nodeAttr,
  nodeIsVisible,
  parseBounds,
  parseNodeTree,
  boundsIntersect,
  boundsCenterY,
  visibleLabelBounds,
  visibleLabelBoundsList,
  boundsForNodeAttribute,
  referenceProductsSection,
  referenceProductImageBounds,
} = require('./hierarchy')
const { imageInfo, cropImage, imageLooksLoaded } = require('./images')
const { findOcrText, mapPhysicalBoundsToLogical } = require('./ocr')

function miniAppReferenceProductsOcrTrigger(recognition, logicalSize, { cropped = false } = {}) {
  const headings = findOcrText(recognition, /^(?:参考|推荐)药品$/, { minConfidence: 0.85 })
  const buttons = findOcrText(recognition, /^(?:查看)?全部药品[>›]?$/, { minConfidence: 0.85 })
  for (const heading of headings) for (const button of buttons) {
    const height = heading.bounds[3] - heading.bounds[1]
    if (button.bounds[0] <= heading.bounds[2]
      || Math.abs(boundsCenterY(button.bounds) - boundsCenterY(heading.bounds)) > height * 0.8
      || button.bounds[0] < recognition.image.width * 0.65) continue
    const bounds = mapPhysicalBoundsToLogical(button.bounds, recognition.image, logicalSize, { cropped })
    return [Math.round((bounds[0] + bounds[2]) / 2), Math.round(boundsCenterY(bounds))]
  }
  return null
}

function treeNodes(root, result = []) {
  for (const child of root.children || []) {
    result.push(child)
    treeNodes(child, result)
  }
  return result
}

function boundsForResourceSuffix(xml, suffix) {
  for (const attrs of iterNodes(xml)) {
    if (!nodeIsVisible(attrs) || !nodeAttr(attrs, 'resource-id').endsWith(suffix)) continue
    const rawBounds = nodeAttr(attrs, 'bounds')
    if (rawBounds) return parseBounds(rawBounds)
  }
  return null
}

function miniAppReferenceProductsTrigger(xml, viewportBounds) {
  const viewportWidth = viewportBounds[2] - viewportBounds[0]
  const viewportHeight = viewportBounds[3] - viewportBounds[1]
  const candidates = []
  for (const node of treeNodes(parseNodeTree(xml))) {
    if (nodeAttr(node.attrs, 'class') !== 'android.view.ViewGroup') continue
    const rawPanel = nodeAttr(node.attrs, 'bounds')
    if (!rawPanel) continue
    const panel = parseBounds(rawPanel)
    const panelWidth = panel[2] - panel[0]
    const panelHeight = panel[3] - panel[1]
    if (!boundsIntersect(panel, viewportBounds)
      || panelWidth < viewportWidth * 0.84
      || panelHeight < viewportHeight * 0.12
      || panelHeight > viewportHeight * 0.55) continue
    const descendants = treeNodes(node)
    const arrow = descendants.find(child => {
      if (nodeAttr(child.attrs, 'class') !== 'android.widget.ImageView') return false
      const raw = nodeAttr(child.attrs, 'bounds')
      if (!raw) return false
      const bounds = parseBounds(raw)
      const width = bounds[2] - bounds[0]
      const height = bounds[3] - bounds[1]
      return bounds[0] >= panel[0] + panelWidth * 0.78
        && boundsCenterY(bounds) <= panel[1] + panelHeight * 0.36
        && width >= viewportWidth * 0.02 && width <= viewportWidth * 0.09
        && height >= viewportWidth * 0.02 && height <= viewportWidth * 0.09
    })
    if (!arrow) continue
    const artwork = descendants.some(child => {
      if (nodeAttr(child.attrs, 'class') !== 'android.view.ViewGroup') return false
      const raw = nodeAttr(child.attrs, 'bounds')
      if (!raw) return false
      const bounds = parseBounds(raw)
      const width = bounds[2] - bounds[0]
      const height = bounds[3] - bounds[1]
      return bounds[0] <= panel[0] + panelWidth * 0.28
        && bounds[1] >= panel[1] + panelHeight * 0.25
        && width >= viewportWidth * 0.1 && width <= viewportWidth * 0.3
        && height >= viewportWidth * 0.1 && height <= viewportWidth * 0.3
        && Math.abs(width - height) <= Math.max(width, height) * 0.25
    })
    if (!artwork) continue
    const arrowBounds = parseBounds(nodeAttr(arrow.attrs, 'bounds'))
    candidates.push({
      panel,
      tap: [Math.floor((arrowBounds[0] + arrowBounds[2]) / 2), boundsCenterY(arrowBounds)],
    })
  }
  candidates.sort((a, b) => {
    const areaA = (a.panel[2] - a.panel[0]) * (a.panel[3] - a.panel[1])
    const areaB = (b.panel[2] - b.panel[0]) * (b.panel[3] - b.panel[1])
    return areaA - areaB
  })
  return candidates[0]?.tap || null
}

function referenceProductsTrigger(xml, chatBounds) {
  for (const label of ['参考药品', '推荐药品']) {
    const bounds = visibleLabelBounds(xml, label)
    if (!bounds || !boundsIntersect(bounds, chatBounds)) continue
    const nodes = iterNodes(xml)
    const nativeHeading = nodes.some(attrs => nodeIsVisible(attrs)
      && nodeAttr(attrs, 'package') === 'com.aurora.xiaohe.aidoctor'
      && nodeAttr(attrs, 'text') === label && nodeAttr(attrs, 'clickable') !== 'true'
      && bounds[2] - bounds[0] >= (chatBounds[2] - chatBounds[0]) * 0.8)
    if (nativeHeading) {
      // The capture crop can end above this visible button to exclude a floating
      // scroll control. Click in UI coordinates, not the cropped image space.
      const all = nodes.find(attrs => nodeIsVisible(attrs)
        && nodeAttr(attrs, 'package') === 'com.aurora.xiaohe.aidoctor'
        && nodeAttr(attrs, 'text') === '查看全部药品')
      if (!all) return null
      const target = parseBounds(nodeAttr(all, 'bounds'))
      return target[1] >= bounds[3] ? [Math.round((target[0] + target[2]) / 2), Math.round((target[1] + target[3]) / 2)] : null
    }
    const centerY = boundsCenterY(bounds)
    const exact = iterNodes(xml).map(attrs => ({
      clickable: nodeAttr(attrs, 'clickable') === 'true',
      rawBounds: nodeAttr(attrs, 'bounds'),
    })).filter(item => item.clickable && item.rawBounds).map(item => parseBounds(item.rawBounds)).filter(candidate =>
      candidate[0] >= bounds[2] - 20
      && candidate[1] <= centerY
      && candidate[3] >= centerY
      && boundsIntersect(candidate, chatBounds))
      .sort((a, b) => a[0] - b[0])[0]
    if (exact) return [Math.floor((exact[0] + exact[2]) / 2), Math.floor((exact[1] + exact[3]) / 2)]
    return [chatBounds[2] - Math.max(20, Math.floor((chatBounds[2] - chatBounds[0]) / 15)), boundsCenterY(bounds)]
  }
  const section = referenceProductsSection(xml)
  if (section && boundsIntersect(section.panel, chatBounds)) return section.tap
  return null
}

function refreshedReferenceProductsTrigger(xml, chatBounds, previousTrigger) {
  const trigger = referenceProductsTrigger(xml, chatBounds)
  if (!trigger) throw new Error('推荐药品入口在点击前已离开当前视口；为避免点击错误位置已停止操作')
  const moved = Array.isArray(previousTrigger)
    && Math.hypot(trigger[0] - previousTrigger[0], trigger[1] - previousTrigger[1]) > 12
  return { trigger, moved }
}

function referenceProductDrawerBounds(xml) {
  let sheet = boundsForResourceSuffix(xml, ':id/bullet_container')
    || boundsForResourceSuffix(xml, ':id/bullet_popup_bottom_sheet')
  if (!sheet) {
    const root = parseNodeTree(xml)
    const nodes = treeNodes(root)
    const parsed = nodes.flatMap(node => {
      const rawBounds = nodeAttr(node.attrs, 'bounds')
      return rawBounds ? [parseBounds(rawBounds)] : []
    })
    const screenWidth = Math.max(0, ...parsed.map(bounds => bounds[2]))
    const screenHeight = Math.max(0, ...parsed.map(bounds => bounds[3]))
    const structural = []
    const visit = (node, ancestors = []) => {
      for (const child of node.children || []) {
        const nextAncestors = [...ancestors, child]
        if (nodeAttr(child.attrs, 'class') === 'androidx.recyclerview.widget.RecyclerView') {
          const rawList = nodeAttr(child.attrs, 'bounds')
          if (rawList) {
            const list = parseBounds(rawList)
            const listWidth = list[2] - list[0]
            const listHeight = list[3] - list[1]
            if (screenWidth > 0 && screenHeight > 0
              && listWidth >= screenWidth * 0.8
              && listHeight >= screenHeight * 0.45
              && list[1] >= screenHeight * 0.15
              && list[1] <= screenHeight * 0.45
              && list[3] >= screenHeight * 0.97) {
              const sheetCandidates = ancestors.flatMap(ancestor => {
                if (nodeAttr(ancestor.attrs, 'class') !== 'android.view.ViewGroup') return []
                const raw = nodeAttr(ancestor.attrs, 'bounds')
                if (!raw) return []
                const bounds = parseBounds(raw)
                return bounds[0] <= list[0] + screenWidth * 0.03
                  && bounds[2] >= list[2] - screenWidth * 0.03
                  && bounds[3] >= list[3] - screenHeight * 0.02
                  && bounds[1] >= screenHeight * 0.1
                  && bounds[1] <= list[1] - Math.max(24, screenHeight * 0.015)
                  ? [bounds]
                  : []
              }).sort((a, b) => b[1] - a[1])
              if (sheetCandidates.length) structural.push({ sheet: sheetCandidates[0], list })
            }
          }
        }
        visit(child, nextAncestors)
      }
    }
    visit(root)
    structural.sort((a, b) => b.sheet[1] - a.sheet[1])
    return structural[0] || { sheet: null, list: null }
  }
  let list = boundsForNodeAttribute(xml, 'class', 'androidx.recyclerview.widget.RecyclerView')
  if (!list) {
    const candidate = iterNodes(xml).find(attrs => {
      if (nodeAttr(attrs, 'scrollable') !== 'true'
        || nodeAttr(attrs, 'class') === 'android.widget.HorizontalScrollView') return false
      const rawBounds = nodeAttr(attrs, 'bounds')
      if (!rawBounds) return false
      const bounds = parseBounds(rawBounds)
      return bounds[0] >= sheet[0] - 8
        && bounds[1] >= sheet[1] - 8
        && bounds[2] <= sheet[2] + 8
        && bounds[3] <= sheet[3] + 8
        && bounds[3] - bounds[1] >= 100
    })
    const rawBounds = candidate && nodeAttr(candidate, 'bounds')
    if (rawBounds) list = parseBounds(rawBounds)
  }
  return { sheet, list }
}

function referenceProductsCaptureComplete({ detected, products }) {
  return !detected || Boolean(products?.firstViewportIncluded && products?.imagesReady && products?.confirmedEnd && products?.continuityVerified)
}

function referenceProductSheetExpanded(sheet, list) {
  if (!sheet || !list) return false
  const viewportBottom = Math.max(sheet[3], list[3])
  const sheetHeight = sheet[3] - sheet[1]
  const listHeight = list[3] - list[1]
  return sheet[1] <= viewportBottom * 0.22
    && sheetHeight >= viewportBottom * 0.72
    && listHeight >= viewportBottom * 0.55
}

function calibratedProductFallbackOverlap(overlaps) {
  const recent = overlaps.filter(Number.isFinite).slice(-8)
  if (recent.length < 3) return null
  const low = Math.min(...recent)
  const high = Math.max(...recent)
  if (high - low > 64) return null
  return Math.max(0, low - 8)
}

async function referenceProductViewportReadiness(frame, xml, listBounds, options = {}) {
  const candidates = referenceProductImageBounds(xml, listBounds, options)
  const frameSize = await imageInfo(frame)
  const scaleX = frameSize.width / (listBounds[2] - listBounds[0])
  const scaleY = frameSize.height / (listBounds[3] - listBounds[1])
  const relativeBounds = candidates.bounds.map(bounds => [
    Math.max(0, Math.round((bounds[0] - listBounds[0]) * scaleX)),
    Math.max(0, Math.round((bounds[1] - listBounds[1]) * scaleY)),
    Math.min(frameSize.width, Math.round((bounds[2] - listBounds[0]) * scaleX)),
    Math.min(frameSize.height, Math.round((bounds[3] - listBounds[1]) * scaleY)),
  ]).filter(bounds => bounds[2] > bounds[0] && bounds[3] > bounds[1])
  const loadedFlags = await Promise.all(relativeBounds.map(async bounds => imageLooksLoaded(await cropImage(frame, bounds))))
  const loaded = loadedFlags.filter(Boolean).length
  const labelledCards = visibleLabelBoundsList(xml, '查看说明书').filter(bounds => boundsIntersect(bounds, listBounds)).length
  const cards = Math.max(candidates.expectedCards || 0, labelledCards - (candidates.offscreenArtworkCards || 0), relativeBounds.length)
  const viewportLoaded = relativeBounds.length ? true : await imageLooksLoaded(frame)
  const imagesReady = cards
    ? relativeBounds.length >= cards && loaded === relativeBounds.length
    : viewportLoaded
  const previousArtworkRequired = (candidates.offscreenArtworkCards || 0) > 0
  const ready = imagesReady && (!previousArtworkRequired || Boolean(options.previousArtworkVerified))
  return {
    ready,
    mode: candidates.mode,
    cards,
    images: relativeBounds.length,
    loaded,
    unloaded: cards ? Math.max(cards, relativeBounds.length) - loaded : (ready ? 0 : 1),
    physicalImageBounds: relativeBounds,
    cardAspectRatios: candidates.cardAspectRatios || [],
    artworkAboveViewportCandidates: candidates.offscreenArtworkCards || 0,
    previouslyVerifiedArtworkAboveViewport: options.previousArtworkVerified ? candidates.offscreenArtworkCards || 0 : 0,
    previousArtworkOverlapRequired: previousArtworkRequired,
    previousArtworkOverlapVerified: !previousArtworkRequired || Boolean(options.previousArtworkVerified),
    previousArtworkTailPhysicalBottom: Math.round((candidates.offscreenArtworkTailBottom || 0) * scaleY),
    reason: !imagesReady ? 'visible_artwork_unloaded' : !ready ? 'previous_artwork_overlap_unverified' : null,
  }
}

module.exports = {
  miniAppReferenceProductsOcrTrigger,
  miniAppReferenceProductsTrigger,
  referenceProductsTrigger,
  refreshedReferenceProductsTrigger,
  referenceProductDrawerBounds,
  referenceProductsCaptureComplete,
  referenceProductSheetExpanded,
  calibratedProductFallbackOverlap,
  referenceProductViewportReadiness,
}
