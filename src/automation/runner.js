const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFile } = require('node:child_process')
const { remote } = require('webdriverio')
const { startAppium } = require('./appium-server')
const { sleep, createBatchDirectory, findResumableBatch, questionArtifactDirectory } = require('./utils')
const { hierarchyIsLoading, parseBounds, boundsIntersect, boundsCenterY, estimateVerticalScrollShift, sharedTextSeam, replyTailOnScreen, questionVisible, findChatScrollBounds, validateCaptureViewport, visibleLabelBounds, visibleLabelBoundsList, boundsForNodeAttribute, boundsListForNodeAttribute, evidencePanelBounds, panelIsClipped, evidenceMinimumHeight, referenceProductsSection } = require('./hierarchy')
const { imageInfo, cropImage, imagesSimilar, imageHasVisibleContent, imageLooksLoaded, verifyFrameOverlap, composeLongImages, cropFramesAtTextSeams, textSeamsAreValid } = require('./images')

const DEFAULT_PACKAGE = 'com.aurora.xiaohe.aidoctor'
const APPIUM_HELPER_PACKAGES = [
  'io.appium.settings',
  'io.appium.uiautomator2.server',
  'io.appium.uiautomator2.server.test',
]
const DEFAULT_MAX_LONG_IMAGE_HEIGHT = 12_000

function maxLongImageHeight(value) {
  const parsed = Number(value ?? DEFAULT_MAX_LONG_IMAGE_HEIGHT)
  if (!Number.isInteger(parsed) || parsed < 3_000 || parsed > 30_000) throw new Error('长截图最大高度必须是 3000–30000 之间的整数。')
  return parsed
}

function adbPackages(adbPath, serial) {
  return new Promise((resolve, reject) => {
    execFile(adbPath, ['-s', serial, 'shell', 'pm', 'list', 'packages'], { encoding: 'utf8' }, (error, stdout) => {
      if (error) reject(error)
      else resolve(String(stdout))
    })
  })
}

function adbPackageVersion(adbPath, serial, packageName) {
  return new Promise((resolve, reject) => {
    execFile(adbPath, ['-s', serial, 'shell', 'dumpsys', 'package', packageName], { encoding: 'utf8' }, (error, stdout) => {
      if (error) reject(error)
      else resolve(parsePackageVersion(stdout))
    })
  })
}

function parsePackageVersion(output) {
  return String(output).match(/^\s*versionName=(.+?)\s*$/m)?.[1] || null
}

function historyOnboardingVisible(xml) {
  return /在这里查看[「"]?历史对话/.test(String(xml))
}

function bundledUiAutomator2ServerVersion(appiumHome) {
  try {
    return require(path.join(appiumHome, 'node_modules', 'appium-uiautomator2-driver', 'node_modules', 'appium-uiautomator2-server', 'package.json')).version
  } catch {
    return null
  }
}

function appiumHelperApks(appiumHome, serverVersion = bundledUiAutomator2ServerVersion(appiumHome)) {
  const driverModules = path.join(appiumHome, 'node_modules', 'appium-uiautomator2-driver', 'node_modules')
  return [
    path.join(driverModules, 'io.appium.settings', 'apks', 'settings_apk-debug.apk'),
    path.join(driverModules, 'appium-uiautomator2-server', 'apks', `appium-uiautomator2-server-v${serverVersion}.apk`),
    path.join(driverModules, 'appium-uiautomator2-server', 'apks', 'appium-uiautomator2-server-debug-androidTest.apk'),
  ]
}

function adbCommand(adbPath, serial, args) {
  return new Promise((resolve, reject) => {
    execFile(adbPath, ['-s', serial, ...args], { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${error.message}: ${String(stderr || stdout).trim()}`))
      else resolve(String(stdout))
    })
  })
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

async function installAppiumHelpers(adbPath, serial, appiumHome) {
  const apks = appiumHelperApks(appiumHome)
  const missing = apks.find(apk => !require('node:fs').existsSync(apk))
  if (missing) throw new Error(`内置 Appium 辅助 APK 缺失：${missing}`)
  // An old instrumentation process keeps serving its old HTTP API after the
  // APK is upgraded. Stop it before Appium allocates its system port.
  await adbCommandWithReconnect(adbPath, serial, ['shell', 'am', 'force-stop', 'io.appium.uiautomator2.server'])
  for (const apk of apks) await adbCommandWithReconnect(adbPath, serial, ['install', '-r', '-g', '-t', apk])
}

async function appiumHelpersAlreadyInstalled(adbPath, serial, expectedServerVersion) {
  const check = async () => {
    const packages = await adbPackages(adbPath, serial)
    if (!APPIUM_HELPER_PACKAGES.every(name => packages.includes(`package:${name}`))) return false
    // Package presence alone is not enough: an old UiAutomator2 server accepts
    // the connection but returns 404 for newer Appium commands.
    if (!expectedServerVersion) return false
    return (await adbPackageVersion(adbPath, serial, 'io.appium.uiautomator2.server')) === expectedServerVersion
  }
  try {
    return await check()
  } catch (error) {
    // Huawei's composite USB mode can briefly re-enumerate ADB. Verify again
    // after it returns instead of treating that transient as a version mismatch.
    if (!adbConnectionLost(error)) return false
    try {
      await waitForAdbDevice(adbPath, serial)
      return await check()
    } catch {}
    return false
  }
}

function sessionCapabilities(serial, { skipHelperInstall = false } = {}) {
  return {
    platformName: 'Android',
    'appium:automationName': 'UiAutomator2',
    'appium:udid': serial,
    'appium:deviceName': serial,
    'appium:appPackage': DEFAULT_PACKAGE,
    'appium:noReset': true,
    'appium:newCommandTimeout': 0,
    'appium:skipUnlock': true,
    'appium:uiautomator2ServerLaunchTimeout': 180_000,
    'appium:uiautomator2ServerInstallTimeout': 180_000,
    // Avoid reinstalling Appium Settings / UiAutomator2 every run when already present.
    ...(skipHelperInstall ? {
      'appium:skipServerInstallation': true,
      'appium:skipDeviceInitialization': true,
    } : {}),
  }
}

class CancelledError extends Error { constructor() { super('任务已停止。'); this.name = 'CancelledError' } }

async function findOptionalElement(driver, selector) {
  try {
    // findElements returns an empty list for an optional miss. findElement
    // returns HTTP 404, which is expected but floods Appium logs and allocates
    // an exception on every poll.
    const elements = await driver.$$(selector)
    return elements.length ? elements[0] : null
  } catch (error) {
    // Appium responds with HTTP 404 for a normal “not on screen yet” lookup.
    // WebdriverIO surfaces that response as an exception before isExisting()
    // can return false, so it must be treated as a retryable condition.
    if (/no such element|element could not be located/i.test(String(error?.message || error))) return null
    throw error
  }
}

function explainSessionError(error) {
  const message = String(error?.message || error)
  if (/uiautomator2|instrumentation|server.*(?:start|launch)|cannot be initialized/i.test(message)) {
    return new Error(`UiAutomator2 服务未能在手机上启动。请在手机的“电池/后台管理”中允许提问自动化的辅助服务后台运行；部分 OnePlus / OPPO 系统会冻结该服务。原始错误：${message}`)
  }
  return error
}

async function buildReplyImages(frames, continuityVerified, overlaps = [], maxHeight = DEFAULT_MAX_LONG_IMAGE_HEIGHT, textSeams = []) {
  // Prefer semantic seams at complete text-node boundaries. Pixel overlap is
  // the second choice: it proves visual continuity but does not understand
  // whether a cut crosses a glyph or line of text.
  if (await textSeamsAreValid(frames, textSeams)) {
    try {
      const segments = await cropFramesAtTextSeams(frames, textSeams)
      return composeLongImages(segments, { maxHeight, separatorHeight: 0 })
    } catch {
      // A dynamic reflow can make two individually valid seams cross inside a
      // middle frame. Preserve full viewports instead of failing the task.
    }
  }
  if (continuityVerified) return composeLongImages(frames, { overlaps, continuityVerified, maxHeight })
  // Unverified frames keep all pixels and use visible separators, so the
  // result never pretends a dynamic reflow was a seamless overlap.
  return composeLongImages(frames, { maxHeight })
}

function createRunner(options) {
  let cancelled = false
  let driver = null
  let server = null
  const checkCancelled = () => { if (cancelled) throw new CancelledError() }
  const log = text => options.log(`${text}${String(text).endsWith('\n') ? '' : '\n'}`)

  async function screenshot() {
    checkCancelled()
    return Buffer.from(await driver.takeScreenshot(), 'base64')
  }

  async function source() {
    checkCancelled()
    return driver.getPageSource()
  }

  async function tap(x, y) {
    checkCancelled()
    await driver.performActions([{ type: 'pointer', id: 'finger-1', parameters: { pointerType: 'touch' }, actions: [
      { type: 'pointerMove', duration: 0, x: Math.round(x), y: Math.round(y) }, { type: 'pointerDown', button: 0 }, { type: 'pause', duration: 80 }, { type: 'pointerUp', button: 0 },
    ] }])
    await driver.releaseActions()
  }

  async function swipe(x, fromY, toY, duration = 250) {
    checkCancelled()
    await driver.performActions([{ type: 'pointer', id: 'finger-1', parameters: { pointerType: 'touch' }, actions: [
      { type: 'pointerMove', duration: 0, x: Math.round(x), y: Math.round(fromY) }, { type: 'pointerDown', button: 0 },
      { type: 'pointerMove', duration, x: Math.round(x), y: Math.round(toY) }, { type: 'pointerUp', button: 0 },
    ] }])
    await driver.releaseActions()
  }

  async function elementExists(selector) {
    return findOptionalElement(driver, selector)
  }

  async function waitForInput(timeout = 10_000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      checkCancelled()
      if (historyOnboardingVisible(await source())) {
        const size = await driver.getWindowSize()
        // The first-launch history hint is a full-screen Compose overlay. Tap
        // a neutral blank area to dismiss it before looking up the input.
        await tap(Math.floor(size.width * 0.8), Math.floor(size.height * 0.22))
        log('已关闭“历史对话”首次引导')
        await sleep(500)
        continue
      }
      const edit = await elementExists('android=new UiSelector().className("android.widget.EditText")')
      if (edit) return edit
      const hint = await elementExists('android=new UiSelector().textContains("输入问题")')
      if (hint) { await hint.click(); await sleep(500) }
      await sleep(500)
    }
    throw new Error('未能在小荷聊天页面找到输入框。')
  }

  async function inputQuestion(question) {
    let lastError = null
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const edit = await waitForInput()
        await edit.click()
        await sleep(500 + attempt * 400)
        await edit.clearValue()
        await edit.setValue(question)
        await sleep(800)
        return
      } catch (error) {
        lastError = error
        await sleep(800)
      }
    }
    throw new Error(`问题输入失败：${lastError?.message || '未知错误'}`)
  }

  async function elementRect(element) {
    // WebdriverIO element instances do not expose getRect() across all versions;
    // fall back to the WebDriver protocol command keyed by element id.
    if (typeof element.getRect === 'function') return element.getRect()
    return driver.getElementRect(element.elementId)
  }

  async function tapSend() {
    const send = await elementExists('~发送')
    if (send) { await send.click(); return }
    const edit = await waitForInput()
    const rect = await elementRect(edit)
    const window = await driver.getWindowSize()
    const x = Math.min(window.width - Math.floor(rect.height / 2), Math.floor(rect.x + rect.width + rect.height / 2))
    await tap(x, Math.floor(rect.y + rect.height * 2 / 3))
  }

  async function tapNewSession() {
    const newSession = await elementExists('android=new UiSelector().description("开启新会话")')
    if (!newSession) return false
    await newSession.click()
    await sleep(1_000)
    for (const text of ['确定', '确认', '开始', '新会话']) {
      const button = await elementExists(`android=new UiSelector().text("${text}")`)
      if (button) { await button.click(); await sleep(1_000); break }
    }
    return true
  }

  async function normalizedHierarchy() {
    return (await source()).replace(/focused="(?:true|false)"/g, 'focused=""').replace(/selected="(?:true|false)"/g, 'selected=""')
  }

  async function waitForStableReply(timeout) {
    const minWait = 12_000
    const stableMilliseconds = 5_000
    const pollInterval = 1_500
    const start = Date.now()
    let lastDigest = ''
    let lastChange = start
    let lastXml = ''
    let lastProgress = 0
    while (Date.now() - start < timeout) {
      checkCancelled()
      try {
        const xml = await normalizedHierarchy()
        const digest = crypto.createHash('sha256').update(xml).digest('hex')
        const now = Date.now()
        const loading = hierarchyIsLoading(xml)
        if (loading && now - lastProgress >= 5_000) { log('waiting: reply still generating…'); lastProgress = now }
        if (digest !== lastDigest) { lastDigest = digest; lastChange = now; lastXml = xml }
        else if (!loading && now - start >= minWait && now - lastChange >= stableMilliseconds) return { status: 'stable', xml }
        else if (loading) lastChange = now
      } catch { /* transient hierarchy failure; retry */ }
      await sleep(pollInterval)
    }
    return { status: hierarchyIsLoading(lastXml) ? 'loading_timeout' : 'timeout', xml: lastXml }
  }

  async function swipeChat(bounds, direction, fraction = 0.6) {
    const [left, top, right, bottom] = bounds
    const height = bottom - top
    const x = left + (right - left) * 0.84
    const distance = Math.max(80, Math.floor(height * Math.min(0.7, Math.max(0.2, fraction))))
    const center = Math.floor((top + bottom) / 2)
    if (direction === 'up') await swipe(x, center - Math.floor(distance / 2), center + Math.ceil(distance / 2), 650)
    else await swipe(x, center + Math.ceil(distance / 2), center - Math.floor(distance / 2), 650)
    await sleep(300)
    return distance
  }

  async function waitForRegionPixelsStable(bounds, timeout = 8_000) {
    let frame = await cropImage(await screenshot(), bounds)
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      await sleep(300)
      const next = await cropImage(await screenshot(), bounds)
      if (await imagesSimilar(frame, next, 1)) return next
      frame = next
    }
    return frame
  }

  async function scrollQuestionIntoView(question, bounds, maxSwipes = 25) {
    for (let index = 0; index < maxSwipes; index += 1) {
      if (questionVisible(await source(), question, bounds)) return true
      await swipeChat(bounds, 'up')
    }
    return questionVisible(await source(), question, bounds)
  }

  async function captureFullReplyFrames(question, maxPages = 30) {
    const size = await driver.getWindowSize()
    const bounds = findChatScrollBounds(await source(), size)
    validateCaptureViewport(size, bounds)
    log(`capture: chat bounds=${bounds.join(',')}`)
    if (!(await scrollQuestionIntoView(question, bounds))) log('capture: question not found while scrolling up; capturing from current position')
    const frames = []
    const overlaps = []
    const textSeams = []
    let noProgress = 0
    let continuityVerified = true
    let frame = await waitForRegionPixelsStable(bounds)
    for (let page = 0; page < maxPages; page += 1) {
      const xml = await source()
      if (!frames.length || !(await imagesSimilar(frames.at(-1), frame, 3))) { frames.push(frame); log(`capture: page ${frames.length}`) }
      if (replyTailOnScreen(xml, bounds) && !hierarchyIsLoading(xml)) { log('capture: reached on-screen reply tail'); break }
      const before = frame
      const shift = await swipeChat(bounds, 'down', 0.25)
      let after = await waitForRegionPixelsStable(bounds)
      if (await imagesSimilar(before, after, 3)) {
        noProgress += 1
        if (noProgress >= 3) { log('capture: scroll ended'); break }
      } else {
        const afterXml = await source()
        const measuredShift = estimateVerticalScrollShift(xml, afterXml, bounds)
        const seam = sharedTextSeam(xml, afterXml, bounds)
        if (seam) textSeams.push(seam)
        const expectedOverlap = Math.max(12, (await imageInfo(before)).height - (measuredShift || shift))
        if (continuityVerified) {
          let verifiedOverlap = null
          try {
            verifiedOverlap = await verifyFrameOverlap(before, after, expectedOverlap)
          } catch (error) {
            // Lazy cards may reflow once after a swipe. Let them settle and
            // retry the same seam before degrading to separate screen files.
            await sleep(900)
            after = await waitForRegionPixelsStable(bounds, 3_000)
            try {
              verifiedOverlap = await verifyFrameOverlap(before, after, expectedOverlap)
            } catch {
              continuityVerified = false
              log(`capture: 无法校验相邻页面重叠，改为分屏保存：${error.message}`)
            }
          }
          if (verifiedOverlap !== null) overlaps.push(verifiedOverlap)
        }
        if (!(await imagesSimilar(frames.at(-1), after, 3))) { frames.push(after); log(`capture: page ${frames.length}`) }
        noProgress = 0
        frame = after
        if (replyTailOnScreen(afterXml, bounds) && !hierarchyIsLoading(afterXml)) { log('capture: reached on-screen reply tail after swipe'); break }
      }
    }
    return { frames: frames.length ? frames : [await cropImage(await screenshot(), bounds)], overlaps, textSeams, bounds, continuityVerified }
  }

  async function waitForProductImagesReady(listBounds, timeout = 12_000) {
    const deadline = Date.now() + timeout
    let consecutiveReady = 0
    let best = { ready: false, cards: 0, images: 0, loaded: 0, unloaded: 0 }
    while (Date.now() < deadline) {
      checkCancelled()
      const xml = await source()
      const cards = visibleLabelBoundsList(xml, '查看说明书').filter(bounds => boundsIntersect(bounds, listBounds))
      const imageBounds = boundsListForNodeAttribute(xml, 'class', 'android.widget.ImageView').filter(bounds => {
        const width = bounds[2] - bounds[0]
        const height = bounds[3] - bounds[1]
        return boundsIntersect(bounds, listBounds) && width >= 60 && height >= 45
      })
      const screen = await screenshot()
      const loadedFlags = await Promise.all(imageBounds.map(async bounds => imageLooksLoaded(await cropImage(screen, bounds))))
      const loaded = loadedFlags.filter(Boolean).length
      const expected = Math.max(1, cards.length)
      const ready = imageBounds.length >= expected && loaded === imageBounds.length
      best = { ready, cards: cards.length, images: imageBounds.length, loaded, unloaded: Math.max(expected - loaded, imageBounds.length - loaded, 0) }
      consecutiveReady = ready ? consecutiveReady + 1 : 0
      if (consecutiveReady >= 2) return best
      await sleep(600)
    }
    return best
  }

  async function captureScrollingRegion(bounds, maxPages = 12) {
    const readiness = []
    readiness.push(await waitForProductImagesReady(bounds))
    const frames = [await waitForRegionPixelsStable(bounds, 2_000)]
    let stalled = 0
    let confirmedEnd = false
    let continuityVerified = true
    const overlaps = []
    const [left, top, right, bottom] = bounds
    const x = left + (right - left) * 0.32
    const height = bottom - top
    while (frames.length < maxPages) {
      await swipe(x, top + height * 0.75, top + height * 0.25, 800)
      await sleep(200)
      readiness.push(await waitForProductImagesReady(bounds))
      const frame = await waitForRegionPixelsStable(bounds, 2_000)
      if (await imagesSimilar(frames.at(-1), frame, 3)) {
        stalled += 1
        if (stalled >= 2) { confirmedEnd = true; break }
      } else {
        stalled = 0
        if (continuityVerified) {
          try { overlaps.push(await verifyFrameOverlap(frames.at(-1), frame, Math.max(12, Math.floor(height / 2)))) }
          catch { continuityVerified = false }
        }
        frames.push(frame)
      }
    }
    return { frames, overlaps, readiness, confirmedEnd, continuityVerified }
  }

  async function closeReferenceProductsDrawer() {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const sheet = boundsForNodeAttribute(await source(), 'resource-id', `${DEFAULT_PACKAGE}:id/bullet_container`)
      if (!sheet) return
      const [left, top, right, bottom] = sheet
      await tap(right - Math.max(24, Math.floor((right - left) / 16)), top + Math.max(24, Math.floor((bottom - top) / 10)))
      await sleep(600)
      if (!boundsForNodeAttribute(await source(), 'resource-id', `${DEFAULT_PACKAGE}:id/bullet_container`)) return
      await driver.back()
      await sleep(600)
    }
  }

  async function captureReferenceProducts(question) {
    const size = await driver.getWindowSize()
    const chatBounds = findChatScrollBounds(await source(), size)
    validateCaptureViewport(size, chatBounds)
    const productLabels = ['参考药品', '推荐药品']
    const findTrigger = async () => {
      const xml = await source()
      // Compose renders the section label off the accessibility tree, so detect
      // the card carousel structurally first and fall back to text if present.
      const section = referenceProductsSection(xml)
      if (section) return section.tap
      for (const label of productLabels) {
        const bounds = visibleLabelBounds(xml, label)
        if (bounds) return [chatBounds[2] - Math.max(20, Math.floor((chatBounds[2] - chatBounds[0]) / 15)), boundsCenterY(bounds)]
      }
      return null
    }
    let trigger = await findTrigger()
    if (!trigger && !(await scrollQuestionIntoView(question, chatBounds))) return null
    let noProgress = 0
    let previous = await cropImage(await screenshot(), chatBounds)
    for (let index = 0; index < 12 && !trigger; index += 1) {
      trigger = await findTrigger()
      if (trigger) break
      await swipeChat(chatBounds, 'down')
      const next = await cropImage(await screenshot(), chatBounds)
      noProgress = (await imagesSimilar(previous, next, 3)) ? noProgress + 1 : 0
      if (noProgress >= 3) break
      previous = next
    }
    if (!trigger) { log('capture: 本回答未出现参考/推荐药品卡片'); return null }
    log('capture: 已发现推荐药品入口，正在展开并截图')
    await tap(trigger[0], trigger[1])
    await sleep(800)
    try {
      const xml = await source()
      const list = boundsForNodeAttribute(xml, 'class', 'androidx.recyclerview.widget.RecyclerView')
      const sheet = boundsForNodeAttribute(xml, 'resource-id', `${DEFAULT_PACKAGE}:id/bullet_container`)
      if (!list || !sheet || list[3] - list[1] < 100) {
        log('capture: 推荐药品入口已点击，但未识别到药品列表抽屉')
        return null
      }
      const header = await cropImage(await screenshot(), [sheet[0], sheet[1], sheet[2], list[1]])
      const capture = await captureScrollingRegion(list)
      const headerSize = await imageInfo(header)
      const chunks = await composeLongImages(capture.frames, {
        overlaps: capture.overlaps,
        continuityVerified: capture.continuityVerified,
        maxHeight: Math.max(1_000, maxLongImageHeight(payloadMaxLongImageHeight) - headerSize.height),
      })
      const firstSize = await imageInfo(chunks[0])
      const sharp = require('sharp')
      chunks[0] = await sharp({ create: { width: Math.max(headerSize.width, firstSize.width), height: headerSize.height + firstSize.height, channels: 3, background: '#000' } })
        .composite([{ input: header, left: 0, top: 0 }, { input: chunks[0], left: 0, top: headerSize.height }]).png().toBuffer()
      const unloaded = capture.readiness.reduce((sum, item) => sum + item.unloaded, 0)
      const imagesReady = capture.readiness.every(item => item.ready)
      log(`capture: 推荐药品截图完成，共 ${capture.frames.length} 屏，图片${imagesReady ? '已全部加载' : `仍有 ${unloaded} 处未确认加载`}`)
      return { images: chunks, pages: capture.frames.length, imagesReady, unloaded, confirmedEnd: capture.confirmedEnd, continuityVerified: capture.continuityVerified }
    } finally { await closeReferenceProductsDrawer() }
  }

  async function captureEvidence(question) {
    const size = await driver.getWindowSize()
    const chatBounds = findChatScrollBounds(await source(), size)
    validateCaptureViewport(size, chatBounds)
    if (!(await scrollQuestionIntoView(question, chatBounds))) { log('capture: 未定位当前问题，跳过引用资料卡片'); return null }
    const minimum = evidenceMinimumHeight(chatBounds)
    let panel = evidencePanelBounds(await source(), minimum)
    if (!panel) { log('capture: 本回答未出现可展开的引用资料卡片'); return null }
    log('capture: 已发现引用资料卡片，正在展开并截图')
    const tolerance = Math.max(2, Math.floor((chatBounds[3] - chatBounds[1]) * 0.006))
    for (let attempt = 0; attempt < 3 && panelIsClipped(panel, chatBounds, tolerance); attempt += 1) {
      await swipeChat(chatBounds, panel[3] >= chatBounds[3] - tolerance ? 'down' : 'up')
      panel = evidencePanelBounds(await source(), minimum) || panel
    }
    if (panel[3] - panel[1] <= (chatBounds[3] - chatBounds[1]) * 0.16) {
      await tap((panel[0] + panel[2]) / 2, (panel[1] + panel[3]) / 2)
      await sleep(800)
      panel = evidencePanelBounds(await source(), minimum) || panel
    }
    const padding = 18
    const image = await cropImage(await screenshot(), [panel[0] - padding, panel[1] - padding, panel[2] + padding, panel[3] + padding])
    if (!(await imageHasVisibleContent(image))) { log('capture: 引用资料卡片截图为空，已跳过'); return null }
    log('capture: 引用资料截图完成')
    return image
  }

  let payloadMaxLongImageHeight = DEFAULT_MAX_LONG_IMAGE_HEIGHT

  async function saveArtifacts({ outDir, stem, question, status, xml, meta, stitch = true }) {
    await fs.mkdir(outDir, { recursive: true })
    const xmlPath = path.join(outDir, `${stem}.xml`)
    const metadataPath = path.join(outDir, `${stem}.json`)
    let screenshotPath = path.join(outDir, `${stem}.png`)
    let resultMeta = { ...meta }
    if (stitch) {
      const { frames, overlaps, textSeams, bounds, continuityVerified } = await captureFullReplyFrames(question)
      const textSeamsVerified = await textSeamsAreValid(frames, textSeams)
      const images = await buildReplyImages(frames, continuityVerified, overlaps, payloadMaxLongImageHeight, textSeams)
      const paths = []
      for (const [index, image] of images.entries()) { const file = path.join(outDir, `${stem}_${String(index + 1).padStart(3, '0')}.png`); await fs.writeFile(file, image); paths.push(file) }
      screenshotPath = paths[0]
      resultMeta = {
        ...resultMeta,
        stitched_pages: frames.length,
        screenshot_parts: paths,
        chat_bounds: bounds,
        reply_capture_mode: textSeamsVerified ? 'shared_text_seam_long_image' : (continuityVerified ? 'verified_overlap_long_image' : 'separated_viewports_long_image'),
        reply_continuity_verified: continuityVerified,
        reply_text_seams_verified: textSeamsVerified,
        long_image_max_height: payloadMaxLongImageHeight,
      }
      const evidence = await captureEvidence(question)
      if (evidence) { const file = path.join(outDir, `${stem}_资料.png`); await fs.writeFile(file, evidence); resultMeta.evidence_screenshot = file }
      const products = await captureReferenceProducts(question)
      if (products) {
        const paths = []
        for (const [index, image] of products.images.entries()) { const file = path.join(outDir, `${stem}_参考药品_${String(index + 1).padStart(3, '0')}.png`); await fs.writeFile(file, image); paths.push(file) }
        Object.assign(resultMeta, {
          reference_products_screenshot: paths[0],
          reference_products_parts: paths,
          reference_products_pages: products.pages,
          reference_products_capture_mode: products.continuityVerified ? 'verified_overlap_stitch' : 'separate_viewports',
          reference_products_continuity_verified: products.continuityVerified,
          reference_products_images_ready: products.imagesReady,
          reference_products_unloaded_images: products.unloaded,
          reference_products_confirmed_end: products.confirmedEnd,
          reference_products_capture_complete: products.imagesReady && products.confirmedEnd,
        })
      }
    } else await fs.writeFile(screenshotPath, await screenshot())
    await fs.writeFile(xmlPath, xml || await normalizedHierarchy(), 'utf8')
    await fs.writeFile(metadataPath, JSON.stringify({ question, status, created_at: new Date().toISOString().replace(/\.\d{3}Z$/, ''), screenshot: screenshotPath, hierarchy: xmlPath, ...resultMeta }, null, 2), 'utf8')
    return { screenshot: screenshotPath, hierarchy: xmlPath, metadata: metadataPath }
  }

  async function askOnce(payload, batchDirectory, question, index) {
    if (payload.newSession) await tapNewSession()
    await inputQuestion(question)
    const directory = questionArtifactDirectory(batchDirectory, index, question)
    const meta = { serial: payload.serial, batch_id: path.basename(batchDirectory), question_index: index, question_directory: directory }
    await tapSend()
    await sleep(2_000)
    const result = await waitForStableReply(payload.timeout * 1_000)
    return saveArtifacts({ outDir: directory, stem: '回答', question, status: result.status, xml: result.xml, meta })
  }

  return {
    async run(payload) {
      payloadMaxLongImageHeight = maxLongImageHeight(payload.maxLongImageHeight)
      const outputRoot = path.resolve(payload.outputDir)
      const resumable = payload.resume === true ? await findResumableBatch(outputRoot, payload.questions) : null
      const batchDirectory = resumable?.batchDirectory || await createBatchDirectory(outputRoot)
      const completed = new Set(resumable?.completed || [])
      if (resumable) log(`断点续跑：复用 ${batchDirectory}，跳过 ${completed.size} 个已完成问题`)
      try {
        server = await startAppium({ root: options.root, appiumHome: options.appiumHome, adbPath: options.adbPath, log })
        const expectedServerVersion = bundledUiAutomator2ServerVersion(options.appiumHome)
        let helpersReady = await appiumHelpersAlreadyInstalled(options.adbPath, payload.serial, expectedServerVersion)
        if (helpersReady) log(`Appium 辅助组件版本匹配（UiAutomator2 ${expectedServerVersion}），跳过重装`)
        else {
          log(`Appium 辅助组件缺失或版本不匹配，正在安装内置 UiAutomator2${expectedServerVersion ? ` ${expectedServerVersion}` : ''}`)
          await installAppiumHelpers(options.adbPath, payload.serial, options.appiumHome)
          helpersReady = await appiumHelpersAlreadyInstalled(options.adbPath, payload.serial, expectedServerVersion)
          if (!helpersReady) throw new Error('内置 UiAutomator2 安装后版本校验失败。请确认手机已授权 USB 调试。')
          log(`Appium 辅助组件已更新为 UiAutomator2 ${expectedServerVersion}`)
        }
        try {
          driver = await remote({
            protocol: 'http', hostname: '127.0.0.1', port: server.port, path: '/',
            logLevel: 'silent', connectionRetryCount: 0,
            capabilities: sessionCapabilities(payload.serial, { skipHelperInstall: helpersReady }),
          })
        } catch (error) {
          if (helpersReady) {
            log('会话启动失败，重新安装内置辅助组件后重试一次…')
            try {
              await installAppiumHelpers(options.adbPath, payload.serial, options.appiumHome)
              driver = await remote({
                protocol: 'http', hostname: '127.0.0.1', port: server.port, path: '/',
                logLevel: 'silent', connectionRetryCount: 0,
                capabilities: sessionCapabilities(payload.serial, { skipHelperInstall: true }),
              })
            } catch (retryError) { throw explainSessionError(retryError) }
          } else {
            throw explainSessionError(error)
          }
        }
        await driver.activateApp(DEFAULT_PACKAGE)
        await waitForInput(15_000)
        log(`device=${payload.serial} package=${DEFAULT_PACKAGE} batch=${batchDirectory}`)
        for (const [zeroIndex, question] of payload.questions.entries()) {
          checkCancelled()
          if (completed.has(zeroIndex)) { log(`[${zeroIndex + 1}/${payload.questions.length}] skipped: ${question}`); continue }
          log(`[${zeroIndex + 1}/${payload.questions.length}] asking: ${question}`)
          log(JSON.stringify(await askOnce(payload, batchDirectory, question, zeroIndex + 1)))
        }
      } finally {
        if (driver) { await driver.deleteSession().catch(() => {}); driver = null }
        if (server) { await server.stop(); server = null }
      }
    },
    async stop() {
      cancelled = true
      if (driver) await driver.deleteSession().catch(() => {})
      if (server) await server.stop().catch(() => {})
    },
  }
}

module.exports = {
  createRunner,
  CancelledError,
  DEFAULT_PACKAGE,
  explainSessionError,
  findOptionalElement,
  buildReplyImages,
  appiumHelpersAlreadyInstalled,
  adbPackageVersion,
  adbConnectionLost,
  appiumHelperApks,
  bundledUiAutomator2ServerVersion,
  historyOnboardingVisible,
  maxLongImageHeight,
  installAppiumHelpers,
  parsePackageVersion,
  sessionCapabilities,
}
