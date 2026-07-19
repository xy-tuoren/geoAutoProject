const fs = require('node:fs/promises')
const path = require('node:path')

function classifyAutomationLog(message) {
  const text = String(message).trim()
  const page = text.match(/^capture: (推荐药品|(?:抖音|头条)?小荷AI全文)?\s*page (\d+)$/)
  if (page) {
    return {
      event: page[1] === '推荐药品' ? 'reference_products_page_captured' : 'reply_page_captured',
      category: 'capture',
      details: { page: Number(page[2]), target: page[1] || 'answer' },
    }
  }
  const drawer = text.match(/^capture: 推荐药品抽屉初始边界 sheet=([\d,]+) list=([\d,]+)$/)
  if (drawer) return { event: 'reference_products_drawer_detected', category: 'capture', details: { drawer_bounds: drawer[1].split(',').map(Number), list_bounds: drawer[2].split(',').map(Number) } }
  const expanded = text.match(/^capture: 推荐药品抽屉已先展开，列表视口=(\d+)px$/)
  if (expanded) return { event: 'reference_products_drawer_expanded', category: 'capture', details: { viewport_height: Number(expanded[1]) } }
  const products = text.match(/^capture: 推荐药品截图完成，共 (\d+) 屏，图片(.+)$/)
  if (products) return { event: 'reference_products_capture_completed', category: 'capture', details: { pages: Number(products[1]), images_status: products[2] } }
  if (/^capture: 回答滚动中发现推荐药品入口/.test(text)) return { event: 'reference_products_trigger_detected', category: 'capture', details: {} }
  if (/^capture: 推荐药品采集未完成/.test(text)) return { event: 'reference_products_capture_retry', category: 'capture', details: {} }
  if (/^capture: 推荐药品已按回答尾部顺序完整采集/.test(text)) return { event: 'reference_products_terminal_sequence_completed', category: 'capture', details: {} }
  if (/^capture: 推荐药品.*(?:确认到底|连续.*无变化)/.test(text)) return { event: 'reference_products_end_confirmed', category: 'capture', details: {} }
  const replyCompletion = text.match(/^waiting: 小荷回答底部已持续(\d+)秒不可继续滚动且内容无变化，确认生成完成（探测=(\d+)，重置=(\d+)）$/)
  if (replyCompletion) return {
    event: 'reply_completion_confirmed',
    category: 'waiting',
    details: { quiet_seconds: Number(replyCompletion[1]), probes: Number(replyCompletion[2]), resets: Number(replyCompletion[3]), method: 'persistent_scroll_end' },
  }
  const ocr = text.match(/^ocr: purpose=([^ ]+) outcome=([^ ]+) engine=([^ ]+) elapsed=(\d+)ms lines=(\d+)(.*)$/)
  if (ocr) {
    const details = { purpose: ocr[1], outcome: ocr[2], engine: ocr[3], elapsed_ms: Number(ocr[4]), recognized_lines: Number(ocr[5]) }
    for (const match of ocr[6].matchAll(/\s([a-z_]+)=([^ ]+)/g)) {
      const value = match[2]
      details[match[1]] = match[1].endsWith('_bounds') && /^\d+(?:,\d+){3}$/.test(value)
        ? value.split(',').map(Number)
        : /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : value
    }
    return { event: 'ocr_recognition', category: 'diagnostic', details }
  }
  if (/^capture: 引用资料/.test(text) || /^capture: 在回答截图前展开引用资料/.test(text)) return { event: 'evidence_capture', category: 'capture', details: {} }
  if (/^capture: 抖音小程序入口搜索页已保存/.test(text)) return { event: 'douyin_miniapp_entry_captured', category: 'capture', details: {} }
  const seamSummary = text.match(/^capture: 接缝汇总已保存 (.+)（帧=(\d+)，接缝=(\d+)\/(\d+)，异常证据=(\d+)组）$/)
  if (seamSummary) return {
    event: 'reply_seam_diagnostics_saved',
    category: 'diagnostic',
    details: {
      summary: seamSummary[1],
      frames: Number(seamSummary[2]),
      transitions: Number(seamSummary[3]),
      expected_transitions: Number(seamSummary[4]),
      diagnostic_groups: Number(seamSummary[5]),
    },
  }
  const reply = text.match(/^capture: 回答截图完成，帧=(\d+)，精确接缝=(\d+)\/(\d+)，安全重复接缝=(\d+)，重采=(\d+)，模式=([^，]+)，耗时=(\d+)ms$/)
  if (reply) return { event: 'reply_capture_completed', category: 'capture', details: { frames: Number(reply[1]), verified_seams: Number(reply[2]), total_seams: Number(reply[3]), safe_overlap_seams: Number(reply[4]), recaptures: Number(reply[5]), mode: reply[6], elapsed_ms: Number(reply[7]) } }
  if (/^capture: .*接缝无法精确校验/.test(text)) return { event: 'capture_seam_fallback', category: 'capture', details: {} }
  if (text.startsWith('stage:')) return { event: 'stage', category: 'stage', details: { stage: text.slice(6).trim() } }
  if (text.startsWith('waiting:')) return { event: 'waiting', category: 'waiting', details: { state: text.slice(8).trim() } }
  if (text.startsWith('diagnostic:')) return { event: 'diagnostic_saved', category: 'diagnostic', details: {} }
  if (text.startsWith('failed:')) return { event: 'question_failed', category: 'error', details: {} }
  if (text.startsWith('recovery:')) return { event: 'recovery', category: 'recovery', details: {} }
  if (text.startsWith('entry:')) return { event: 'entry_started', category: 'lifecycle', details: {} }
  if (/asking via /.test(text)) return { event: 'question_started', category: 'lifecycle', details: {} }
  if (text.startsWith('执行完成：')) return { event: 'batch_completed', category: 'lifecycle', details: {} }
  return { event: 'log', category: 'runtime', details: {} }
}

class EventLog {
  constructor({ filePath, scope, context = {}, now = () => new Date() }) {
    this.filePath = filePath
    this.scope = scope
    this.context = { ...context }
    this.now = now
    this.startedAt = Date.now()
    this.sequence = 0
    this.pending = Promise.resolve()
  }

  record(event, { message = null, category = 'runtime', details = {}, context = {} } = {}) {
    const createdAt = this.now()
    const item = {
      sequence: ++this.sequence,
      created_at: createdAt.toISOString(),
      elapsed_ms: Math.max(0, Date.now() - this.startedAt),
      scope: this.scope,
      event,
      category,
      ...this.context,
      ...context,
      ...(message ? { message } : {}),
      ...(Object.keys(details).length ? { details } : {}),
    }
    this.pending = this.pending.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true })
      await fs.appendFile(this.filePath, `${JSON.stringify(item)}\n`, 'utf8')
    }).catch(error => {
      this.error ||= error
    })
    return this.pending
  }

  recordMessage(message, context = {}) {
    const lines = String(message).split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    for (const line of lines) {
      const classified = classifyAutomationLog(line)
      this.record(classified.event, { message: line, category: classified.category, details: classified.details, context })
    }
    return this.pending
  }

  async flush() {
    await this.pending
    if (this.error) throw this.error
  }
}

module.exports = { EventLog, classifyAutomationLog }
