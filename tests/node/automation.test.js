const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const sharp = require('sharp')
const XLSX = require('xlsx')
const { questionVisible, replyTailOnScreen, findChatScrollBounds, validateCaptureViewport, floatingScrollControlBounds, replyCaptureBounds, estimateVerticalScrollShift, sharedTextSeam, evidencePanelBounds, visibleLabelBounds, visibleLabelBoundsList, boundsListForNodeAttribute, referenceProductsSection } = require('../../src/automation/hierarchy')
const { stackFramesInGroups, verifyFrameOverlap, imageInfo, imageLooksLoaded, imagesSimilar, imageRegionsStable, alignCropToWhitespace, stitchFramesWithOverlaps, composeLongImages, cropFramesAtTextSeams } = require('../../src/automation/images')
const { createBatchDirectory, questionArtifactDirectory } = require('../../src/automation/utils')
const { loadQuestionFile } = require('../../src/questions')
const { adbConnectionLost, appiumHelperApks, chatSwipePlan, conservativeFallbackOverlap, explainSessionError, findOptionalElement, buildReplyImages, historyOnboardingVisible, maxLongImageHeight, parsePackageVersion, prepareEmbeddedEvidence, scrollEndConfirmed, sessionCapabilities } = require('../../src/automation/runner')
const { prepareAndroidSdk } = require('../../src/automation/appium-server')

const CHAT_BOUNDS = [0, 200, 1080, 1800]

test('为 Appium 建立标准 Android SDK platform-tools 目录', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'appium-sdk-test-'))
  try {
    const bundledTools = path.join(directory, 'vendor', 'platform-tools', 'win32')
    const appiumHome = path.join(directory, 'vendor', 'appium-home')
    await fs.mkdir(bundledTools, { recursive: true })
    await fs.writeFile(path.join(bundledTools, 'adb.exe'), 'adb')
    await fs.writeFile(path.join(bundledTools, 'AdbWinApi.dll'), 'dll')

    const sdkRoot = prepareAndroidSdk({ appiumHome, adbPath: path.join(bundledTools, 'adb.exe') })

    assert.equal(sdkRoot, path.join(appiumHome, 'android-sdk'))
    assert.equal(await fs.readFile(path.join(sdkRoot, 'platform-tools', 'adb.exe'), 'utf8'), 'adb')
    assert.equal(await fs.readFile(path.join(sdkRoot, 'platform-tools', 'AdbWinApi.dll'), 'utf8'), 'dll')
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('只将聊天区域内且可见的问题视为当前问题', () => {
  const hidden = '<hierarchy><node text="这是一个很长的问题" visible-to-user="false" bounds="[20,300][1060,460]" /></hierarchy>'
  const visible = '<hierarchy><node text="这是一个很长的问题" visible-to-user="true" bounds="[20,300][1060,460]" /></hierarchy>'
  assert.equal(questionVisible(hidden, '这是一个很长的问题', CHAT_BOUNDS), false)
  assert.equal(questionVisible(visible, '这是一个很长的问题', CHAT_BOUNDS), true)
})

test('兼容 class 命名的 UiAutomator 层级节点', () => {
  const xml = '<hierarchy><android.widget.TextView text="新的问题" displayed="true" bounds="[80,900][900,980]" /></hierarchy>'
  assert.equal(questionVisible(xml, '新的问题', [0, 400, 1080, 1800]), true)
})

test('系统 uiautomator dump 未写可见属性时仍按可见节点处理', () => {
  const xml = '<hierarchy><node class="android.widget.TextView" text="系统层级问题" bounds="[80,900][900,980]" /></hierarchy>'
  assert.equal(questionVisible(xml, '系统层级问题', [0, 400, 1080, 1800]), true)
})

test('新 Android 层级格式可识别引用资料卡和推荐药品入口', () => {
  const xml = '<hierarchy><androidx.compose.ui.viewinterop.ViewFactoryHolder class="androidx.compose.ui.viewinterop.ViewFactoryHolder" displayed="true" bounds="[40,700][1040,980]" /><android.widget.TextView text="推荐药品" displayed="true" bounds="[60,1100][300,1180]" /></hierarchy>'
  assert.deepEqual(evidencePanelBounds(xml, 100), [40, 700, 1040, 980])
  assert.deepEqual(visibleLabelBounds(xml, '推荐药品'), [60, 1100, 300, 1180])
})

test('引用资料在回答第一帧前展开，并复用展开后的稳定帧', async () => {
  const collapsed = '<hierarchy><androidx.compose.ui.viewinterop.ViewFactoryHolder class="androidx.compose.ui.viewinterop.ViewFactoryHolder" displayed="true" bounds="[40,700][1040,820]" /></hierarchy>'
  const expanded = '<hierarchy><androidx.compose.ui.viewinterop.ViewFactoryHolder class="androidx.compose.ui.viewinterop.ViewFactoryHolder" displayed="true" bounds="[40,700][1040,1200]" /></hierarchy>'
  const events = []
  const capture = { frame: Buffer.from('expanded-frame'), xml: expanded, stable: true }
  const result = await prepareEmbeddedEvidence({
    source: async () => { events.push('source'); return collapsed },
    tap: async () => { events.push('tap') },
    delay: async () => { events.push('delay') },
    waitForStable: async () => { events.push('stable'); return capture },
    log: () => {},
  }, CHAT_BOUNDS)

  assert.deepEqual(events, ['source', 'tap', 'delay', 'stable'])
  assert.equal(result.found, true)
  assert.equal(result.expanded, true)
  assert.equal(result.capture, capture)
})

test('仅在底部同时可见复制和免责声明时结束回答截图', () => {
  const xml = '<hierarchy><node text="复制" visible-to-user="true" bounds="[800,1550][900,1620]" /><node text="AI生成非医疗诊断仅供参考 不适就医" visible-to-user="true" bounds="[100,1500][900,1540]" /></hierarchy>'
  assert.equal(replyTailOnScreen(xml, CHAT_BOUNDS), true)
})

test('兼容新版回答操作栏和免责声明文案', () => {
  const xml = '<hierarchy>'
    + '<node content-desc="复制回答" displayed="true" bounds="[760,1510][880,1600]" />'
    + '<node text="AI生成内容可能存在不准确，仅供参考，请勿作为诊疗依据，不适请就医" displayed="true" bounds="[80,1430][940,1500]" />'
    + '</hierarchy>'
  assert.equal(replyTailOnScreen(xml, CHAT_BOUNDS), true)
})

test('设备明确到达滚动边界时立即结束，否则两次无进展兜底', () => {
  assert.equal(scrollEndConfirmed(false, 0), true)
  assert.equal(scrollEndConfirmed(null, 1), false)
  assert.equal(scrollEndConfirmed(null, 2), true)
  assert.equal(scrollEndConfirmed(true, 1), false)
})

test('聊天区域会避开底部输入框，并拒绝横屏', () => {
  const xml = '<hierarchy><node scrollable="true" bounds="[0,457][1272,2744]" /><node class="android.widget.EditText" visible-to-user="true" bounds="[189,2523][1064,2689]" /></hierarchy>'
  assert.deepEqual(findChatScrollBounds(xml, { width: 1272, height: 2800 }), [0, 457, 1272, 2317])
  assert.throws(() => validateCaptureViewport({ width: 1600, height: 720 }, [0, 100, 1600, 600]), /竖屏/)
})

test('识别聊天区底部固定的无标签向下按钮', () => {
  const xml = '<hierarchy>'
    + '<node class="android.view.View" clickable="true" text="" content-desc="" displayed="true" bounds="[475,1829][607,1961]" />'
    + '<node class="android.view.View" clickable="true" text="操作" displayed="true" bounds="[430,900][650,1030]" />'
    + '</hierarchy>'
  assert.deepEqual(floatingScrollControlBounds(xml, [0, 333, 1080, 2001]), [475, 1829, 607, 1961])
})

test('滚到顶部后重新计算回答截图范围并排除新出现的向下按钮', () => {
  const xml = '<hierarchy>'
    + '<node class="android.view.View" scrollable="true" displayed="true" bounds="[0,333][1080,2001]" />'
    + '<node class="android.view.View" clickable="true" text="" content-desc="" displayed="true" bounds="[475,1829][607,1961]" />'
    + '</hierarchy>'
  assert.deepEqual(replyCaptureBounds(xml, { width: 1080, height: 2340 }), {
    bounds: [0, 333, 1080, 1816],
    floatingControl: [475, 1829, 607, 1961],
  })
})

test('顶部定位使用更长且更快的滚动，回答采集保持较高重叠', () => {
  const bounds = [0, 333, 1080, 2001]
  const capture = chatSwipePlan(bounds, 0.45, { speed: 1400 })
  const navigation = chatSwipePlan(bounds, 0.65, { speed: 3200 })
  assert.equal(capture.distance, 750)
  assert.equal(navigation.distance, 1084)
  assert.ok(navigation.durationMs < capture.durationMs)
})

test('根据相同文本节点测量真实滚动距离，忽略固定控件', () => {
  const before = '<hierarchy><node text="固定标题" displayed="true" bounds="[0,100][500,160]" /><node text="回答中的同一段文字" displayed="true" bounds="[20,900][1000,1000]" /></hierarchy>'
  const after = '<hierarchy><node text="固定标题" displayed="true" bounds="[0,100][500,160]" /><node text="回答中的同一段文字" displayed="true" bounds="[20,400][1000,500]" /></hierarchy>'
  assert.equal(estimateVerticalScrollShift(before, after, [0, 200, 1080, 1800]), 500)
  assert.deepEqual(sharedTextSeam(before, after, [0, 200, 1080, 1800]), { previousEnd: 700, currentStart: 200 })
})

test('滚动距离估计排除重复文本，并拒绝互相矛盾的节点位移', () => {
  const before = '<hierarchy>'
    + '<node text="重复段落文字" displayed="true" bounds="[20,1200][900,1260]" />'
    + '<node text="重复段落文字" displayed="true" bounds="[20,1500][900,1560]" />'
    + '<node text="唯一段落文字" displayed="true" bounds="[20,900][900,960]" />'
    + '</hierarchy>'
  const after = '<hierarchy>'
    + '<node text="重复段落文字" displayed="true" bounds="[20,300][900,360]" />'
    + '<node text="唯一段落文字" displayed="true" bounds="[20,400][900,460]" />'
    + '</hierarchy>'
  assert.equal(estimateVerticalScrollShift(before, after, [0, 200, 1080, 1800]), 500)

  const inconsistentAfter = '<hierarchy>'
    + '<node text="唯一段落文字" displayed="true" bounds="[20,400][900,460]" />'
    + '<node text="另一个唯一段落" displayed="true" bounds="[20,300][900,360]" />'
    + '</hierarchy>'
  const inconsistentBefore = '<hierarchy>'
    + '<node text="唯一段落文字" displayed="true" bounds="[20,900][900,960]" />'
    + '<node text="另一个唯一段落" displayed="true" bounds="[20,1200][900,1260]" />'
    + '</hierarchy>'
  assert.equal(estimateVerticalScrollShift(inconsistentBefore, inconsistentAfter, [0, 200, 1080, 1800]), null)
})

test('在共享文字顶部切换视口，避免接缝切过文字行', async () => {
  const frame = await sharp({ create: { width: 20, height: 100, channels: 3, background: 'white' } }).png().toBuffer()
  const segments = await cropFramesAtTextSeams([frame, frame], [{ previousEnd: 70, currentStart: 20 }])
  assert.deepEqual(await imageInfo(segments[0]), { width: 20, height: 70 })
  assert.deepEqual(await imageInfo(segments[1]), { width: 20, height: 80 })
})

test('共享文字接缝拒绝同一视口内重复出现的标题', () => {
  const before = '<hierarchy>'
    + '<node text="重复标题" displayed="true" bounds="[20,700][800,760]" />'
    + '<node text="重复标题" displayed="true" bounds="[20,1100][800,1160]" />'
    + '</hierarchy>'
  const after = '<hierarchy><node text="重复标题" displayed="true" bounds="[20,300][800,360]" /></hierarchy>'
  assert.equal(sharedTextSeam(before, after, [0, 200, 1080, 1800]), null)
})

test('拼接参考药品时保留完整视口，并阻止无法验证的跨屏拼接', async () => {
  const make = color => sharp({ create: { width: 20, height: 10, channels: 3, background: color } }).png().toBuffer()
  const chunks = await stackFramesInGroups([await make('red'), await make('green'), await make('blue'), await make('white')], 3)
  assert.equal(chunks.length, 2)
  assert.deepEqual(await imageInfo(chunks[0]), { width: 20, height: 30 })
  const black = await make('black')
  const white = await make('white')
  await assert.rejects(() => verifyFrameOverlap(black, white, 4), /连续性/)
})

test('按已验证的精确重叠高度拼接，不再二次猜测滚动距离', async () => {
  const first = await sharp({ create: { width: 20, height: 20, channels: 3, background: 'red' } }).png().toBuffer()
  const second = await sharp({ create: { width: 20, height: 20, channels: 3, background: 'blue' } }).png().toBuffer()
  const [stitched] = await stitchFramesWithOverlaps([first, second], [6])
  assert.deepEqual(await imageInfo(stitched), { width: 20, height: 34 })
})

test('批次和问题目录保持与旧版一致，CSV 默认读取问题列', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'node-automation-test-'))
  try {
    const batch = await createBatchDirectory(directory, new Date(2026, 6, 11, 23, 59, 0))
    assert.equal(path.basename(batch), 'batch_20260711-235900')
    assert.equal(path.basename(questionArtifactDirectory(batch, 2, '儿童腹泻/脱水用什么药？')), '002_儿童腹泻_脱水用什么药？')
    const csv = path.join(directory, 'questions.csv')
    await fs.writeFile(csv, '问题,分类\n腹泻怎么办,儿科\n腹泻怎么办,儿科\n', 'utf8')
    assert.deepEqual(await loadQuestionFile(csv), ['腹泻怎么办'])
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([{ 问题: '儿童发热怎么办' }, { 问题: '儿童发热怎么办' }]), '问题')
    const xlsx = path.join(directory, 'questions.xlsx')
    XLSX.writeFile(workbook, xlsx)
    assert.deepEqual(await loadQuestionFile(xlsx), ['儿童发热怎么办'])
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('UiAutomator2 服务启动失败会给出设备后台冻结的处理提示', () => {
  const error = explainSessionError(new Error('The instrumentation process cannot be initialized'))
  assert.match(error.message, /后台管理/)
})

test('可选元素使用 findElements 空列表，避免制造 Appium 404', async () => {
  const driver = { $$: async () => [] }
  assert.equal(await findOptionalElement(driver, 'android=new UiSelector().className("android.widget.EditText")'), null)
})

test('逐接缝混合拼接只在失败位置保留少量重复内容和浅色留白', async () => {
  const make = color => sharp({ create: { width: 20, height: 100, channels: 3, background: color } }).png().toBuffer()
  const frames = [await make('red'), await make('green'), await make('blue')]
  const transitions = [
    { verified: true, overlap: 70 },
    { verified: false, fallbackOverlap: 60 },
  ]
  const images = await buildReplyImages(frames, { transitions, maxHeight: 3000 })
  assert.equal(images.length, 1)
  assert.deepEqual(await imageInfo(images[0]), { width: 20, height: 194 })
  const separator = await sharp(images[0]).extract({ left: 0, top: 130, width: 20, height: 24 }).raw().toBuffer()
  assert.ok(separator.every(value => value >= 230))
})

test('失败接缝依据真实滚动距离计算保守重叠，节点不可用时增加安全余量', () => {
  assert.equal(conservativeFallbackOverlap(1000, 400, 450), 528)
  assert.equal(conservativeFallbackOverlap(1483, null, 667, [700, 702]), 581)
  assert.equal(conservativeFallbackOverlap(1483, null, 667, [164, 256]), 0)
  assert.equal(conservativeFallbackOverlap(1000, null, 450), 0)
})

test('失败接缝会把裁切位置移到附近空白行，避免从文字中间切开', async () => {
  const frame = await sharp({ create: { width: 120, height: 120, channels: 3, background: 'white' } })
    .composite([
      { input: await sharp({ create: { width: 100, height: 14, channels: 3, background: 'black' } }).png().toBuffer(), left: 10, top: 42 },
      { input: await sharp({ create: { width: 100, height: 14, channels: 3, background: 'black' } }).png().toBuffer(), left: 10, top: 76 },
    ])
    .png().toBuffer()
  const cut = await alignCropToWhitespace(frame, 50, { searchBefore: 20, searchAfter: 24, minimumBand: 8 })
  assert.ok(cut >= 60 && cut <= 72, `裁切位置 ${cut}px 未落在两行文字之间`)
})

test('局部文字区域变化不会被全屏平均差异掩盖', async () => {
  const first = await sharp({ create: { width: 240, height: 240, channels: 3, background: 'white' } }).png().toBuffer()
  const patch = await sharp({ create: { width: 20, height: 10, channels: 3, background: 'black' } }).png().toBuffer()
  const second = await sharp(first).composite([{ input: patch, left: 24, top: 96 }]).png().toBuffer()
  assert.equal(await imagesSimilar(first, second, 1), true)
  assert.equal(await imageRegionsStable(first, second), false)
})

test('不同内容区域测得不同滚动位移时拒绝拼接', async () => {
  const width = 240
  const height = 300
  const raw = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3
      const value = (y * 37 + x * 17 + ((y * x) % 97)) % 256
      raw[offset] = value
      raw[offset + 1] = (value * 3) % 256
      raw[offset + 2] = (value * 7) % 256
    }
  }
  const previous = await sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer()
  const left = await sharp(previous).extract({ left: 0, top: 80, width: 120, height: 220 }).extend({ bottom: 80, background: 'white' }).png().toBuffer()
  const right = await sharp(previous).extract({ left: 120, top: 100, width: 120, height: 200 }).extend({ bottom: 100, background: 'white' }).png().toBuffer()
  const current = await sharp({ create: { width, height, channels: 3, background: 'white' } })
    .composite([{ input: left, left: 0, top: 0 }, { input: right, left: 120, top: 0 }]).png().toBuffer()
  await assert.rejects(() => verifyFrameOverlap(previous, current, 210), /区域.*不一致|连续性/)
})

test('长截图超过高度上限时只在视口边界拆分', async () => {
  const frame = await sharp({ create: { width: 20, height: 1000, channels: 3, background: 'white' } }).png().toBuffer()
  const images = await composeLongImages([frame, frame, frame, frame], { maxHeight: 3000 })
  assert.equal(images.length, 2)
  for (const image of images) assert.ok((await imageInfo(image)).height <= 3000)
  assert.equal(maxLongImageHeight(undefined), 12000)
  assert.throws(() => maxLongImageHeight(2999), /3000/)
})

test('药品图片检测拒绝纯色占位区并接受有实际图像细节的区域', async () => {
  const blank = await sharp({ create: { width: 80, height: 60, channels: 3, background: '#000' } }).png().toBuffer()
  const detailed = await sharp({ create: { width: 80, height: 60, channels: 3, background: '#fff' } })
    .composite([{ input: await sharp({ create: { width: 36, height: 30, channels: 3, background: '#d22' } }).png().toBuffer(), left: 10, top: 12 }]).png().toBuffer()
  assert.equal(await imageLooksLoaded(blank), false)
  assert.equal(await imageLooksLoaded(detailed), true)
})

test('可枚举当前药品列表内的说明书按钮与图片节点', () => {
  const xml = '<hierarchy>'
    + '<node class="android.widget.ImageView" displayed="true" bounds="[20,100][220,260]" />'
    + '<node class="android.widget.ImageView" displayed="true" bounds="[20,300][220,460]" />'
    + '<node text="查看说明书" displayed="true" bounds="[30,250][200,290]" />'
    + '<node text="查看说明书" displayed="true" bounds="[30,450][200,490]" />'
    + '</hierarchy>'
  assert.equal(boundsListForNodeAttribute(xml, 'class', 'android.widget.ImageView').length, 2)
  assert.equal(visibleLabelBoundsList(xml, '查看说明书').length, 2)
})

test('参考药品卡片虽无文本，也能凭结构（Compose 面板+横向列表）定位入口箭头', () => {
  const xml = '<hierarchy>'
    + '<node class="androidx.compose.ui.viewinterop.ViewFactoryHolder" bounds="[0,673][1080,1714]">'
    + '<node class="android.widget.ImageView" bounds="[942,682][1020,760]" />'
    + '<node class="android.widget.HorizontalScrollView" scrollable="true" bounds="[0,817][1080,1714]">'
    + '<node class="android.view.ViewGroup" bounds="[48,817][504,1714]" />'
    + '</node></node></hierarchy>'
  const section = referenceProductsSection(xml)
  assert.deepEqual(section.panel, [0, 673, 1080, 1714])
  assert.deepEqual(section.tap, [981, 721])
})

test('普通资料卡（Compose 面板但无横向药品列表）不会被误判为参考药品', () => {
  const xml = '<hierarchy>'
    + '<node class="androidx.compose.ui.viewinterop.ViewFactoryHolder" displayed="true" bounds="[40,700][1040,980]">'
    + '<node class="android.widget.TextView" text="引用资料" displayed="true" bounds="[60,720][300,780]" />'
    + '</node></hierarchy>'
  assert.equal(referenceProductsSection(xml), null)
})

test('辅助组件已存在时会话能力会跳过 Settings / UiAutomator2 重装', () => {
  const skip = sessionCapabilities('SERIAL', { skipHelperInstall: true })
  assert.equal(skip['appium:skipServerInstallation'], true)
  assert.equal(skip['appium:skipDeviceInitialization'], true)
  const fresh = sessionCapabilities('SERIAL', { skipHelperInstall: false })
  assert.equal(fresh['appium:skipServerInstallation'], undefined)
  assert.equal(fresh['appium:skipDeviceInitialization'], undefined)
})

test('从 adb 包信息读取 UiAutomator2 的已安装版本', () => {
  assert.equal(parsePackageVersion('Packages:\n  versionName=10.3.2\n  versionCode=214\n'), '10.3.2')
  assert.equal(parsePackageVersion('Package [io.appium.uiautomator2.server]'), null)
})

test('内置辅助 APK 路径随 UiAutomator2 服务版本变化', () => {
  const apks = appiumHelperApks('/runtime/appium-home', '10.3.2')
  assert.equal(apks.length, 3)
  assert.match(apks[1], /appium-uiautomator2-server-v10\.3\.2\.apk$/)
  assert.match(apks[2], /appium-uiautomator2-server-debug-androidTest\.apk$/)
})

test('仅为 ADB 短暂断连启用安装重试', () => {
  assert.equal(adbConnectionLost(new Error('adb: device offline')), true)
  assert.equal(adbConnectionLost(new Error('INSTALL_FAILED_UPDATE_INCOMPATIBLE')), false)
})

test('识别首次启动时遮挡输入框的历史对话引导', () => {
  assert.equal(historyOnboardingVisible('<node text="在这里查看「历史对话」" />'), true)
  assert.equal(historyOnboardingVisible('<node text="输入问题 或 按住说话" />'), false)
})
