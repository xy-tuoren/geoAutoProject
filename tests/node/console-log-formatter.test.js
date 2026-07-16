const test = require('node:test')
const assert = require('node:assert/strict')
const { ConsoleLogFormatter } = require('../../src/automation/console-log-formatter')

test('控制台按单题分组并折叠重复生成提示和逐页日志', () => {
  const formatter = new ConsoleLogFormatter()
  assert.equal(formatter.format('[1/1 1/14] task ready via 小荷AI医生APP: 测试问题'), null)
  assert.equal(formatter.format('[1/1 1/14] asking via 小荷AI医生APP: 测试问题'), '\n[1/14] 小荷AI医生APP｜测试问题')
  assert.equal(formatter.format('waiting: reply still generating…'), '  等待  回答生成中…')
  assert.equal(formatter.format('waiting: reply still generating…'), null)
  assert.equal(formatter.format('capture: page 1'), null)
  assert.equal(formatter.format('capture: page 12'), null)
  assert.equal(formatter.format('stage: 正在输入问题'), '  阶段  正在输入问题')
})

test('控制台把完成 JSON 压缩为交付和性能文件摘要', () => {
  const formatter = new ConsoleLogFormatter()
  const line = JSON.stringify({
    screenshot: '/tmp/batch/交付图片/001_测试/回答_001.png',
    hierarchy: '/tmp/batch/调试产物/001_测试/回答.xml',
    metadata: '/tmp/batch/调试产物/001_测试/回答.json',
    performance: '/tmp/batch/调试产物/001_测试/性能分析.json',
  })
  assert.equal(formatter.format(line), '  完成  001_测试/回答_001.png｜性能 001_测试/性能分析.json')
})

test('错误、恢复和关键截图汇总不被控制台过滤', () => {
  const formatter = new ConsoleLogFormatter()
  assert.equal(formatter.format('failed: [1/1 1/14] 小荷 / 问题: 点击失败'), '  失败  点击失败')
  assert.match(formatter.format('capture: 回答截图完成，帧=6，精确接缝=5/5，安全重复接缝=0，重采=0，模式=verified_overlap_long_image，耗时=39767ms'), /6屏.*接缝5\/5.*39\.8s/)
  assert.equal(formatter.format('[uiautomator2] Traceback (most recent call last):'), '[uiautomator2] Traceback (most recent call last):')
})
