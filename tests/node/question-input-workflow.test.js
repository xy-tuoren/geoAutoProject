const test = require('node:test')
const assert = require('node:assert/strict')
const { createQuestionInputWorkflow } = require('../../src/automation/question-input-workflow')

const OLD_CONVERSATION = `<hierarchy>
  <node package="com.aurora.xiaohe.aidoctor" bounds="[0,0][1080,2400]" visible-to-user="true">
    <node class="android.view.View" content-desc="开启新会话" bounds="[730,101][806,177]" visible-to-user="true" />
    <node class="android.widget.TextView" text="冠心病心绞痛用心通口服液是否有效" bounds="[120,300][960,380]" visible-to-user="true" />
    <node class="android.widget.TextView" text="我这边没有看到你之前的具体问题内容" bounds="[40,500][1000,620]" visible-to-user="true" />
    <node class="android.widget.EditText" text="" bounds="[32,2100][900,2200]" visible-to-user="true" />
  </node>
</hierarchy>`

const NEW_CONVERSATION = `<hierarchy>
  <node package="com.aurora.xiaohe.aidoctor" bounds="[0,0][1080,2400]" visible-to-user="true">
    <node class="android.view.View" content-desc="开启新会话" bounds="[730,101][806,177]" visible-to-user="true" />
    <node class="android.widget.Button" content-desc="不选择咨询人，随便聊聊" bounds="[40,240][400,380]" visible-to-user="true" />
    <node class="android.widget.Button" text="拍药品" bounds="[700,2020][900,2160]" visible-to-user="true" />
    <node class="android.widget.TextView" text="输入问题 或 按住说话" bounds="[180,2220][850,2300]" visible-to-user="true" />
  </node>
</hierarchy>`

const NEW_CONVERSATION_SMALL = `<hierarchy>
  <node package="com.aurora.xiaohe.aidoctor" bounds="[0,0][720,1600]" visible-to-user="true">
    <node class="android.view.View" content-desc="开启新会话" bounds="[487,67][537,118]" visible-to-user="true" />
    <node class="android.widget.Button" content-desc="不选择咨询人，随便聊聊" bounds="[27,160][267,253]" visible-to-user="true" />
    <node class="android.widget.Button" text="拍药品" bounds="[467,1347][600,1440]" visible-to-user="true" />
    <node class="android.widget.TextView" text="输入问题 或 按住说话" bounds="[120,1480][567,1533]" visible-to-user="true" />
  </node>
</hierarchy>`

const SESSION_TRANSITION = `<hierarchy>
  <node package="com.aurora.xiaohe.aidoctor" bounds="[0,0][1080,2400]" visible-to-user="true" />
</hierarchy>`

const DOUYIN_FULL_ANSWER = `<hierarchy>
  <node package="com.ss.android.ugc.aweme" class="android.view.View" content-desc="close" visible-to-user="true" bounds="[978,135][1020,177]" />
  <node package="com.ss.android.ugc.aweme" class="android.view.ViewGroup" visible-to-user="true" bounds="[0,231][1080,2014]" />
  <node package="com.ss.android.ugc.aweme" class="android.widget.HorizontalScrollView" scrollable="true" visible-to-user="true" bounds="[0,2014][1080,2169]" />
</hierarchy>`

const DOUYIN_SEARCH_INPUT = `<hierarchy>
  <node package="com.ss.android.ugc.aweme" class="android.widget.EditText" resource-id="com.ss.android.ugc.aweme:id/et_search_kw" text="" visible-to-user="true" bounds="[132,90][754,210]" />
</hierarchy>`

function workflowWithSource(source, {
  tap = async () => {},
  log = () => {},
  ui = {},
  getActiveEntry = () => ({ label: '小荷AI医生APP', inputHints: ['输入问题'] }),
} = {}) {
  return createQuestionInputWorkflow({
    checkCancelled: () => {},
    source,
    windowSize: async () => ({ width: 1080, height: 2400 }),
    tap,
    log,
    ui,
    waitForVisualQuiet: async () => {},
    findSubmitBounds: () => null,
    boundsForResourceId: () => null,
    getActiveEntry,
    getCachedInputBounds: () => null,
    setCachedInputBounds: () => {},
    getCachedSendBounds: () => null,
    setCachedSendBounds: () => {},
  })
}

test('点击新会话后旧对话层级没有变化时不得报告成功', async () => {
  let taps = 0
  const workflow = workflowWithSource(async () => OLD_CONVERSATION, { tap: async () => { taps += 1 } })
  assert.equal(await workflow.tapNewSession({ timeout: 30 }), false)
  assert.equal(taps, 3)
})

test('新会话按钮前两次无响应时只在旧会话和入口仍完整存在后尝试第三次', async () => {
  let taps = 0
  const workflow = workflowWithSource(async () => (taps >= 3 ? NEW_CONVERSATION : OLD_CONVERSATION), {
    tap: async () => { taps += 1 },
  })
  assert.equal(await workflow.tapNewSession({ timeout: 300 }), true)
  assert.equal(taps, 3)
})

test('只有旧对话内容消失且新页面输入框稳定后才确认新会话', async () => {
  let reads = 0
  let taps = 0
  const workflow = workflowWithSource(async () => (++reads <= 1 ? OLD_CONVERSATION : NEW_CONVERSATION), { tap: async () => { taps += 1 } })
  assert.equal(await workflow.tapNewSession({ timeout: 300 }), true)
  assert.equal(taps, 1)
})

test('新会话入口在转场中消失时继续等待干净页面而不重复点击', async () => {
  let reads = 0
  let taps = 0
  const workflow = workflowWithSource(async () => {
    reads += 1
    if (reads === 1) return OLD_CONVERSATION
    if (reads <= 3) return SESSION_TRANSITION
    return NEW_CONVERSATION
  }, { tap: async () => { taps += 1 } })
  assert.equal(await workflow.tapNewSession({ timeout: 700 }), true)
  assert.equal(taps, 1)
})

test('任务开始时已经是干净的新会话页则直接确认且不重复点击', async () => {
  let taps = 0
  const workflow = workflowWithSource(async () => NEW_CONVERSATION, { tap: async () => { taps += 1 } })
  assert.equal(await workflow.tapNewSession({ timeout: 30 }), true)
  assert.equal(taps, 0)
})

test('不同竖屏尺寸的干净新会话页使用相同比例规则确认', async () => {
  let taps = 0
  const workflow = workflowWithSource(async () => NEW_CONVERSATION_SMALL, { tap: async () => { taps += 1 } })
  assert.equal(await workflow.tapNewSession({ timeout: 30 }), true)
  assert.equal(taps, 0)
})

test('组合输入提示也能被点击并进入真实编辑框', async () => {
  let reads = 0
  let taps = 0
  const workflow = workflowWithSource(async () => (++reads === 1 ? NEW_CONVERSATION : NEW_CONVERSATION.replace(
    '<node class="android.widget.TextView" text="输入问题 或 按住说话" bounds="[180,2220][850,2300]" visible-to-user="true" />',
    '<node class="android.widget.EditText" text="" bounds="[180,2220][850,2300]" visible-to-user="true" />',
  )), { tap: async () => { taps += 1 } })
  const input = await workflow.waitForInput(1_500)
  assert.deepEqual(input.bounds, [180, 2220, 850, 2300])
  assert.equal(taps, 1)
})

test('抖音下一题识别英文close并只点击一次关闭上一题全文页', async () => {
  let closed = false
  const taps = []
  const workflow = workflowWithSource(async () => closed ? DOUYIN_SEARCH_INPUT : DOUYIN_FULL_ANSWER, {
    tap: async (x, y) => { taps.push([x, y]); closed = true },
    getActiveEntry: () => ({ label: '抖音搜索框（小荷AI小程序）', inputHints: [] }),
  })
  const input = await workflow.waitForDouyinSearchInput(2_000)
  assert.deepEqual(input.bounds, [132, 90, 754, 210])
  assert.deepEqual(taps, [[999, 156]])
})

test('抖音题间关闭按钮按竖屏比例定位且不把正文close当作外壳', async () => {
  const scaled = DOUYIN_FULL_ANSWER
    .replaceAll('1080', '720').replaceAll('2400', '1600')
    .replaceAll('978', '652').replaceAll('1020', '680')
    .replaceAll('135', '90').replaceAll('177', '118')
    .replaceAll('231', '154').replaceAll('2014', '1343').replaceAll('2169', '1446')
  let reads = 0
  const taps = []
  const workflow = createQuestionInputWorkflow({
    checkCancelled: () => {},
    source: async () => (++reads === 1 ? scaled : DOUYIN_SEARCH_INPUT.replaceAll('1080', '720')),
    windowSize: async () => ({ width: 720, height: 1600 }),
    tap: async (x, y) => { taps.push([x, y]) }, log: () => {}, ui: {}, waitForVisualQuiet: async () => {},
    findSubmitBounds: () => null, boundsForResourceId: () => null,
    getActiveEntry: () => ({ label: '抖音搜索框（小荷AI小程序）', inputHints: [] }),
    getCachedInputBounds: () => null, setCachedInputBounds: () => {}, getCachedSendBounds: () => null, setCachedSendBounds: () => {},
  })
  await workflow.waitForDouyinSearchInput(2_000)
  assert.deepEqual(taps, [[666, 104]])

  const bodyClose = DOUYIN_FULL_ANSWER.replace('[978,135][1020,177]', '[400,900][450,950]')
  const noTapWorkflow = workflowWithSource(async () => bodyClose, {
    tap: async () => { throw new Error('正文close不应被点击') },
    getActiveEntry: () => ({ label: '抖音搜索框（小荷AI小程序）', inputHints: [] }),
  })
  await assert.rejects(() => noTapWorkflow.waitForDouyinSearchInput(30), /未能在抖音打开搜索输入框/)
})

test('头条搜索入口在等待截止点刚出现时执行最终探测', async () => {
  const blank = '<hierarchy><node package="com.ss.android.article.news" bounds="[0,0][1080,2400]" visible-to-user="true" /></hierarchy>'
  const home = `<hierarchy><node package="com.ss.android.article.news" resource-id="com.ss.android.article.news:id/kic" content-desc="搜索框，推荐内容" bounds="[261,96][922,216]" visible-to-user="true" /></hierarchy>`
  const edit = `<hierarchy><node package="com.ss.android.article.news" class="android.widget.EditText" resource-id="com.ss.android.article.news:id/cx" text="" bounds="[40,96][900,216]" visible-to-user="true" /></hierarchy>`
  let reads = 0
  let taps = 0
  const workflow = workflowWithSource(async () => {
    reads += 1
    if (reads === 1) return blank
    if (reads === 2) return home
    return edit
  }, {
    tap: async () => { taps += 1 },
    getActiveEntry: () => ({ label: '头条搜索框（小荷AI小程序）', inputHints: [] }),
  })
  const input = await workflow.waitForToutiaoSearchInput(1)
  assert.deepEqual(input.bounds, [40, 96, 900, 216])
  assert.equal(taps, 2)
})

test('头条冷启动添加到主屏幕弹窗安全取消后继续寻找搜索框', async () => {
  const popup = `<hierarchy>
    <node package="com.huawei.android.launcher" class="android.widget.TextView" text="添加到主屏幕" visible-to-user="true" bounds="[120,1655][960,1747]" />
    <node package="com.huawei.android.launcher" class="android.widget.TextView" text="今日头条" visible-to-user="true" bounds="[435,2029][643,2099]" />
    <node package="com.huawei.android.launcher" class="android.widget.Button" text="取消" clickable="true" visible-to-user="true" bounds="[84,2202][539,2334]" />
  </hierarchy>`
  const home = `<hierarchy><node package="com.ss.android.article.news" resource-id="com.ss.android.article.news:id/kic" content-desc="搜索框，推荐内容" bounds="[261,96][922,216]" visible-to-user="true" /></hierarchy>`
  const edit = `<hierarchy><node package="com.ss.android.article.news" class="android.widget.EditText" resource-id="com.ss.android.article.news:id/cx" text="" bounds="[40,96][900,216]" visible-to-user="true" /></hierarchy>`
  let stage = 'popup'
  const taps = []
  const source = async () => {
    if (stage === 'popup') throw new Error('当前前台页面不是头条小荷AI小程序')
    if (stage === 'home') return home
    return edit
  }
  const workflow = workflowWithSource(source, {
    ui: { dumpHierarchy: async () => popup },
    tap: async (x, y) => {
      taps.push([x, y])
      stage = stage === 'popup' ? 'home' : 'edit'
    },
    getActiveEntry: () => ({ label: '头条搜索框（小荷AI小程序）', inputHints: [] }),
  })
  const input = await workflow.waitForToutiaoSearchInput(2_000)
  assert.deepEqual(input.bounds, [40, 96, 900, 216])
  assert.deepEqual(taps[0], [311.5, 2268])
})
