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
  // Different UiAutomator serializers use either attribute. Some versions use
  // visible-to-user, while others expose displayed or omit both for visible
  // nodes.
  const visible = nodeAttr(attrs, 'visible-to-user')
  const displayed = nodeAttr(attrs, 'displayed')
  if (!visible && !displayed) return Boolean(nodeAttr(attrs, 'bounds'))
  return visible === 'true' || displayed === 'true'
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
    const ambiguous = new Set()
    for (const attrs of iterNodes(xml)) {
      if (!nodeIsVisible(attrs)) continue
      const label = nodeAttr(attrs, 'text') || nodeAttr(attrs, 'content-desc')
      const rawBounds = nodeAttr(attrs, 'bounds')
      if (!label || label.length < 3 || !rawBounds || ambiguous.has(label)) continue
      const bounds = parseBounds(rawBounds)
      if (!boundsIntersect(bounds, region)) continue
      if (result.has(label)) { result.delete(label); ambiguous.add(label); continue }
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
  if (shifts.length === 1) return shifts[0]
  const median = shifts[Math.floor(shifts.length / 2)]
  const tolerance = Math.max(24, Math.floor(maxShift * 0.025))
  const inliers = shifts.filter(shift => Math.abs(shift - median) <= tolerance)
  if (inliers.length < Math.ceil(shifts.length * 0.6)) return null
  return inliers[Math.floor(inliers.length / 2)]
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
  const inTailArea = bounds => boundsCenterY(bounds) >= lowerY - tolerance && boundsCenterY(bounds) <= bottom
  const copyVisible = iterNodes(xml).some(attrs => {
    if (!nodeIsVisible(attrs)) return false
    const label = nodeAttr(attrs, 'text') || nodeAttr(attrs, 'content-desc')
    const rawBounds = nodeAttr(attrs, 'bounds')
    return label.includes('复制') && rawBounds && inTailArea(parseBounds(rawBounds))
  })
  if (!copyVisible) return false
  return iterNodes(xml).some(attrs => {
    if (!nodeIsVisible(attrs)) return false
    const label = nodeAttr(attrs, 'text') || nodeAttr(attrs, 'content-desc')
    const rawBounds = nodeAttr(attrs, 'bounds')
    if (!label.includes('AI生成') || !rawBounds || !inTailArea(parseBounds(rawBounds))) return false
    return label.includes('仅供参考')
      || label.includes('不适就医')
      || label.includes('不适请就医')
      || label.includes('诊疗依据')
      || label.includes('可能存在不准确')
  })
}

function questionVisible(xml, question, chatBounds) {
  const needle = String(question).trim()
  if (!needle) return false
  const prefix = needle.slice(0, Math.min(24, needle.length))
  const verticalInset = Math.max(12, Math.floor((chatBounds[3] - chatBounds[1]) * 0.02))
  return userQuestionCandidates(xml, chatBounds).some(({ label, bounds }) => {
    return (label.includes(needle) || (prefix && label.includes(prefix)))
      && bounds[1] >= chatBounds[1] + verticalInset
      && bounds[3] <= chatBounds[3] - verticalInset
  })
}

function userQuestionCandidates(xml, chatBounds) {
  const chatWidth = chatBounds[2] - chatBounds[0]
  const candidates = []
  const visit = (node, ancestors) => {
    const text = nodeAttr(node.attrs, 'text')
    const description = nodeAttr(node.attrs, 'content-desc')
    const label = text || description
    const rawBounds = nodeAttr(node.attrs, 'bounds')
    const nodeClass = nodeAttr(node.attrs, 'class') || node.tag
    if (label && rawBounds && nodeIsVisible(node.attrs) && nodeClass === 'android.widget.TextView'
      && description === label
      && !/^\d{1,2}:\d{2}$/.test(label) && !/^\d+[.)、]?$/.test(label)) {
      const bounds = parseBounds(rawBounds)
      const parent = ancestors.at(-1)
      const parentRaw = parent && nodeAttr(parent.attrs, 'bounds')
      const parentBounds = parentRaw ? parseBounds(parentRaw) : null
      // In the chat Compose tree the message row is the direct parent of the
      // bubble container. Product badges can have the same right-inset shape,
      // but only inside several additional card/carousel ancestors.
      const row = ancestors.at(-2)
      const rowRaw = row && nodeAttr(row.attrs, 'bounds')
      const rowBounds = rowRaw ? parseBounds(rowRaw) : null
      if (parentBounds && rowBounds && boundsIntersect(bounds, chatBounds)
        && rowBounds[2] - rowBounds[0] >= chatWidth * 0.72
        && rowBounds[0] <= bounds[0] && rowBounds[2] >= bounds[2]
        // Longer questions legitimately produce wider right-aligned bubbles.
        // Keep a proportional right-bubble inset while allowing the 1080-wide
        // live layout whose left inset is about 15.7% of the chat viewport.
        && parentBounds[0] >= rowBounds[0] + chatWidth * 0.14
        && parentBounds[2] <= rowBounds[2] - chatWidth * 0.02
        && parentBounds[2] - parentBounds[0] <= (rowBounds[2] - rowBounds[0]) * 0.86
        && Math.abs(parentBounds[0] - bounds[0]) <= chatWidth * 0.04
        && Math.abs(parentBounds[2] - bounds[2]) <= chatWidth * 0.04) {
        candidates.push({ label, bounds, bottom: bounds[3] })
      }
    }
    for (const child of node.children) visit(child, [...ancestors, node])
  }
  visit(parseNodeTree(xml), [])
  return candidates
}

// Locate the latest visible user bubble without reading from or focusing the
// composer. A user message is rendered as a right-inset bubble inside a
// substantially wider chat row; assistant paragraphs use the full-width left
// column and therefore do not have this nested geometry.
function currentQuestionText(xml, chatBounds) {
  const candidates = userQuestionCandidates(xml, chatBounds)
  candidates.sort((a, b) => b.bottom - a.bottom)
  return candidates[0]?.label || null
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

function floatingScrollControlBounds(xml, chatBounds) {
  const width = chatBounds[2] - chatBounds[0]
  const height = chatBounds[3] - chatBounds[1]
  const centerX = (chatBounds[0] + chatBounds[2]) / 2
  const candidates = iterNodes(xml).flatMap(attrs => {
    if (!nodeIsVisible(attrs) || nodeAttr(attrs, 'clickable') !== 'true') return []
    if (nodeAttr(attrs, 'text') || nodeAttr(attrs, 'content-desc')) return []
    const rawBounds = nodeAttr(attrs, 'bounds')
    if (!rawBounds) return []
    const bounds = parseBounds(rawBounds)
    const itemWidth = bounds[2] - bounds[0]
    const itemHeight = bounds[3] - bounds[1]
    const itemCenterX = (bounds[0] + bounds[2]) / 2
    if (bounds[0] < chatBounds[0] || bounds[2] > chatBounds[2] || bounds[1] < chatBounds[1] || bounds[3] > chatBounds[3]) return []
    if (itemWidth < width * 0.07 || itemWidth > width * 0.2 || itemHeight < itemWidth * 0.75 || itemHeight > itemWidth * 1.25) return []
    if (Math.abs(itemCenterX - centerX) > width * 0.08 || bounds[1] < chatBounds[1] + height * 0.6) return []
    return [bounds]
  })
  candidates.sort((a, b) => b[1] - a[1])
  return candidates[0] || null
}

function replyCaptureBounds(xml, screenSize) {
  const bounds = findChatScrollBounds(xml, screenSize)
  const floatingControl = floatingScrollControlBounds(xml, bounds)
  if (floatingControl) {
    const safeBottom = floatingControl[1] - Math.max(8, Math.floor((bounds[3] - bounds[1]) * 0.008))
    if (safeBottom - bounds[1] >= screenSize.height * 0.3) bounds[3] = safeBottom
  }
  return { bounds, floatingControl }
}

function visibleLabelBounds(xml, label) { return visibleNodesWithLabel(xml, label)[0] || null }

function visibleLabelBoundsList(xml, label) { return visibleNodesWithLabel(xml, label) }

function responseTimeoutRetryTarget(xml, chatBounds) {
  const chatWidth = chatBounds[2] - chatBounds[0]
  const chatHeight = chatBounds[3] - chatBounds[1]
  const candidates = iterNodes(xml).flatMap(attrs => {
    if (!nodeIsVisible(attrs)) return []
    const rawBounds = nodeAttr(attrs, 'bounds')
    if (!rawBounds) return []
    const bounds = parseBounds(rawBounds)
    if (!boundsIntersect(bounds, chatBounds)) return []
    return [{
      attrs,
      bounds,
      label: (nodeAttr(attrs, 'text') || nodeAttr(attrs, 'content-desc')).trim(),
      packageName: nodeAttr(attrs, 'package'),
    }]
  })
  const prompts = candidates.filter(candidate =>
    candidate.label.includes('响应超时')
    && (candidate.label.includes('重新生成回答') || candidate.label.includes('重试')))
  const retries = candidates.filter(candidate => {
    const width = candidate.bounds[2] - candidate.bounds[0]
    const height = candidate.bounds[3] - candidate.bounds[1]
    return candidate.label === '重试'
      && nodeAttr(candidate.attrs, 'clickable') === 'true'
      && /Button$/.test(nodeAttr(candidate.attrs, 'class'))
      && width >= chatWidth * 0.35
      && height >= chatHeight * 0.025
      && height <= chatHeight * 0.16
  })
  const pairs = []
  for (const prompt of prompts) {
    for (const retry of retries) {
      if (prompt.packageName && retry.packageName && prompt.packageName !== retry.packageName) continue
      const gap = retry.bounds[1] - prompt.bounds[3]
      if (gap < 0 || gap > chatHeight * 0.12) continue
      pairs.push({ prompt, retry, gap })
    }
  }
  pairs.sort((first, second) => first.gap - second.gap)
  const pair = pairs[0]
  if (!pair) return null
  return {
    promptBounds: pair.prompt.bounds,
    retryBounds: pair.retry.bounds,
    tap: [
      Math.floor((pair.retry.bounds[0] + pair.retry.bounds[2]) / 2),
      boundsCenterY(pair.retry.bounds),
    ],
  }
}

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
  const root = { tag: '', attrs: '', children: [] }
  const stack = [root]
  for (const token of tokens) {
    if (token.startsWith('<?') || token.startsWith('<!')) continue
    if (token.startsWith('</')) { if (stack.length > 1) stack.pop(); continue }
    if (!/^<(?:node|[A-Za-z][\w.$-]*)\b/.test(token)) continue
    const tag = token.match(/^<([^\s>/]+)/)?.[1] || ''
    const attrs = token.replace(/^<[^\s>/]+/, '').replace(/\/?>$/, '')
    const node = { tag, attrs, children: [] }
    stack[stack.length - 1].children.push(node)
    if (!token.endsWith('/>')) stack.push(node)
  }
  return root
}

function collectNodes(node, out = []) {
  for (const child of node.children) { out.push(child); collectNodes(child, out) }
  return out
}

// UiAutomator serializers do not agree on visibility attributes. Treat a node
// as usable unless it is explicitly hidden so structural detection works
// across supported Android versions.
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
  // Visibility is intentionally not required: some hierarchy serializers omit
  // displayed/visible-to-user entirely, and the structural signature
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

// Some app/device combinations expose product artwork as ImageView nodes,
// while others expose each Compose product card as an opaque ViewGroup.  In
// the latter case infer only the artwork portion near the top of a fully sized
// card; this lets capture readiness remain image-aware without waiting for
// accessibility labels that will never appear.
function referenceProductImageBounds(xml, listBounds) {
  const listWidth = listBounds[2] - listBounds[0]
  const listHeight = listBounds[3] - listBounds[1]
  const root = parseNodeTree(xml)
  const allNodes = collectNodes(root)
  const listNode = allNodes.find(node => {
    if (nodeAttr(node.attrs, 'class') !== 'androidx.recyclerview.widget.RecyclerView') return false
    const rawBounds = nodeAttr(node.attrs, 'bounds')
    return rawBounds && parseBounds(rawBounds).join(',') === listBounds.join(',')
  })
  // Bottom sheets can leave the obscured chat hierarchy attached behind them.
  // Scope image readiness to the RecyclerView subtree so a fixed input icon or
  // toolbar icon cannot be mistaken for loaded product artwork.
  const scopedNodes = listNode ? collectNodes(listNode) : allNodes
  const explicit = scopedNodes.flatMap(node => {
    if (nodeAttr(node.attrs, 'class') !== 'android.widget.ImageView' || !nodeNotHidden(node.attrs)) return []
    const rawBounds = nodeAttr(node.attrs, 'bounds')
    return rawBounds ? [parseBounds(rawBounds)] : []
  }).filter(bounds => {
    const width = bounds[2] - bounds[0]
    const height = bounds[3] - bounds[1]
    return boundsIntersect(bounds, listBounds) && width >= 60 && height >= 45
  })
  if (explicit.length) return { mode: 'explicit_images', bounds: explicit }

  const inferred = []
  const seen = new Set()
  for (const node of scopedNodes) {
    const attrs = node.attrs
    if (nodeAttr(attrs, 'class') !== 'android.view.ViewGroup') continue
    const rawBounds = nodeAttr(attrs, 'bounds')
    if (!rawBounds) continue
    const card = parseBounds(rawBounds)
    const width = card[2] - card[0]
    const height = card[3] - card[1]
    if (width < listWidth * 0.28 || width > listWidth * 0.5 || height < listHeight * 0.32) continue
    const marginX = Math.max(8, Math.round(width * 0.06))
    const artwork = [
      card[0] + marginX,
      card[1] + Math.round(height * 0.03),
      card[2] - marginX,
      card[1] + Math.round(height * 0.55),
    ]
    const visible = [
      Math.max(listBounds[0], artwork[0]),
      Math.max(listBounds[1], artwork[1]),
      Math.min(listBounds[2], artwork[2]),
      Math.min(listBounds[3], artwork[3]),
    ]
    if (visible[2] - visible[0] < 60 || visible[3] - visible[1] < 80) continue
    const key = visible.join(',')
    if (!seen.has(key)) { seen.add(key); inferred.push(visible) }
  }
  return { mode: inferred.length ? 'inferred_card_artwork' : 'viewport_content', bounds: inferred }
}

module.exports = { LOADING_TEXT_MARKERS, iterNodes, nodeAttr, nodeIsVisible, parseBounds, boundsIntersect, boundsCenterY, estimateVerticalScrollShift, sharedTextSeam, hierarchyIsLoading, visibleNodesWithLabel, replyTailOnScreen, questionVisible, currentQuestionText, findChatScrollBounds, validateCaptureViewport, floatingScrollControlBounds, replyCaptureBounds, visibleLabelBounds, visibleLabelBoundsList, responseTimeoutRetryTarget, boundsForNodeAttribute, boundsListForNodeAttribute, evidencePanelBounds, panelIsClipped, evidenceMinimumHeight, parseNodeTree, referenceProductsSection, referenceProductImageBounds }
