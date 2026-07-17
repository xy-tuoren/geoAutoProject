const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { writeReplySeamDiagnostics } = require('../../src/automation/seam-diagnostics')
const { classifyAutomationLog } = require('../../src/automation/event-log')

test('接缝调试包在拼图前保存数量不变量、原始帧、层级和候选位移', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'reply-seam-diagnostic-'))
  try {
    const capture = {
      frames: [Buffer.from('frame-1'), Buffer.from('frame-2'), Buffer.from('frame-3')],
      transitions: [{ verified: false, fallbackOverlap: 0, reason: '局部内容发生变化' }],
      bounds: [0, 333, 1080, 1816],
      recaptureCount: 1,
      fallbackReasons: ['局部内容发生变化'],
      seamRecords: [{ index: 1, outcome: 'fallback', candidate_overlaps: [695, 899] }],
      scrollDecisions: [{ attempt: 2, outcome: 'candidate_appended' }],
      seamDiagnostics: [{
        index: 1,
        fromPage: 1,
        toPage: 2,
        scroll: { distance: 667, x: 907, duration_ms: 476 },
        initialMeasurement: { expected_overlap: 816, measured_shift: null },
        retryMeasurement: { expected_overlap: 816, measured_shift: null },
        firstError: Object.assign(new Error('第一次校验失败'), { candidateOverlaps: [695, 899], suggestedOverlap: 797 }),
        retryError: new Error('局部内容发生变化'),
        transition: { verified: false, fallbackOverlap: 0, reason: '局部内容发生变化' },
        previous: { frame: Buffer.from('before'), xml: '<previous />', stable: true, attempts: 1 },
        afterScroll: { frame: Buffer.from('after'), xml: '<after />', stable: false, attempts: 2, reason: 'capture_activity' },
        recapture: { frame: Buffer.from('retry'), xml: '<retry />', stable: false, attempts: 2, reason: 'capture_activity' },
      }],
    }
    const result = await writeReplySeamDiagnostics(directory, capture, () => new Date('2026-07-16T16:00:00.000Z'))
    const summary = JSON.parse(await fs.readFile(result.summary, 'utf8'))
    assert.equal(summary.frame_count, 3)
    assert.equal(summary.expected_transition_count, 2)
    assert.equal(summary.transition_count, 1)
    assert.equal(summary.frame_transition_invariant_valid, false)
    assert.equal(summary.diagnostic_directories.length, 1)
    const details = JSON.parse(await fs.readFile(summary.diagnostic_directories[0].details, 'utf8'))
    assert.deepEqual(details.first_error.candidate_overlaps, [695, 899])
    assert.equal(details.first_error.suggested_overlap, 797)
    assert.equal(await fs.readFile(details.snapshots.previous.frame, 'utf8'), 'before')
    assert.equal(await fs.readFile(details.snapshots.after_scroll.hierarchy, 'utf8'), '<after />')
    assert.equal(await fs.readFile(details.snapshots.recapture.frame, 'utf8'), 'retry')
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('接缝汇总日志形成可检索的结构化诊断事件', () => {
  const result = classifyAutomationLog('capture: 接缝汇总已保存 /tmp/接缝汇总.json（帧=22，接缝=20/21，异常证据=13组）')
  assert.deepEqual(result, {
    event: 'reply_seam_diagnostics_saved',
    category: 'diagnostic',
    details: {
      summary: '/tmp/接缝汇总.json',
      frames: 22,
      transitions: 20,
      expected_transitions: 21,
      diagnostic_groups: 13,
    },
  })
})
