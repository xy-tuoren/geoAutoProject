const { sleep } = require('./utils')
const { imageRegionsStable } = require('./images')
const { hierarchyIsLoading } = require('./hierarchy')
const { createSearchObservation } = require('./douyin-search-stability')

// Search loading is independent of the answer-generation timeout. Never scroll
// or resubmit here. Finish one in-flight recognition even if it crosses the budget.
const SEARCH_ENTRY_TIMEOUT_MS = 15_000
class SearchFirstScreenTimeoutError extends Error {
  constructor(inspection) {
    const reasons = {
      query_mismatch: '搜索框未确认当前原题', loading: '页面仍有加载标记', blank: '搜索结果像素仍为空白',
      content_changed: '搜索结果的非媒体区域仍在变化', layout_changed: '搜索结果布局或文字仍在变化',
      insufficient_observations: '剩余预算不足以取得连续校验证据',
    }
    super(`搜索首屏尚未完成加载、稳定或当前查询确认（${reasons[inspection.reason] || inspection.reason}，OCR=${inspection.ocrAttempts}次）；已停止本题，不能将加载超时记为无入口。`)
    this.name = 'SearchFirstScreenTimeoutError'
    this.code = 'SEARCH_FIRST_SCREEN_NOT_READY'
    this.details = this.inspection = inspection
  }
}

async function inspectSearchFirstScreen({
  source, screenshot, hierarchyTarget, recognize, queryMatches = () => true,
  timeout = SEARCH_ENTRY_TIMEOUT_MS, now = Date.now, delay = sleep, log = () => {},
  ignoreDynamicMedia = false, logicalSize = null,
}) {
  const started = now()
  const deadline = started + Math.min(timeout, SEARCH_ENTRY_TIMEOUT_MS)
  let previous = null
  let ocrAttempts = 0
  let dynamicRegionsIgnored = 0
  let reason = 'insufficient_observations'
  const checks = {}
  const inspection = () => ({
    ocrAttempts, elapsedMs: now() - started, dynamicRegionsIgnored,
    stabilityPolicy: dynamicRegionsIgnored ? 'verified_media_mask' : 'full_first_screen',
    reason, checks: { ...checks },
  })
  const report = (state, nextReason) => {
    reason = nextReason
    checks[reason] = (checks[reason] || 0) + 1
    log(`search: 首屏检查 ${JSON.stringify({ state, reason, elapsed_ms: now() - started,
      ocr_attempts: ocrAttempts, dynamic_regions_ignored: dynamicRegionsIgnored })}`)
  }
  const observe = async (frame, xml) => {
    const observation = await createSearchObservation(frame, xml, { ignoreDynamicMedia, logicalSize })
    dynamicRegionsIgnored = Math.max(dynamicRegionsIgnored, observation.dynamicRegionsIgnored)
    return observation
  }
  const sameLayout = (first, second) => first.fingerprint === second.fingerprint
  while (now() < deadline) {
    const xml = await source()
    if (!queryMatches(xml) || hierarchyIsLoading(xml)) {
      report('waiting', !queryMatches(xml) ? 'query_mismatch' : 'loading')
      previous = null
      await delay(350)
      continue
    }
    const direct = hierarchyTarget(xml)
    if (direct) return { ...direct, xml, ...inspection() }
    const frame = await screenshot()
    const current = await observe(frame, xml)
    if (!current.loaded || !previous) {
      report('waiting', current.loaded ? 'insufficient_observations' : 'blank')
      previous = current.loaded ? current : null
      await delay(600)
      continue
    }
    const layoutStable = sameLayout(previous, current)
    const pixelsStable = layoutStable && await imageRegionsStable(previous.content, current.content)
    // A loaded native result list with identical labels/geometry can be read
    // while media plays. A miss still requires stable unmasked pixels below.
    const canReadMovingResults = ignoreDynamicMedia && layoutStable && current.fingerprint && current.layoutReady
    if (!pixelsStable && !canReadMovingResults) {
      report('waiting', layoutStable ? 'content_changed' : 'layout_changed')
      previous = current
      await delay(600)
      continue
    }
    report('ready', pixelsStable ? 'stable_pixels' : 'stable_result_layout')
    ocrAttempts++
    const result = await recognize(frame, xml)
    if (result.target) return { ...result, xml, ...inspection() }
    // Never classify a moving unknown region, a new entry, or a changed
    // result layout as absence. Only explicitly verified media is excluded.
    await delay(800)
    const afterXml = await source()
    if (!queryMatches(afterXml) || hierarchyIsLoading(afterXml)) {
      report('waiting', !queryMatches(afterXml) ? 'query_mismatch' : 'loading')
      previous = null
      if (ocrAttempts >= 2) break
      continue
    }
    const afterDirect = hierarchyTarget(afterXml)
    if (afterDirect) return { ...afterDirect, xml: afterXml, ...inspection() }
    const afterFrame = await screenshot()
    const after = await observe(afterFrame, afterXml)
    if (after.loaded && sameLayout(current, after)
      && await imageRegionsStable(current.content, after.content)) {
      log(`search: 首屏已加载且稳定，无小荷入口（ocr_attempts=${ocrAttempts}，elapsed=${now() - started}ms，scrolls=0）`)
      return { absent: true, xml: afterXml, frame: afterFrame, ...inspection(), stableAbsence: true }
    }
    report('waiting', !after.loaded ? 'blank' : sameLayout(current, after) ? 'content_changed' : 'layout_changed')
    if (ocrAttempts >= 2) break
    previous = after.loaded ? after : null
  }
  report('timeout', reason)
  throw new SearchFirstScreenTimeoutError(inspection())
}

module.exports = { inspectSearchFirstScreen, SEARCH_ENTRY_TIMEOUT_MS, SearchFirstScreenTimeoutError }
