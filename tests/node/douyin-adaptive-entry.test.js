const test = require('node:test')
const assert = require('node:assert/strict')
const { douyinOcrBrandEntryTarget } = require('../../src/automation/miniapp-locators')
const { miniAppReferenceProductsOcrTrigger } = require('../../src/automation/reference-products')
const sharp = require('sharp')
const { createDouyinSearchWorkflow } = require('../../src/automation/douyin-search-workflow')

test('品牌与卡片标题共同确认入口，兼容首屏位置、文案变化和物理逻辑缩放', () => {
  for (const scale of [1, 2 / 3]) {
    const b = values => `[${values.slice(0, 2).map(v => Math.round(v * scale))}][${values.slice(2).map(v => Math.round(v * scale))}]`
    const xml = `<hierarchy><node class="android.widget.EditText" resource-id="com.ss.android.ugc.aweme:id/et_search_kw" package="com.ss.android.ugc.aweme" bounds="${b([132,90,754,210])}"/><node class="android.widget.FrameLayout" bounds="${b([545,394,1069,1296])}">
      <node class="android.view.ViewGroup" bounds="${b([545,394,1069,1296])}"/>
      <node class="android.view.ViewGroup" bounds="${b([545,394,1069,548])}"><node class="android.view.ViewGroup" bounds="${b([565,414,665,514])}"/></node>
      <node class="android.view.ViewGroup" bounds="${b([545,570,1069,735])}"/>
      <node class="android.view.ViewGroup" bounds="${b([545,735,1069,1285])}"/>
    </node></hierarchy>`
    const recognition = { image: { width: 1080, height: 2400 }, results: [{ text: '小荷AI医生', normalizedText: '小荷AI医生', confidence: 0.99, bounds: [690, 430, 900, 477] }] }
    const size = { width: 1080 * scale, height: 2400 * scale }
    const target = douyinOcrBrandEntryTarget(recognition, xml, size)
    assert.ok(target?.identityConfirmed)
    assert.deepEqual(target.tapBounds, [545,394,1069,548].map(v => Math.round(v * scale)))
    assert.equal(douyinOcrBrandEntryTarget({ ...recognition, results: [{ ...recognition.results[0], normalizedText: '其他AI医生' }] }, xml, size), null)
    assert.equal(douyinOcrBrandEntryTarget({ ...recognition, results: [{ ...recognition.results[0], bounds: [100,1800,300,1850] }] }, xml, size), null)
  }
})

test('Canvas全部药品必须与参考药品同一标题行，映射到逻辑坐标', () => {
  const recognition = { image: { width: 1080, height: 2400 }, results: [
    { normalizedText: '参考药品', confidence: 0.99, bounds: [60, 1400, 260, 1450] },
    { normalizedText: '全部药品>', confidence: 0.99, bounds: [820, 1400, 1000, 1450] },
  ] }
  for (const scale of [1, 2 / 3]) {
    assert.deepEqual(miniAppReferenceProductsOcrTrigger(recognition, { width: 1080 * scale, height: 2400 * scale }), [Math.round(910 * scale), Math.round(1425 * scale)])
  }
  assert.equal(miniAppReferenceProductsOcrTrigger({ ...recognition, results: [recognition.results[1]] }, { width: 1080, height: 2400 }), null)
})

test('首屏底部被裁短的小荷卡片仍按完整品牌标题点击，兼容物理逻辑缩放', () => {
  for (const scale of [1, 2 / 3]) {
    const b = values => `[${values.slice(0, 2).map(v => Math.round(v * scale))}][${values.slice(2).map(v => Math.round(v * scale))}]`
    const xml = `<hierarchy><node class="android.widget.EditText" resource-id="com.ss.android.ugc.aweme:id/et_search_kw" package="com.ss.android.ugc.aweme" bounds="${b([121,105,782,215])}"/>
      <node class="android.widget.FrameLayout" bounds="${b([11,1963,535,2356])}">
        <node class="android.view.ViewGroup" bounds="${b([11,1963,535,2356])}"/>
        <node class="android.view.ViewGroup" bounds="${b([11,1963,535,2117])}"><node class="android.view.ViewGroup" bounds="${b([33,1985,143,2095])}"/></node>
        <node class="android.view.ViewGroup" bounds="${b([11,2139,535,2249])}"/>
        <node class="android.view.ViewGroup" bounds="${b([11,2249,535,2356])}"/>
      </node></hierarchy>`
    const recognition = { image: { width: 1080, height: 2400 }, results: [{ normalizedText: '小荷AI医生', confidence: 0.99, bounds: [165, 2000, 400, 2048] }] }
    const size = { width: 1080 * scale, height: 2400 * scale }
    const target = douyinOcrBrandEntryTarget(recognition, xml, size)
    assert.deepEqual(target?.tapBounds, [11,1963,535,2117].map(v => Math.round(v * scale)))
    assert.equal(douyinOcrBrandEntryTarget({ ...recognition, results: [] }, xml, size), null)
    assert.equal(douyinOcrBrandEntryTarget({ ...recognition, results: [{ ...recognition.results[0], bounds: [700,2000,950,2048] }] }, xml, size), null)
  }
})

test('正文没有药名时不反复回查，进入完成确认但不跳过完整原题验证', async () => {
  let clock = 0, swipes = 0
  const raw = Buffer.alloc(360 * 800 * 3)
  for (let i = 0; i < raw.length; i += 1) raw[i] = Math.floor(i / 3) % 360 < 180 ? 255 : 40
  const frame = await sharp(raw, { raw: { width: 360, height: 800, channels: 3 } }).png().toBuffer()
  const xml = '<hierarchy><node package="com.ss.android.ugc.aweme" content-desc="关闭" bounds="[300,32][345,64]"/><node class="android.view.ViewGroup" bounds="[0,84][360,592]"/></hierarchy>'
  const workflow = createDouyinSearchWorkflow({
    screenshot: async () => frame, windowSize: async () => ({ width: 360, height: 800 }),
    log: () => {}, checkCancelled: () => {}, setLastOcrDiagnostic: () => {},
    now: () => clock, delay: async ms => { clock += ms },
    swipeChat: async (_bounds, direction) => { assert.equal(direction, 'up'); swipes += 1 },
    waitForStableReply: async () => ({ status: 'stable', xml }),
    ocr: { recognize: async () => { clock += 8_000; return { image: { width: 360, height: 800 }, results: [
      { normalizedText: '小荷AI医生', bounds: [60,40,220,65], confidence: 0.99 },
      { text: '疼痛持续多久', confidence: 0.99 },
    ] } } },
  })
  const result = await workflow.waitForDouyinMiniAppAnswer({ bounds: [0,84,360,592], startedAt: 0 }, 60_000, { question: '肝脏隐隐作痛用什么药？' })
  assert.equal(result.xml, xml)
  assert.equal(swipes, 0)
  assert.equal(result.exactQuestionValidationRequired, true)
  assert.ok(clock > 15_000 && clock < 60_000)
})
