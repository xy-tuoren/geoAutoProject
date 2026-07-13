const LOADING_TEXT_MARKERS = ['正在生成咨询小结', '正在生成', '正在思考', '思考中', '请稍候', '加载中']

function iterNodes(xml) {
  // UiAutomator may emit either the conventional <node .../> tree or a
  // class-named tree such as <android.widget.TextView .../>. Treat both as
  // UI nodes; otherwise every visibility lookup silently misses on newer
  // Android/UiAutomator combinations.
  return [...String(xml).matchAll(/<(?!\/)(?:node|[A-Za-z][\w.$-]*)\b([^>]*)\/?>/g)].map(match => match[1])
}

function nodeAttr(attrs, name) {
  const match = String(attrs).match(new RegExp(`${name}="([^"]*)"`))
  return match ? match[1] : ''
}

function nodeIsVisible(attrs) {
  // Different UiAutomator serializers use either attribute. Older dumps use
  // visible-to-user, while this device exposes displayed only.
  return nodeAttr(attrs, 'visible-to-user') === 'true' || nodeAttr(attrs, 'displayed') === 'true'
}

function parseBounds(bounds) {
  const match = String(bounds).match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/)
  if (!match) throw new Error(`无法识别控件范围：${bounds}`)
  return match.slice(1).map(Number)
}

function boundsIntersect(first, second) {
  return first[0] < second[2] && first[2] > second[0] && first[1] < second[3] && first[3] > second[1]
}

function boundsCenterY(bounds) { return Math.floor((bounds[1] + bounds[3]) / 2) }

function estimateVerticalScrollShift(beforeXml, afterXml, region) {
  const labels = xml => {
    const result = new Map()
    for (const attrs of iterNodes(xml)) {
      if (!nodeIsVisible(attrs)) continue
      const label = nodeAttr(attrs, 'text') || nodeAttr(attrs, 'content-desc')
      const rawBounds = nodeAttr(attrs, 'bounds')
      if (!label || label.length < 3 || !rawBounds) continue
      const bounds = parseBounds(rawBounds)
      if (!boundsIntersect(bounds, region) || result.has(label)) continue
      result.set(label, boundsCenterY(bounds))
    }
    return result
  }
  const before = labels(beforeXml)
  const after = labels(afterXml)
  const maxShift = region[3] - region[1]
  const shifts = []
  for (const [label, beforeY] of before) {
    if (!after.has(label)) continue
    const shift = beforeY - after.get(label)
    if (shift >= 20 && shift < maxShift) shifts.push(shift)
  }
  if (!shifts.length) return null
  shifts.sort((a, b) => a - b)
  return shifts[Math.floor(shifts.length / 2)]
}

function sharedTextSeam(beforeXml, afterXml, region) {
  const collect = xml => {
    const result = new Map()
    const ambiguous = new Set()
    for (const attrs of iterNodes(xml)) {
      if (!nodeIsVisible(attrs)) continue
      const label = nodeAttr(attrs, 'text') || nodeAttr(attrs, 'content-desc')
      const rawBounds = nodeAttr(attrs, 'bounds')
      if (!label || label.length < 4 || !rawBounds || ambiguous.has(label)) continue
      const bounds = parseBounds(rawBounds)
      if (bounds[1] < region[1] || bounds[3] > region[3] || !boundsIntersect(bounds, region)) continue
      // Repeated headings or list items are not stable seam anchors. Picking
      // the first matching label can jump to another occurrence and duplicate
      // a whole paragraph in the long image.
      if (result.has(label)) { result.delete(label); ambiguous.add(label); continue }
      result.set(label, bounds)
    }
    return result
  }
  const before = collect(beforeXml)
  const after = collect(afterXml)
  const height = region[3] - region[1]
  const candidates = []
  for (const [label, previous] of before) {
    const current = after.get(label)
    if (!current) continue
    const shift = boundsCenterY(previous) - boundsCenterY(current)
    const previousEnd = previous[1] - region[1]
    const currentStart = current[1] - region[1]
    if (shift < 20 || previousEnd < height * 0.35 || previousEnd > height * 0.9 || currentStart < 0 || currentStart > height * 0.65) continue
    candidates.push({ previousEnd, currentStart, labelLength: label.length })
  }
  candidates.sort((a, b) => b.previousEnd - a.previousEnd || b.labelLength - a.labelLength)
  const seam = candidates[0]
  return seam ? { previousEnd: seam.previousEnd, currentStart: seam.currentStart } : null
}

function hierarchyIsLoading(xml) { return LOADING_TEXT_MARKERS.some(marker => String(xml).includes(marker)) }

function visibleNodesWithLabel(xml, label) {
  return iterNodes(xml).flatMap(attrs => {
    if (!nodeIsVisible(attrs)) return []
    if (nodeAttr(attrs, 'text') !== label && nodeAttr(attrs, 'content-desc') !== label) return []
    const bounds = nodeAttr(attrs, 'bounds')
    return bounds ? [parseBounds(bounds)] : []
  })
}

function replyTailOnScreen(xml, chatBounds) {
  const [, top,, bottom] = chatBounds
  const lowerY = top + Math.floor((bottom - top) * 0.45)
  const tolerance = Math.max(1, Math.floor((bottom - top) * 0.064))
  if (!visibleNodesWithLabel(xml, '复制').some(bounds => boundsCenterY(bounds) >= lowerY && boundsCenterY(bounds) <= bottom)) return false
  const disclaimer = visibleNodesWithLabel(xml, 'AI生成非医疗诊断仅供参考 不适就医')
  if (disclaimer.some(bounds => boundsCenterY(bounds) >= lowerY - tolerance && boundsCenterY(bounds) <= bottom)) return true
  return iterNodes(xml).some(attrs => {
    if (!nodeIsVisible(attrs)) return false
    const text = nodeAttr(attrs, 'text')
    const bounds = nodeAttr(attrs, 'bounds')
    return text.includes('AI生成非医疗诊断仅供参考') && bounds && boundsCenterY(parseBounds(bounds)) >= lowerY - tolerance && boundsCenterY(parseBounds(bounds)) <= bottom
  })
}

function questionVisible(xml, question, chatBounds) {
  const needle = String(question).trim()
  if (!needle) return false
  const prefix = needle.slice(0, Math.min(24, needle.length))
  return iterNodes(xml).some(attrs => {
    if (!nodeIsVisible(attrs)) return false
    const label = nodeAttr(attrs, 'text') || nodeAttr(attrs, 'content-desc')
    const bounds = nodeAttr(attrs, 'bounds')
    return Boolean(label && bounds && (label.includes(needle) || (prefix && label.includes(prefix))) && boundsIntersect(parseBounds(bounds), chatBounds))
  })
}

function findChatScrollBounds(xml, screenSize) {
  let best = null
  let bestArea = 0
  for (const attrs of iterNodes(xml)) {
    if (nodeAttr(attrs, 'scrollable') !== 'true') continue
    const rawBounds = nodeAttr(attrs, 'bounds')
    if (!rawBounds) continue
    const bounds = parseBounds(rawBounds)
    const area = Math.max(0, bounds[2] - bounds[0]) * Math.max(0, bounds[3] - bounds[1])
    if (area > bestArea) { best = bounds; bestArea = area }
  }
  if (best && bestArea > screenSize.width * screenSize.height * 0.15) {
    const adjusted = [...best]
    for (const attrs of iterNodes(xml)) {
      if (nodeAttr(attrs, 'class') !== 'android.widget.EditText' || !nodeIsVisible(attrs)) continue
      const rawBounds = nodeAttr(attrs, 'bounds')
      if (!rawBounds) continue
      const [, inputTop,, inputBottom] = parseBounds(rawBounds)
      if (inputTop > adjusted[1]) adjusted[3] = Math.min(adjusted[3], inputTop - Math.max(80, inputBottom - inputTop + 40))
    }
    if (adjusted[3] - adjusted[1] >= screenSize.height * 0.2) return adjusted
  }
  return [0, Math.floor(screenSize.height * 0.16), screenSize.width, Math.floor(screenSize.height * 0.82)]
}

function validateCaptureViewport(screenSize, bounds) {
  const [left, top, right, bottom] = bounds
  if (screenSize.height <= screenSize.width) throw new Error('仅支持竖屏截图；请将手机保持在竖屏后重试。')
  if (right - left < screenSize.width * 0.7 || bottom - top < screenSize.height * 0.2) throw new Error(`无法可靠识别聊天区域：${bounds.join(',')}，请确认小荷停留在聊天页面。`)
}

function visibleLabelBounds(xml, label) { return visibleNodesWithLabel(xml, label)[0] || null }

function visibleLabelBoundsList(xml, label) { return visibleNodesWithLabel(xml, label) }

function boundsListForNodeAttribute(xml, attribute, value) {
  return iterNodes(xml).flatMap(attrs => {
    if (nodeAttr(attrs, attribute) !== value || !nodeIsVisible(attrs)) return []
    const bounds = nodeAttr(attrs, 'bounds')
    return bounds ? [parseBounds(bounds)] : []
  })
}

function boundsForNodeAttribute(xml, attribute, value) {
  return boundsListForNodeAttribute(xml, attribute, value)[0] || null
}

function evidencePanelBounds(xml, minimumHeight = 1) {
  return iterNodes(xml).flatMap(attrs => {
    if (nodeAttr(attrs, 'class') !== 'androidx.compose.ui.viewinterop.ViewFactoryHolder' || !nodeIsVisible(attrs)) return []
    const bounds = nodeAttr(attrs, 'bounds')
    if (!bounds) return []
    const parsed = parseBounds(bounds)
    return parsed[3] - parsed[1] >= minimumHeight ? [parsed] : []
  })[0] || null
}

function panelIsClipped(panel, chatBounds, tolerance = 8) { return panel[1] <= chatBounds[1] + tolerance || panel[3] >= chatBounds[3] - tolerance }
function evidenceMinimumHeight(chatBounds) { return Math.max(1, Math.floor((chatBounds[3] - chatBounds[1]) * 0.065)) }

const COMPOSE_PANEL_CLASS = 'androidx.compose.ui.viewinterop.ViewFactoryHolder'
const HORIZONTAL_SCROLL_CLASS = 'android.widget.HorizontalScrollView'

// The 小荷 chat content is rendered by Jetpack Compose, so section labels such
// as "参考药品" never reach the accessibility tree. The reference-products card
// row is still exposed structurally: a Compose interop panel (ViewFactoryHolder)
// whose subtree contains a HorizontalScrollView carousel. Locate it by shape
// rather than by text, which is why a real DOM tree (not a flat scan) is needed.
function parseNodeTree(xml) {
  const tokens = String(xml).match(/<[^>]+>/g) || []
  const root = { attrs: '', children: [] }
  const stack = [root]
  for (const token of tokens) {
    if (token.startsWith('<?') || token.startsWith('<!')) continue
    if (token.startsWith('</')) { if (stack.length > 1) stack.pop(); continue }
    if (!/^<(?:node|[A-Za-z][\w.$-]*)\b/.test(token)) continue
    const attrs = token.replace(/^<[^\s>/]+/, '').replace(/\/?>$/, '')
    const node = { attrs, children: [] }
    stack[stack.length - 1].children.push(node)
    if (!token.endsWith('/>')) stack.push(node)
  }
  return root
}

function collectNodes(node, out = []) {
  for (const child of node.children) { out.push(child); collectNodes(child, out) }
  return out
}

// Appium getPageSource emits displayed="true"; a plain uiautomator dump omits
// visibility entirely. Treat a node as usable unless it is explicitly hidden so
// structural detection works against both serializers.
function nodeNotHidden(attrs) {
  return nodeAttr(attrs, 'visible-to-user') !== 'false' && nodeAttr(attrs, 'displayed') !== 'false'
}

function subtreeContainsClass(node, className) {
  return node.children.some(child => nodeAttr(child.attrs, 'class') === className || subtreeContainsClass(child, className))
}

// Returns the reference-products carousel panel plus the tap point that opens
// its full bottom-sheet list (the "参考药品 >" header arrow), or null when the
// current reply has no medicine cards.
function referenceProductsSection(xml) {
  const nodes = collectNodes(parseNodeTree(xml))
  // Visibility is intentionally not required: uiautomator dumps omit the
  // displayed/visible-to-user attribute entirely, and the structural signature
  // (a Compose interop panel wrapping a horizontal carousel) is specific enough.
  const holder = nodes.find(node =>
    nodeAttr(node.attrs, 'class') === COMPOSE_PANEL_CLASS
    && nodeNotHidden(node.attrs)
    && nodeAttr(node.attrs, 'bounds')
    && subtreeContainsClass(node, HORIZONTAL_SCROLL_CLASS))
  if (!holder) return null
  const panel = parseBounds(nodeAttr(holder.attrs, 'bounds'))
  const descendants = collectNodes(holder)
  const carousel = descendants.find(node => nodeAttr(node.attrs, 'class') === HORIZONTAL_SCROLL_CLASS && nodeAttr(node.attrs, 'bounds'))
  const cardsTop = carousel ? parseBounds(nodeAttr(carousel.attrs, 'bounds'))[1] : panel[1] + Math.floor((panel[3] - panel[1]) * 0.12)
  // The header ">" arrow is an ImageView on the right side, above the cards.
  const arrow = descendants.find(node => {
    if (nodeAttr(node.attrs, 'class') !== 'android.widget.ImageView') return false
    const raw = nodeAttr(node.attrs, 'bounds')
    if (!raw) return false
    const bounds = parseBounds(raw)
    return boundsCenterY(bounds) < cardsTop && bounds[2] > panel[0] + (panel[2] - panel[0]) * 0.6
  })
  const tap = arrow
    ? (() => { const bounds = parseBounds(nodeAttr(arrow.attrs, 'bounds')); return [Math.floor((bounds[0] + bounds[2]) / 2), boundsCenterY(bounds)] })()
    : [panel[2] - Math.max(60, Math.floor((panel[2] - panel[0]) * 0.08)), Math.floor((panel[1] + cardsTop) / 2)]
  return { panel, cardsTop, tap }
}

module.exports = { LOADING_TEXT_MARKERS, iterNodes, nodeAttr, nodeIsVisible, parseBounds, boundsIntersect, boundsCenterY, estimateVerticalScrollShift, sharedTextSeam, hierarchyIsLoading, visibleNodesWithLabel, replyTailOnScreen, questionVisible, findChatScrollBounds, validateCaptureViewport, visibleLabelBounds, visibleLabelBoundsList, boundsForNodeAttribute, boundsListForNodeAttribute, evidencePanelBounds, panelIsClipped, evidenceMinimumHeight, parseNodeTree, referenceProductsSection }
