const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { remote } = require('webdriverio')
const { startAppium } = require('./appium-server')
const { sleep, createBatchDirectory, questionArtifactDirectory } = require('./utils')
const { hierarchyIsLoading, parseBounds, boundsCenterY, replyTailOnScreen, questionVisible, findChatScrollBounds, validateCaptureViewport, visibleLabelBounds, boundsForNodeAttribute, evidencePanelBounds, panelIsClipped, evidenceMinimumHeight } = require('./hierarchy')
const { imageInfo, cropImage, imagesSimilar, imageHasVisibleContent, stackFramesInGroups, verifyFrameOverlap, stitchFramesInGroups } = require('./images')

const DEFAULT_PACKAGE = 'com.aurora.xiaohe.aidoctor'

class CancelledError extends Error { constructor() { super('任务已停止。'); this.name = 'CancelledError' } }

async function findOptionalElement(driver, selector) {
  try {
    const element = await driver.$(selector)
    return (await element.isExisting()) ? element : null
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

async function buildReplyImages(frames, continuityVerified) {
  // When lazy-loaded cards reflow, the overlap is no longer reliable. Keep
  // complete viewports in that case: repeated pixels are safer than lost text.
  return continuityVerified ? stitchFramesInGroups(frames) : stackFramesInGroups(frames)
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

  async function tapSend() {
    const send = await elementExists('~发送')
    if (send) { await send.click(); return }
    const edit = await waitForInput()
    const rect = await edit.getRect()
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

  async function swipeChat(bounds, direction) {
    const [left, top, right, bottom] = bounds
    const height = bottom - top
    const x = left + (right - left) * 0.84
    const margin = Math.max(12, Math.floor(height / 5))
    if (direction === 'up') await swipe(x, top + margin, bottom - margin)
    else await swipe(x, bottom - margin, top + margin)
    await sleep(300)
    return Math.max(1, height - 2 * margin)
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
    let noProgress = 0
    // Dynamic cards and lazy-loaded text regularly reflow between swipes on
    // this app. Preserve complete viewports by default so capture is fast and
    // cannot lose content through an incorrect overlap crop.
    let continuityVerified = false
    let frame = await waitForRegionPixelsStable(bounds)
    for (let page = 0; page < maxPages; page += 1) {
      const xml = await source()
      if (!frames.length || !(await imagesSimilar(frames.at(-1), frame, 3))) { frames.push(frame); log(`capture: page ${frames.length}`) }
      if (replyTailOnScreen(xml, bounds) && !hierarchyIsLoading(xml)) { log('capture: reached on-screen reply tail'); break }
      const before = frame
      const shift = await swipeChat(bounds, 'down')
      const after = await waitForRegionPixelsStable(bounds)
      if (await imagesSimilar(before, after, 3)) {
        noProgress += 1
        if (noProgress >= 3) { log('capture: scroll ended'); break }
      } else {
        if (continuityVerified) {
          try {
            await verifyFrameOverlap(before, after, Math.max(12, (await imageInfo(before)).height - shift))
          } catch (error) {
            continuityVerified = false
            log(`capture: 无法校验相邻页面重叠，改为完整视口保存：${error.message}`)
          }
        }
        if (!(await imagesSimilar(frames.at(-1), after, 3))) { frames.push(after); log(`capture: page ${frames.length}`) }
        noProgress = 0
        frame = after
        const afterXml = await source()
        if (replyTailOnScreen(afterXml, bounds) && !hierarchyIsLoading(afterXml)) { log('capture: reached on-screen reply tail after swipe'); break }
      }
    }
    return { frames: frames.length ? frames : [await cropImage(await screenshot(), bounds)], bounds, continuityVerified }
  }

  async function captureScrollingRegion(bounds, maxPages = 60) {
    const frames = [await waitForRegionPixelsStable(bounds)]
    let stalled = 0
    const [left, top, right, bottom] = bounds
    const x = left + (right - left) * 0.32
    const height = bottom - top
    while (frames.length < maxPages) {
      await swipe(x, top + height * 0.75, top + height * 0.25, 800)
      await sleep(200)
      const frame = await waitForRegionPixelsStable(bounds)
      if (await imagesSimilar(frames.at(-1), frame, 3)) {
        stalled += 1
        if (stalled >= 2) break
      } else { stalled = 0; frames.push(frame) }
    }
    return frames
  }

  async function closeReferenceProductsDrawer() {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const sheet = boundsForNodeAttribute(await source(), 'resource-id', `${DEFAULT_PACKAGE}:id/bullet_container`)
      if (!sheet) return
      const [left, top, right, bottom] = sheet
      await tap(right - Math.max(24, Math.floor((right - left) / 16)), top + Math.max(24, Math.floor((bottom - top) / 10)))
      await sleep(600)
      if (!boundsForNodeAttribute(await source(), 'resource-id', `${DEFAULT_PACKAGE}:id/bullet_container`)) return
      await driver.back(); await sleep(600)
    }
  }

  async function captureReferenceProducts(question) {
    const size = await driver.getWindowSize()
    const chatBounds = findChatScrollBounds(await source(), size)
    validateCaptureViewport(size, chatBounds)
    const productLabels = ['参考药品', '推荐药品']
    const findTrigger = async () => {
      const xml = await source()
      for (const label of productLabels) {
        const bounds = visibleLabelBounds(xml, label)
        if (bounds) return bounds
      }
      return null
    }
    let trigger = await findTrigger()
    if (!trigger && !(await scrollQuestionIntoView(question, chatBounds))) return null
    let noProgress = 0
    let previous = await cropImage(await screenshot(), chatBounds)
    for (let index = 0; index < 60 && !trigger; index += 1) {
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
    await tap(chatBounds[2] - Math.max(20, Math.floor((chatBounds[2] - chatBounds[0]) / 15)), boundsCenterY(trigger))
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
      const frames = await captureScrollingRegion(list)
      const chunks = await stackFramesInGroups(frames)
      const headerSize = await imageInfo(header)
      const firstSize = await imageInfo(chunks[0])
      const sharp = require('sharp')
      chunks[0] = await sharp({ create: { width: Math.max(headerSize.width, firstSize.width), height: headerSize.height + firstSize.height, channels: 3, background: '#000' } })
        .composite([{ input: header, left: 0, top: 0 }, { input: chunks[0], left: 0, top: headerSize.height }]).png().toBuffer()
      log(`capture: 推荐药品截图完成，共 ${frames.length} 屏`)
      return { images: chunks, pages: frames.length }
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

  async function saveArtifacts({ outDir, stem, question, status, xml, meta, stitch = true }) {
    await fs.mkdir(outDir, { recursive: true })
    const xmlPath = path.join(outDir, `${stem}.xml`)
    const metadataPath = path.join(outDir, `${stem}.json`)
    let screenshotPath = path.join(outDir, `${stem}.png`)
    let resultMeta = { ...meta }
    if (stitch) {
      const { frames, bounds, continuityVerified } = await captureFullReplyFrames(question)
      const images = await buildReplyImages(frames, continuityVerified)
      const paths = []
      for (const [index, image] of images.entries()) { const file = path.join(outDir, `${stem}_${String(index + 1).padStart(3, '0')}.png`); await fs.writeFile(file, image); paths.push(file) }
      screenshotPath = paths[0]
      resultMeta = {
        ...resultMeta,
        stitched_pages: frames.length,
        screenshot_parts: paths,
        chat_bounds: bounds,
        reply_capture_mode: continuityVerified ? 'verified_overlap_stitch' : 'full_viewport_no_crop',
        reply_continuity_verified: continuityVerified,
      }
      const evidence = await captureEvidence(question)
      if (evidence) { const file = path.join(outDir, `${stem}_资料.png`); await fs.writeFile(file, evidence); resultMeta.evidence_screenshot = file }
      const products = await captureReferenceProducts(question)
      if (products) {
        const paths = []
        for (const [index, image] of products.images.entries()) { const file = path.join(outDir, `${stem}_参考药品_${String(index + 1).padStart(3, '0')}.png`); await fs.writeFile(file, image); paths.push(file) }
        Object.assign(resultMeta, { reference_products_screenshot: paths[0], reference_products_parts: paths, reference_products_pages: products.pages, reference_products_capture_mode: 'full_viewport_no_crop', reference_products_confirmed_end: true })
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
      const batchDirectory = await createBatchDirectory(path.resolve(payload.outputDir))
      try {
        server = await startAppium({ root: options.root, appiumHome: options.appiumHome, adbPath: options.adbPath, log })
        try {
          driver = await remote({ protocol: 'http', hostname: '127.0.0.1', port: server.port, path: '/', logLevel: 'silent', connectionRetryCount: 0, capabilities: {
            platformName: 'Android', 'appium:automationName': 'UiAutomator2', 'appium:udid': payload.serial, 'appium:deviceName': payload.serial,
            'appium:appPackage': DEFAULT_PACKAGE, 'appium:noReset': true, 'appium:newCommandTimeout': 0, 'appium:skipUnlock': true,
            'appium:uiautomator2ServerLaunchTimeout': 90_000, 'appium:uiautomator2ServerInstallTimeout': 90_000,
          } })
        } catch (error) { throw explainSessionError(error) }
        await driver.activateApp(DEFAULT_PACKAGE)
        await waitForInput(15_000)
        log(`device=${payload.serial} package=${DEFAULT_PACKAGE} batch=${batchDirectory}`)
        for (const [zeroIndex, question] of payload.questions.entries()) {
          checkCancelled()
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

module.exports = { createRunner, CancelledError, DEFAULT_PACKAGE, explainSessionError, findOptionalElement, buildReplyImages }
