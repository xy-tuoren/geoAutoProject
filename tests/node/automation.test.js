const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const sharp = require('sharp')
const XLSX = require('xlsx')
const { questionVisible, replyTailOnScreen, findChatScrollBounds, validateCaptureViewport, estimateVerticalScrollShift, sharedTextSeam, evidencePanelBounds, visibleLabelBounds, visibleLabelBoundsList, boundsListForNodeAttribute, referenceProductsSection } = require('../../src/automation/hierarchy')
const { stackFramesInGroups, verifyFrameOverlap, imageInfo, imageLooksLoaded, imagesSimilar, imageRegionsStable, stitchFramesWithOverlaps, composeLongImages, cropFramesAtTextSeams } = require('../../src/automation/images')
const { createBatchDirectory, findResumableBatch, questionArtifactDirectory } = require('../../src/automation/utils')
const { loadQuestionFile } = require('../../src/questions')
const { adbConnectionLost, appiumHelperApks, explainSessionError, findOptionalElement, buildReplyImages, historyOnboardingVisible, maxLongImageHeight, parsePackageVersion, sessionCapabilities } = require('../../src/automation/runner')

const CHAT_BOUNDS = [0, 200, 1080, 1800]

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

test('新 Android 层级格式可识别引用资料卡和推荐药品入口', () => {
  const xml = '<hierarchy><androidx.compose.ui.viewinterop.ViewFactoryHolder class="androidx.compose.ui.viewinterop.ViewFactoryHolder" displayed="true" bounds="[40,700][1040,980]" /><android.widget.TextView text="推荐药品" displayed="true" bounds="[60,1100][300,1180]" /></hierarchy>'
  assert.deepEqual(evidencePanelBounds(xml, 100), [40, 700, 1040, 980])
  assert.deepEqual(visibleLabelBounds(xml, '推荐药品'), [60, 1100, 300, 1180])
})

test('仅在底部同时可见复制和免责声明时结束回答截图', () => {
  const xml = '<hierarchy><node text="复制" visible-to-user="true" bounds="[800,1550][900,1620]" /><node text="AI生成非医疗诊断仅供参考 不适就医" visible-to-user="true" bounds="[100,1500][900,1540]" /></hierarchy>'
  assert.equal(replyTailOnScreen(xml, CHAT_BOUNDS), true)
})

test('聊天区域会避开底部输入框，并拒绝横屏', () => {
  const xml = '<hierarchy><node scrollable="true" bounds="[0,457][1272,2744]" /><node class="android.widget.EditText" visible-to-user="true" bounds="[189,2523][1064,2689]" /></hierarchy>'
  assert.deepEqual(findChatScrollBounds(xml, { width: 1272, height: 2800 }), [0, 457, 1272, 2317])
  assert.throws(() => validateCaptureViewport({ width: 1600, height: 720 }, [0, 100, 1600, 600]), /竖屏/)
})

test('根据相同文本节点测量真实滚动距离，忽略固定控件', () => {
  const before = '<hierarchy><node text="固定标题" displayed="true" bounds="[0,100][500,160]" /><node text="回答中的同一段文字" displayed="true" bounds="[20,900][1000,1000]" /></hierarchy>'
  const after = '<hierarchy><node text="固定标题" displayed="true" bounds="[0,100][500,160]" /><node text="回答中的同一段文字" displayed="true" bounds="[20,400][1000,500]" /></hierarchy>'
  assert.equal(estimateVerticalScrollShift(before, after, [0, 200, 1080, 1800]), 500)
  assert.deepEqual(sharedTextSeam(before, after, [0, 200, 1080, 1800]), { previousEnd: 700, currentStart: 200 })
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

test('断点续跑只复用题目位置匹配且尚未完成的批次', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'node-resume-test-'))
  try {
    const questions = ['问题一', '问题二']
    const batch = await createBatchDirectory(root, new Date(2026, 6, 12, 10, 0, 0))
    const first = questionArtifactDirectory(batch, 1, questions[0])
    await fs.mkdir(first, { recursive: true })
    const screenshot = path.join(first, '回答_001.png')
    await fs.writeFile(screenshot, 'png')
    await fs.writeFile(path.join(first, '回答.json'), JSON.stringify({
      status: 'stable',
      screenshot_parts: [screenshot],
      reply_capture_mode: 'verified_overlap_long_image',
      reply_continuity_verified: true,
    }))
    assert.deepEqual(await findResumableBatch(root, questions), { batchDirectory: batch, completed: [0] })
    assert.equal(await findResumableBatch(root, ['其他问题']), null)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('断点续跑不会复用旧版文字接缝截图', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'node-resume-quality-test-'))
  try {
    const questions = ['旧坏图', '待执行']
    const batch = await createBatchDirectory(root, new Date(2026, 6, 12, 11, 0, 0))
    const first = questionArtifactDirectory(batch, 1, questions[0])
    await fs.mkdir(first, { recursive: true })
    const screenshot = path.join(first, '回答_001.png')
    await fs.writeFile(screenshot, 'png')
    await fs.writeFile(path.join(first, '回答.json'), JSON.stringify({
      status: 'stable',
      screenshot_parts: [screenshot],
      reply_capture_mode: 'shared_text_seam_long_image',
      reply_text_seams_verified: true,
    }))
    assert.equal(await findResumableBatch(root, questions), null)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('回答截图无法验证相邻重叠时，用分隔线组成长图而不丢像素', async () => {
  const make = color => sharp({ create: { width: 20, height: 10, channels: 3, background: color } }).png().toBuffer()
  const images = await buildReplyImages([await make('red'), await make('green'), await make('blue')], false)
  assert.equal(images.length, 1)
  assert.deepEqual(await imageInfo(images[0]), { width: 20, height: 78 })
})

test('文字接缝参数不再改变已经过像素验证的拼接结果', async () => {
  const frame = await sharp({ create: { width: 20, height: 100, channels: 3, background: 'white' } }).png().toBuffer()
  const images = await buildReplyImages([frame, frame], true, [0], 3000, [{ previousEnd: 70, currentStart: 50 }])
  assert.deepEqual(await imageInfo(images[0]), { width: 20, height: 200 })
})

test('像素连续性失败时绝不使用看似合法的文字接缝', async () => {
  const frame = await sharp({ create: { width: 20, height: 100, channels: 3, background: 'white' } }).png().toBuffer()
  const images = await buildReplyImages([frame, frame], false, [], 3000, [{ previousEnd: 70, currentStart: 50 }])
  assert.deepEqual(await imageInfo(images[0]), { width: 20, height: 224 })
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
