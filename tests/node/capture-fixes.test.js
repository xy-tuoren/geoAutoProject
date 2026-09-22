const test = require('node:test')
const assert = require('node:assert/strict')
const sharp = require('sharp')
const { verifiedQuestionBubble, miniAppQuestionOcrTarget } = require('../../src/automation/reply-capture')
const { referenceProductViewportReadiness } = require('../../src/automation/reference-products')
const { createReferenceProductCapture } = require('../../src/automation/reference-product-capture')
const { createToutiaoSearchWorkflow } = require('../../src/automation/toutiao-search-workflow')
const { createQuestionWorkflows } = require('../../src/automation/question-workflows')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')

test('OCR equivalent glyph preserves complete-question and green-bubble validation at two scales', async () => {
  for (const scale of [1, 2]) {
    const frame = await sharp(Buffer.from('<svg width="360" height="800"><rect width="360" height="800" fill="white"/><rect x="140" y="140" width="205" height="70" fill="#00c2ae"/></svg>')).resize(360 * scale, 800 * scale).png().toBuffer()
    const recognition = { image: { width: 360 * scale, height: 800 * scale }, results: [{ text: '正品怎么辨別', confidence: 0.99, bounds: [155, 158, 330, 188].map(v => v * scale) }] }
    const ocr = { recognize: async () => recognition }
    assert.ok(await verifiedQuestionBubble(frame, [0, 100, 360, 720], { width: 360, height: 800 }, '正品怎么辨别', ocr))
    assert.equal(await verifiedQuestionBubble(frame, [0, 100, 360, 720], { width: 360, height: 800 }, '正品怎么服用', ocr), null)
    const low = { ...recognition, results: recognition.results.map(r => ({ ...r, bounds: [155, 620, 330, 650].map(v => v * scale) })) }
    assert.ok(miniAppQuestionOcrTarget(low, '正品怎么辨别', { width: 360, height: 800 }))
    assert.equal(await verifiedQuestionBubble(frame, [0, 100, 360, 720], { width: 360, height: 800 }, '正品怎么辨别', { recognize: async () => low }), null)
  }
})

test('product image readiness maps logical bounds to physical crop and does not accept missing second artwork', async () => {
  for (const scale of [1, 2]) {
    const xml = '<hierarchy><node class="androidx.recyclerview.widget.RecyclerView" bounds="[0,100][400,600]">'
      + '<node class="android.widget.ImageView" bounds="[20,130][160,270]"/>'
      + '<node class="android.widget.ImageView" bounds="[220,130][360,270]"/></node></hierarchy>'
    const render = async missing => sharp(Buffer.from(`<svg width="400" height="500"><rect width="400" height="500" fill="white"/><rect x="40" y="50" width="90" height="90" fill="red"/>${missing ? '' : '<rect x="240" y="50" width="90" height="90" fill="blue"/>'}</svg>`)).resize(400 * scale, 500 * scale).png().toBuffer()
    const ready = await referenceProductViewportReadiness(await render(false), xml, [0, 100, 400, 600])
    assert.equal(ready.ready, true)
    assert.deepEqual(ready.physicalImageBounds[1], [220, 30, 360, 170].map(v => v * scale))
    assert.equal((await referenceProductViewportReadiness(await render(true), xml, [0, 100, 400, 600])).loaded, 1)
  }
})

test('clipped final card tails do not invent two blank artwork slots after validated card geometry', async () => {
  for (const scale of [1, 2 / 3]) {
    const b = a => `[${a.slice(0, 2).map(v => Math.round(v * scale))}][${a.slice(2).map(v => Math.round(v * scale))}]`
    const xml = `<hierarchy><node class="androidx.recyclerview.widget.RecyclerView" bounds="${b([0, 100, 400, 600])}">`
      + [10, 210].map(x => `<node class="android.view.ViewGroup" bounds="${b([x, 100, x + 180, 290])}"><node text="查看说明书" bounds="${b([x + 10, 210, x + 150, 240])}"/></node>`).join('') + '</node></hierarchy>'
    const frame = await sharp(Buffer.from('<svg width="400" height="500"><rect width="400" height="500" fill="white"/><path d="M20 110h140v20H20z M220 110h140v20H220z"/></svg>')).png().toBuffer()
    assert.equal((await referenceProductViewportReadiness(frame, xml, [0, 100, 400, 600].map(v => Math.round(v * scale)), { cardAspectRatios: [2] })).ready, false)
    const result = await referenceProductViewportReadiness(frame, xml, [0, 100, 400, 600].map(v => Math.round(v * scale)), { cardAspectRatios: [2], previousArtworkVerified: true })
    assert.equal(result.ready, true)
    assert.equal(result.previouslyVerifiedArtworkAboveViewport, 2)
    assert.equal(result.images, 0)
    assert.equal((await referenceProductViewportReadiness(frame, xml, [0, 100, 400, 600].map(v => Math.round(v * scale)))).ready, false)
  }
})

test('partly hidden product entry is revealed and re-resolved before a single tap; failure evidence precedes cleanup', async () => {
  for (const scale of [1, 2]) {
    const calls = [], bounds = [0, 100, 400, 700].map(v => v * scale)
    let revealed = false, opened = false
    const workflow = createReferenceProductCapture({
      log: () => {}, checkCancelled: () => {}, observer: { active: false },
      source: async () => { if (opened) throw new Error('original drawer read failure'); return '<hierarchy/>' },
      waitForVisualQuiet: async () => {},
      swipe: async (x, from, to) => { assert.ok(from > to); assert.ok(x <= bounds[2]); revealed = true; calls.push('reveal') },
      tap: async (x, y) => { assert.deepEqual([x, y], [360 * scale, 550 * scale]); opened = true; calls.push('tap') },
      saveFailureEvidence: async error => { assert.match(error.message, /original/); calls.push('evidence') },
    })
    await assert.rejects(workflow.captureReferenceProductsAtTrigger([360 * scale, 695 * scale], {
      chatBounds: bounds, triggerResolver: async () => revealed ? [360 * scale, 550 * scale] : null,
    }), error => /original drawer read failure/.test(error.message) && Boolean(error.productCleanupError))
    assert.deepEqual(calls, ['reveal', 'tap', 'evidence'])
  }
})

test('Toutiao accepts only an explicit Xiaohe app route after one entry click, before guarded hierarchy reads', async () => {
  for (const target of ['com.aurora.xiaohe.aidoctor', 'other.app']) {
    const calls = []
    const workflow = createToutiaoSearchWorkflow({
      tap: async () => calls.push('tap'), waitForVisualQuiet: async () => {}, log: () => {},
      ui: { currentApp: async () => ({ package: target }) }, getActivePackageName: () => 'com.ss.android.article.news',
      source: async () => assert.fail('host source must not read the routed application'),
      activateAnswerRoute: async packageName => { calls.push(packageName); return { xml: '<native/>' } },
    })
    if (target === 'other.app') await assert.rejects(workflow.openToutiaoFullAnswer([10, 20, 30, 40], { width: 360, height: 800 }), /错误应用/)
    else assert.equal((await workflow.openToutiaoFullAnswer([10, 20, 30, 40], { width: 360, height: 800 })).pageKind, 'xiaohe_app')
    assert.equal(calls.filter(x => x === 'tap').length, 1)
    assert.equal(calls.includes('other.app'), false)
  }
})

test('native Toutiao route verifies the original question before publishing the entry image and restores the host', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'geoauto-native-route-'))
  try {
    for (const failure of [false, true]) {
      let restored = 0, nativeCaptures = 0
      const deliveryDirectory = path.join(directory, String(failure)), diagnosticDirectory = path.join(directory, 'debug')
      const workflow = createQuestionWorkflows({ observer: {}, recoverySnapshot: () => ({}), log: () => {},
        getActiveEntry: () => ({ id: 'toutiao-xiaohe-miniapp' }), getActivePackageName: () => 'com.ss.android.article.news',
        restoreSearchEntry: async () => { restored++ }, inputToutiaoQuestion: async () => [10, 20, 30, 40], tap: async () => {},
        waitForToutiaoAnswerCard: async () => ({ size: { width: 360, height: 800 } }),
        captureToutiaoSearchSummary: async () => ({ frame: Buffer.from('entry'), viewMore: [10, 20, 30, 40] }),
        openToutiaoFullAnswer: async () => ({ pageKind: 'xiaohe_app', answerPackage: 'com.aurora.xiaohe.aidoctor', xml: '<native/>' }),
        captureToutiaoFullAnswerFrames: async () => assert.fail('must use native capture'),
        captureFullReplyFrames: async (question, _pages, options) => {
          nativeCaptures++
          assert.equal(question, '验证问题')
          assert.equal(options.singleQuestionSession, true)
          if (failure) throw new Error('原题不匹配')
          return {}
        },
        saveArtifacts: async options => { await options.captureMethod(); return {} },
      })
      const pending = workflow.askOnceToutiao({ serial: 'test', timeout: 90 }, { batchDirectory: directory, diagnosticDirectory, deliveryDirectory }, '验证问题', 1)
      if (failure) await assert.rejects(pending, /原题不匹配/)
      else await pending
      assert.equal(nativeCaptures, 1)
      assert.equal(restored, failure ? 1 : 2)
      assert.equal((await fs.readdir(deliveryDirectory)).length, failure ? 0 : 1)
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})
