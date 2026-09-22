const { sleep } = require('./utils')
const { cropImage, imageInfo, imageLooksLoaded, imageRegionsStable } = require('./images')
const { hierarchyIsLoading } = require('./hierarchy')

// Search loading is independent of the answer-generation timeout. Never scroll
// or resubmit here. Finish one in-flight recognition even if it crosses the budget.
const SEARCH_ENTRY_TIMEOUT_MS = 15_000
async function searchContentFrame(frame) {
  const { width, height } = await imageInfo(frame)
  return cropImage(frame, [0, Math.round(height * 0.04), width, Math.round(height * 0.97)])
}

async function inspectSearchFirstScreen({
  source, screenshot, hierarchyTarget, recognize, queryMatches = () => true,
  timeout = SEARCH_ENTRY_TIMEOUT_MS, now = Date.now, delay = sleep, log = () => {},
}) {
  const started = now()
  const deadline = started + Math.min(timeout, SEARCH_ENTRY_TIMEOUT_MS)
  let previous = null
  let ocrAttempts = 0
  while (now() < deadline) {
    const xml = await source()
    if (!queryMatches(xml) || hierarchyIsLoading(xml)) {
      previous = null
      await delay(350)
      continue
    }
    const direct = hierarchyTarget(xml)
    if (direct) return { ...direct, xml, ocrAttempts, elapsedMs: now() - started }
    const frame = await screenshot()
    const content = await searchContentFrame(frame)
    const { width, height } = await imageInfo(frame)
    const body = await cropImage(frame, [0, Math.round(height * 0.22), width, Math.round(height * 0.92)])
    if (!await imageLooksLoaded(body) || !previous || !await imageRegionsStable(previous, content)) {
      previous = content
      await delay(600)
      continue
    }
    ocrAttempts++
    const result = await recognize(frame, xml)
    if (result.target) return { ...result, xml, ocrAttempts, elapsedMs: now() - started }
    // A miss is conclusive only if the loaded result has stayed unchanged for
    // the entire OCR call and a short final read. Clock/status-bar changes do
    // not justify running the OCR engine again.
    await delay(800)
    const afterXml = await source()
    const after = await searchContentFrame(await screenshot())
    if (queryMatches(afterXml) && !hierarchyIsLoading(afterXml)
      && await imageRegionsStable(content, after)) {
      log(`search: 首屏已加载且稳定，无小荷入口（ocr_attempts=${ocrAttempts}，elapsed=${now() - started}ms，scrolls=0）`)
      return { absent: true, xml: afterXml, ocrAttempts, elapsedMs: now() - started }
    }
    if (ocrAttempts >= 2) break
    previous = after
  }
  throw new Error('搜索首屏尚未完成加载、稳定或当前查询确认；已停止本题，不能将加载超时记为无入口。')
}

module.exports = { inspectSearchFirstScreen, SEARCH_ENTRY_TIMEOUT_MS }
