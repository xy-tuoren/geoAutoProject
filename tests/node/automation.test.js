const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const sharp = require('sharp')
const XLSX = require('xlsx')
const { questionVisible, replyTailOnScreen, findChatScrollBounds, validateCaptureViewport, evidencePanelBounds, visibleLabelBounds } = require('../../src/automation/hierarchy')
const { stackFramesInGroups, verifyFrameOverlap, imageInfo } = require('../../src/automation/images')
const { createBatchDirectory, questionArtifactDirectory } = require('../../src/automation/utils')
const { loadQuestionFile } = require('../../src/questions')
const { explainSessionError, findOptionalElement, buildReplyImages } = require('../../src/automation/runner')

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

test('拼接参考药品时保留完整视口，并阻止无法验证的跨屏拼接', async () => {
  const make = color => sharp({ create: { width: 20, height: 10, channels: 3, background: color } }).png().toBuffer()
  const chunks = await stackFramesInGroups([await make('red'), await make('green'), await make('blue'), await make('white')], 3)
  assert.equal(chunks.length, 2)
  assert.deepEqual(await imageInfo(chunks[0]), { width: 20, height: 30 })
  const black = await make('black')
  const white = await make('white')
  await assert.rejects(() => verifyFrameOverlap(black, white, 4), /连续性/)
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

test('输入框尚未出现时，将 Appium 的 404 作为可重试状态而不是任务错误', async () => {
  const driver = { $: async () => { throw new Error('NoSuchElementError: An element could not be located on the page') } }
  assert.equal(await findOptionalElement(driver, 'android=new UiSelector().className("android.widget.EditText")'), null)
})

test('回答截图无法验证相邻重叠时，保留完整视口而不裁图', async () => {
  const make = color => sharp({ create: { width: 20, height: 10, channels: 3, background: color } }).png().toBuffer()
  const images = await buildReplyImages([await make('red'), await make('green'), await make('blue')], false)
  assert.equal(images.length, 1)
  assert.deepEqual(await imageInfo(images[0]), { width: 20, height: 30 })
})
