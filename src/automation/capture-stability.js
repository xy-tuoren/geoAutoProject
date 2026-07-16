const { sleep } = require('./utils')
const { hierarchyIsLoading } = require('./hierarchy')
const { cropImage, imagesSimilar, imageRegionsStable } = require('./images')
const {
  captureStableSandwich,
  captureStableObserved,
  observerRegionFallbackOptions,
  chatSwipePlan,
} = require('./capture-primitives')

const REPLY_STABLE_QUIET_MS = 3_000

function createCaptureStability({
  source,
  screenshot,
  checkCancelled,
  log,
  observer,
  recoverObserver,
  swipe,
  incrementObserverRegionFallbacks,
  incrementObserverActivityRegionChecks,
}) {
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
        incrementObserverRegionFallbacks()
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
          incrementObserverRegionFallbacks()
          regionFallback = observerRegionFallbackOptions(observed)
          const reuse = regionFallback.initialFrame ? '，复用已取得的PNG' : ''
          if (regionFallback.activityObserved) {
            incrementObserverActivityRegionChecks()
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
  

  return {
    normalizedHierarchy,
    waitForStableReplyPixels,
    waitForStableReply,
    waitForFinalVisualQuiet,
    swipeChat,
    waitForRegionPixelsStable,
    waitForStableReplyRegion,
  }
}

module.exports = { createCaptureStability, REPLY_STABLE_QUIET_MS }

