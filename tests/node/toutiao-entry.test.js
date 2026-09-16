const test = require('node:test')
const assert = require('node:assert/strict')
const { toutiaoHomeSearchBounds, toutiaoSearchInput, toutiaoOcrMiniAppEntryTarget } = require('../../src/automation/miniapp-locators')
const { createQuestionWorkflows } = require('../../src/automation/question-workflows')
const { ToutiaoAnswerCardNotFoundError } = require('../../src/automation/search-recovery')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

test('头条新版首页通过搜索图标与可点击容器定位，兼容竖屏缩放', () => {
  for (const scale of [1, 2 / 3]) {
    const b = values => `[${values.slice(0, 2).map(v => Math.round(v * scale))}][${values.slice(2).map(v => Math.round(v * scale))}]`
    const xml = `<hierarchy><node package="com.ss.android.article.news" bounds="${b([0, 0, 1272, 2800])}">
      <node package="com.ss.android.article.news" clickable="true" bounds="${b([203, 162, 1093, 302])}">
        <node resource-id="com.ss.android.article.news:id/search_bar_search_icon" bounds="${b([231, 190, 315, 274])}"/>
        <node text="搜你想看的"/>
      </node></node></hierarchy>`
    assert.deepEqual(toutiaoHomeSearchBounds(xml), [203, 162, 1093, 302].map(v => Math.round(v * scale)))
    assert.equal(toutiaoHomeSearchBounds(xml.replace('search_bar_search_icon', 'unrelated')), null)
  }
})

test('首屏独立小荷入口必须同时具备品牌和邻近小程序标识，映射物理与逻辑尺寸', () => {
  for (const scale of [1, 2 / 3]) {
    const recognition = { image: { width: 1272, height: 2800 }, results: [
      { text: '小荷AI医生', normalizedText: '小荷AI医生', confidence: 0.99, bounds: [150, 650, 450, 710] },
      { text: '小程序', normalizedText: '小程序', confidence: 0.99, bounds: [475, 660, 610, 705] },
    ] }
    const size = { width: 1272 * scale, height: 2800 * scale }
    assert.deepEqual(toutiaoOcrMiniAppEntryTarget(recognition, size)?.bounds, [150, 650, 450, 710].map(v => Math.round(v * scale)))
    assert.equal(toutiaoOcrMiniAppEntryTarget({ ...recognition, results: [recognition.results[0]] }, size), null)
    assert.equal(toutiaoOcrMiniAppEntryTarget({ ...recognition, results: [recognition.results[0], { ...recognition.results[1], bounds: [475, 1800, 610, 1850] }] }, size), null)
  }
})

test('头条首屏没有小荷入口只搜索一次，保存当前结果并结束本题', async () => {
  let inputs = 0, taps = 0, waits = 0, saved
  const workflow = createQuestionWorkflows({
    observer: {}, recoverySnapshot: () => ({}), log: () => {},
    inputToutiaoQuestion: async () => { inputs++; return [0, 0, 100, 50] },
    tap: async () => { taps++ },
    waitForToutiaoAnswerCard: async () => { waits++; throw new ToutiaoAnswerCardNotFoundError('首屏无入口') },
    getActiveEntry: () => ({ id: 'toutiao-xiaohe-miniapp', workflow: 'toutiao-search' }),
    getActivePackageName: () => 'com.ss.android.article.news',
    source: async () => '<hierarchy/>', screenshot: async () => Buffer.from('screen'),
    saveArtifacts: async options => { saved = options; return {} },
  })
  await workflow.askOnceToutiao({ timeout: 1 }, { batchDirectory: '/tmp/example', diagnosticDirectory: '/tmp/debug', deliveryDirectory: '/tmp/images' }, '示例问题', 1)
  assert.deepEqual([inputs, taps, waits], [1, 1, 1])
  assert.equal(saved.meta.toutiao_search_attempts, 1)
  assert.equal(saved.meta.toutiao_search_repeated_exact_question, false)
  assert.equal(saved.stem, '回答_搜索结果')
})

test('头条独立入口只采集本题，原题验证失败不能交付入口图或重复搜索', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'toutiao-entry-'))
  try {
    for (const failCapture of [false, true]) {
      const deliveryDirectory = path.join(directory, String(failCapture))
      const searchImage = path.join(deliveryDirectory, '回答_小程序入口.png')
      let inputs = 0, opens = 0
      const workflow = createQuestionWorkflows({
        observer: {}, recoverySnapshot: () => ({}), log: () => {},
        inputToutiaoQuestion: async () => { inputs++; return [0, 0, 100, 50] }, tap: async () => {},
        waitForToutiaoAnswerCard: async () => ({ size: { width: 720, height: 1600 } }),
        captureToutiaoSearchSummary: async (_size, _card, question) => {
          assert.equal(question, '示例问题')
          return { mode: 'miniapp_entry_card', viewMore: [100, 300, 300, 350], frame: Buffer.from('search-image') }
        },
        openToutiaoFullAnswer: async () => { opens++; return { xml: '<hierarchy/>', bounds: [0, 200, 720, 1300] } },
        captureToutiaoFullAnswerFrames: async (_xml, _bounds, question) => {
          assert.equal(question, '示例问题')
          if (failCapture) throw new Error('完整原题未通过验证')
          return {}
        },
        saveArtifacts: async options => {
          await assert.rejects(fs.access(searchImage))
          assert.equal(options.meta.toutiao_miniapp_question_submitted, false)
          assert.equal(options.meta.toutiao_full_answer_route_repeated, false)
          return options.captureMethod()
        },
        getActiveEntry: () => ({ id: 'toutiao-xiaohe-miniapp', workflow: 'toutiao-search' }),
        getActivePackageName: () => 'com.ss.android.article.news',
      })
      const pending = workflow.askOnceToutiao({ timeout: 1 }, { batchDirectory: directory, diagnosticDirectory: directory, deliveryDirectory }, '示例问题', 1)
      if (failCapture) { await assert.rejects(pending, /完整原题/); await assert.rejects(fs.access(searchImage)) }
      else { await pending; assert.equal(await fs.readFile(searchImage, 'utf8'), 'search-image') }
      assert.deepEqual([inputs, opens], [1, 1])
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('新版头条搜索框按顶部语义定位，不依赖混淆后的资源编号', () => {
  for (const scale of [1, 2 / 3]) {
    const b = values => `[${values.slice(0, 2).map(v => Math.round(v * scale))}][${values.slice(2).map(v => Math.round(v * scale))}]`
    const xml = `<hierarchy><node bounds="${b([0, 0, 1272, 2800])}"/><node package="com.ss.android.article.news" resource-id="com.ss.android.article.news:id/d0" text="搜索框，示例问题" clickable="true" bounds="${b([259, 162, 1062, 302])}"/></hierarchy>`
    assert.deepEqual(toutiaoSearchInput(xml), { text: '示例问题', bounds: [259, 162, 1062, 302].map(v => Math.round(v * scale)) })
    assert.equal(toutiaoSearchInput(xml.replace('搜索框，', '普通正文，')), null)
    assert.equal(toutiaoSearchInput(xml.replace('com.ss.android.article.news"', 'other.app"')), null)
  }
})
