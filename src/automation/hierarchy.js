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

function boundsForNodeAttribute(xml, attribute, value) {
  for (const attrs of iterNodes(xml)) {
    if (nodeAttr(attrs, attribute) !== value || !nodeIsVisible(attrs)) continue
    const bounds = nodeAttr(attrs, 'bounds')
    if (bounds) return parseBounds(bounds)
  }
  return null
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

module.exports = { LOADING_TEXT_MARKERS, iterNodes, nodeAttr, nodeIsVisible, parseBounds, boundsIntersect, boundsCenterY, hierarchyIsLoading, visibleNodesWithLabel, replyTailOnScreen, questionVisible, findChatScrollBounds, validateCaptureViewport, visibleLabelBounds, boundsForNodeAttribute, evidencePanelBounds, panelIsClipped, evidenceMinimumHeight }
