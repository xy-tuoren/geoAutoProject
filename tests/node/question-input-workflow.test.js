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
  assert.equal(taps, 2)
})

test('只有旧对话内容消失且新页面输入框稳定后才确认新会话', async () => {
  let reads = 0
  let taps = 0
  const workflow = workflowWithSource(async () => (++reads <= 1 ? OLD_CONVERSATION : NEW_CONVERSATION), { tap: async () => { taps += 1 } })
  assert.equal(await workflow.tapNewSession({ timeout: 300 }), true)
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
