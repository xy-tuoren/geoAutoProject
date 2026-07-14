const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const sharp = require('sharp')
const XLSX = require('xlsx')
const { questionVisible, currentQuestionText, replyTailOnScreen, findChatScrollBounds, validateCaptureViewport, floatingScrollControlBounds, replyCaptureBounds, estimateVerticalScrollShift, sharedTextSeam, evidencePanelBounds, visibleLabelBounds, visibleLabelBoundsList, boundsListForNodeAttribute, referenceProductsSection, referenceProductImageBounds } = require('../../src/automation/hierarchy')
const { stackFramesInGroups, verifyFrameOverlap, verifyProductGridOverlap, imageInfo, imageLooksLoaded, imagesSimilar, imageRegionsStable, alignCropToWhitespace, stitchFramesWithOverlaps, composeLongImages, cropFramesAtTextSeams } = require('../../src/automation/images')
const { createBatchDirectory, questionArtifactDirectory } = require('../../src/automation/utils')
const { loadQuestionFile } = require('../../src/questions')
const { adbConnectionLost, automationEntries, captureStableObserved, captureStableSandwich, calibratedProductFallbackOverlap, chatSwipePlan, conservativeFallbackOverlap, buildReplyImages, fillQuestionInput, hierarchyBelongsToPackage, historyOnboardingVisible, maxLongImageHeight, normalizeAutomationEntries, observerResultRequiresFreshCapture, prepareEmbeddedEvidence, referenceProductsCaptureComplete, referenceProductsTrigger, referenceProductViewportReadiness, scrollEndConfirmed, shouldRetryFullReplyCapture, waitForPackageHierarchy } = require('../../src/automation/runner')

const CHAT_BOUNDS = [0, 200, 1080, 1800]

test('只允许目标App层级进入UI操作流程', () => {
  const target = '<hierarchy><node package="com.aurora.xiaohe.aidoctor" class="android.widget.EditText" /></hierarchy>'
  const search = '<hierarchy><node package="com.huawei.search" class="android.widget.EditText" /></hierarchy>'
  assert.equal(hierarchyBelongsToPackage(target), true)
  assert.equal(hierarchyBelongsToPackage(search), false)
})

test('桌面入口默认小荷App，并按选择顺序去重执行', () => {
  assert.equal(normalizeAutomationEntries([])[0].id, 'xiaohe-app')
  const entries = normalizeAutomationEntries(['douyin-xiaohe-miniapp', 'xiaohe-app', 'douyin-xiaohe-miniapp'])
  assert.deepEqual(entries.map(entry => entry.id), ['douyin-xiaohe-miniapp', 'xiaohe-app'])
  assert.deepEqual(automationEntries().map(entry => entry.id), ['xiaohe-app', 'douyin-xiaohe-miniapp', 'toutiao-xiaohe-miniapp'])
  assert.throws(() => normalizeAutomationEntries(['unknown-entry']), /未知入口/)
})

test('入口启动后等待目标App层级出现，避免启动过渡误判前台错误', async () => {
  let now = 0
  const packages = ['com.huawei.android.launcher', 'com.huawei.android.launcher', 'com.aurora.xiaohe.aidoctor']
  const xml = await waitForPackageHierarchy({
    dumpHierarchy: async () => `<hierarchy><node package="${packages.shift()}" /></hierarchy>`,
    packageName: 'com.aurora.xiaohe.aidoctor',
    packageLabel: '小荷App',
    delay: async milliseconds => { now += milliseconds },
    now: () => now,
    timeout: 1_000,
    interval: 100,
  })

  assert.match(xml, /com\.aurora\.xiaohe\.aidoctor/)
  assert.equal(now, 200)
})

test('输入完成后不盲按返回键退出App', async () => {
  const events = []
  const xml = '<hierarchy><node package="com.aurora.xiaohe.aidoctor" /></hierarchy>'
  const result = await fillQuestionInput({
    ui: {
      sendKeys: async (text, options) => events.push(['sendKeys', text, options]),
      press: async key => events.push(['press', key]),
    },
    tap: async (x, y) => events.push(['tap', x, y]),
    source: async () => { events.push(['source']); return xml },
    delay: async milliseconds => events.push(['delay', milliseconds]),
  }, { bounds: [100, 200, 500, 300], text: '' }, '真机测试')

  assert.equal(result, xml)
  assert.deepEqual(events, [
    ['tap', 300, 250],
    ['delay', 300],
    ['sendKeys', '真机测试', { clear: false }],
    ['delay', 350],
    ['source'],
  ])
})

test('稳定帧夹心校验首轮只需要两次截图', async () => {
  let now = 0
  const events = []
  const frames = [Buffer.from('same'), Buffer.from('same')]
  const result = await captureStableSandwich({
    capture: async () => { events.push('capture'); return frames.shift() },
    hierarchy: async () => { events.push('hierarchy'); return '<hierarchy />' },
    framesStable: async (before, after) => before.equals(after),
    hierarchyLoading: () => false,
    delay: async milliseconds => { events.push(`delay:${milliseconds}`); now += milliseconds },
    now: () => now,
    interval: 80,
  }, 1_000)

  assert.equal(result.stable, true)
  assert.equal(result.attempts, 1)
  assert.deepEqual(events, ['capture', 'delay:80', 'hierarchy', 'capture'])
})

test('夹心校验发现滚动未停时复用最新帧继续检测', async () => {
  let now = 0
  const frames = [Buffer.from('first'), Buffer.from('moving'), Buffer.from('moving')]
  let captures = 0
  const result = await captureStableSandwich({
    capture: async () => { captures += 1; return frames.shift() },
    hierarchy: async () => '<hierarchy />',
    framesStable: async (before, after) => before.equals(after),
    hierarchyLoading: () => false,
    delay: async milliseconds => { now += milliseconds },
    now: () => now,
    interval: 80,
  }, 1_000)

  assert.equal(result.stable, true)
  assert.equal(result.attempts, 2)
  assert.equal(captures, 3)
})

test('从scrcpy路径切换夹心校验时复用已有PNG', async () => {
  let now = 0
  const events = []
  const initialFrame = Buffer.from('same')
  const result = await captureStableSandwich({
    capture: async () => { events.push('capture'); return Buffer.from('same') },
    hierarchy: async () => { events.push('hierarchy'); return '<hierarchy />' },
    framesStable: async (before, after) => before.equals(after),
    hierarchyLoading: () => false,
    delay: async milliseconds => { events.push(`delay:${milliseconds}`); now += milliseconds },
    now: () => now,
    interval: 80,
    initialFrame,
  }, 1_000)

  assert.equal(result.stable, true)
  assert.equal(result.attempts, 1)
  assert.deepEqual(events, ['delay:80', 'hierarchy', 'capture'])
})

test('scrcpy确认静止后只截取一张无损PNG，并校验层级读取期间无重排', async () => {
  const events = []
  const observer = {
    waitForNoActivity: async () => { events.push('noActivity'); return { quiet: true } },
    mark: () => ({ frameCount: 7 }),
  }
  const result = await captureStableObserved({
    observer,
    capture: async () => { events.push('capture'); return Buffer.from('png') },
    hierarchy: async () => { events.push('hierarchy'); return '<hierarchy />' },
    hierarchyLoading: () => false,
  })

  assert.equal(result.stable, true)
  assert.equal(result.observer, true)
  assert.deepEqual(events, ['noActivity', 'hierarchy', 'capture', 'noActivity'])
})

test('滑动后的稳定截图优先使用活动标记快速判静止', async () => {
  const events = []
  const settleSince = { at: 1_000, frameCount: 4, activityFrameCount: 2 }
  const observer = {
    waitForSettleSince: async (mark, options) => {
      events.push(['settle', mark, options])
      return { settled: true, activity: true }
    },
    waitForNoActivity: async () => { events.push(['noActivity']); return { quiet: true } },
    mark: () => ({ frameCount: 7, activityFrameCount: 2 }),
  }

  const result = await captureStableObserved({
    observer,
    settleSince,
    capture: async () => { events.push(['capture']); return Buffer.from('png') },
    hierarchy: async () => { events.push(['hierarchy']); return '<hierarchy />' },
    hierarchyLoading: () => false,
  })

  assert.equal(result.stable, true)
  assert.deepEqual(events, [
    ['settle', settleSince, { hardTimeout: 2500, quietMs: 650, conservativeQuietMs: 1000 }],
    ['hierarchy'],
    ['capture'],
    ['noActivity'],
  ])
})

test('scrcpy未等到静止时不额外读层级或截PNG', async () => {
  const events = []
  const result = await captureStableObserved({
    observer: {
      waitForSettleSince: async () => ({ settled: false, activity: true }),
    },
    settleSince: { at: 0, frameCount: 0, activityFrameCount: 0 },
    capture: async () => { events.push('capture'); return Buffer.from('png') },
    hierarchy: async () => { events.push('hierarchy'); return '<hierarchy />' },
    hierarchyLoading: () => false,
  })

  assert.equal(result.stable, false)
  assert.equal(result.reason, 'settle_timeout')
  assert.equal(result.frame, null)
  assert.equal(result.xml, '')
  assert.deepEqual(events, [])
})

test('scrcpy二次确认失败时保留PNG给ADB夹心校验', async () => {
  const events = []
  let noActivityChecks = 0
  const observer = {
    waitForNoActivity: async () => {
      noActivityChecks += 1
      return noActivityChecks === 1 ? { quiet: true } : { quiet: false }
    },
    mark: () => ({ frameCount: 7, activityFrameCount: 2 }),
  }
  const result = await captureStableObserved({
    observer,
    capture: async () => { events.push('capture'); return Buffer.from('png') },
    hierarchy: async () => { events.push('hierarchy'); return '<hierarchy />' },
    hierarchyLoading: () => false,
  })

  assert.equal(result.stable, false)
  assert.equal(result.reason, 'confirmation_timeout')
  assert.ok(result.frame.equals(Buffer.from('png')))
  assert.equal(result.xml, '<hierarchy />')
  assert.deepEqual(events, ['hierarchy', 'capture'])
})

test('scrcpy二次确认拒绝截图期间任意活动帧', async () => {
  let marks = 0
  const observer = {
    waitForNoActivity: async () => ({ quiet: true }),
    mark: () => {
      marks += 1
      return marks === 1
        ? { activityFrameCount: 10, burstActivityFrameCount: 4 }
        : { activityFrameCount: 13, burstActivityFrameCount: 4 }
    },
  }

  const result = await captureStableObserved({
    observer,
    capture: async () => Buffer.from('png'),
    hierarchy: async () => '<hierarchy />',
    hierarchyLoading: () => false,
  })

  assert.equal(result.stable, false)
  assert.equal(result.reason, 'capture_activity')
})

test('scrcpy二次确认仍拒绝截图期间的连续活动突发', async () => {
  let marks = 0
  const observer = {
    waitForNoActivity: async () => ({ quiet: true }),
    mark: () => {
      marks += 1
      return marks === 1
        ? { activityFrameCount: 10, burstActivityFrameCount: 4 }
        : { activityFrameCount: 13, burstActivityFrameCount: 5 }
    },
  }

  const result = await captureStableObserved({
    observer,
    capture: async () => Buffer.from('png'),
    hierarchy: async () => '<hierarchy />',
    hierarchyLoading: () => false,
  })

  assert.equal(result.stable, false)
  assert.equal(result.reason, 'capture_activity')
})

test('scrcpy明确发现截图窗口活动时必须重新采集而不是ADB兜底', () => {
  assert.equal(observerResultRequiresFreshCapture({ reason: 'capture_activity' }), true)
  assert.equal(observerResultRequiresFreshCapture({ reason: 'confirmation_timeout' }), true)
  assert.equal(observerResultRequiresFreshCapture({ reason: 'capture_deadline' }), true)
  assert.equal(observerResultRequiresFreshCapture({ reason: 'settle_timeout' }), false)
  assert.equal(observerResultRequiresFreshCapture({ reason: 'observer_timeout' }), false)
})

test('普通回答不可靠接缝会整题重采一次但不越过药品终止序列', () => {
  assert.equal(shouldRetryFullReplyCapture({ fallbackReasons: ['局部内容发生变化'] }), true)
  assert.equal(shouldRetryFullReplyCapture({ fallbackReasons: [] }), false)
  assert.equal(shouldRetryFullReplyCapture({ fallbackReasons: ['局部内容发生变化'], allowFullRetry: false }), false)
  assert.equal(shouldRetryFullReplyCapture({ fallbackReasons: ['局部内容发生变化'], products: { pages: 3 } }), false)
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

test('层级节点未写可见属性时仍按可见节点处理', () => {
  const xml = '<hierarchy><node class="android.widget.TextView" text="系统层级问题" bounds="[80,900][900,980]" /></hierarchy>'
  assert.equal(questionVisible(xml, '系统层级问题', [0, 400, 1080, 1800]), true)
})

test('从右侧消息气泡自动识别当前已有问题而不依赖输入框', () => {
  const xml = '<hierarchy><node class="android.view.View" bounds="[0,200][1272,2300]">'
    + '<node class="android.view.View" bounds="[65,558][1207,715]">'
    + '<node class="android.view.View" bounds="[715,558][1155,715]">'
    + '<node class="android.widget.TextView" text="腹泻脱水用什么药" content-desc="腹泻脱水用什么药" bounds="[715,604][1155,669]" />'
    + '</node></node>'
    + '<node class="android.view.View" bounds="[0,786][1272,2200]">'
    + '<node class="android.widget.TextView" text="腹泻脱水首选口服补液盐" bounds="[65,970][1207,1192]" />'
    + '</node></node></hierarchy>'
  assert.equal(currentQuestionText(xml, [0, 440, 1272, 2315]), '腹泻脱水用什么药')
})

test('药品卡片里的医保标签不能被误识别为当前问题', () => {
  const xml = '<hierarchy><node class="android.view.View" bounds="[0,440][1272,2315]">'
    + '<node class="android.widget.HorizontalScrollView" bounds="[0,1200][1272,2315]">'
    + '<node class="android.view.ViewGroup" bounds="[588,1400][1106,2315]">'
    + '<node class="android.view.View" bounds="[619,2050][1048,2261]">'
    + '<node class="android.view.View" bounds="[761,2105][917,2261]">'
    + '<node class="android.widget.TextView" text="医保甲类" content-desc="" bounds="[772,2160][906,2206]" />'
    + '</node></node></node></node></node></hierarchy>'
  assert.equal(currentQuestionText(xml, [0, 440, 1272, 2315]), null)
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

test('单列药品行使用整宽校验，不把右侧黑色空栏当成接缝证据', async () => {
  const width = 240
  const height = 300
  const raw = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < 110; x += 1) {
      const offset = (y * width + x) * 3
      raw[offset] = (y * 37 + x * 11) % 256
      raw[offset + 1] = (y * 13 + x * 29) % 256
      raw[offset + 2] = (y * 7 + x * 19) % 256
    }
  }
  const previous = await sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer()
  const current = await sharp(previous).extract({ left: 0, top: 80, width, height: 220 }).extend({ bottom: 80, background: 'black' }).png().toBuffer()
  assert.equal(await verifyProductGridOverlap(previous, current, 220), 220)
})

test('药品动态接缝仅在前序滚动位移一致时采用保守重叠', () => {
  assert.equal(calibratedProductFallbackOverlap([403, 391]), null)
  assert.equal(calibratedProductFallbackOverlap([403, 391, 393, 410]), 383)
  assert.equal(calibratedProductFallbackOverlap([403, 391, 520]), null)
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

test('已验证长图拆成多个文件时不会重新保留整屏重叠内容', async () => {
  const frame = await sharp({ create: { width: 20, height: 1000, channels: 3, background: 'white' } }).png().toBuffer()
  const transitions = Array.from({ length: 3 }, () => ({ verified: true, overlap: 600 }))
  const images = await composeLongImages([frame, frame, frame, frame], { transitions, maxHeight: 1500 })

  assert.equal(images.length, 2)
  assert.deepEqual(await imageInfo(images[0]), { width: 20, height: 1400 })
  assert.deepEqual(await imageInfo(images[1]), { width: 20, height: 800 })
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

test('回答滚动阶段直接返回参考药品入口坐标', () => {
  const xml = '<hierarchy>'
    + '<node class="androidx.compose.ui.viewinterop.ViewFactoryHolder" bounds="[0,673][1080,1714]">'
    + '<node class="android.widget.ImageView" bounds="[942,682][1020,760]" />'
    + '<node class="android.widget.HorizontalScrollView" scrollable="true" bounds="[0,817][1080,1714]" />'
    + '</node></hierarchy>'

  assert.deepEqual(referenceProductsTrigger(xml, CHAT_BOUNDS), [981, 721])
})

test('参考药品标题旁存在真实可点击按钮时使用按钮中心而非估算坐标', () => {
  const xml = '<hierarchy>'
    + '<node text="参考药品" class="android.widget.TextView" bounds="[65,1394][1096,1482]" />'
    + '<node class="android.view.View" clickable="true" bounds="[1096,1360][1253,1517]" />'
    + '</hierarchy>'
  assert.deepEqual(referenceProductsTrigger(xml, [0, 200, 1272, 2300]), [1174, 1438])
})

test('检测到回答尾部药品入口后只要求完整采集药品，不依赖正文锚点恢复', () => {
  const complete = { firstViewportIncluded: true, imagesReady: true, confirmedEnd: true, continuityVerified: true }

  assert.equal(referenceProductsCaptureComplete({ detected: false, products: null }), true)
  assert.equal(referenceProductsCaptureComplete({ detected: true, products: null }), false)
  assert.equal(referenceProductsCaptureComplete({ detected: true, products: { ...complete, firstViewportIncluded: false } }), false)
  assert.equal(referenceProductsCaptureComplete({ detected: true, products: { ...complete, imagesReady: false } }), false)
  assert.equal(referenceProductsCaptureComplete({ detected: true, products: { ...complete, confirmedEnd: false } }), false)
  assert.equal(referenceProductsCaptureComplete({ detected: true, products: { ...complete, continuityVerified: false } }), false)
  assert.equal(referenceProductsCaptureComplete({ detected: true, products: complete }), true)
})

test('新版药品抽屉无图片节点时从卡片上半部推断药品图片区域', () => {
  const list = [0, 1280, 1272, 2744]
  const xml = '<hierarchy>'
    + '<node class="androidx.recyclerview.widget.RecyclerView" bounds="[0,1280][1272,2744]">'
    + '<node class="android.view.ViewGroup" bounds="[42,1424][560,2413]" />'
    + '<node class="android.view.ViewGroup" bounds="[588,1424][1106,2413]" />'
    + '<node class="android.view.ViewGroup" bounds="[42,2641][560,2744]" />'
    + '</node></hierarchy>'
  const result = referenceProductImageBounds(xml, list)
  assert.equal(result.mode, 'inferred_card_artwork')
  assert.deepEqual(result.bounds, [[73, 1454, 529, 1968], [619, 1454, 1075, 1968]])
})

test('药品稳定截图直接复用完成图片就绪判断', async () => {
  const artwork = await sharp({ create: { width: 140, height: 140, channels: 3, background: '#fff' } })
    .composite([{ input: await sharp({ create: { width: 80, height: 60, channels: 3, background: '#d71945' } }).png().toBuffer(), left: 30, top: 40 }])
    .png().toBuffer()
  const frame = await sharp({ create: { width: 400, height: 500, channels: 3, background: '#000' } })
    .composite([{ input: artwork, left: 30, top: 50 }])
    .png().toBuffer()
  const xml = '<hierarchy><node class="android.widget.ImageView" bounds="[30,150][170,290]" /></hierarchy>'
  const result = await referenceProductViewportReadiness(frame, xml, [0, 100, 400, 600])
  assert.equal(result.ready, true)
  assert.equal(result.mode, 'explicit_images')
  assert.equal(result.loaded, 1)
})

test('普通资料卡（Compose 面板但无横向药品列表）不会被误判为参考药品', () => {
  const xml = '<hierarchy>'
    + '<node class="androidx.compose.ui.viewinterop.ViewFactoryHolder" displayed="true" bounds="[40,700][1040,980]">'
    + '<node class="android.widget.TextView" text="引用资料" displayed="true" bounds="[60,720][300,780]" />'
    + '</node></hierarchy>'
  assert.equal(referenceProductsSection(xml), null)
})

test('仅为 ADB 短暂断连启用安装重试', () => {
  assert.equal(adbConnectionLost(new Error('adb: device offline')), true)
  assert.equal(adbConnectionLost(new Error('INSTALL_FAILED_UPDATE_INCOMPATIBLE')), false)
})

test('识别首次启动时遮挡输入框的历史对话引导', () => {
  assert.equal(historyOnboardingVisible('<node text="在这里查看「历史对话」" />'), true)
  assert.equal(historyOnboardingVisible('<node text="输入问题 或 按住说话" />'), false)
})
