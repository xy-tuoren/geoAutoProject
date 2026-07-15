const fs = require('node:fs/promises')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { sleep, createBatchDirectory, batchArtifactDirectories, entryArtifactDirectories, questionArtifactDirectories } = require('./utils')
const { EventLog } = require('./event-log')
const { iterNodes, nodeAttr, nodeIsVisible, hierarchyIsLoading, parseBounds, parseNodeTree, boundsIntersect, boundsCenterY, estimateVerticalScrollShift, questionVisible, currentQuestionText, findChatScrollBounds, validateCaptureViewport, replyCaptureBounds, visibleLabelBounds, visibleLabelBoundsList, boundsForNodeAttribute, evidencePanelBounds, evidenceMinimumHeight, referenceProductsSection, referenceProductImageBounds } = require('./hierarchy')
const { imageInfo, cropImage, imagesSimilar, imageRegionsStable, imageLooksLoaded, verifyFrameOverlap, verifyProductGridOverlap, composeLongImages } = require('./images')
const { U2Client } = require('./u2-client')
const { ScrcpyObserver, SCRCPY_VERSION } = require('./scrcpy-observer')
const { bundledScrcpyServer } = require('../runtime-paths')

const DEFAULT_PACKAGE = 'com.aurora.xiaohe.aidoctor'
const DEFAULT_MAX_LONG_IMAGE_HEIGHT = 12_000
const REPLY_STABLE_QUIET_MS = 3_000
const DEFAULT_ENTRY_ID = 'xiaohe-app'
const SEARCH_SUMMARY_FILENAME = '回答_智能总结.png'
const DOUYIN_SEARCH_SUMMARY_FILENAME = SEARCH_SUMMARY_FILENAME
const DOUYIN_MINIAPP_ENTRY_FILENAME = '回答_小程序入口.png'
const TOUTIAO_SEARCH_SUMMARY_FILENAME = SEARCH_SUMMARY_FILENAME
const DOUYIN_SUMMARY_PREFERENCE_MS = 3_000
const DOUYIN_INITIAL_RESULT_WAIT_MS = 12_000
const DOUYIN_SEARCH_SCAN_LIMIT = 3
const DOUYIN_POST_SCAN_WAIT_MS = 5_000
const ENTRY_DEFINITIONS = Object.freeze({
  'xiaohe-app': Object.freeze({
    id: 'xiaohe-app',
    label: '小荷AI医生APP',
    packageName: DEFAULT_PACKAGE,
    resourcePackage: DEFAULT_PACKAGE,
    packageLabel: '小荷App',
    inputHints: ['输入问题'],
    submitLabels: ['发送'],
    supportsNewSession: true,
  }),
  'douyin-xiaohe-miniapp': Object.freeze({
    id: 'douyin-xiaohe-miniapp',
    label: '抖音搜索框（小荷AI小程序）',
    packageName: 'com.ss.android.ugc.aweme',
    packageLabel: '抖音小荷AI小程序',
    workflow: 'douyin-search',
    supportsNewSession: false,
  }),
  'toutiao-xiaohe-miniapp': Object.freeze({
    id: 'toutiao-xiaohe-miniapp',
    label: '头条搜索框（小荷AI小程序）',
    packageName: 'com.ss.android.article.news',
    packageLabel: '头条小荷AI小程序',
    workflow: 'toutiao-search',
    supportsNewSession: false,
  }),
})
const ENTRY_LIST = Object.freeze(Object.values(ENTRY_DEFINITIONS))

function hierarchyBelongsToPackage(xml, packageName = DEFAULT_PACKAGE) {
  return iterNodes(String(xml)).some(node => nodeAttr(node, 'package') === packageName)
}

function automationEntries() {
  return ENTRY_LIST.map(entry => ({ ...entry }))
}

function normalizeEntryId(value) {
  const id = String(value || '').trim()
  if (!id) return DEFAULT_ENTRY_ID
  if (!ENTRY_DEFINITIONS[id]) {
    throw new Error(`未知入口：${id}。请从桌面端入口列表中选择。`)
  }
  return id
}

function normalizeAutomationEntries(entries) {
  const raw = Array.isArray(entries) && entries.length ? entries : [DEFAULT_ENTRY_ID]
  const seen = new Set()
  const result = []
  for (const value of raw) {
    const id = normalizeEntryId(value)
    if (seen.has(id)) continue
    seen.add(id)
    result.push(ENTRY_DEFINITIONS[id])
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
      || panelHeight > viewportHeight * 0.34) continue
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

async function waitForPackageHierarchy({
  dumpHierarchy,
  packageName = DEFAULT_PACKAGE,
  packageLabel = '目标App',
  delay = sleep,
  now = Date.now,
  timeout = 8_000,
  interval = 250,
}) {
  const deadline = now() + timeout
  let xml = ''
  while (now() < deadline) {
    xml = await dumpHierarchy()
    if (hierarchyBelongsToPackage(xml, packageName)) return xml
    await delay(Math.min(interval, Math.max(0, deadline - now())))
  }
  throw new Error(`当前前台页面不是${packageLabel}（层级中缺少 ${packageName}），已停止UI操作。`)
}

function maxLongImageHeight(value) {
  const parsed = Number(value ?? DEFAULT_MAX_LONG_IMAGE_HEIGHT)
  if (!Number.isInteger(parsed) || parsed < 3_000 || parsed > 30_000) throw new Error('长截图最大高度必须是 3000–30000 之间的整数。')
  return parsed
}

function historyOnboardingVisible(xml) {
  return /在这里查看[「"]?历史对话/.test(String(xml))
}

function adbCommand(adbPath, serial, args) {
  return new Promise((resolve, reject) => {
    execFile(adbPath, ['-s', serial, ...args], { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${error.message}: ${String(stderr || stdout).trim()}`))
      else resolve(String(stdout))
    })
  })
}

function adbBinaryCommand(adbPath, serial, args) {
  return new Promise((resolve, reject) => {
    execFile(adbPath, ['-s', serial, ...args], { encoding: null, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${error.message}: ${Buffer.from(stderr || stdout || '').toString('utf8').trim()}`))
      else resolve(Buffer.from(stdout))
    })
  })
}

async function adbScreenshot(adbPath, serial) {
  await waitForAdbDevice(adbPath, serial)
  try {
    return await adbBinaryCommand(adbPath, serial, ['exec-out', 'screencap', '-p'])
  } catch (error) {
    if (!adbConnectionLost(error)) throw error
    await waitForAdbDevice(adbPath, serial)
    return adbBinaryCommand(adbPath, serial, ['exec-out', 'screencap', '-p'])
  }
}

function adbConnectionLost(error) {
  return /device (?:not found|offline)|closed|no devices\/emulators found/i.test(String(error?.message || error))
}

async function waitForAdbDevice(adbPath, serial, timeout = 30_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try {
      if ((await adbCommand(adbPath, serial, ['get-state'])).trim() === 'device') return
    } catch {}
    await sleep(1_000)
  }
  throw new Error(`ADB 设备 ${serial} 未连接或未授权。请重新插拔 USB 数据线并在手机上确认“允许 USB 调试”。`)
}

async function adbCommandWithReconnect(adbPath, serial, args) {
  await waitForAdbDevice(adbPath, serial)
  try {
    return await adbCommand(adbPath, serial, args)
  } catch (error) {
    if (!adbConnectionLost(error)) throw error
    await waitForAdbDevice(adbPath, serial)
    return adbCommand(adbPath, serial, args)
  }
}

class CancelledError extends Error { constructor() { super('任务已停止。'); this.name = 'CancelledError' } }

class DouyinSearchResultNotFoundError extends Error {
  constructor(message, { cause, scanScrolls = 0 } = {}) {
    super(message, { cause })
    this.name = 'DouyinSearchResultNotFoundError'
    this.scanScrolls = scanScrolls
  }
}

async function runDouyinSearchResultAttempts({ waitForResult, refreshResults }) {
  try {
    return { ...(await waitForResult(1)), attempt: 1, refreshed: false }
  } catch (error) {
    if (!(error instanceof DouyinSearchResultNotFoundError)) throw error
    await refreshResults(error)
  }
  try {
    return { ...(await waitForResult(2)), attempt: 2, refreshed: true }
  } catch (error) {
    if (!(error instanceof DouyinSearchResultNotFoundError)) throw error
    throw new DouyinSearchResultNotFoundError(
      '抖音当前搜索结果刷新后再次扫描，仍未出现小荷AI医生智能总结或可验证的小程序入口卡片。',
      { cause: error, scanScrolls: error.scanScrolls },
    )
  }
}

function fatalBatchError(error) {
  if (error instanceof CancelledError || error?.name === 'CancelledError') return true
  const message = String(error?.message || error)
  return adbConnectionLost(error)
    || /ADB 设备 .*未连接或未授权/.test(message)
    || /(?:无法启动|尚未启动)Python uiautomator2|Python uiautomator2(?:进程已退出|已停止)/.test(message)
}

async function runQuestionsWithRecovery({
  questions,
  beforeQuestion = async () => {},
  prepare,
  execute,
  recordFailure,
  isFatal = fatalBatchError,
  checkCancelled = () => {},
}) {
  let prepared = false
  let completed = 0
  let failed = 0
  for (const [zeroIndex, question] of questions.entries()) {
    checkCancelled()
    const index = zeroIndex + 1
    try {
      await beforeQuestion(question, index)
      if (!prepared) {
        await prepare()
        prepared = true
      }
      await execute(question, index)
      completed += 1
    } catch (error) {
      if (isFatal(error)) throw error
      prepared = false
      failed += 1
      await recordFailure(error, question, index)
    }
  }
  return { completed, failed }
}

function fallbackOverlapEstimates(frameHeight, measuredShift, candidateOverlaps = []) {
  const hasMeasuredShift = Number.isFinite(measuredShift) && measuredShift >= 0 && measuredShift < frameHeight
  const candidates = candidateOverlaps
    .filter(value => Number.isFinite(value) && value >= 0 && value < frameHeight)
    .sort((a, b) => a - b)
  const estimates = candidates.length >= 2 && candidates.at(-1) - candidates[0] <= 3 ? candidates : []
  if (hasMeasuredShift) estimates.push(frameHeight - measuredShift)
  return { estimates, hasMeasuredShift }
}

function conservativeFallbackOverlap(frameHeight, measuredShift, _requestedShift, candidateOverlaps = []) {
  const { estimates, hasMeasuredShift } = fallbackOverlapEstimates(frameHeight, measuredShift, candidateOverlaps)
  if (!estimates.length) return 0
  // Crop no farther than the smallest independent overlap estimate, leaving
  // roughly two text lines as insurance against hierarchy/layout jitter.
  const uncertainty = hasMeasuredShift
    ? Math.max(72, Math.ceil(frameHeight * 0.06))
    : Math.max(96, Math.ceil(frameHeight * 0.08))
  return Math.max(0, Math.floor(Math.min(...estimates) - uncertainty))
}

function chatSwipePlan(bounds, fraction = 0.6, { maxFraction = 0.7, speed = 1400 } = {}) {
  const height = bounds[3] - bounds[1]
  const distance = Math.max(80, Math.floor(height * Math.min(maxFraction, Math.max(0.2, fraction))))
  return { distance, percent: distance / height, speed, durationMs: distance / speed * 1_000 }
}

function scrollEndConfirmed(canScrollMore, unchangedCount) {
  return canScrollMore === false || unchangedCount >= 2
}

function referenceProductsTrigger(xml, chatBounds) {
  for (const label of ['参考药品', '推荐药品']) {
    const bounds = visibleLabelBounds(xml, label)
    if (!bounds || !boundsIntersect(bounds, chatBounds)) continue
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

function requireQuestionLocated(found, question) {
  if (!found) throw new Error(`未能在当前会话中定位刚发送的问题“${question}”，为避免截取旧回答已停止本题`)
}

function calibratedProductFallbackOverlap(overlaps) {
  const recent = overlaps.filter(Number.isFinite).slice(-8)
  if (recent.length < 3) return null
  const low = Math.min(...recent)
  const high = Math.max(...recent)
  if (high - low > 64) return null
  // Prefer a few pixels of harmless duplicate background over cutting into a
  // product row when the current overlap contains animated/lazy artwork.
  return Math.max(0, low - 8)
}

async function referenceProductViewportReadiness(frame, xml, listBounds) {
  const candidates = referenceProductImageBounds(xml, listBounds)
  const frameSize = await imageInfo(frame)
  const relativeBounds = candidates.bounds.map(bounds => [
    Math.max(0, bounds[0] - listBounds[0]),
    Math.max(0, bounds[1] - listBounds[1]),
    Math.min(frameSize.width, bounds[2] - listBounds[0]),
    Math.min(frameSize.height, bounds[3] - listBounds[1]),
  ]).filter(bounds => bounds[2] - bounds[0] >= 60 && bounds[3] - bounds[1] >= 45)
  const loadedFlags = await Promise.all(relativeBounds.map(async bounds => imageLooksLoaded(await cropImage(frame, bounds))))
  const loaded = loadedFlags.filter(Boolean).length
  const viewportLoaded = relativeBounds.length ? true : await imageLooksLoaded(frame)
  const ready = relativeBounds.length ? loaded === relativeBounds.length : viewportLoaded
  return {
    ready,
    mode: candidates.mode,
    cards: visibleLabelBoundsList(xml, '查看说明书').filter(bounds => boundsIntersect(bounds, listBounds)).length || relativeBounds.length,
    images: relativeBounds.length,
    loaded,
    unloaded: relativeBounds.length ? relativeBounds.length - loaded : (ready ? 0 : 1),
  }
}

async function buildReplyImages(frames, { transitions = [], maxHeight = DEFAULT_MAX_LONG_IMAGE_HEIGHT } = {}) {
  return composeLongImages(frames, { transitions, maxHeight, separatorHeight: 24 })
}

async function prepareEmbeddedEvidence({ source, tap, delay, waitForStable, log }, bounds) {
  const minimum = evidenceMinimumHeight(bounds)
  const xml = await source()
  const panel = evidencePanelBounds(xml, minimum)
  if (!panel) return { found: false, expanded: false, capture: await waitForStable(bounds) }
  const viewportHeight = bounds[3] - bounds[1]
  const collapsed = panel[3] - panel[1] <= viewportHeight * 0.16
  if (collapsed) {
    log('capture: 在回答截图前展开引用资料，使其直接进入回答长图')
    await tap((panel[0] + panel[2]) / 2, (panel[1] + panel[3]) / 2)
    await delay(800)
  }
  const capture = await waitForStable(bounds)
  const finalPanel = evidencePanelBounds(capture.xml || '', minimum)
  const expanded = Boolean(finalPanel && finalPanel[3] - finalPanel[1] > viewportHeight * 0.16)
  if (expanded) log('capture: 引用资料已展开并合并到回答截图')
  else if (collapsed) log('capture: 引用资料点击后未确认展开，保留当前状态继续回答截图')
  return { found: true, expanded, capture }
}

async function fillQuestionInput({ ui, tap, source, delay = sleep }, edit, question) {
  await tap((edit.bounds[0] + edit.bounds[2]) / 2, (edit.bounds[1] + edit.bounds[3]) / 2)
  await delay(300)
  // Hierarchy text can lag behind the real EditText value. Always clear so a
  // stale value cannot be appended and silently sent as a different question.
  await ui.sendKeys(question, { clear: true })
  // FastInputIME has no visible keyboard on this device. Pressing Back after
  // sendKeys exits the app instead of hiding an IME, so let sendKeys restore
  // the user's original IME and confirm the target hierarchy directly.
  await delay(350)
  return source()
}

async function captureStableSandwich({
  capture,
  hierarchy,
  framesStable,
  hierarchyLoading,
  delay = sleep,
  now = Date.now,
  interval = 80,
  initialFrame = null,
  initialXml = '',
  requiredStablePairs = 1,
}, timeout = 8_000) {
  if (!Number.isInteger(requiredStablePairs) || requiredStablePairs < 1) throw new Error('稳定帧组数必须是正整数。')
  let before = initialFrame || await capture()
  let lastXml = initialXml
  let attempts = 0
  let stablePairs = 0
  const deadline = now() + timeout
  while (now() < deadline) {
    await delay(interval)
    // The first frame is taken before hierarchy collection and the second
    // immediately after it. The default path needs one stable pair; strict
    // activity fallback asks for consecutive pairs without changing this loop.
    lastXml = await hierarchy()
    const after = await capture()
    attempts += 1
    if (!hierarchyLoading(lastXml) && await framesStable(before, after)) {
      stablePairs += 1
      if (stablePairs >= requiredStablePairs) return { frame: after, xml: lastXml, stable: true, attempts }
    } else stablePairs = 0
    before = after
  }
  return { frame: before, xml: lastXml || await hierarchy(), stable: false, attempts }
}

async function captureStableObserved({
  observer,
  capture,
  hierarchy,
  hierarchyLoading,
  settleSince = null,
  now = Date.now,
  settleWaitCap = 2_500,
  settleQuietMs = 650,
  settleConservativeQuietMs = 1_000,
  confirmQuietMs = 300,
}, timeout = 3_500) {
  const deadline = now() + timeout
  const remaining = deadline - now()
  if (remaining <= 0) {
    return { frame: null, xml: '', stable: false, attempts: 0, observer: true, reason: 'observer_timeout' }
  }
  // scrcpy is the cheap first gate, but it must leave time for XML and PNG
  // confirmation after the quiet window; otherwise strict quiet checks turn
  // into avoidable capture_deadline fallbacks.
  const reserveForCapture = Math.min(1_000, Math.max(confirmQuietMs + 150, Math.floor(remaining * 0.28)))
  const initialWaitTimeout = Math.max(1, Math.min(settleWaitCap, remaining - reserveForCapture))
  const settled = settleSince && typeof observer.waitForSettleSince === 'function'
    ? await observer.waitForSettleSince(settleSince, {
        hardTimeout: initialWaitTimeout,
        quietMs: settleQuietMs,
        conservativeQuietMs: settleConservativeQuietMs,
      })
    : typeof observer.waitForNoActivity === 'function'
      ? await observer.waitForNoActivity({
          timeout: initialWaitTimeout,
          quietMs: settleQuietMs,
          minWaitMs: Math.min(120, initialWaitTimeout),
        })
      : await observer.waitForQuiet({
          timeout: initialWaitTimeout,
          windowMs: settleQuietMs,
          quietMs: settleQuietMs,
          maxFrames: 0,
          minWaitMs: Math.min(120, initialWaitTimeout),
        })
  if (!(settled.settled ?? settled.quiet)) {
    return { frame: null, xml: '', stable: false, attempts: 0, observer: true, reason: 'settle_timeout' }
  }

  const mark = observer.mark()
  const xml = await hierarchy()
  const frame = await capture()
  const confirmRemaining = Math.min(800, deadline - now())
  if (confirmRemaining <= 0) {
    return { frame, xml, stable: false, attempts: 1, observer: true, reason: 'capture_deadline' }
  }
  const confirmed = typeof observer.waitForNoActivity === 'function'
    ? await observer.waitForNoActivity({
        timeout: confirmRemaining,
        quietMs: confirmQuietMs,
        minWaitMs: Math.min(confirmQuietMs, confirmRemaining),
      })
    : await observer.waitForQuiet({
        timeout: confirmRemaining,
        windowMs: confirmQuietMs,
        quietMs: confirmQuietMs,
        maxFrames: 0,
        minWaitMs: Math.min(confirmQuietMs, confirmRemaining),
      })
  const currentMark = observer.mark()
  const activityFramesDuringCapture = (currentMark.activityFrameCount ?? currentMark.frameCount)
    - (mark.activityFrameCount ?? mark.frameCount)
  const loading = hierarchyLoading(xml)
  if (!loading && confirmed.quiet && activityFramesDuringCapture === 0) {
    return { frame, xml, stable: true, attempts: 1, observer: true }
  }
  const reason = loading
    ? 'hierarchy_loading'
    : (!confirmed.quiet ? 'confirmation_timeout' : 'capture_activity')
  return { frame, xml, stable: false, attempts: 1, observer: true, reason }
}

function observerRegionFallbackOptions(result) {
  const activityObserved = result?.reason === 'capture_activity'
  return {
    initialFrame: result?.frame || null,
    requiredStablePairs: activityObserved ? 2 : 1,
    activityObserved,
  }
}

function shouldRetryFullReplyCapture({ fallbackReasons = [], allowFullRetry = true, products = null } = {}) {
  return Boolean(allowFullRetry && !products && fallbackReasons.length)
}

function failedRetryItems(summary) {
  if (!summary || !Array.isArray(summary.results)) throw new Error('批次汇总缺少 results，无法识别失败题。')
  return summary.results
    .map((result, resultIndex) => ({ ...result, resultIndex }))
    .filter(result => result.status === 'failed')
    .map(result => {
      if (!result.entry_id || !result.question || !Number.isInteger(result.question_index)) {
        throw new Error('批次汇总中的失败题信息不完整，无法安全重试。')
      }
      return result
    })
}

function retryAttemptCount(summary) {
  return Math.max(0, Number(summary?.retry_count) || 0) + 1
}

function createRunner(options) {
  let cancelled = false
  let activeSerial = null
  let activeEntry = ENTRY_DEFINITIONS[DEFAULT_ENTRY_ID]
  let cachedInputBounds = null
  let cachedSendBounds = null
  let observerFallbackReason = null
  let observerFallbackLogged = false
  let observerRecoveryAttempts = 0
  let observerRecoverySuccesses = 0
  let observerRecoveryFailures = 0
  let observerRegionFallbacks = 0
  let observerActivityRegionChecks = 0
  let adbPngCaptures = 0
  let batchEventLog = null
  let activeQuestionEventLog = null
  let activeQuestionContext = {}
  const log = text => {
    const message = String(text)
    options.log(`${message}${message.endsWith('\n') ? '' : '\n'}`)
    batchEventLog?.recordMessage(message, activeQuestionContext)
    activeQuestionEventLog?.recordMessage(message)
  }
  const ui = options.uiClient || new U2Client({
    root: options.root,
    isPackaged: options.isPackaged,
    resourcesPath: options.resourcesPath,
    adbPath: options.adbPath,
    log,
  })
  const observer = options.scrcpyObserver || new ScrcpyObserver({
    adbPath: options.adbPath,
    serverPath: bundledScrcpyServer(options),
    log,
  })
  const checkCancelled = () => { if (cancelled) throw new CancelledError() }

  async function initializeArtifactLogging(artifacts, payload, mode) {
    await Promise.all([
      fs.mkdir(artifacts.deliveryDirectory, { recursive: true }),
      fs.mkdir(artifacts.diagnosticDirectory, { recursive: true }),
    ])
    batchEventLog = new EventLog({
      filePath: path.join(artifacts.diagnosticDirectory, '执行日志.jsonl'),
      scope: 'batch',
      context: { batch_id: path.basename(artifacts.batchDirectory), serial: payload.serial, mode },
    })
    await batchEventLog.record('batch_started', {
      category: 'lifecycle',
      details: {
        artifact_layout_version: 2,
        delivery_directory: artifacts.deliveryDirectory,
        diagnostic_directory: artifacts.diagnosticDirectory,
      },
    })
  }

  async function startQuestionLogging(artifacts, context) {
    activeQuestionContext = { ...context }
    activeQuestionEventLog = new EventLog({
      filePath: path.join(artifacts.diagnosticDirectory, '执行日志.jsonl'),
      scope: 'question',
      context,
    })
    await activeQuestionEventLog.record('question_context_ready', {
      category: 'lifecycle',
      details: {
        delivery_directory: artifacts.deliveryDirectory,
        diagnostic_directory: artifacts.diagnosticDirectory,
      },
    })
  }

  async function finishQuestionLogging(event, details = {}) {
    if (!activeQuestionEventLog) return
    await batchEventLog?.record(event, {
      category: event === 'question_failed' ? 'error' : 'lifecycle',
      details,
      context: activeQuestionContext,
    })
    await activeQuestionEventLog.record(event, { category: event === 'question_failed' ? 'error' : 'lifecycle', details })
    await activeQuestionEventLog.flush()
    activeQuestionEventLog = null
    activeQuestionContext = {}
  }

  async function flushArtifactLogs() {
    await activeQuestionEventLog?.flush()
    await batchEventLog?.flush()
  }

  function resetEntryState(entry) {
    activeEntry = entry
    cachedInputBounds = null
    cachedSendBounds = null
  }

  function activePackageName() {
    return activeEntry.packageName || DEFAULT_PACKAGE
  }

  function activePackageLabel() {
    return activeEntry.packageLabel || activeEntry.label || activePackageName()
  }

  function boundsForResourceId(xml, name) {
    const packages = [activeEntry.resourcePackage, activePackageName(), DEFAULT_PACKAGE].filter(Boolean)
    for (const packageName of [...new Set(packages)]) {
      const exact = boundsForNodeAttribute(xml, 'resource-id', `${packageName}:id/${name}`)
      if (exact) return exact
    }
    const suffix = `:id/${name}`
    for (const attrs of iterNodes(xml)) {
      if (!nodeIsVisible(attrs) || !nodeAttr(attrs, 'resource-id').endsWith(suffix)) continue
      const rawBounds = nodeAttr(attrs, 'bounds')
      if (rawBounds) return parseBounds(rawBounds)
    }
    return null
  }

  function findSubmitBounds(xml) {
    const labels = activeEntry.submitLabels || ['发送']
    for (const label of labels) {
      const byDescription = boundsForNodeAttribute(xml, 'content-desc', label)
      if (byDescription) return byDescription
      const byText = visibleLabelBounds(xml, label)
      if (byText) return byText
    }
    return null
  }

  function recoverySnapshot() {
    return {
      attempts: observerRecoveryAttempts,
      successes: observerRecoverySuccesses,
      failures: observerRecoveryFailures,
      regionFallbacks: observerRegionFallbacks,
      activityRegionChecks: observerActivityRegionChecks,
      adbPngCaptures,
    }
  }

  function observerMetadata(baseline = null, recoveryBaseline = null) {
    const snapshot = typeof observer.snapshot === 'function'
      ? observer.snapshot()
      : { active: Boolean(observer.active), version: SCRCPY_VERSION, frames: 0 }
    const metadata = {
      scrcpy_observer_requested: true,
      scrcpy_observer_active: Boolean(snapshot.active),
      scrcpy_observer_version: snapshot.version || SCRCPY_VERSION,
      scrcpy_observer_frames: snapshot.frames || 0,
      scrcpy_observer_activity_frames: snapshot.activity_frames || 0,
      scrcpy_observer_burst_activity_frames: snapshot.burst_activity_frames || 0,
      scrcpy_observer_sparse_activity_frames: snapshot.sparse_activity_frames || 0,
      scrcpy_observer_noise_frames: snapshot.noise_frames || 0,
      scrcpy_observer_frames_last_second: snapshot.frames_last_second || 0,
      scrcpy_observer_activity_frames_last_second: snapshot.activity_frames_last_second || 0,
      scrcpy_observer_bytes_last_second: snapshot.bytes_last_second || 0,
      scrcpy_observer_quiet_checks: snapshot.quiet_checks || 0,
      scrcpy_observer_quiet_successes: snapshot.quiet_successes || 0,
      scrcpy_observer_quiet_timeouts: snapshot.quiet_timeouts || 0,
      scrcpy_observer_no_activity_checks: snapshot.no_activity_checks || 0,
      scrcpy_observer_no_activity_successes: snapshot.no_activity_successes || 0,
      scrcpy_observer_no_activity_timeouts: snapshot.no_activity_timeouts || 0,
      scrcpy_observer_no_activity_wait_ms: snapshot.no_activity_wait_ms || 0,
      scrcpy_observer_activity_checks: snapshot.activity_checks || 0,
      scrcpy_observer_activity_successes: snapshot.activity_successes || 0,
      scrcpy_observer_activity_timeouts: snapshot.activity_timeouts || 0,
      scrcpy_observer_settle_checks: snapshot.settle_checks || 0,
      scrcpy_observer_settle_successes: snapshot.settle_successes || 0,
      scrcpy_observer_settle_timeouts: snapshot.settle_timeouts || 0,
      scrcpy_observer_settle_fast_successes: snapshot.settle_fast_successes || 0,
      scrcpy_observer_settle_conservative_successes: snapshot.settle_conservative_successes || 0,
      scrcpy_observer_settle_no_activity: snapshot.settle_no_activity || 0,
      scrcpy_observer_settle_wait_ms: snapshot.settle_wait_ms || 0,
      scrcpy_observer_recovery_attempts: observerRecoveryAttempts,
      scrcpy_observer_recovery_successes: observerRecoverySuccesses,
      scrcpy_observer_recovery_failures: observerRecoveryFailures,
      scrcpy_observer_region_fallbacks: observerRegionFallbacks,
      scrcpy_observer_activity_region_checks: observerActivityRegionChecks,
      adb_png_captures: adbPngCaptures,
      ...(observerFallbackReason ? { scrcpy_observer_fallback_reason: observerFallbackReason } : {}),
    }
    if (baseline) {
      for (const key of ['frames', 'activity_frames', 'burst_activity_frames', 'sparse_activity_frames', 'noise_frames', 'quiet_checks', 'quiet_successes', 'quiet_timeouts', 'no_activity_checks', 'no_activity_successes', 'no_activity_timeouts', 'no_activity_wait_ms', 'activity_checks', 'activity_successes', 'activity_timeouts', 'settle_checks', 'settle_successes', 'settle_timeouts', 'settle_fast_successes', 'settle_conservative_successes', 'settle_no_activity', 'settle_wait_ms']) {
        metadata[`scrcpy_observer_question_${key}`] = Math.max(0, Number(snapshot[key] || 0) - Number(baseline[key] || 0))
      }
    }
    if (recoveryBaseline) {
      metadata.scrcpy_observer_question_recovery_attempts = observerRecoveryAttempts - recoveryBaseline.attempts
      metadata.scrcpy_observer_question_recovery_successes = observerRecoverySuccesses - recoveryBaseline.successes
      metadata.scrcpy_observer_question_recovery_failures = observerRecoveryFailures - recoveryBaseline.failures
      metadata.scrcpy_observer_question_region_fallbacks = observerRegionFallbacks - recoveryBaseline.regionFallbacks
      metadata.scrcpy_observer_question_activity_region_checks = observerActivityRegionChecks - recoveryBaseline.activityRegionChecks
      metadata.adb_png_captures_question = adbPngCaptures - recoveryBaseline.adbPngCaptures
    }
    return metadata
  }

  async function disableObserver(error) {
    observerFallbackReason ||= error?.message || String(error)
    if (!observerFallbackLogged) {
      log(`scrcpy画面观察器不可用，稳定性判断改用双ADB PNG校验（UI仍严格使用Python uiautomator2）：${observerFallbackReason}`)
      observerFallbackLogged = true
    }
    await observer.stop().catch(() => {})
  }

  async function recoverObserver(error) {
    // captureStableObserved also executes hierarchy and PNG callbacks. If
    // scrcpy itself is still healthy, preserve those errors instead of masking
    // them with an unrelated observer restart.
    if (observer.active && !observer.failure) throw error
    if (cancelled || !activeSerial || observerRecoveryAttempts >= 1) {
      await disableObserver(error)
      return false
    }
    observerRecoveryAttempts += 1
    log(`scrcpy观察器连接中断，正在自动恢复（1/1）：${error?.message || error}`)
    await observer.stop().catch(() => {})
    try {
      await waitForAdbDevice(options.adbPath, activeSerial, 10_000)
      checkCancelled()
      await observer.start(activeSerial)
      observerRecoverySuccesses += 1
      log('scrcpy观察器已自动恢复，继续使用画面活动检测')
      return true
    } catch (recoveryError) {
      observerRecoveryFailures += 1
      await disableObserver(new Error(`${error?.message || error}；自动恢复失败：${recoveryError.message}`))
      return false
    }
  }

  async function waitForVisualQuiet({ timeout = 1_200, fallbackMs = 600 } = {}) {
    checkCancelled()
    for (let attempt = 0; attempt < 2 && observer.active; attempt += 1) {
      try {
        const quiet = await observer.waitForQuiet({
          timeout,
          windowMs: 400,
          quietMs: 250,
          maxFrames: 1,
          minWaitMs: 120,
        })
        if (quiet.quiet) return true
        break
      } catch (error) {
        if (!(await recoverObserver(error))) break
      }
    }
    checkCancelled()
    await sleep(fallbackMs)
    return false
  }

  async function screenshot() {
    checkCancelled()
    adbPngCaptures += 1
    return adbScreenshot(options.adbPath, activeSerial)
  }

  async function source() {
    checkCancelled()
    let xml = ''
    // During bottom-sheet attach/detach UiAutomator can briefly serialize an
    // empty transitional root even though WindowManager still reports the app
    // in front. Retry only this read-only operation; clicks are never replayed.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      xml = await ui.dumpHierarchy()
      if (hierarchyBelongsToPackage(xml, activePackageName())) return xml
      if (attempt < 2) await sleep(120)
    }
    throw new Error(`当前前台页面不是${activePackageLabel()}（层级中缺少 ${activePackageName()}），已停止UI操作。`)
  }

  async function tap(x, y) {
    checkCancelled()
    await ui.click(x, y)
  }

  async function swipe(x, fromY, toY, duration = 250) {
    checkCancelled()
    await adbCommandWithReconnect(options.adbPath, activeSerial, ['shell', 'input', 'swipe', String(Math.round(x)), String(Math.round(fromY)), String(Math.round(x)), String(Math.round(toY)), String(Math.round(duration))])
  }

  async function windowSize() {
    const { width, height } = await imageInfo(await screenshot())
    return { width, height }
  }

  async function waitForInput(timeout = 10_000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      checkCancelled()
      const xml = await source()
      if (historyOnboardingVisible(xml)) {
        const size = await windowSize()
        // The first-launch history hint is a full-screen Compose overlay. Tap
        // a neutral blank area to dismiss it before looking up the input.
        await tap(Math.floor(size.width * 0.8), Math.floor(size.height * 0.22))
        log('已关闭“历史对话”首次引导')
        await sleep(500)
        continue
      }
      const editBounds = boundsForNodeAttribute(xml, 'class', 'android.widget.EditText')
      if (editBounds) {
        cachedInputBounds = editBounds
        cachedSendBounds = findSubmitBounds(xml)
        const attrs = iterNodes(xml).find(item => nodeAttr(item, 'class') === 'android.widget.EditText')
        return { bounds: editBounds, text: attrs ? nodeAttr(attrs, 'text') : '' }
      }
      for (const hintText of activeEntry.inputHints || ['输入问题']) {
        const hint = visibleLabelBounds(xml, hintText)
        if (hint) {
          await tap((hint[0] + hint[2]) / 2, (hint[1] + hint[3]) / 2)
          await sleep(500)
          break
        }
      }
      await sleep(500)
    }
    throw new Error(`未能在${activeEntry.label}找到输入框。`)
  }

  async function inputQuestion(question) {
    const edit = await waitForInput()
    // Use uiautomator2's device-level IME/clipboard input rather than a
    // WebDriver element value command. Mutating UI requests are not replayed
    // after failure, so an uncertain input state terminates the task.
    const restoredXml = await fillQuestionInput({ ui, tap, source }, edit, question)
    const restoredEdit = iterNodes(restoredXml).find(item => nodeIsVisible(item)
      && nodeAttr(item, 'class') === 'android.widget.EditText')
    if (!restoredEdit || nodeAttr(restoredEdit, 'text') !== question) {
      throw new Error('小荷App输入框未能确认问题文本，已停止发送。')
    }
    cachedInputBounds = boundsForNodeAttribute(restoredXml, 'class', 'android.widget.EditText') || cachedInputBounds
    cachedSendBounds = findSubmitBounds(restoredXml) || cachedSendBounds
  }

  async function tapSend() {
    // The send control is already present in the hierarchy read by
    // waitForInput, so use the cached hit target without a second lookup.
    if (cachedSendBounds) {
      const x = Math.round((cachedSendBounds[0] + cachedSendBounds[2]) / 2)
      const y = Math.round((cachedSendBounds[1] + cachedSendBounds[3]) / 2)
      await tap(x, y)
      return
    }
    if (activeEntry.submitKey) {
      await ui.press(activeEntry.submitKey)
      return
    }
    if (!cachedInputBounds) await waitForInput()
    const [left, top, right, bottom] = cachedInputBounds
    const height = bottom - top
    const x = Math.round(right - Math.min(80, height * 0.24))
    const y = Math.round(bottom + Math.min(48, height * 0.2))
    await tap(x, y)
  }

  async function tapNewSession() {
    // Compose exposes the icon's label on a non-clickable child while its
    // clickable hit target is the parent. Clicking the label works on some
    // devices but silently fails on others, so prefer the parent when present.
    const newSession = boundsForNodeAttribute(await source(), 'content-desc', '开启新会话')
    if (!newSession) return false
    await tap((newSession[0] + newSession[2]) / 2, (newSession[1] + newSession[3]) / 2)
    await waitForVisualQuiet({ timeout: 1_200, fallbackMs: 1_000 })
    for (const text of ['确定', '确认', '开始', '新会话']) {
      const button = visibleLabelBounds(await source(), text)
      if (button) {
        await tap((button[0] + button[2]) / 2, (button[1] + button[3]) / 2)
        await waitForVisualQuiet({ timeout: 1_200, fallbackMs: 1_000 })
        break
      }
    }
    return true
  }

  async function waitForDouyinSearchInput(timeout = 12_000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const xml = await source()
      const edit = douyinSearchInput(xml)
      if (edit) return edit
      const close = boundsForNodeAttribute(xml, 'content-desc', '关闭')
      if (close) {
        log('stage: 正在关闭上一题的小荷AI全文页')
        await tap((close[0] + close[2]) / 2, (close[1] + close[3]) / 2)
        await waitForVisualQuiet({ timeout: 1_500, fallbackMs: 800 })
        continue
      }
      const search = boundsForNodeAttribute(xml, 'content-desc', '搜索') || visibleLabelBounds(xml, '搜索')
      if (search) {
        await tap((search[0] + search[2]) / 2, (search[1] + search[3]) / 2)
        await waitForVisualQuiet({ timeout: 1_500, fallbackMs: 800 })
        continue
      }
      await sleep(400)
    }
    throw new Error('未能在抖音打开搜索输入框。请确认抖音首页可正常使用且没有登录、青少年模式或升级提示遮挡。')
  }

  async function inputDouyinQuestion(question) {
    const edit = await waitForDouyinSearchInput()
    const xml = await fillQuestionInput({ ui, tap, source }, edit, question)
    const restored = douyinSearchInput(xml)
    if (!restored || restored.text !== question) throw new Error('抖音搜索框输入后未能确认问题文本，已停止搜索。')
    const search = boundsForNodeAttribute(xml, 'content-desc', '搜索') || visibleLabelBounds(xml, '搜索')
    if (!search) throw new Error('抖音搜索框已输入问题，但未能定位“搜索”按钮；为避免误操作，本题未继续。')
    return search
  }

  async function waitForToutiaoSearchInput(timeout = 12_000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const xml = await source()
      const close = boundsForNodeAttribute(xml, 'content-desc', '关闭')
      if (close) {
        log('stage: 正在关闭上一题的头条小荷AI全文页')
        await tap((close[0] + close[2]) / 2, (close[1] + close[3]) / 2)
        await waitForVisualQuiet({ timeout: 1_500, fallbackMs: 800 })
        continue
      }
      const edit = toutiaoSearchInput(xml)
      if (edit) {
        await tap((edit.bounds[0] + edit.bounds[2]) / 2, (edit.bounds[1] + edit.bounds[3]) / 2)
        await waitForVisualQuiet({ timeout: 1_200, fallbackMs: 500 })
        return toutiaoSearchInput(await source()) || edit
      }
      const search = boundsForNodeAttribute(xml, 'content-desc', '搜索') || visibleLabelBounds(xml, '搜索')
      if (search) {
        await tap((search[0] + search[2]) / 2, (search[1] + search[3]) / 2)
        await waitForVisualQuiet({ timeout: 1_500, fallbackMs: 800 })
        continue
      }
      await sleep(400)
    }
    throw new Error('未能在今日头条打开搜索输入框。请确认头条首页可正常使用且没有登录或升级提示遮挡。')
  }

  async function inputToutiaoQuestion(question) {
    const edit = await waitForToutiaoSearchInput()
    const xml = await fillQuestionInput({ ui, tap, source }, edit, question)
    const restored = toutiaoSearchInput(xml)
    if (!restored || restored.text !== question) throw new Error('头条搜索框输入后未能确认问题文本，已停止搜索。')
    const search = boundsForResourceId(xml, 'e0') || visibleLabelBounds(xml, '搜索')
    if (!search) throw new Error('头条搜索框已输入问题，但未能定位“搜索”按钮；为避免误操作，本题未继续。')
    return search
  }

  async function waitForDouyinSearchResult(timeout, { attempt = 1 } = {}) {
    const startedAt = Date.now()
    const initialScanDelay = Math.min(DOUYIN_INITIAL_RESULT_WAIT_MS, Math.max(5_000, Math.floor(timeout * 0.25)))
    const deadline = Date.now() + timeout
    const size = await windowSize()
    const roundLabel = attempt === 1 ? '第一轮' : '刷新后第二轮'
    let lastProgress = 0
    let stableEntrySignature = ''
    let stableEntryReads = 0
    let entryFirstSeenAt = 0
    let searchScrolls = 0
    let lastSearchScrollAt = 0
    let genericAnswerLogged = false
    while (Date.now() < deadline) {
      const xml = await source()
      const target = douyinSearchResultTarget(xml, size)
      const genericAnswer = douyinGenericAiAnswerBounds(xml, size)
      if ((genericAnswer || target?.ignoredExpandableAnswer) && !genericAnswerLogged) {
        log(target?.mode === 'miniapp_entry_card'
          ? 'stage: 已识别抖音通用AI回答，忽略“展开更多”并改走下方小荷AI医生独立小程序入口卡片'
          : 'stage: 已识别抖音通用AI回答，已忽略“展开更多”并继续查找小荷AI医生入口')
        genericAnswerLogged = true
      }
      if (target?.mode === 'smart_summary') return { xml, target, size }
      if (target?.mode === 'miniapp_entry_card') {
        const signature = `${target.cardBounds.join(',')}|${target.tapBounds.join(',')}`
        if (signature === stableEntrySignature) stableEntryReads += 1
        else {
          stableEntrySignature = signature
          stableEntryReads = 1
          entryFirstSeenAt = Date.now()
        }
        if (stableEntryReads >= 2 && Date.now() - entryFirstSeenAt >= DOUYIN_SUMMARY_PREFERENCE_MS) {
          return { xml, target, size }
        }
      } else {
        stableEntrySignature = ''
        stableEntryReads = 0
        entryFirstSeenAt = 0
      }
      if (!target && searchScrolls >= DOUYIN_SEARCH_SCAN_LIMIT
        && Date.now() - lastSearchScrollAt >= DOUYIN_POST_SCAN_WAIT_MS) {
        throw new DouyinSearchResultNotFoundError(
          `${roundLabel}抖音搜索结果已完成${DOUYIN_SEARCH_SCAN_LIMIT}次向下扫描，仍未找到智能总结或小程序入口卡片。`,
          { scanScrolls: searchScrolls },
        )
      }
      if (!target && searchScrolls < DOUYIN_SEARCH_SCAN_LIMIT
        && Date.now() - startedAt >= initialScanDelay
        && Date.now() - lastSearchScrollAt >= 3_500) {
        const resultsBounds = douyinSearchResultsBounds(xml, size)
        if (resultsBounds) {
          searchScrolls += 1
          lastSearchScrollAt = Date.now()
          log(`stage: ${roundLabel}首屏未发现智能总结或入口卡片，向下扫描抖音搜索结果（${searchScrolls}/${DOUYIN_SEARCH_SCAN_LIMIT}）`)
          await swipeChat(resultsBounds, 'down', 0.34, { maxFraction: 0.42, speed: 1_700, eventDrivenSettle: true })
          await waitForVisualQuiet({ timeout: 1_200, fallbackMs: 300 })
          continue
        }
      }
      if (Date.now() - lastProgress >= 5_000) {
        log(`waiting: ${stableEntryReads ? '已发现小程序入口卡片，继续短暂等待智能总结优先出现' : '正在等待抖音智能总结或小荷AI医生小程序入口卡片'}…`)
        lastProgress = Date.now()
      }
      await sleep(500)
    }
    throw new DouyinSearchResultNotFoundError(
      `${roundLabel}抖音搜索结果中既未出现小荷AI医生智能总结，也未出现可验证的小程序入口卡片。`,
      { scanScrolls: searchScrolls },
    )
  }

  async function refreshDouyinSearchResults(question, scanScrolls = DOUYIN_SEARCH_SCAN_LIMIT) {
    let xml = await source()
    const size = await windowSize()
    let resultsBounds = douyinSearchResultsBounds(xml, size)
    if (!resultsBounds) throw new Error('抖音第一轮扫描无结果，但刷新前无法定位当前搜索结果列表。')
    const returnSwipes = Math.max(1, Math.ceil(Math.max(1, scanScrolls) * 0.34 / 0.55))
    log(`stage: 第一轮未找到入口，正在返回抖音搜索结果顶部（回滚=${returnSwipes}次）`)
    for (let index = 0; index < returnSwipes; index += 1) {
      await swipeChat(resultsBounds, 'up', 0.55, { maxFraction: 0.62, speed: 2_500, eventDrivenSettle: true })
      await waitForVisualQuiet({ timeout: 1_200, fallbackMs: 300 })
      xml = await source()
      resultsBounds = douyinSearchResultsBounds(xml, size) || resultsBounds
    }
    const edit = douyinSearchInput(xml)
    if (!edit || edit.text !== question) {
      throw new Error('抖音搜索结果回到顶部后未能确认当前搜索关键词；为避免刷新错误问题已停止本题。')
    }
    log('stage: 已回到顶部，正在下拉刷新当前抖音搜索结果')
    await swipeChat(resultsBounds, 'up', 0.5, { maxFraction: 0.58, speed: 700, eventDrivenSettle: true })
    await waitForVisualQuiet({ timeout: 2_500, fallbackMs: 1_200 })
    await sleep(700)
    log('stage: 当前搜索结果已刷新，开始第二轮入口识别与向下扫描')
  }

  async function captureDouyinSearchTarget(size) {
    await waitForVisualQuiet({ timeout: 1_200, fallbackMs: 300 })
    const capture = await captureStableSandwich({
      capture: screenshot,
      hierarchy: source,
      framesStable: imageRegionsStable,
      hierarchyLoading: () => false,
      interval: 120,
    }, 8_000)
    if (!capture.stable) throw new Error('抖音搜索结果持续变化，无法取得稳定截图。')
    const target = douyinSearchResultTarget(capture.xml, size)
    if (!target) throw new Error('取得稳定搜索截图后，智能总结和小程序入口卡片均已消失，已停止点击。')
    return { ...capture, target }
  }

  async function openDouyinFullAnswer(viewFull, size, timeout = 12_000) {
    await tap((viewFull[0] + viewFull[2]) / 2, (viewFull[1] + viewFull[3]) / 2)
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      await waitForVisualQuiet({ timeout: 1_000, fallbackMs: 400 })
      const xml = await source()
      const bounds = douyinMiniAppCaptureBounds(xml, size)
      if (bounds) return { xml, bounds }
    }
    throw new Error('已点击抖音小荷AI医生“查看全文”，但未能确认全文页打开。')
  }

  async function openDouyinMiniAppEntry(entry, size, timeout = 12_000) {
    const startedAt = Date.now()
    await tap((entry.tapBounds[0] + entry.tapBounds[2]) / 2, (entry.tapBounds[1] + entry.tapBounds[3]) / 2)
    const deadline = startedAt + timeout
    while (Date.now() < deadline) {
      await waitForVisualQuiet({ timeout: 1_000, fallbackMs: 400 })
      const [xml, foreground] = await Promise.all([source(), ui.foregroundWindow()])
      if (foreground?.package && foreground.package !== activePackageName()) {
        throw new Error(`小程序入口点击后进入了错误应用：expected=${activePackageName()}, actual=${foreground.package}`)
      }
      const bounds = douyinMiniAppCaptureBounds(xml, size)
      if (/MiniAppHostActivity/.test(foreground?.activity || '') && bounds) {
        return { xml, bounds, activity: foreground.activity, startedAt }
      }
      if (Date.now() - startedAt >= 3_000 && douyinSearchInput(xml)) {
        throw new Error('小程序入口卡片已点击，但页面仍停留在抖音搜索结果；为避免重复点击，本题已停止。')
      }
    }
    throw new Error('小程序入口卡片已点击，但未能确认抖音小程序宿主页打开。')
  }

  async function waitForDouyinMiniAppAnswer(full, timeout) {
    const deadline = full.startedAt + timeout
    const contentHeight = full.bounds[3] - full.bounds[1]
    const readinessBounds = [
      full.bounds[0],
      full.bounds[1] + Math.floor(contentHeight * 0.48),
      full.bounds[2],
      full.bounds[3] - Math.max(12, Math.floor(contentHeight * 0.03)),
    ]
    let lastProgress = 0
    while (Date.now() < deadline) {
      checkCancelled()
      const frame = await cropImage(await screenshot(), readinessBounds)
      if (await imageLooksLoaded(frame)) {
        log('waiting: 抖音小程序回答正文已出现，继续等待画面稳定')
        const remaining = Math.max(1_000, deadline - Date.now())
        const stable = await waitForStableReply(remaining, { startedAt: full.startedAt })
        if (stable.status !== 'stable') throw new Error(`抖音小程序回答已出现，但等待稳定超时（${stable.status}）。`)
        const bounds = douyinMiniAppCaptureBounds(stable.xml, await windowSize())
        if (!bounds) throw new Error('抖音小程序回答稳定后未能重新确认正文截图区域。')
        return { ...full, xml: stable.xml, bounds }
      }
      if (Date.now() - lastProgress >= 5_000) {
        log('waiting: 已进入抖音小荷AI医生小程序，正在等待回答正文出现…')
        lastProgress = Date.now()
      }
      await sleep(1_000)
    }
    throw new Error('已进入抖音小荷AI医生小程序，但等待时间内未出现可截图的回答正文。')
  }

  async function waitForToutiaoAnswerCard(timeout) {
    const deadline = Date.now() + timeout
    const size = await windowSize()
    let lastProgress = 0
    while (Date.now() < deadline) {
      const xml = await source()
      const viewMore = toutiaoViewMoreBounds(xml)
      if (viewMore) return { xml, viewMore, size }
      if (Date.now() - lastProgress >= 5_000) {
        log('waiting: 正在等待头条小荷AI医生搜索结果…')
        lastProgress = Date.now()
      }
      await sleep(500)
    }
    throw new Error('头条搜索结果中未出现小荷AI医生“查看更多”卡片。')
  }

  async function captureToutiaoSearchSummary(size) {
    await waitForVisualQuiet({ timeout: 1_200, fallbackMs: 300 })
    const capture = await captureStableSandwich({
      capture: screenshot,
      hierarchy: source,
      framesStable: imageRegionsStable,
      hierarchyLoading: () => false,
      interval: 120,
    }, 8_000)
    if (!capture.stable) throw new Error('头条搜索结果智能总结持续变化，无法取得稳定截图。')
    const viewMore = toutiaoViewMoreBounds(capture.xml)
    if (!viewMore) throw new Error('截取头条智能总结后未能再次确认“查看更多”卡片，已停止点击。')
    return { ...capture, viewMore, size }
  }

  async function openToutiaoFullAnswer(viewMore, size, timeout = 12_000) {
    await tap((viewMore[0] + viewMore[2]) / 2, (viewMore[1] + viewMore[3]) / 2)
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      await waitForVisualQuiet({ timeout: 1_000, fallbackMs: 400 })
      const xml = await source()
      const bounds = douyinMiniAppCaptureBounds(xml, size)
      if (bounds) return { xml, bounds }
    }
    throw new Error('已点击头条小荷AI医生“查看更多”，但未能确认全文页打开。')
  }

  async function normalizedHierarchy() {
    return (await source()).replace(/focused="(?:true|false)"/g, 'focused=""').replace(/selected="(?:true|false)"/g, 'selected=""')
  }

  async function waitForStableReplyPixels(timeout, { minWait = 12_000 } = {}) {
    const stableMilliseconds = REPLY_STABLE_QUIET_MS
    const pollInterval = 1_500
    const start = Date.now()
    let lastChange = start
    let lastXml = ''
    let lastFrame = null
    let lastProgress = 0
    while (Date.now() - start < timeout) {
      checkCancelled()
      const frame = await screenshot()
      const now = Date.now()
      const pixelsStable = lastFrame && await imageRegionsStable(lastFrame, frame)
      lastFrame = frame
      if (!pixelsStable) lastChange = now
      if (now - lastProgress >= 5_000) { log('waiting: reply still generating…'); lastProgress = now }
      if (pixelsStable && now - start >= minWait && now - lastChange >= stableMilliseconds) {
        // Only serialize the dynamic Compose hierarchy after pixels have been
        // stable for long enough, then confirm that the UI did not reflow while
        // the hierarchy was being read.
        const xml = await normalizedHierarchy()
        const confirmedFrame = await screenshot()
        lastXml = xml
        lastFrame = confirmedFrame
        if (!hierarchyIsLoading(xml) && await imageRegionsStable(frame, confirmedFrame)) return { status: 'stable', xml }
        lastChange = Date.now()
      }
      await sleep(pollInterval)
    }
    if (!lastXml) lastXml = await normalizedHierarchy()
    return { status: hierarchyIsLoading(lastXml) ? 'loading_timeout' : 'timeout', xml: lastXml }
  }

  async function waitForStableReply(timeout, { startedAt = Date.now() } = {}) {
    const minWait = 12_000
    const initialElapsed = Math.max(0, Date.now() - startedAt)
    if (!observer.active) {
      return waitForStableReplyPixels(
        Math.max(1_000, timeout - initialElapsed),
        { minWait: Math.max(0, minWait - initialElapsed) },
      )
    }
    const started = startedAt
    let lastProgress = 0
    while (Date.now() - started < timeout) {
      checkCancelled()
      const elapsed = Date.now() - started
      if (Date.now() - lastProgress >= 5_000) {
        log('waiting: reply still generating…')
        lastProgress = Date.now()
      }
      if (elapsed < minWait) {
        await sleep(Math.min(1_000, minWait - elapsed))
        continue
      }
      try {
        const remaining = timeout - elapsed
        const quiet = await observer.waitForNoActivity({
          timeout: Math.max(100, Math.min(6_000, remaining)),
          quietMs: REPLY_STABLE_QUIET_MS,
        })
        if (!quiet.quiet) continue
        const mark = observer.mark()
        const xml = await normalizedHierarchy()
        const confirmed = await observer.waitForNoActivity({ timeout: 1_200, quietMs: 300, minWaitMs: 120 })
        const currentMark = observer.mark()
        const activityFramesDuringHierarchy = (currentMark.activityFrameCount ?? currentMark.frameCount)
          - (mark.activityFrameCount ?? mark.frameCount)
        if (!hierarchyIsLoading(xml) && confirmed.quiet && activityFramesDuringHierarchy === 0) {
          log(`waiting: scrcpy已确认回答画面连续${Math.round(REPLY_STABLE_QUIET_MS / 1000)}秒无活动帧，读取最终UI层级完成`)
          return { status: 'stable', xml }
        }
      } catch (error) {
        if (await recoverObserver(error)) continue
        const remaining = Math.max(1_000, timeout - (Date.now() - started))
        return waitForStableReplyPixels(remaining, { minWait: 0 })
      }
    }
    const xml = await normalizedHierarchy()
    return { status: hierarchyIsLoading(xml) ? 'loading_timeout' : 'timeout', xml }
  }

  async function waitForFinalVisualQuiet({ quietMs = REPLY_STABLE_QUIET_MS, timeout = quietMs + 2_000 } = {}) {
    if (!observer.active) {
      await sleep(quietMs)
      return false
    }
    try {
      const quiet = await observer.waitForNoActivity({
        timeout,
        quietMs,
        minWaitMs: Math.min(500, quietMs),
      })
      return quiet.quiet
    } catch (error) {
      await recoverObserver(error)
      await sleep(Math.min(quietMs, 2_000))
      return false
    }
  }

  async function swipeChat(bounds, direction, fraction = 0.6, {
    maxFraction = 0.7,
    speed = 1400,
    settle = 60,
    fallbackDuration = 900,
    eventDrivenSettle = false,
  } = {}) {
    const [left, top, right, bottom] = bounds
    const height = bottom - top
    const { distance, percent } = chatSwipePlan(bounds, fraction, { maxFraction, speed })
    const canScrollMore = null
    const x = left + (right - left) * 0.84
    const center = Math.floor((top + bottom) / 2)
    const duration = Math.max(120, Math.round(distance / speed * 1_000))
    const activityMark = eventDrivenSettle && observer.active ? observer.mark() : null
    if (direction === 'up') await swipe(x, center - Math.floor(distance / 2), center + Math.ceil(distance / 2), duration || fallbackDuration)
    else await swipe(x, center + Math.ceil(distance / 2), center - Math.floor(distance / 2), duration || fallbackDuration)
    if (!activityMark) await sleep(settle)
    return { distance, canScrollMore, activityMark }
  }

  async function waitForRegionPixelsStable(bounds, timeout = 8_000) {
    let observedFrame = null
    if (observer.active) {
      const started = Date.now()
      try {
        const observed = await captureStableObserved({
          observer,
          capture: async () => cropImage(await screenshot(), bounds),
          hierarchy: source,
          hierarchyLoading: () => false,
        }, Math.min(timeout, 3_500))
        if (observed.stable) return observed.frame
        observedFrame = observed.frame
        observerRegionFallbacks += 1
      } catch (error) {
        if (await recoverObserver(error)) {
          const remaining = Math.max(500, timeout - (Date.now() - started))
          return waitForRegionPixelsStable(bounds, remaining)
        }
      }
      timeout = Math.max(500, timeout - (Date.now() - started))
    }
    let frame = observedFrame || await cropImage(await screenshot(), bounds)
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      await sleep(300)
      const next = await cropImage(await screenshot(), bounds)
      if (await imagesSimilar(frame, next, 1)) return next
      frame = next
    }
    return frame
  }

  async function waitForStableReplyRegion(bounds, timeout = 8_000, { settleSince = null } = {}) {
    let observed = null
    let regionFallback = observerRegionFallbackOptions(null)
    const deadline = Date.now() + timeout
    if (observer.active) {
      while (observer.active && Date.now() < deadline) {
        const started = Date.now()
        try {
          observed = await captureStableObserved({
            observer,
            capture: async () => cropImage(await screenshot(), bounds),
            hierarchy: source,
            hierarchyLoading: hierarchyIsLoading,
            settleSince,
          }, Math.min(Math.max(1, deadline - Date.now()), 3_500))
          if (observed.stable) return observed
          const elapsed = Date.now() - started
          observerRegionFallbacks += 1
          regionFallback = observerRegionFallbackOptions(observed)
          const reuse = regionFallback.initialFrame ? '，复用已取得的PNG' : ''
          if (regionFallback.activityObserved) {
            observerActivityRegionChecks += 1
            log(`capture: scrcpy检测到全屏活动（${elapsed}ms）${reuse}，转回答区域连续两组ADB像素校验`)
          } else {
            log(`capture: scrcpy快速静止判断未通过（${observed.reason || 'unknown'}，${elapsed}ms）${reuse}，转ADB夹心复核`)
          }
          break
        } catch (error) {
          const recovered = await recoverObserver(error)
          if (recovered) {
            const remaining = Math.max(1_000, deadline - Date.now())
            return waitForStableReplyRegion(bounds, remaining)
          }
          break
        }
      }
      timeout = Math.max(1_000, deadline - Date.now())
    }
    return captureStableSandwich({
      capture: async () => cropImage(await screenshot(), bounds),
      hierarchy: source,
      framesStable: imageRegionsStable,
      hierarchyLoading: hierarchyIsLoading,
      interval: 80,
      initialFrame: regionFallback.initialFrame,
      initialXml: observed?.xml || '',
      requiredStablePairs: regionFallback.requiredStablePairs,
    }, timeout)
  }

  async function scrollQuestionIntoView(question, bounds, maxSwipes = 25) {
    for (let index = 0; index < maxSwipes; index += 1) {
      if (questionVisible(await source(), question, bounds)) return true
      await swipeChat(bounds, 'up', 0.65, { speed: 3200, settle: 80 })
    }
    return questionVisible(await source(), question, bounds)
  }

  async function captureFullReplyFrames(question, maxPages = 30, { scrollFraction = 0.45, allowFullRetry = true } = {}) {
    const size = await windowSize()
    const initialXml = await source()
    const navigationBounds = findChatScrollBounds(initialXml, size)
    validateCaptureViewport(size, navigationBounds)
    const topNavigationStarted = Date.now()
    requireQuestionLocated(await scrollQuestionIntoView(question, navigationBounds), question)
    const topNavigationMs = Date.now() - topNavigationStarted
    log(`capture: 快速定位当前问题顶部耗时=${topNavigationMs}ms`)
    const evidence = await prepareEmbeddedEvidence({
      source,
      tap,
      delay: sleep,
      waitForStable: waitForStableReplyRegion,
      log,
    }, navigationBounds)
    if (!questionVisible(evidence.capture.xml || await source(), question, navigationBounds)) {
      requireQuestionLocated(await scrollQuestionIntoView(question, navigationBounds), question)
      evidence.capture = await waitForStableReplyRegion(navigationBounds)
      log('capture: 引用资料展开后已重新确认问题气泡完整位于首屏')
    }
    const { bounds, floatingControl } = replyCaptureBounds(evidence.capture.xml || await source(), size)
    validateCaptureViewport(size, bounds)
    log(`capture: chat bounds=${bounds.join(',')}${floatingControl ? '（已在顶部稳定后避开固定向下按钮）' : ''}`)
    const contained = bounds[0] >= navigationBounds[0] && bounds[1] >= navigationBounds[1]
      && bounds[2] <= navigationBounds[2] && bounds[3] <= navigationBounds[3]
    let initialCapture = evidence.capture
    if (contained) {
      initialCapture = {
        ...evidence.capture,
        frame: await cropImage(evidence.capture.frame, [
          bounds[0] - navigationBounds[0],
          bounds[1] - navigationBounds[1],
          bounds[2] - navigationBounds[0],
          bounds[3] - navigationBounds[1],
        ]),
      }
    } else initialCapture = await waitForStableReplyRegion(bounds)
    const frames = []
    const transitions = []
    let noProgress = 0
    let recaptureCount = 0
    const fallbackReasons = []
    let productDetected = false
    let products = null
    let productCaptureAttempts = 0
    let productCaptureMs = 0
    const captureProductsIfVisible = async xml => {
      if (products) return true
      const trigger = referenceProductsTrigger(xml, bounds)
      if (!trigger) return false
      productDetected = true
      const started = Date.now()
      let lastError = null
      try {
        for (let attempt = 0; attempt < 2 && !products; attempt += 1) {
          productCaptureAttempts += 1
          try {
            const candidate = await captureReferenceProductsAtTrigger(trigger, { chatBounds: bounds })
            if (!candidate.firstViewportIncluded) throw new Error('推荐药品首项所在视口未纳入截图')
            if (!candidate.imagesReady) throw new Error(`推荐药品图片仍有 ${candidate.unloaded} 处未确认加载`)
            if (!candidate.confirmedEnd) throw new Error('推荐药品列表未确认到底')
            if (!candidate.continuityVerified) throw new Error('推荐药品拼接连续性未通过校验')
            products = candidate
          } catch (error) {
            lastError = error
            if (attempt < 1) {
              log(`capture: 推荐药品采集未完成，在回答尾部入口直接重试（2/2）：${error.message}`)
            }
          }
        }
        if (!products) throw new Error(`推荐药品为必采内容，但两次采集均未完成：${lastError?.message || '未知错误'}`)
        log('capture: 推荐药品已按回答尾部顺序完整采集，本题截图结束')
        return true
      } finally {
        productCaptureMs += Date.now() - started
      }
    }
    let capture = initialCapture
    let frame = capture.frame
    for (let page = 0; page < maxPages; page += 1) {
      let xml = capture.xml || await source()
      if (!frames.length || !(await imagesSimilar(frames.at(-1), frame, 3))) { frames.push(frame); log(`capture: page ${frames.length}`) }
      if (await captureProductsIfVisible(xml)) break
      const before = frame
      const scroll = await swipeChat(bounds, 'down', scrollFraction, { eventDrivenSettle: true })
      const shift = scroll.distance
      let afterCapture = await waitForStableReplyRegion(bounds, 8_000, { settleSince: scroll.activityMark })
      let after = afterCapture.frame
      if (await imagesSimilar(before, after, 3)) {
        noProgress += 1
        if (scrollEndConfirmed(scroll.canScrollMore, noProgress)) {
          log(`capture: scroll ended（${scroll.canScrollMore === false ? '设备确认已到底' : '连续两次画面无变化'}）`)
          break
        }
      } else {
        let afterXml = afterCapture.xml || await source()
        const frameHeight = (await imageInfo(before)).height
        let measuredShift = estimateVerticalScrollShift(xml, afterXml, bounds)
        let reliableMeasuredShift = measuredShift !== null && measuredShift <= shift * 1.35 ? measuredShift : null
        const expectedShift = reliableMeasuredShift ?? shift
        let expectedOverlap = Math.max(12, frameHeight - expectedShift)
        let transition
        try {
          if (!afterCapture.stable) throw new Error('滚动后的局部画面未稳定')
          transition = { verified: true, overlap: await verifyFrameOverlap(before, after, expectedOverlap) }
        } catch (error) {
          recaptureCount += 1
          afterCapture = await waitForStableReplyRegion(bounds, 3_000)
          after = afterCapture.frame
          afterXml = afterCapture.xml || await source()
          measuredShift = estimateVerticalScrollShift(xml, afterXml, bounds)
          reliableMeasuredShift = measuredShift !== null && measuredShift <= shift * 1.35 ? measuredShift : null
          const retryExpectedShift = reliableMeasuredShift ?? shift
          expectedOverlap = Math.max(12, frameHeight - retryExpectedShift)
          try {
            if (!afterCapture.stable) throw new Error('重采后的局部画面仍未稳定')
            transition = { verified: true, overlap: await verifyFrameOverlap(before, after, expectedOverlap) }
          } catch (retryError) {
            const reason = retryError.message || error.message
            // Once pixel continuity cannot be proven, XML coordinates and the
            // requested swipe distance are only estimates. Cropping by either
            // can silently remove lines after a Compose reflow, so retain the
            // complete next viewport and make the duplicate boundary explicit.
            const fallbackOverlap = 0
            transition = { verified: false, fallbackOverlap, reason }
            fallbackReasons.push(reason)
            log(`capture: 接缝无法精确校验，保留下一屏完整视口、重复内容和浅色留白：${reason}`)
          }
        }
        if (!(await imagesSimilar(frames.at(-1), after, 3))) {
          frames.push(after)
          transitions.push(transition)
          log(`capture: page ${frames.length}`)
          noProgress = 0
        } else noProgress += 1
        frame = after
        capture = afterCapture
        if (await captureProductsIfVisible(afterXml)) break
        if (scroll.canScrollMore === false) { log('capture: reached device-reported scroll boundary'); break }
      }
    }
    if (!productDetected) log('capture: 回答滚动过程中未发现参考/推荐药品入口，无需完成后重复扫描')
    const result = {
      frames: frames.length ? frames : [await cropImage(await screenshot(), bounds)],
      transitions,
      bounds,
      recaptureCount,
      fullRetryCount: 0,
      fallbackReasons,
      topNavigationMs,
      questionLocated: true,
      questionFullyVisible: true,
      evidenceEmbedded: evidence.found,
      evidenceExpanded: evidence.expanded,
      productDetected,
      products,
      productCaptureAttempts,
      productCaptureMs,
    }
    if (shouldRetryFullReplyCapture({ fallbackReasons, allowFullRetry, products })) {
      log(`capture: 首轮存在不可靠接缝，等待${Math.round(REPLY_STABLE_QUIET_MS / 1000)}秒最终静止后从问题顶部整题重采一次`)
      await waitForFinalVisualQuiet()
      const retry = await captureFullReplyFrames(question, maxPages, { scrollFraction: 0.3, allowFullRetry: false })
      retry.recaptureCount += recaptureCount
      retry.fullRetryCount = 1
      retry.topNavigationMs += topNavigationMs
      return retry
    }
    if (fallbackReasons.length) log('capture: 不可靠接缝已局部重采并安全分隔，因已进入终止序列或重试后仍失败而保留安全降级')
    return result
  }

  async function waitForMiniAppStableRegion(bounds, platformLabel, timeout = 8_000) {
    await waitForVisualQuiet({ timeout: Math.min(1_200, timeout), fallbackMs: 180 })
    const capture = await captureStableSandwich({
      capture: async () => cropImage(await screenshot(), bounds),
      hierarchy: source,
      framesStable: imageRegionsStable,
      hierarchyLoading: () => false,
      interval: 120,
    }, timeout)
    if (!capture.stable) throw new Error(`${platformLabel}小荷AI全文正文区域持续变化，无法取得可验证的稳定截图。`)
    return capture
  }

  async function captureMiniAppFullAnswerFrames(initialXml, initialBounds, {
    platformLabel,
    metadataPrefix,
    openedMetadataKey,
    initialQuietMs = 0,
  }) {
    const frames = []
    const transitions = []
    const fallbackReasons = []
    let recaptureCount = 0
    let unchangedCount = 0
    let scrollAttempts = 0
    let productDetected = false
    let products = null
    let productCaptureAttempts = 0
    let productCaptureMs = 0
    if (initialQuietMs > 0) {
      log(`waiting: 正在等待${platformLabel}小荷AI全文连续${Math.round(initialQuietMs / 1000)}秒无画面活动`)
      await waitForFinalVisualQuiet({ quietMs: initialQuietMs, timeout: 25_000 })
    }
    let capture = await waitForMiniAppStableRegion(initialBounds, platformLabel, 12_000)
    let bounds = douyinMiniAppCaptureBounds(capture.xml || initialXml, await windowSize()) || initialBounds
    if (bounds.join(',') !== initialBounds.join(',')) capture = await waitForMiniAppStableRegion(bounds, platformLabel, 8_000)

    const captureProductsIfVisible = async xml => {
      if (products) return true
      let trigger = miniAppReferenceProductsTrigger(xml, bounds)
      if (!trigger) return false
      productDetected = true
      const started = Date.now()
      let lastError = null
      try {
        for (let attempt = 0; attempt < 2 && !products; attempt += 1) {
          productCaptureAttempts += 1
          try {
            const candidate = await captureReferenceProductsAtTrigger(trigger, {
              triggerResolver: latestXml => miniAppReferenceProductsTrigger(latestXml, bounds),
            })
            if (!candidate.firstViewportIncluded) throw new Error('参考药品首项所在视口未纳入截图')
            if (!candidate.imagesReady) throw new Error(`参考药品图片仍有 ${candidate.unloaded} 处未确认加载`)
            if (!candidate.confirmedEnd) throw new Error('参考药品列表未确认到底')
            if (!candidate.continuityVerified) throw new Error('参考药品拼接连续性未通过校验')
            products = candidate
          } catch (error) {
            lastError = error
            if (attempt < 1) {
              log(`capture: ${platformLabel}参考药品采集未完成，在回答尾部入口直接重试（2/2）：${error.message}`)
              trigger = miniAppReferenceProductsTrigger(await source(), bounds) || trigger
            }
          }
        }
        if (!products) throw new Error(`${platformLabel}参考药品为必采内容，但两次采集均未完成：${lastError?.message || '未知错误'}`)
        log(`capture: ${platformLabel}参考药品已从首项到末项完整采集，本题截图结束`)
        return true
      } finally {
        productCaptureMs += Date.now() - started
      }
    }

    let topUnchangedCount = 0
    let topNavigationAttempts = 0
    while (topUnchangedCount < 2) {
      topNavigationAttempts += 1
      const before = capture.frame
      await swipeChat(bounds, 'up', 0.62, { maxFraction: 0.68, speed: 2_600 })
      capture = await waitForMiniAppStableRegion(bounds, platformLabel, 6_000)
      topUnchangedCount = await imagesSimilar(before, capture.frame, 3) ? topUnchangedCount + 1 : 0
    }
    log(`capture: ${platformLabel}小荷AI全文已确认位于顶部（回滚尝试=${topNavigationAttempts}）`)
    frames.push(capture.frame)
    log(`capture: ${platformLabel}小荷AI全文 page 1`)

    let terminalSequence = await captureProductsIfVisible(capture.xml || await source())

    while (!terminalSequence && unchangedCount < 2) {
      scrollAttempts += 1
      const before = frames.at(-1)
      const scroll = await swipeChat(bounds, 'down', 0.5, { maxFraction: 0.58, speed: 1_600, eventDrivenSettle: true })
      let afterCapture = await waitForMiniAppStableRegion(bounds, platformLabel, 8_000)
      let after = afterCapture.frame
      if (await imagesSimilar(before, after, 3)) {
        unchangedCount += 1
        continue
      }

      unchangedCount = 0
      const frameHeight = (await imageInfo(before)).height
      const expectedOverlap = Math.max(12, frameHeight - scroll.distance)
      let transition = null
      try {
        if (!afterCapture.stable) throw new Error(`滚动后的${platformLabel}全文画面未稳定`)
        try {
          transition = { verified: true, overlap: await verifyFrameOverlap(before, after, expectedOverlap) }
        } catch {
          transition = { verified: true, overlap: await verifyFrameOverlap(before, after, null) }
        }
      } catch (error) {
        recaptureCount += 1
        afterCapture = await waitForMiniAppStableRegion(bounds, platformLabel, 3_000)
        after = afterCapture.frame
        try {
          if (!afterCapture.stable) throw new Error(`重采后的${platformLabel}全文画面仍未稳定`)
          transition = { verified: true, overlap: await verifyFrameOverlap(before, after, null) }
        } catch (retryError) {
          const reason = retryError.message || error.message
          transition = { verified: false, fallbackOverlap: 0, reason }
          fallbackReasons.push(reason)
          log(`capture: ${platformLabel}全文接缝无法精确校验，保留下一屏完整视口和浅色留白：${reason}`)
        }
      }
      if (!(await imagesSimilar(frames.at(-1), after, 3))) {
        frames.push(after)
        transitions.push(transition)
        log(`capture: ${platformLabel}小荷AI全文 page ${frames.length}`)
      }
      terminalSequence = await captureProductsIfVisible(afterCapture.xml || await source())
    }
    if (!terminalSequence) log(`capture: ${platformLabel}小荷AI全文连续两次滚动无变化，已确认到底`)
    return {
      frames,
      transitions,
      bounds,
      recaptureCount,
      fullRetryCount: 0,
      fallbackReasons,
      topNavigationMs: 0,
      evidenceEmbedded: false,
      evidenceExpanded: false,
      productDetected,
      products,
      productCaptureAttempts,
      productCaptureMs,
      captureMetadata: {
        [openedMetadataKey]: true,
        [`${metadataPrefix}_full_page_confirmed_top`]: true,
        [`${metadataPrefix}_full_page_top_navigation_attempts`]: topNavigationAttempts,
        [`${metadataPrefix}_full_page_confirmed_end`]: true,
        [`${metadataPrefix}_full_page_scroll_attempts`]: scrollAttempts,
      },
    }
  }

  function captureDouyinFullAnswerFrames(initialXml, initialBounds) {
    return captureMiniAppFullAnswerFrames(initialXml, initialBounds, {
      platformLabel: '抖音',
      metadataPrefix: 'douyin',
      openedMetadataKey: 'douyin_view_full_opened',
      initialQuietMs: REPLY_STABLE_QUIET_MS,
    })
  }

  function captureDouyinMiniAppEntryAnswerFrames(initialXml, initialBounds) {
    return captureMiniAppFullAnswerFrames(initialXml, initialBounds, {
      platformLabel: '抖音',
      metadataPrefix: 'douyin',
      openedMetadataKey: 'douyin_miniapp_entry_opened',
      initialQuietMs: REPLY_STABLE_QUIET_MS,
    })
  }

  function captureToutiaoFullAnswerFrames(initialXml, initialBounds) {
    return captureMiniAppFullAnswerFrames(initialXml, initialBounds, {
      platformLabel: '头条',
      metadataPrefix: 'toutiao',
      openedMetadataKey: 'toutiao_view_more_opened',
      initialQuietMs: REPLY_STABLE_QUIET_MS,
    })
  }

  async function captureProductViewport(listBounds, timeout = 4_000, { settleSince = null } = {}) {
    const deadline = Date.now() + timeout
    let latest = null
    while (Date.now() < deadline) {
      checkCancelled()
      const remaining = Math.max(250, deadline - Date.now())
      let capture
      if (observer.active) {
        try {
          capture = await captureStableObserved({
            observer,
            capture: async () => cropImage(await screenshot(), listBounds),
            hierarchy: source,
            hierarchyLoading: () => false,
            settleSince,
          }, Math.min(2_500, remaining))
        } catch (error) {
          if (await recoverObserver(error)) continue
        }
      }
      if (!capture?.stable) {
        if (observer.active) observerRegionFallbacks += 1
        capture = await captureStableSandwich({
          capture: async () => cropImage(await screenshot(), listBounds),
          hierarchy: source,
          framesStable: imageRegionsStable,
          hierarchyLoading: () => false,
          interval: 80,
          initialFrame: capture?.frame || null,
          initialXml: capture?.xml || '',
        }, remaining)
      }
      const readiness = await referenceProductViewportReadiness(capture.frame, capture.xml, listBounds)
      latest = { ...capture, readiness }
      if (capture.stable && readiness.ready) {
        if (!observer.active) return latest
        const confirmMark = observer.mark()
        try {
          const confirmed = await observer.waitForQuiet({
            timeout: Math.min(1_200, Math.max(650, deadline - Date.now())),
            windowMs: 750,
            quietMs: 650,
            maxFrames: 1,
            minWaitMs: 650,
          })
          const currentMark = observer.mark()
          const activityFrames = (currentMark.activityFrameCount ?? currentMark.frameCount)
            - (confirmMark.activityFrameCount ?? confirmMark.frameCount)
          // Reuse the lossless PNG when the extra observation window remains
          // quiet.  If lazy artwork or scroll rebound appears, loop once more
          // and replace it instead of stitching two different render states.
          if (confirmed.quiet && activityFrames === 0) return latest
        } catch (error) {
          await recoverObserver(error)
        }
      }
      settleSince = observer.active ? observer.mark() : null
      await waitForVisualQuiet({ timeout: Math.min(700, Math.max(100, deadline - Date.now())), fallbackMs: 180 })
    }
    return latest
  }

  async function captureScrollingRegion(bounds, initialCapture = null) {
    const readiness = []
    const initial = initialCapture || await captureProductViewport(bounds)
    if (!initial) throw new Error('推荐药品首屏未能完成稳定截图')
    readiness.push(initial.readiness)
    const frames = [initial.frame]
    log('capture: 推荐药品 page 1')
    let confirmedEnd = false
    const transitions = []
    let unchangedCount = 0
    let seamRecaptures = 0
    let fullRangeSearches = 0
    const [left, top, right, bottom] = bounds
    // The sheet is expanded before this function starts, so a gesture inside
    // the card area now belongs to the vertical RecyclerView rather than the
    // bottom-sheet drag handle.
    const height = bottom - top
    // The product count is not bounded. Completion is defined only by the
    // RecyclerView producing the same settled viewport after repeated swipe
    // attempts; cancellation remains available to stop a genuinely stuck UI.
    while (!confirmedEnd) {
      const activityMark = observer.active ? observer.mark() : null
      const swipeFractions = [0.32, 0.5, 0.68]
      const x = left + (right - left) * swipeFractions[Math.min(unchangedCount, swipeFractions.length - 1)]
      await swipe(x, top + height * 0.82, top + height * 0.18, unchangedCount ? 800 : 520)
      let capture = await captureProductViewport(bounds, 4_000, { settleSince: activityMark })
      if (!capture) throw new Error('推荐药品滚动后未能完成稳定截图')
      readiness.push(capture.readiness)
      let frame = capture.frame
      if (await imagesSimilar(frames.at(-1), frame, 3)) {
        unchangedCount += 1
        const requiredUnchanged = frames.length === 1 ? 3 : 2
        if (unchangedCount >= requiredUnchanged) {
          confirmedEnd = true
          log(`capture: 推荐药品连续 ${requiredUnchanged} 次滚动无变化，已确认真实末项`)
          break
        }
        log(`waiting: 推荐药品末端确认 ${unchangedCount}/${requiredUnchanged}`)
        continue
      } else {
        unchangedCount = 0
        const previous = frames.at(-1)
        const expectedOverlap = Math.max(12, Math.floor(height * 0.28))
        let overlap = null
        let transition = null
        let firstError = null
        try {
          overlap = await verifyFrameOverlap(previous, frame, expectedOverlap)
        } catch (error) {
          firstError = error
          try { overlap = await verifyProductGridOverlap(previous, frame, expectedOverlap) } catch {
            fullRangeSearches += 1
            try { overlap = await verifyProductGridOverlap(previous, frame, null) } catch {}
          }
        }
        if (overlap === null) {
          seamRecaptures += 1
          capture = await captureProductViewport(bounds, 3_000)
          if (!capture) throw firstError
          readiness[readiness.length - 1] = capture.readiness
          frame = capture.frame
          try {
            overlap = await verifyFrameOverlap(previous, frame, expectedOverlap)
          } catch (error) {
            try { overlap = await verifyProductGridOverlap(previous, frame, expectedOverlap) } catch {
              fullRangeSearches += 1
              try { overlap = await verifyProductGridOverlap(previous, frame, null) } catch (retryError) {
                const fallbackOverlap = calibratedProductFallbackOverlap(transitions.filter(item => item.verified).map(item => item.overlap))
                if (fallbackOverlap === null) {
                  throw new Error(`推荐药品第 ${frames.length + 1} 屏接缝重采后仍无法验证，已拒绝生成带灰线和重复商品的长图：${retryError.message || error.message}`)
                }
                transition = { verified: false, calibrated: true, fallbackOverlap, reason: retryError.message || error.message }
                log(`capture: 推荐药品第 ${frames.length + 1} 屏含局部动态内容，按前序一致位移保守拼接（重叠 ${fallbackOverlap}px，无灰线）`)
              }
            }
          }
        }
        transitions.push(transition || { verified: true, overlap })
        frames.push(frame)
        log(`capture: 推荐药品 page ${frames.length}`)
      }
    }
    const calibratedSeams = transitions.filter(item => item.calibrated).length
    const continuityVerified = transitions.length === Math.max(0, frames.length - 1)
      && transitions.every(item => item.verified || item.calibrated)
    return { frames, transitions, readiness, confirmedEnd, continuityVerified, calibratedSeams, seamRecaptures, fullRangeSearches }
  }

  async function closeReferenceProductsDrawer() {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const xml = await source()
      const { sheet, list } = referenceProductDrawerBounds(xml)
      if (!sheet) return true
      const [left, top, right, bottom] = sheet
      const closeY = list ? Math.floor((top + list[1]) / 2) : top + Math.max(24, Math.floor((bottom - top) / 10))
      await tap(right - Math.max(24, Math.floor((right - left) / 16)), closeY)
      await waitForVisualQuiet({ timeout: 900, fallbackMs: 600 })
      if (!referenceProductDrawerBounds(await source()).sheet) return true
      await ui.press('back')
      await waitForVisualQuiet({ timeout: 900, fallbackMs: 600 })
    }
    return !referenceProductDrawerBounds(await source()).sheet
  }

  async function captureReferenceProductsAtTrigger(trigger, { restoreDrawer = true, chatBounds = null, triggerResolver = null } = {}) {
    log('capture: 回答滚动中发现推荐药品入口，正在从首项开始采集完整列表')
    await waitForVisualQuiet({ timeout: 1_200, fallbackMs: 350 })
    let triggerRefreshed = false
    if (chatBounds || triggerResolver) {
      const latestXml = await source()
      const refreshed = triggerResolver
        ? (() => {
            const latest = triggerResolver(latestXml)
            if (!latest) throw new Error('推荐药品入口在点击前已离开当前视口；为避免点击错误位置已停止操作')
            return {
              trigger: latest,
              moved: Math.hypot(latest[0] - trigger[0], latest[1] - trigger[1]) > 12,
            }
          })()
        : refreshedReferenceProductsTrigger(latestXml, chatBounds, trigger)
      trigger = refreshed.trigger
      triggerRefreshed = refreshed.moved
      if (triggerRefreshed) log(`capture: 推荐药品入口在页面稳定后发生位移，已刷新点击坐标为 ${trigger.join(',')}`)
    }
    await tap(trigger[0], trigger[1])
    await waitForVisualQuiet({ timeout: 1_200, fallbackMs: 800 })
    let result = null
    try {
      const deadline = Date.now() + 6_000
      let list = null
      let sheet = null
      while (Date.now() < deadline && (!list || !sheet)) {
        const xml = await source()
        const drawer = referenceProductDrawerBounds(xml)
        list = drawer.list
        sheet = drawer.sheet
        if (!list || !sheet) await sleep(100)
      }
      if (!list || !sheet || list[3] - list[1] < 100) {
        throw new Error(`推荐药品入口已点击，但未识别到药品列表抽屉（sheet=${sheet ? sheet.join(',') : 'none'} list=${list ? list.join(',') : 'none'}）`)
      }
      log(`capture: 推荐药品抽屉初始边界 sheet=${sheet.join(',')} list=${list.join(',')}`)
      for (let attempt = 0; attempt < 3 && !referenceProductSheetExpanded(sheet, list); attempt += 1) {
        const [left, top, right, bottom] = list
        const height = bottom - top
        const previousTop = top
        // Drag the sheet header/handle, not RecyclerView content. A gesture in
        // the product grid can scroll to a middle card before the first frame
        // and was the source of the missing/duplicated opening products.
        const headerHeight = Math.max(60, top - sheet[1])
        const fromY = top - Math.min(headerHeight * 0.35, 70)
        const toY = Math.max(140, top - Math.max(700, height * 0.65))
        await swipe(left + (right - left) * 0.5, fromY, toY, 350)
        const expandDeadline = Date.now() + 2_500
        while (Date.now() < expandDeadline) {
          await sleep(100)
          const expandedXml = await source()
          const { list: expandedList, sheet: expandedSheet } = referenceProductDrawerBounds(expandedXml)
          if (expandedList && expandedSheet && expandedList[1] < previousTop - 40) {
            list = expandedList
            sheet = expandedSheet
            break
          }
        }
        if (list[1] >= previousTop - 40) await waitForVisualQuiet({ timeout: 700, fallbackMs: 250 })
      }
      if (!referenceProductSheetExpanded(sheet, list)) {
        throw new Error(`推荐药品抽屉未完全展开（sheet=${sheet.join(',')} list=${list.join(',')}），为避免从中间药品开始已停止采集`)
      }
      await waitForVisualQuiet({ timeout: 900, fallbackMs: 250 })
      log(`capture: 推荐药品抽屉已先展开，列表视口=${list[3] - list[1]}px`)
      const expandedInitial = await captureProductViewport(list)
      if (!expandedInitial) throw new Error('推荐药品展开后首屏未能完成稳定截图')
      const capture = await captureScrollingRegion(list, expandedInitial)
      const chunks = await composeLongImages(capture.frames, {
        transitions: capture.transitions,
        maxHeight: maxLongImageHeight(payloadMaxLongImageHeight),
        separatorHeight: 0,
      })
      const unloaded = capture.readiness.reduce((sum, item) => sum + item.unloaded, 0)
      const imagesReady = capture.readiness.every(item => item.ready)
      log(`capture: 推荐药品截图完成，共 ${capture.frames.length} 屏，图片${imagesReady ? '已全部加载' : `仍有 ${unloaded} 处未确认加载`}`)
      result = { images: chunks, pages: capture.frames.length, firstViewportIncluded: true, firstViewportStandalone: false, imagesReady, unloaded, confirmedEnd: capture.confirmedEnd, continuityVerified: capture.continuityVerified, calibratedSeams: capture.calibratedSeams, seamRecaptures: capture.seamRecaptures, fullRangeSearches: capture.fullRangeSearches, readinessModes: [...new Set(capture.readiness.map(item => item.mode))], triggerRefreshed }
    } finally {
      if (restoreDrawer && !(await closeReferenceProductsDrawer())) throw new Error('推荐药品截图完成后无法关闭药品列表抽屉')
    }
    return result
  }

  let payloadMaxLongImageHeight = DEFAULT_MAX_LONG_IMAGE_HEIGHT

  async function saveArtifacts({ artifacts, stem, question, status, xml, meta, stitch = true, captureMethod = captureFullReplyFrames, observerBaseline, recoveryBaseline }) {
    const deliveryDirectory = artifacts.deliveryDirectory
    const diagnosticDirectory = artifacts.diagnosticDirectory
    await Promise.all([
      fs.mkdir(deliveryDirectory, { recursive: true }),
      fs.mkdir(diagnosticDirectory, { recursive: true }),
    ])
    const xmlPath = path.join(diagnosticDirectory, `${stem}.xml`)
    const metadataPath = path.join(diagnosticDirectory, `${stem}.json`)
    let screenshotPath = path.join(deliveryDirectory, `${stem}.png`)
    let resultMeta = { ...meta }
    if (stitch) {
      const replyCaptureStarted = Date.now()
      const capture = await captureMethod(question)
      const { frames, transitions, bounds, recaptureCount, fullRetryCount, fallbackReasons, topNavigationMs, questionLocated, questionFullyVisible, evidenceEmbedded, evidenceExpanded, productDetected, products, productCaptureAttempts, productCaptureMs, captureMetadata = {} } = capture
      if (!referenceProductsCaptureComplete({ detected: productDetected, products })) {
        throw new Error('检测到推荐药品入口，但药品截图未完整完成')
      }
      const seamsTotal = Math.max(0, frames.length - 1)
      const seamsVerified = transitions.filter(transition => transition.verified).length
      const continuityVerified = transitions.length === seamsTotal && seamsVerified === seamsTotal
      const images = await buildReplyImages(frames, { transitions, maxHeight: payloadMaxLongImageHeight })
      const replyCaptureMs = Date.now() - replyCaptureStarted
      const paths = []
      for (const [index, image] of images.entries()) { const file = path.join(deliveryDirectory, `${stem}_${String(index + 1).padStart(3, '0')}.png`); await fs.writeFile(file, image); paths.push(file) }
      screenshotPath = paths[0]
      resultMeta = {
        ...resultMeta,
        stitched_pages: frames.length,
        screenshot_parts: paths,
        chat_bounds: bounds,
        reply_capture_mode: continuityVerified ? 'verified_overlap_long_image' : 'safe_overlap_long_image',
        reply_continuity_verified: continuityVerified,
        reply_seams_total: seamsTotal,
        reply_seams_verified: seamsVerified,
        reply_seams_with_safe_overlap: seamsTotal - seamsVerified,
        reply_recapture_count: recaptureCount,
        reply_full_retry_count: fullRetryCount,
        reply_top_navigation_ms: topNavigationMs,
        ...(questionLocated !== undefined ? { reply_question_located: questionLocated } : {}),
        ...(questionFullyVisible !== undefined ? { reply_question_fully_visible: questionFullyVisible } : {}),
        reply_evidence_embedded: evidenceEmbedded,
        reply_evidence_expanded: evidenceExpanded,
        reply_capture_ms: replyCaptureMs,
        reference_products_detected: productDetected,
        reference_products_capture_required: productDetected,
        reference_products_inline_capture: Boolean(products),
        reference_products_restore_required: false,
        reference_products_terminal_sequence: Boolean(products),
        reference_products_retry_count: Math.max(0, productCaptureAttempts - (productDetected ? 1 : 0)),
        reference_products_post_scan_swipes: 0,
        reference_products_capture_ms: productCaptureMs,
        ...captureMetadata,
        ...(fallbackReasons.length ? { reply_fallback_reason: fallbackReasons.join('；') } : {}),
        long_image_max_height: payloadMaxLongImageHeight,
      }
      log(`capture: 回答截图完成，帧=${frames.length}，精确接缝=${seamsVerified}/${seamsTotal}，安全重复接缝=${seamsTotal - seamsVerified}，重采=${recaptureCount}，模式=${resultMeta.reply_capture_mode}，耗时=${replyCaptureMs}ms`)
      if (products) {
        const paths = []
        for (const [index, image] of products.images.entries()) { const file = path.join(deliveryDirectory, `${stem}_参考药品_${String(index + 1).padStart(3, '0')}.png`); await fs.writeFile(file, image); paths.push(file) }
        Object.assign(resultMeta, {
          reference_products_screenshot: paths[0],
          reference_products_parts: paths,
          reference_products_pages: products.pages,
          reference_products_capture_mode: products.firstViewportStandalone ? 'standalone_first_viewport_then_verified_overlap_stitch' : (products.continuityVerified ? 'verified_overlap_stitch' : 'separate_viewports'),
          reference_products_continuity_verified: products.continuityVerified,
          reference_products_first_viewport_standalone: products.firstViewportStandalone,
          reference_products_images_ready: products.imagesReady,
          reference_products_unloaded_images: products.unloaded,
          reference_products_confirmed_end: products.confirmedEnd,
          reference_products_first_viewport_included: products.firstViewportIncluded,
          reference_products_capture_complete: products.firstViewportIncluded && products.imagesReady && products.confirmedEnd && products.continuityVerified,
          reference_products_calibrated_seams: products.calibratedSeams,
          reference_products_trigger_refreshed: products.triggerRefreshed,
        })
      }
    } else await fs.writeFile(screenshotPath, await screenshot())
    await fs.writeFile(xmlPath, xml || await normalizedHierarchy(), 'utf8')
    resultMeta = { ...resultMeta, ...observerMetadata(observerBaseline, recoveryBaseline) }
    await fs.writeFile(metadataPath, JSON.stringify({
      question,
      status,
      created_at: new Date().toISOString().replace(/\.\d{3}Z$/, ''),
      artifact_layout_version: 2,
      delivery_directory: deliveryDirectory,
      diagnostic_directory: diagnosticDirectory,
      event_log: path.join(diagnosticDirectory, '执行日志.jsonl'),
      batch_event_log: batchEventLog?.filePath || null,
      screenshot: screenshotPath,
      hierarchy: xmlPath,
      ...resultMeta,
    }, null, 2), 'utf8')
    return { screenshot: screenshotPath, hierarchy: xmlPath, metadata: metadataPath }
  }

  async function askOnceDouyin(payload, artifacts, question, index) {
    const observerBaseline = typeof observer.snapshot === 'function' ? observer.snapshot() : {}
    const recoveryBaseline = recoverySnapshot()
    log('stage: 正在打开抖音搜索框并输入问题')
    const search = await inputDouyinQuestion(question)
    const directory = artifacts.diagnosticDirectory
    const meta = {
      serial: payload.serial,
      batch_id: path.basename(artifacts.batchDirectory),
      question_index: index,
      question_directory: directory,
      entry_id: activeEntry.id,
      entry_label: activeEntry.label,
      entry_package: activePackageName(),
      entry_workflow: activeEntry.workflow,
      new_session_requested: Boolean(payload.newSession),
      new_session_performed: false,
      douyin_search_performed: true,
      ui_backend: 'python_uiautomator2_strict',
      ui_fallback_enabled: false,
    }
    log('stage: 正在执行抖音搜索')
    await tap((search[0] + search[2]) / 2, (search[1] + search[3]) / 2)
    let card
    try {
      card = await runDouyinSearchResultAttempts({
        waitForResult: attempt => waitForDouyinSearchResult(payload.timeout * 1_000, { attempt }),
        refreshResults: error => refreshDouyinSearchResults(question, error.scanScrolls),
      })
      Object.assign(meta, {
        douyin_search_attempts: card.attempt,
        douyin_search_refreshed: card.refreshed,
      })
    } catch (error) {
      await fs.mkdir(directory, { recursive: true })
      const [xml, frame] = await Promise.all([source(), screenshot()])
      await Promise.all([
        fs.writeFile(path.join(directory, '搜索超时.xml'), xml, 'utf8'),
        fs.writeFile(path.join(directory, '搜索超时.png'), frame),
      ])
      log(`diagnostic: 抖音搜索超时现场已保存到 ${directory}`)
      throw error
    }
    const searchCapture = await captureDouyinSearchTarget(card.size)
    await fs.mkdir(artifacts.deliveryDirectory, { recursive: true })
    let leadingScreenshotPath
    let full
    let captureMethod
    if (searchCapture.target.mode === 'smart_summary') {
      log('stage: 已找到小荷AI医生回答卡片，正在截取搜索结果智能总结')
      leadingScreenshotPath = path.join(artifacts.deliveryDirectory, DOUYIN_SEARCH_SUMMARY_FILENAME)
      await fs.writeFile(leadingScreenshotPath, searchCapture.frame)
      Object.assign(meta, {
        douyin_result_mode: 'smart_summary',
        douyin_search_summary_captured: true,
        douyin_search_summary_screenshot: leadingScreenshotPath,
        douyin_miniapp_entry_detected: false,
        douyin_question_logical_image_count: 2,
      })
      log(`capture: 抖音搜索结果智能总结已保存 ${leadingScreenshotPath}`)
      log('stage: 已找到小荷AI医生回答卡片，正在点击查看全文')
      full = await openDouyinFullAnswer(searchCapture.target.viewFull, card.size)
      captureMethod = () => captureDouyinFullAnswerFrames(full.xml, full.bounds)
    } else {
      log('stage: 未出现智能总结，已识别小荷AI医生小程序入口卡片')
      leadingScreenshotPath = path.join(artifacts.deliveryDirectory, DOUYIN_MINIAPP_ENTRY_FILENAME)
      await fs.writeFile(leadingScreenshotPath, searchCapture.frame)
      log(`capture: 抖音小程序入口搜索页已保存 ${leadingScreenshotPath}`)
      log('stage: 正在通过独立入口卡片打开小荷AI医生小程序')
      full = await openDouyinMiniAppEntry(searchCapture.target, card.size)
      Object.assign(meta, {
        douyin_result_mode: 'miniapp_entry_card',
        douyin_search_summary_captured: false,
        douyin_miniapp_entry_detected: true,
        douyin_miniapp_entry_screenshot: leadingScreenshotPath,
        douyin_miniapp_entry_card_bounds: searchCapture.target.cardBounds,
        douyin_miniapp_entry_tap_bounds: searchCapture.target.tapBounds,
        douyin_miniapp_entry_activity: full.activity,
        douyin_question_logical_image_count: 2,
      })
      full = await waitForDouyinMiniAppAnswer(full, payload.timeout * 1_000)
      captureMethod = () => captureDouyinMiniAppEntryAnswerFrames(full.xml, full.bounds)
    }
    log('stage: 小荷AI医生全文页已打开且回答可截图，开始从上到下完整截图')
    const result = await saveArtifacts({
      artifacts,
      stem: '回答',
      question,
      status: 'stable',
      xml: full.xml,
      meta,
      captureMethod,
      observerBaseline,
      recoveryBaseline,
    })
    return searchCapture.target.mode === 'smart_summary'
      ? { summaryScreenshot: leadingScreenshotPath, ...result }
      : { entryScreenshot: leadingScreenshotPath, ...result }
  }

  async function askOnceToutiao(payload, artifacts, question, index) {
    const observerBaseline = typeof observer.snapshot === 'function' ? observer.snapshot() : {}
    const recoveryBaseline = recoverySnapshot()
    log('stage: 正在打开头条搜索框并输入问题')
    const search = await inputToutiaoQuestion(question)
    const directory = artifacts.diagnosticDirectory
    const meta = {
      serial: payload.serial,
      batch_id: path.basename(artifacts.batchDirectory),
      question_index: index,
      question_directory: directory,
      entry_id: activeEntry.id,
      entry_label: activeEntry.label,
      entry_package: activePackageName(),
      entry_workflow: activeEntry.workflow,
      new_session_requested: Boolean(payload.newSession),
      new_session_performed: false,
      toutiao_search_performed: true,
      ui_backend: 'python_uiautomator2_strict',
      ui_fallback_enabled: false,
    }
    log('stage: 正在执行头条搜索')
    await tap((search[0] + search[2]) / 2, (search[1] + search[3]) / 2)
    const card = await waitForToutiaoAnswerCard(payload.timeout * 1_000)
    log('stage: 已找到头条小荷AI医生回答卡片，正在截取搜索结果智能总结')
    const summary = await captureToutiaoSearchSummary(card.size)
    await fs.mkdir(artifacts.deliveryDirectory, { recursive: true })
    const summaryPath = path.join(artifacts.deliveryDirectory, TOUTIAO_SEARCH_SUMMARY_FILENAME)
    await fs.writeFile(summaryPath, summary.frame)
    Object.assign(meta, {
      toutiao_search_summary_captured: true,
      toutiao_search_summary_screenshot: summaryPath,
      toutiao_question_logical_image_count: 2,
    })
    log(`capture: 头条搜索结果智能总结已保存 ${summaryPath}`)
    log('stage: 已找到头条小荷AI医生回答卡片，正在点击查看更多')
    const full = await openToutiaoFullAnswer(summary.viewMore, card.size)
    log('stage: 头条小荷AI医生全文页已打开，开始从上到下完整截图')
    const result = await saveArtifacts({
      artifacts,
      stem: '回答',
      question,
      status: 'stable',
      xml: full.xml,
      meta,
      captureMethod: () => captureToutiaoFullAnswerFrames(full.xml, full.bounds),
      observerBaseline,
      recoveryBaseline,
    })
    return { summaryScreenshot: summaryPath, ...result }
  }

  async function askOnce(payload, artifacts, question, index) {
    if (activeEntry.workflow === 'douyin-search') return askOnceDouyin(payload, artifacts, question, index)
    if (activeEntry.workflow === 'toutiao-search') return askOnceToutiao(payload, artifacts, question, index)
    const observerBaseline = typeof observer.snapshot === 'function' ? observer.snapshot() : {}
    const recoveryBaseline = recoverySnapshot()
    let newSessionPerformed = false
    if (payload.newSession && activeEntry.supportsNewSession) {
      log('stage: 正在切换到新会话')
      newSessionPerformed = await tapNewSession()
    } else if (payload.newSession && !activeEntry.supportsNewSession) {
      log(`stage: ${activeEntry.label}不支持自动新建会话，已跳过该步骤`)
    }
    log('stage: 正在输入问题')
    await inputQuestion(question)
    const directory = artifacts.diagnosticDirectory
    const meta = {
      serial: payload.serial,
      batch_id: path.basename(artifacts.batchDirectory),
      question_index: index,
      question_directory: directory,
      entry_id: activeEntry.id,
      entry_label: activeEntry.label,
      entry_package: activePackageName(),
      new_session_requested: Boolean(payload.newSession),
      new_session_performed: newSessionPerformed,
      ui_backend: 'python_uiautomator2_strict',
      ui_fallback_enabled: false,
    }
    log('stage: 正在发送问题')
    const sendMark = observer.active ? observer.mark() : null
    const replyStartedAt = Date.now()
    await tapSend()
    log('stage: 问题已发送，等待回答稳定')
    if (sendMark && observer.active && typeof observer.waitForActivity === 'function') {
      try {
        const activity = await observer.waitForActivity({ timeout: 2_000, since: sendMark })
        if (activity.activity) log('waiting: scrcpy已检测到回答画面开始变化')
      } catch (error) {
        await recoverObserver(error)
      }
    } else await sleep(2_000)
    const result = await waitForStableReply(payload.timeout * 1_000, { startedAt: replyStartedAt })
    log(`stage: 回答等待结束（${result.status}），开始截图`)
    return saveArtifacts({
      artifacts,
      stem: '回答',
      question,
      status: result.status,
      xml: result.xml,
      meta,
      observerBaseline,
      recoveryBaseline,
    })
  }

  async function prepareEntry(entry) {
    resetEntryState(entry)
    await ui.appStart(entry.packageName)
    await waitForPackageHierarchy({
      dumpHierarchy: async () => {
        checkCancelled()
        return ui.dumpHierarchy()
      },
      packageName: activePackageName(),
      packageLabel: activePackageLabel(),
    })
    await waitForVisualQuiet({ timeout: 1_200, fallbackMs: 800 })
    if (entry.workflow === 'douyin-search') await waitForDouyinSearchInput(15_000)
    else if (entry.workflow === 'toutiao-search') await waitForToutiaoSearchInput(15_000)
    else await waitForInput(15_000)
  }

  return {
    async captureCurrentAnswer(payload) {
      activeSerial = payload.serial
      if ((payload.entries || []).length > 1) throw new Error('当前已有回答模式一次只能指定一个入口。')
      const requestedEntry = (payload.entries || []).length
        ? normalizeAutomationEntries(payload.entries)[0]
        : ENTRY_DEFINITIONS[DEFAULT_ENTRY_ID]
      resetEntryState(requestedEntry)
      payloadMaxLongImageHeight = maxLongImageHeight(payload.maxLongImageHeight)
      const outputRoot = path.resolve(payload.outputDir)
      const batchDirectory = await createBatchDirectory(outputRoot)
      const batchArtifacts = batchArtifactDirectories(batchDirectory)
      await initializeArtifactLogging(batchArtifacts, payload, 'capture_current_existing_reply')
      try {
        await waitForAdbDevice(options.adbPath, payload.serial)
        await ui.start(payload.serial)
        try {
          await observer.start(payload.serial)
        } catch (error) {
          await disableObserver(error)
        }
        await waitForVisualQuiet({ timeout: 1_200, fallbackMs: 600 })
        const observerBaseline = typeof observer.snapshot === 'function' ? observer.snapshot() : {}
        const recoveryBaseline = recoverySnapshot()
        let xml = await source()
        const alreadyOpen = Boolean(referenceProductDrawerBounds(xml).sheet)
        if (alreadyOpen) throw new Error('当前药品抽屉已经打开，无法证明仍位于第一项；为避免漏药，本次未继续操作，也未输入或发送新问题。')
        const size = await windowSize()
        let question = ''
        let captureMethod = captureFullReplyFrames
        if (activeEntry.workflow === 'douyin-search' || activeEntry.workflow === 'toutiao-search') {
          question = String(payload.questions?.[0] || '').trim()
          if (!question) throw new Error('小程序当前已有回答模式需要在命令末尾提供当前问题文字，仅用于文件夹命名；不会输入或发送。')
          const bounds = douyinMiniAppCaptureBounds(xml, size)
          if (!bounds) throw new Error(`当前页面不是${activeEntry.label}的已打开全文页；本次未输入或发送。`)
          if (activeEntry.workflow === 'douyin-search') {
            const foreground = await ui.foregroundWindow()
            if (foreground?.package !== activePackageName() || !/MiniAppHostActivity/.test(foreground?.activity || '')) {
              throw new Error(`当前前台不是抖音小程序宿主页；本次未输入或发送（activity=${foreground?.activity || 'unknown'}）。`)
            }
            captureMethod = () => captureDouyinMiniAppEntryAnswerFrames(xml, bounds)
          } else captureMethod = () => captureToutiaoFullAnswerFrames(xml, bounds)
        } else {
          const chatBounds = findChatScrollBounds(xml, size)
          validateCaptureViewport(size, chatBounds)
          question = currentQuestionText(xml, chatBounds)
          let unchangedAtTop = 0
          let locateFrame = question ? null : await cropImage(await screenshot(), chatBounds)
          while (!question && unchangedAtTop < 2) {
            const scroll = await swipeChat(chatBounds, 'up', 0.45, { speed: 2_600, settle: 100, eventDrivenSettle: true })
            const settled = await waitForStableReplyRegion(chatBounds, 3_000, { settleSince: scroll.activityMark })
            xml = settled.xml || await source()
            question = currentQuestionText(xml, chatBounds)
            unchangedAtTop = await imagesSimilar(locateFrame, settled.frame, 3) ? unchangedAtTop + 1 : 0
            locateFrame = settled.frame
          }
          if (!question) {
            await waitForVisualQuiet({ timeout: 900, fallbackMs: 300 })
            xml = await source()
            question = currentQuestionText(xml, chatBounds)
          }
          if (!question) throw new Error('无法从当前已有回答向上定位对应问题；本次未输入、未发送，也未新建会话。')
        }
        const artifacts = questionArtifactDirectories(batchArtifacts, 1, question)
        await startQuestionLogging(artifacts, {
          batch_id: path.basename(batchDirectory),
          serial: payload.serial,
          entry_id: activeEntry.id,
          entry_label: activeEntry.label,
          question,
          question_index: 1,
        })
        log(`capture: 已识别当前已有问题“${question}”，开始执行正文、引用资料和完整参考药品归档；不会输入或发送内容`)
        const result = await saveArtifacts({
          artifacts,
          stem: '回答',
          question,
          status: 'existing_reply',
          xml,
          meta: {
            serial: payload.serial,
            batch_id: path.basename(batchDirectory),
            question_index: 1,
            question_directory: artifacts.diagnosticDirectory,
            entry_id: activeEntry.id,
            entry_label: activeEntry.label,
            entry_package: activePackageName(),
            existing_reply_capture: true,
            input_performed: false,
            send_performed: false,
            new_session_performed: false,
            ui_backend: 'python_uiautomator2_strict',
            ui_fallback_enabled: false,
          },
          captureMethod,
          observerBaseline,
          recoveryBaseline,
        })
        await finishQuestionLogging('question_completed', { status: 'existing_reply', screenshot: result.screenshot, metadata: result.metadata })
        const summaryPath = path.join(batchArtifacts.diagnosticDirectory, 'batch-summary.json')
        const summary = {
          created_at: new Date().toISOString(),
          serial: payload.serial,
          mode: 'capture_current_existing_reply',
          question_count: 1,
          total: 1,
          completed: 1,
          failed: 0,
          status: 'completed',
          artifact_layout_version: 2,
          batch_directory: batchDirectory,
          delivery_directory: batchArtifacts.deliveryDirectory,
          diagnostic_directory: batchArtifacts.diagnosticDirectory,
          event_log: batchEventLog.filePath,
          summary: summaryPath,
          results: [{
            status: 'completed',
            entry_id: activeEntry.id,
            entry_label: activeEntry.label,
            question,
            question_index: 1,
            delivery_directory: artifacts.deliveryDirectory,
            diagnostic_directory: artifacts.diagnosticDirectory,
            event_log: path.join(artifacts.diagnosticDirectory, '执行日志.jsonl'),
            ...result,
          }],
        }
        await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf8')
        await batchEventLog.record('batch_completed', { category: 'lifecycle', details: { completed: 1, failed: 0, summary: summaryPath } })
        return { ...result, summary: summaryPath }
      } catch (error) {
        await finishQuestionLogging('question_failed', { error_name: error?.name || 'Error', error_message: error?.message || String(error) }).catch(() => {})
        await batchEventLog.record('batch_failed', { category: 'error', details: { error_name: error?.name || 'Error', error_message: error?.message || String(error) } }).catch(() => {})
        await fs.writeFile(path.join(batchArtifacts.diagnosticDirectory, 'automation-failure.json'), JSON.stringify({
          created_at: new Date().toISOString(),
          serial: payload.serial,
          mode: 'capture_current_existing_reply',
          artifact_layout_version: 2,
          batch_directory: batchDirectory,
          delivery_directory: batchArtifacts.deliveryDirectory,
          diagnostic_directory: batchArtifacts.diagnosticDirectory,
          event_log: batchEventLog.filePath,
          input_performed: false,
          send_performed: false,
          new_session_performed: false,
          error_name: error?.name || 'Error',
          error_message: error?.message || String(error),
          stack: error?.stack || null,
        }, null, 2), 'utf8').catch(() => {})
        throw error
      } finally {
        await observer.stop().catch(() => {})
        await ui.stop().catch(() => {})
        await flushArtifactLogs().catch(() => {})
      }
    },
    async run(payload) {
      activeSerial = payload.serial
      payloadMaxLongImageHeight = maxLongImageHeight(payload.maxLongImageHeight)
      const entries = normalizeAutomationEntries(payload.entries)
      const outputRoot = path.resolve(payload.outputDir)
      const batchDirectory = await createBatchDirectory(outputRoot)
      const batchArtifacts = batchArtifactDirectories(batchDirectory)
      await initializeArtifactLogging(batchArtifacts, payload, 'batch_questions')
      try {
        await waitForAdbDevice(options.adbPath, payload.serial)
        await ui.start(payload.serial)
        try {
          await observer.start(payload.serial)
        } catch (error) {
          await disableObserver(error)
        }
        log(`device=${payload.serial} entries=${entries.map(entry => entry.id).join(',')} batch=${batchDirectory}`)
        let completed = 0
        let failed = 0
        const results = []
        const failures = []
        for (const [entryIndex, entry] of entries.entries()) {
          checkCancelled()
          log(`entry: [${entryIndex + 1}/${entries.length}] ${entry.label} package=${entry.packageName}`)
          const entryArtifacts = entryArtifactDirectories(batchArtifacts, entryIndex + 1, entry.label, entries.length)
          const entryResult = await runQuestionsWithRecovery({
            questions: payload.questions,
            beforeQuestion: async (question, index) => {
              const artifacts = questionArtifactDirectories(entryArtifacts, index, question)
              await startQuestionLogging(artifacts, {
                batch_id: path.basename(batchDirectory),
                serial: payload.serial,
                entry_id: entry.id,
                entry_label: entry.label,
                question,
                question_index: index,
              })
              log(`[${entryIndex + 1}/${entries.length} ${index}/${payload.questions.length}] task ready via ${entry.label}: ${question}`)
            },
            prepare: () => prepareEntry(entry),
            execute: async (question, index) => {
              const artifacts = questionArtifactDirectories(entryArtifacts, index, question)
              log(`[${entryIndex + 1}/${entries.length} ${index}/${payload.questions.length}] asking via ${entry.label}: ${question}`)
              const result = await askOnce(payload, artifacts, question, index)
              log(JSON.stringify(result))
              results.push({
                status: 'completed',
                entry_id: entry.id,
                entry_label: entry.label,
                question,
                question_index: index,
                delivery_directory: artifacts.deliveryDirectory,
                diagnostic_directory: artifacts.diagnosticDirectory,
                event_log: path.join(artifacts.diagnosticDirectory, '执行日志.jsonl'),
                ...result,
              })
              await finishQuestionLogging('question_completed', { screenshot: result.screenshot, metadata: result.metadata })
            },
            recordFailure: async (error, question, index) => {
              const artifacts = questionArtifactDirectories(entryArtifacts, index, question)
              const directory = artifacts.diagnosticDirectory
              const failurePath = path.join(directory, '失败.json')
              const failure = {
                created_at: new Date().toISOString(),
                status: 'failed',
                artifact_layout_version: 2,
                serial: payload.serial,
                batch_id: path.basename(batchDirectory),
                question,
                question_index: index,
                question_directory: directory,
                delivery_directory: artifacts.deliveryDirectory,
                diagnostic_directory: artifacts.diagnosticDirectory,
                event_log: path.join(directory, '执行日志.jsonl'),
                batch_event_log: batchEventLog.filePath,
                entry_id: entry.id,
                entry_label: entry.label,
                entry_package: entry.packageName,
                batch_continued: true,
                error_name: error?.name || 'Error',
                error_message: error?.message || String(error),
                stack: error?.stack || null,
              }
              await fs.mkdir(directory, { recursive: true })
              await fs.writeFile(failurePath, JSON.stringify(failure, null, 2), 'utf8')
              failures.push({
                entry_id: entry.id,
                entry_label: entry.label,
                question,
                question_index: index,
                failure: failurePath,
                error_name: failure.error_name,
                error_message: failure.error_message,
              })
              results.push({
                status: 'failed',
                entry_id: entry.id,
                entry_label: entry.label,
                question,
                question_index: index,
                delivery_directory: artifacts.deliveryDirectory,
                diagnostic_directory: artifacts.diagnosticDirectory,
                event_log: path.join(directory, '执行日志.jsonl'),
                failure: failurePath,
              })
              log(`failed: [${entryIndex + 1}/${entries.length} ${index}/${payload.questions.length}] ${entry.label} / ${question}: ${failure.error_message}`)
              log(`recovery: 本题已记录到 ${failurePath}；下一题将重新启动并校验当前入口`)
              await finishQuestionLogging('question_failed', { failure: failurePath, error_name: failure.error_name, error_message: failure.error_message })
            },
            checkCancelled,
          })
          completed += entryResult.completed
          failed += entryResult.failed
        }
        const total = entries.length * payload.questions.length
        const summaryPath = path.join(batchArtifacts.diagnosticDirectory, 'batch-summary.json')
        const summary = {
          created_at: new Date().toISOString(),
          serial: payload.serial,
          artifact_layout_version: 2,
          batch_directory: batchDirectory,
          delivery_directory: batchArtifacts.deliveryDirectory,
          diagnostic_directory: batchArtifacts.diagnosticDirectory,
          event_log: batchEventLog.filePath,
          entries: entries.map(entry => ({ id: entry.id, label: entry.label, package: entry.packageName })),
          question_count: payload.questions.length,
          total,
          completed,
          failed,
          status: failed ? 'completed_with_failures' : 'completed',
          results,
          failures,
          summary: summaryPath,
        }
        await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf8')
        log(`执行完成：计划=${total}，成功=${completed}，失败=${failed}，批次汇总=${summaryPath}`)
        await batchEventLog.record('batch_result_saved', { category: 'lifecycle', details: { total, completed, failed, summary: summaryPath } })
        return summary
      } catch (error) {
        await finishQuestionLogging('question_failed', { error_name: error?.name || 'Error', error_message: error?.message || String(error), fatal: true }).catch(() => {})
        await batchEventLog.record('batch_failed', { category: 'error', details: { error_name: error?.name || 'Error', error_message: error?.message || String(error) } }).catch(() => {})
        await fs.writeFile(path.join(batchArtifacts.diagnosticDirectory, 'automation-failure.json'), JSON.stringify({
          created_at: new Date().toISOString(),
          serial: payload.serial,
          artifact_layout_version: 2,
          batch_directory: batchDirectory,
          delivery_directory: batchArtifacts.deliveryDirectory,
          diagnostic_directory: batchArtifacts.diagnosticDirectory,
          event_log: batchEventLog.filePath,
          entry_id: activeEntry.id,
          entry_label: activeEntry.label,
          entry_package: activePackageName(),
          ui_backend: 'python_uiautomator2_strict',
          ui_fallback_enabled: false,
          error_name: error?.name || 'Error',
          error_message: error?.message || String(error),
          stack: error?.stack || null,
        }, null, 2), 'utf8').catch(() => {})
        throw error
      } finally {
        await observer.stop().catch(() => {})
        await ui.stop().catch(() => {})
        await flushArtifactLogs().catch(() => {})
      }
    },
    async retryFailedBatch(payload) {
      activeSerial = payload.serial
      payloadMaxLongImageHeight = maxLongImageHeight(payload.maxLongImageHeight)
      const batchDirectory = path.resolve(String(payload.batchDirectory || ''))
      if (!batchDirectory || batchDirectory === path.parse(batchDirectory).root) throw new Error('请选择要重试的原批次。')
      const batchArtifacts = batchArtifactDirectories(batchDirectory)
      const summaryPath = path.join(batchArtifacts.diagnosticDirectory, 'batch-summary.json')
      let previousSummary
      try {
        previousSummary = JSON.parse(await fs.readFile(summaryPath, 'utf8'))
      } catch (error) {
        throw new Error(`无法读取原批次汇总：${error.message}`)
      }
      const retryItems = failedRetryItems(previousSummary)
      if (!retryItems.length) throw new Error('该批次没有可重试的失败题。')
      if (!payload.serial) throw new Error('请选择 Android 设备后再重试失败题。')
      const entriesById = new Map(automationEntries().map(entry => [entry.id, entry]))
      for (const item of retryItems) {
        if (!entriesById.has(item.entry_id)) throw new Error(`原批次使用的入口“${item.entry_id}”已不可用，无法安全重试。`)
      }
      const retryAttempt = retryAttemptCount(previousSummary)
      const results = [...previousSummary.results]
      const retryStartedAt = new Date().toISOString()
      const retryFailures = []
      let completed = Number(previousSummary.completed) || results.filter(result => result.status === 'completed').length
      let failed = 0
      await initializeArtifactLogging(batchArtifacts, payload, 'retry_failed_questions')
      try {
        await waitForAdbDevice(options.adbPath, payload.serial)
        await ui.start(payload.serial)
        try {
          await observer.start(payload.serial)
        } catch (error) {
          await disableObserver(error)
        }
        log(`retry: batch=${batchDirectory} attempt=${retryAttempt} failed_questions=${retryItems.length}`)
        for (const item of retryItems) {
          checkCancelled()
          const entry = entriesById.get(item.entry_id)
          const entryCount = Array.isArray(previousSummary.entries) ? previousSummary.entries.length : 1
          const entryIndex = Math.max(0, (previousSummary.entries || []).findIndex(candidate => candidate.id === entry.id))
          const entryArtifacts = entryArtifactDirectories(batchArtifacts, entryIndex + 1, entry.label, entryCount)
          const artifacts = questionArtifactDirectories(entryArtifacts, item.question_index, item.question)
          const failurePath = path.join(artifacts.diagnosticDirectory, '失败.json')
          await startQuestionLogging(artifacts, {
            batch_id: path.basename(batchDirectory),
            serial: payload.serial,
            entry_id: entry.id,
            entry_label: entry.label,
            question: item.question,
            question_index: item.question_index,
            retry_attempt: retryAttempt,
          })
          try {
            // A failed attempt may have produced partial delivery PNGs. They must
            // never be mistaken for the replacement result of this retry.
            await fs.rm(artifacts.deliveryDirectory, { recursive: true, force: true })
            await prepareEntry(entry)
            log(`retry: [${item.question_index}] ${entry.label} / ${item.question}`)
            const result = await askOnce(payload, artifacts, item.question, item.question_index)
            const replacement = {
              status: 'completed',
              entry_id: entry.id,
              entry_label: entry.label,
              question: item.question,
              question_index: item.question_index,
              delivery_directory: artifacts.deliveryDirectory,
              diagnostic_directory: artifacts.diagnosticDirectory,
              event_log: path.join(artifacts.diagnosticDirectory, '执行日志.jsonl'),
              retry_attempt: retryAttempt,
              retried_at: new Date().toISOString(),
              ...result,
            }
            results[item.resultIndex] = replacement
            completed += 1
            await fs.rename(failurePath, path.join(artifacts.diagnosticDirectory, `失败_重试前_${retryAttempt}.json`)).catch(error => {
              if (error.code !== 'ENOENT') throw error
            })
            await finishQuestionLogging('question_completed', { retry_attempt: retryAttempt, screenshot: result.screenshot, metadata: result.metadata })
          } catch (error) {
            if (fatalBatchError(error)) throw error
            failed += 1
            const failure = {
              created_at: new Date().toISOString(),
              status: 'failed',
              artifact_layout_version: 2,
              serial: payload.serial,
              batch_id: path.basename(batchDirectory),
              question: item.question,
              question_index: item.question_index,
              question_directory: artifacts.diagnosticDirectory,
              delivery_directory: artifacts.deliveryDirectory,
              diagnostic_directory: artifacts.diagnosticDirectory,
              event_log: path.join(artifacts.diagnosticDirectory, '执行日志.jsonl'),
              batch_event_log: batchEventLog.filePath,
              entry_id: entry.id,
              entry_label: entry.label,
              entry_package: entry.packageName,
              retry_attempt: retryAttempt,
              error_name: error?.name || 'Error',
              error_message: error?.message || String(error),
              stack: error?.stack || null,
            }
            await fs.mkdir(artifacts.diagnosticDirectory, { recursive: true })
            await fs.writeFile(failurePath, JSON.stringify(failure, null, 2), 'utf8')
            results[item.resultIndex] = {
              status: 'failed', entry_id: entry.id, entry_label: entry.label,
              question: item.question, question_index: item.question_index,
              delivery_directory: artifacts.deliveryDirectory, diagnostic_directory: artifacts.diagnosticDirectory,
              event_log: path.join(artifacts.diagnosticDirectory, '执行日志.jsonl'), failure: failurePath,
              retry_attempt: retryAttempt,
            }
            retryFailures.push({ entry_id: entry.id, entry_label: entry.label, question: item.question, question_index: item.question_index, failure: failurePath, error_name: failure.error_name, error_message: failure.error_message })
            log(`retry failed: [${item.question_index}] ${entry.label} / ${item.question}: ${failure.error_message}`)
            await finishQuestionLogging('question_failed', { retry_attempt: retryAttempt, failure: failurePath, error_name: failure.error_name, error_message: failure.error_message })
          }
        }
        const remainingFailures = results.filter(result => result.status === 'failed')
        const summary = {
          ...previousSummary,
          updated_at: new Date().toISOString(),
          serial: payload.serial,
          completed: results.filter(result => result.status === 'completed').length,
          failed: remainingFailures.length,
          status: remainingFailures.length ? 'completed_with_failures' : 'completed',
          results,
          failures: remainingFailures.map(result => retryFailures.find(failure => failure.entry_id === result.entry_id && failure.question_index === result.question_index && failure.question === result.question) || {
            entry_id: result.entry_id, entry_label: result.entry_label, question: result.question,
            question_index: result.question_index, failure: result.failure,
          }),
          retry_count: retryAttempt,
          retry_history: [...(Array.isArray(previousSummary.retry_history) ? previousSummary.retry_history : []), {
            attempt: retryAttempt, started_at: retryStartedAt, finished_at: new Date().toISOString(),
            requested: retryItems.length, completed: retryItems.length - failed, failed,
          }],
          summary: summaryPath,
        }
        await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf8')
        log(`重试完成：本次成功=${retryItems.length - failed}，仍失败=${failed}，原批次汇总=${summaryPath}`)
        await batchEventLog.record('batch_result_saved', { category: 'lifecycle', details: { retry_attempt: retryAttempt, total: summary.total, completed: summary.completed, failed: summary.failed, summary: summaryPath } })
        return summary
      } catch (error) {
        await finishQuestionLogging('question_failed', { retry_attempt: retryAttempt, error_name: error?.name || 'Error', error_message: error?.message || String(error), fatal: true }).catch(() => {})
        await batchEventLog.record('batch_retry_failed', { category: 'error', details: { retry_attempt: retryAttempt, error_name: error?.name || 'Error', error_message: error?.message || String(error) } }).catch(() => {})
        throw error
      } finally {
        await observer.stop().catch(() => {})
        await ui.stop().catch(() => {})
        await flushArtifactLogs().catch(() => {})
      }
    },
    async stop() {
      cancelled = true
      await observer.stop().catch(() => {})
      await ui.stop().catch(() => {})
    },
  }
}

module.exports = {
  createRunner,
  CancelledError,
  DouyinSearchResultNotFoundError,
  DEFAULT_PACKAGE,
  DEFAULT_ENTRY_ID,
  DOUYIN_MINIAPP_ENTRY_FILENAME,
  DOUYIN_SEARCH_SUMMARY_FILENAME,
  TOUTIAO_SEARCH_SUMMARY_FILENAME,
  ENTRY_DEFINITIONS,
  automationEntries,
  normalizeAutomationEntries,
  douyinSearchInput,
  douyinGenericAiAnswerBounds,
  douyinMiniAppEntryBounds,
  douyinSearchResultTarget,
  douyinSearchResultsBounds,
  douyinViewFullBounds,
  douyinMiniAppCaptureBounds,
  miniAppReferenceProductsTrigger,
  toutiaoSearchInput,
  toutiaoViewMoreBounds,
  waitForPackageHierarchy,
  runDouyinSearchResultAttempts,
  buildReplyImages,
  conservativeFallbackOverlap,
  chatSwipePlan,
  hierarchyBelongsToPackage,
  scrollEndConfirmed,
  referenceProductsTrigger,
  refreshedReferenceProductsTrigger,
  referenceProductDrawerBounds,
  referenceProductsCaptureComplete,
  referenceProductSheetExpanded,
  requireQuestionLocated,
  calibratedProductFallbackOverlap,
  referenceProductViewportReadiness,
  prepareEmbeddedEvidence,
  fillQuestionInput,
  captureStableSandwich,
  captureStableObserved,
  observerRegionFallbackOptions,
  shouldRetryFullReplyCapture,
  failedRetryItems,
  retryAttemptCount,
  fatalBatchError,
  runQuestionsWithRecovery,
  adbConnectionLost,
  historyOnboardingVisible,
  maxLongImageHeight,
}
