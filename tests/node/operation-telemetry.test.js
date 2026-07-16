const test = require('node:test')
const assert = require('node:assert/strict')
const { OperationTelemetry } = require('../../src/automation/operation-telemetry')

test('操作遥测记录成功、失败、耗时和可执行的优化候选', async () => {
  const ticks = [-10, 0, 10, 40, 45, 95, 100]
  const events = []
  const telemetry = new OperationTelemetry({
    now: () => ticks.shift(),
    timestamp: () => '2026-07-16T12:00:00.000Z',
    record: item => events.push(item),
  })
  telemetry.beginQuestion({ entry_id: 'douyin-xiaohe-miniapp', question_index: 1 })

  assert.equal(await telemetry.measure('ui.dump_hierarchy', async () => '<hierarchy />', {
    backend: 'uiautomator2',
    details: { read_only: true },
  }), '<hierarchy />')
  await assert.rejects(
    telemetry.measure('adb.screenshot', async () => { throw new Error('device offline') }, { backend: 'adb' }),
    /device offline/,
  )

  const report = telemetry.report({ status: 'failed' })
  assert.equal(report.status, 'failed')
  assert.equal(report.summary.operation_count, 2)
  assert.equal(report.summary.failure_count, 1)
  assert.equal(report.summary.wall_clock_ms, 100)
  assert.equal(report.operations[0].duration_ms, 30)
  assert.equal(report.operations[1].duration_ms, 50)
  assert.equal(report.operations[1].error_message, 'device offline')
  assert.equal(report.failure_analysis.failed_operation.operation, 'adb.screenshot')
  assert.equal(report.optimization_candidates[0].operation, 'adb.screenshot')
  assert.deepEqual(events.map(event => event.event), ['operation_completed', 'operation_failed'])
})

test('操作遥测按总耗时聚合并保留最近操作时间线', async () => {
  let now = 0
  const telemetry = new OperationTelemetry({ now: () => now, timestamp: () => '2026-07-16T12:00:00.000Z' })
  telemetry.beginQuestion({ question_index: 2 })
  for (const duration of [20, 30, 50]) {
    await telemetry.measure('adb.screenshot', async () => { now += duration })
  }
  const snapshot = telemetry.snapshot({ recentLimit: 2 })
  assert.equal(snapshot.summary.by_operation[0].count, 3)
  assert.equal(snapshot.summary.by_operation[0].total_ms, 100)
  assert.equal(snapshot.recent_operations.length, 2)
})

test('状态机阶段失败可直接定位但不重复计入底层操作优化耗时', async () => {
  let now = 0
  const telemetry = new OperationTelemetry({ now: () => now, timestamp: () => '2026-07-16T12:00:00.000Z' })
  telemetry.beginQuestion({ question_index: 3 })
  await telemetry.measure('adb.screenshot', async () => { now += 40 })
  await assert.rejects(telemetry.measure('capture.douyin_full_answer', async () => {
    now += 100
    throw new Error('正文区域持续变化')
  }, { kind: 'phase', backend: 'automation_state_machine' }), /持续变化/)

  const snapshot = telemetry.snapshot()
  assert.equal(snapshot.summary.operation_count, 1)
  assert.equal(snapshot.summary.total_operation_ms, 40)
  assert.equal(snapshot.failure_analysis.failed_operation.operation, 'capture.douyin_full_answer')
  assert.equal(snapshot.slowest_phases[0].duration_ms, 100)
})
