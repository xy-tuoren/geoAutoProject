const test = require('node:test')
const assert = require('node:assert/strict')
const { hasAppLimitedNotice, resultQuality } = require('../../src/automation/result-quality')
const { diagnosticError } = require('../../src/automation/failure-diagnostics')
const { automationErrorInfo } = require('../../src/automation/batch-recovery')
const { replayRecognition } = require('../../src/automation/recognition-replay')

test('应用提示、仅搜索结果和待核图独立分类，不把系统校验冒充人工验收', () => {
  assert.equal(hasAppLimitedNotice('有一条消息暂时无法展示，请下载 APP 查看'), true)
  assert.equal(hasAppLimitedNotice('你有一条消息暂时无法展示，请下载小荷AI医\n生APP查看本消息全部内容'), true)
  assert.equal(hasAppLimitedNotice('正常回答'), false)
  assert.equal(resultQuality({ app_limited_notice: true }).result_label, '成功：应用限制提示')
  assert.equal(resultQuality({ search_result_only: true }).content_type, 'search_results_only')
  assert.equal(resultQuality({ reply_continuity_verified: false }).quality_status, 'needs_review')
  assert.equal(resultQuality({}).human_reviewed, false)
})

test('错误归档保留稳定错误码与底层原因，引用失败提供具体处理建议', () => {
  const cause = Object.assign(new Error('native'), { code: 'REMOTE', details: { method: 'click' } })
  const error = Object.assign(new Error('引用资料标题已点击一次，但未确认展开', { cause }), { code: 'EVIDENCE_NOT_EXPANDED' })
  assert.equal(diagnosticError(error).cause.code, 'REMOTE')
  assert.deepEqual(diagnosticError(error).cause.details, { method: 'click' })
  assert.equal(automationErrorInfo(error).code, 'EVIDENCE_NOT_EXPANDED')
})

test('头条入口证据在两种竖屏尺度上离线重放，缺少品牌时拒绝通用全文按钮', () => {
  for (const [width, height] of [[1080, 2400], [720, 1600]]) {
    const scale = width / 1080
    const item = (text, bounds) => ({ text, normalizedText: require('../../src/automation/ocr').normalizeOcrText(text), confidence: 0.99, bounds: bounds.map(x => x * scale) })
    const recognition = { image: { width, height }, results: [item('小荷AI医生·智能总结', [120, 430, 650, 490]), item('查看全文', [400, 1000, 680, 1070])] }
    const evidence = { purpose: 'toutiao_answer_card', recognition, logical_size: { width, height } }
    assert.equal(replayRecognition(evidence).matched, true)
    recognition.results.shift()
    assert.equal(replayRecognition(evidence).matched, false)
  }
})
