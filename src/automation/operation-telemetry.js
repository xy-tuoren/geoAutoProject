function percentile(values, ratio) {
  if (!values.length) return 0
  const sorted = [...values].sort((first, second) => first - second)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))]
}

function roundMilliseconds(value) {
  return Number(Number(value || 0).toFixed(3))
}

function optimizationHint(operation) {
  if (operation === 'ui.dump_hierarchy') return '检查是否能复用同一稳定状态的层级，减少重复读取。'
  if (operation === 'adb.screenshot') return '检查是否能复用已确认稳定的原始 PNG，避免同一状态重复截图。'
  if (operation === 'adb.swipe') return '检查无效滚动次数、滚动距离和触点是否可以校准。'
  if (operation.startsWith('scrcpy.wait_')) return '检查活动检测是否频繁超时或进入保守等待。'
  if (operation === 'ui.ocr_recognize') return '检查 OCR 区域能否缩小，或复用同一帧的识别结果。'
  if (operation === 'ui.app_start') return '检查入口是否被重复启动，或冷启动恢复是否过多。'
  if (operation.startsWith('ui.')) return '检查设备端 UI 服务响应、重试次数和不必要的重复调用。'
  return '结合操作时间线检查调用次数、失败重试和可复用结果。'
}

function operationSummary(operations) {
  const groups = new Map()
  for (const item of operations) {
    const group = groups.get(item.operation) || { operation: item.operation, durations: [], failures: 0 }
    group.durations.push(item.duration_ms)
    if (item.outcome === 'failed') group.failures += 1
    groups.set(item.operation, group)
  }
  const byOperation = [...groups.values()].map(group => {
    const total = group.durations.reduce((sum, duration) => sum + duration, 0)
    return {
      operation: group.operation,
      count: group.durations.length,
      failures: group.failures,
      total_ms: roundMilliseconds(total),
      average_ms: Math.round(total / group.durations.length),
      p95_ms: roundMilliseconds(percentile(group.durations, 0.95)),
      max_ms: roundMilliseconds(Math.max(...group.durations)),
    }
  }).sort((first, second) => second.total_ms - first.total_ms || second.max_ms - first.max_ms)
  return {
    operation_count: operations.length,
    success_count: operations.filter(item => item.outcome === 'completed').length,
    failure_count: operations.filter(item => item.outcome === 'failed').length,
    total_operation_ms: roundMilliseconds(operations.reduce((sum, item) => sum + item.duration_ms, 0)),
    by_operation: byOperation,
  }
}

class OperationTelemetry {
  constructor({ record = () => {}, now = () => performance.now(), timestamp = () => new Date().toISOString(), maxOperations = 2_000 } = {}) {
    this.record = record
    this.now = now
    this.timestamp = timestamp
    this.maxOperations = maxOperations
    this.context = {}
    this.operations = []
    this.stages = []
    this.currentStage = null
    this.nextId = 1
    this.startedAtMs = this.now()
    this.startedAt = this.timestamp()
  }

  beginQuestion(context = {}) {
    this.context = { ...context }
    this.operations = []
    this.stages = []
    this.currentStage = null
    this.nextId = 1
    this.startedAtMs = this.now()
    this.startedAt = this.timestamp()
  }

  markStage(stage) {
    const now = this.now()
    if (this.currentStage) {
      this.stages.push({
        stage: this.currentStage.stage,
        started_at: this.currentStage.started_at,
        offset_ms: this.currentStage.offset_ms,
        duration_ms: roundMilliseconds(Math.max(0, now - this.currentStage.started_at_ms)),
      })
    }
    this.currentStage = {
      stage: String(stage),
      started_at: this.timestamp(),
      started_at_ms: now,
      offset_ms: roundMilliseconds(Math.max(0, now - this.startedAtMs)),
    }
  }

  async measure(operation, task, { backend = null, kind = 'operation', details = {} } = {}) {
    const operationId = this.nextId++
    const startedAtMs = this.now()
    const startedAt = this.timestamp()
    try {
      const result = await task()
      this.#finish({ operationId, operation, backend, kind, details, startedAtMs, startedAt, outcome: 'completed' })
      return result
    } catch (error) {
      this.#finish({
        operationId,
        operation,
        backend,
        kind,
        details,
        startedAtMs,
        startedAt,
        outcome: 'failed',
        error_name: error?.name || 'Error',
        error_message: error?.message || String(error),
      })
      throw error
    }
  }

  #finish(item) {
    const finishedAtMs = this.now()
    const finishedAt = this.timestamp()
    const completed = {
      operation_id: item.operationId,
      operation: item.operation,
      backend: item.backend,
      kind: item.kind,
      started_at: item.startedAt,
      finished_at: finishedAt,
      offset_ms: roundMilliseconds(Math.max(0, item.startedAtMs - this.startedAtMs)),
      duration_ms: roundMilliseconds(Math.max(0, finishedAtMs - item.startedAtMs)),
      outcome: item.outcome,
      ...(Object.keys(item.details || {}).length ? { details: item.details } : {}),
      ...(item.error_name ? { error_name: item.error_name, error_message: item.error_message } : {}),
    }
    this.operations.push(completed)
    if (this.operations.length > this.maxOperations) this.operations.splice(0, this.operations.length - this.maxOperations)
    this.record({
      event: completed.outcome === 'failed' ? 'operation_failed' : 'operation_completed',
      category: completed.outcome === 'failed' ? 'error' : 'performance',
      details: completed,
      context: this.context,
    })
  }

  snapshot({ recentLimit = 30 } = {}) {
    const snapshotNow = this.now()
    const measuredOperations = this.operations.filter(item => item.kind === 'operation')
    const phases = this.operations.filter(item => item.kind === 'phase')
    const summary = operationSummary(measuredOperations)
    const failedOperation = [...this.operations].reverse().find(item => item.outcome === 'failed') || null
    const slowest = [...measuredOperations].sort((first, second) => second.duration_ms - first.duration_ms).slice(0, 10)
    const total = Math.max(1, summary.total_operation_ms)
    const optimizationCandidates = summary.by_operation.slice(0, 8).map(item => ({
      ...item,
      share_of_measured_time: Number((item.total_ms / total).toFixed(4)),
      priority: item.failures > 0 || item.total_ms / total >= 0.25 || item.max_ms >= 3_000 ? 'high' : 'medium',
      hint: optimizationHint(item.operation),
    }))
    return {
      operation_telemetry_version: 1,
      started_at: this.startedAt,
      context: { ...this.context },
      summary: {
        ...summary,
        wall_clock_ms: roundMilliseconds(Math.max(0, snapshotNow - this.startedAtMs)),
      },
      failure_analysis: {
        failed_operation: failedOperation,
        operations_before_failure: failedOperation
          ? this.operations.slice(Math.max(0, this.operations.indexOf(failedOperation) - 8), this.operations.indexOf(failedOperation))
          : [],
      },
      slowest_operations: slowest,
      slowest_phases: [...phases].sort((first, second) => second.duration_ms - first.duration_ms).slice(0, 10),
      optimization_candidates: optimizationCandidates,
      stage_timeline: [
        ...this.stages,
        ...(this.currentStage ? [{
          stage: this.currentStage.stage,
          started_at: this.currentStage.started_at,
          offset_ms: this.currentStage.offset_ms,
          duration_ms: roundMilliseconds(Math.max(0, snapshotNow - this.currentStage.started_at_ms)),
          active: true,
        }] : []),
      ],
      recent_operations: this.operations.slice(-recentLimit),
    }
  }

  report({ status = 'unknown' } = {}) {
    const snapshot = this.snapshot({ recentLimit: this.maxOperations })
    return {
      created_at: this.timestamp(),
      status,
      ...snapshot,
      operations: [...this.operations],
    }
  }
}

module.exports = { OperationTelemetry, operationSummary, optimizationHint }
const { performance } = require('node:perf_hooks')
