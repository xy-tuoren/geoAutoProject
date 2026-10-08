const sharp = require('sharp')
const { cropImage, imageInfo, imageLooksLoaded } = require('./images')
const { nodeAttr, nodeIsVisible, parseBounds, parseNodeTree } = require('./hierarchy')
const { hierarchyLogicalSize } = require('./miniapp-locators')

const DOUYIN_PACKAGE = 'com.ss.android.ugc.aweme'
const ENTRY_LABEL = /小荷|咨询|医学数据智能总结|查看全文|查看更多|字节跳动旗下医疗大模型/
const MEDIA_CONTROL_LABEL = /^(?:静音|取消静音|开启声音|关闭声音|声音|音量)$/

function flatten(node, out = []) {
  for (const child of node.children) { out.push(child); flatten(child, out) }
  return out
}

function nodeBounds(node) {
  if (!nodeIsVisible(node.attrs)) return null
  try {
    const bounds = parseBounds(nodeAttr(node.attrs, 'bounds'))
    return bounds?.length === 4 && bounds.every(Number.isFinite)
      && bounds[2] > bounds[0] && bounds[3] > bounds[1] ? bounds : null
  } catch { return null }
}

function label(node) {
  return [nodeAttr(node.attrs, 'text'), nodeAttr(node.attrs, 'content-desc')].filter(Boolean).join(' ')
}

function contains(outer, inner) {
  return inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3]
}

function overlaps(first, second) {
  return first[0] < second[2] && first[2] > second[0] && first[1] < second[3] && first[3] > second[1]
}

// These are comparison masks, never OCR/capture crops. Require explicit media
// semantics or a product card with independently visible price/sales captions.
function douyinSearchDynamicRegions(xml, size) {
  if (!size || size.width <= 0 || size.height <= size.width) return []
  const nodes = flatten(parseNodeTree(xml))
  const visible = nodes.filter(node => nodeBounds(node))
  const protectedBounds = visible.filter(node => ENTRY_LABEL.test(label(node))
    || /WebView/.test(nodeAttr(node.attrs, 'class'))).map(nodeBounds)
  const candidates = []
  const add = (node, kind, identity) => {
    const bounds = nodeBounds(node)
    if (!bounds || nodeAttr(node.attrs, 'package') !== DOUYIN_PACKAGE) return
    const width = bounds[2] - bounds[0], height = bounds[3] - bounds[1]
    if (bounds[0] < 0 || bounds[2] > size.width || bounds[1] < size.height * 0.14
      || bounds[3] > size.height * 0.97 || width < size.width * 0.1
      || width > size.width * 0.96 || height < size.height * 0.1
      || height > size.height * 0.55 || protectedBounds.some(box => overlaps(box, bounds))) return
    candidates.push({ bounds, kind, identity })
  }
  for (const node of visible) {
    const description = nodeAttr(node.attrs, 'content-desc')
    if (/的直播间[，,].*直播中/.test(description)) {
      add(node, 'live', description.replace(/观众[^，,]*[，,]?/g, ''))
    } else if (/^(?:android\.view\.)?(?:SurfaceView|TextureView)$/.test(nodeAttr(node.attrs, 'class'))) {
      add(node, 'video_surface', nodeAttr(node.attrs, 'resource-id'))
    }
  }
  for (const card of visible) {
    const box = nodeBounds(card)
    if (nodeAttr(card.attrs, 'class') !== 'android.widget.FrameLayout'
      || nodeAttr(card.attrs, 'package') !== DOUYIN_PACKAGE
      || box[2] - box[0] < size.width * 0.35 || box[2] - box[0] > size.width * 0.58) continue
    const children = flatten(card).filter(node => nodeBounds(node))
    const captions = children.filter(node => label(node) && !MEDIA_CONTROL_LABEL.test(label(node)))
    if (!captions.some(node => /^[¥￥](?:\s*\d.*)?$/.test(label(node)))
      || !captions.some(node => /^已售[\d千万]/.test(label(node)))) continue
    const firstCaptionTop = Math.min(...captions.map(node => nodeBounds(node)[1]))
    const previews = children.filter(node => {
      const bounds = nodeBounds(node)
      return /^(?:android\.view\.ViewGroup|android\.widget\.FrameLayout)$/.test(nodeAttr(node.attrs, 'class'))
        && bounds[2] - bounds[0] >= (box[2] - box[0]) * 0.9
        && Math.abs(bounds[1] - box[1]) <= size.height * 0.005
        && bounds[3] <= firstCaptionTop && !label(node)
        && !flatten(node).some(child => ENTRY_LABEL.test(label(child)) || /WebView/.test(nodeAttr(child.attrs, 'class'))
          || (label(child) && !MEDIA_CONTROL_LABEL.test(label(child))))
    }).sort((a, b) => nodeBounds(b)[3] - nodeBounds(a)[3])
    if (previews[0]) add(previews[0], 'product_media', 'product_preview')
  }
  // Prefer the enclosing verified preview over its nested render surfaces.
  const unique = []
  for (const candidate of candidates.sort((a, b) => {
    const area = item => (item.bounds[2] - item.bounds[0]) * (item.bounds[3] - item.bounds[1])
    return area(b) - area(a)
  })) {
    if (!unique.some(item => contains(item.bounds, candidate.bounds))) unique.push(candidate)
  }
  return unique.sort((a, b) => a.bounds[1] - b.bounds[1] || a.bounds[0] - b.bounds[0])
}

function structure(xml, regions, size) {
  const tokens = []
  const seenMedia = new Set()
  let resultLabels = 0
  const visit = node => {
    const bounds = nodeBounds(node)
    if (bounds) {
      const region = regions.find(item => contains(item.bounds, bounds))
      if (region) {
        const key = JSON.stringify(region)
        if (!seenMedia.has(key)) { tokens.push(['media', region.kind, region.bounds, region.identity]); seenMedia.add(key) }
        return
      }
      if (bounds[3] > size.height * 0.04 && bounds[1] < size.height * 0.97
        && nodeAttr(node.attrs, 'package') === DOUYIN_PACKAGE) {
        const text = label(node)
        tokens.push([nodeAttr(node.attrs, 'class'), nodeAttr(node.attrs, 'resource-id'), bounds, text])
        if (text.length >= 3 && bounds[1] > size.height * 0.17
          && !/^(?:直播|图文|视频|用户|综合|商品|继续追问)$/.test(text)) resultLabels++
      }
    }
    for (const child of node.children) visit(child)
  }
  visit(parseNodeTree(xml))
  return { fingerprint: tokens.length ? JSON.stringify(tokens) : null, layoutReady: resultLabels >= 2 }
}

async function createSearchObservation(frame, xml, { ignoreDynamicMedia = false, logicalSize = null } = {}) {
  const physical = await imageInfo(frame)
  if (physical.height <= physical.width) throw new Error('搜索首屏检查仅支持正常竖屏截图。')
  const size = ignoreDynamicMedia ? hierarchyLogicalSize(xml, logicalSize || physical) : physical
  const scaleX = physical.width / size.width, scaleY = physical.height / size.height
  // Refuse to mask when screenshot and hierarchy do not describe the same viewport.
  const compatible = Math.abs(scaleX / scaleY - 1) <= 0.03
  const regions = ignoreDynamicMedia && compatible ? douyinSearchDynamicRegions(xml, size) : []
  const body = await cropImage(frame, [0, Math.round(physical.height * 0.22), physical.width, Math.round(physical.height * 0.92)])
  let comparison = frame
  if (regions.length) {
    const decoded = await sharp(frame).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    const raw = { data: decoded.data, ...decoded.info }
    for (const { bounds } of regions) {
      const left = Math.max(0, Math.floor(bounds[0] * scaleX)), right = Math.min(raw.width, Math.ceil(bounds[2] * scaleX))
      const top = Math.max(0, Math.floor(bounds[1] * scaleY)), bottom = Math.min(raw.height, Math.ceil(bounds[3] * scaleY))
      for (let y = top; y < bottom; y++) raw.data.fill(255, (y * raw.width + left) * raw.channels, (y * raw.width + right) * raw.channels)
    }
    comparison = await sharp(raw.data, { raw: { width: raw.width, height: raw.height, channels: raw.channels } }).png().toBuffer()
  }
  const evidence = ignoreDynamicMedia && compatible ? structure(xml, regions, size) : { fingerprint: null, layoutReady: false }
  return {
    content: await cropImage(comparison, [0, Math.round(physical.height * 0.04), physical.width, Math.round(physical.height * 0.97)]),
    ...evidence,
    loaded: await imageLooksLoaded(body),
    dynamicRegionsIgnored: regions.length,
    stabilityPolicy: regions.length ? 'verified_media_mask' : 'full_first_screen',
  }
}

module.exports = { douyinSearchDynamicRegions, createSearchObservation }
