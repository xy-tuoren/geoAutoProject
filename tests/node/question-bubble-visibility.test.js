const test = require('node:test')
const assert = require('node:assert/strict')
const sharp = require('sharp')
const { verifiedQuestionBubble } = require('../../src/automation/reply-capture')

test('首帧必须在原图绿色气泡内读到完整原题，拒绝浮层遮挡和正文同名文字', async () => {
  for (const scale of [1, 2 / 3]) {
    const frame = await sharp({ create: { width: 1080, height: 2400, channels: 3, background: '#ffffff' } })
      .composite([{ input: await sharp({ create: { width: 931, height: 190, channels: 3, background: '#00c090' } }).png().toBuffer(), left: 94, top: 520 }])
      .png().toBuffer()
    const size = { width: 1080 * scale, height: 2400 * scale }
    const viewport = [0, 326, 1080, 1967].map(v => v * scale)
    const verify = (text, bounds, question = '示例完整问题') => verifiedQuestionBubble(frame, viewport, size, question, {
      recognize: async () => ({ image: { width: 1080, height: 2400 }, results: Array.isArray(text) ? text : [{ text, confidence: 0.99, bounds }] }),
    })
    assert.ok(await verify('示例完整问题', [600, 550, 990, 610]))
    assert.ok(await verify('非酒精性脂肪肝用什么药？', [425, 550, 990, 610], '非酒精性脂肪肝用什么药？'))
    assert.ok(await verify([
      { text: '类风湿性关节炎吃金藤清痹颗粒有效', confidence: 0.99, bounds: [150, 550, 892, 602] },
      { text: '吗？', confidence: 0.76, bounds: [144, 617, 234, 680] },
    ], null, '类风湿性关节炎吃金藤清痹颗粒有效吗？'))
    assert.equal(await verify('完整问题', [600, 550, 990, 610]), null)
    assert.equal(await verify('示例完整问题', [600, 700, 990, 760]), null)
    assert.equal(await verify('示例完整问题', [600, 490, 990, 550]), null)
  }
})
