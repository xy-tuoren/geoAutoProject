const path = require('node:path')

function seconds(milliseconds) {
  return `${(Number(milliseconds) / 1_000).toFixed(1)}s`
}

function shortFile(file) {
  if (!file) return null
  return `${path.basename(path.dirname(file))}/${path.basename(file)}`
}

class ConsoleLogFormatter {
  constructor() {
    this.generatingShown = false
  }

  format(message) {
    const text = String(message).trim()
    if (!text) return null
    if (/^\[\d+\/\d+ \d+\/\d+\] task ready via /.test(text)) return null

    const asking = text.match(/^\[\d+\/\d+ (\d+)\/(\d+)\] asking via (.+?): (.+)$/)
    if (asking) {
      this.generatingShown = false
      return `\n[${asking[1]}/${asking[2]}] ${asking[3]}｜${asking[4]}`
    }

    const entry = text.match(/^entry: \[(\d+)\/(\d+)\] (.+?) package=/)
    if (entry) return `\n入口 ${entry[1]}/${entry[2]}｜${entry[3]}`

    const stage = text.match(/^stage:\s*(.+)$/)
    if (stage) return `  阶段  ${stage[1]}`

    if (/^waiting: reply still generating/.test(text)) {
      if (this.generatingShown) return null
      this.generatingShown = true
      return '  等待  回答生成中…'
    }
    if (/^waiting: scrcpy已检测到回答画面开始变化/.test(text)) {
      this.generatingShown = true
      return '  等待  已检测到回答开始生成'
    }
    const stable = text.match(/^waiting: .*连续(\d+)秒无变化，回答稳定$/)
    if (stable) return `  等待  回答稳定｜连续${stable[1]}秒无变化`
    if (/^waiting: 仅检测聊天内容区域 /.test(text)) return `  区域  ${text.slice('waiting: '.length)}`
    if (text.startsWith('waiting:')) return `  等待  ${text.slice('waiting:'.length).trim()}`

    if (/^capture: (?:推荐药品|(?:抖音|头条)?小荷AI全文)?\s*page \d+$/.test(text)) return null

    const top = text.match(/^capture: .*确认到达本题顶部（向上滚动=(\d+)，耗时=(\d+)ms）$/)
    if (top) return `  定位  已到顶部｜上滑${top[1]}次｜${seconds(top[2])}`
    if (/^capture: 已连续两次向下滚动无变化，确认到达回答底部/.test(text)) return '  定位  已到回答底部｜连续2次无变化'
    if (/^capture: 第一次向下滚动无变化/.test(text)) return null

    const ocr = text.match(/^ocr: purpose=([^ ]+) outcome=([^ ]+) engine=([^ ]+) elapsed=(\d+)ms(.*)$/)
    if (ocr) {
      const outcome = ocr[2] === 'matched' ? '发现目标' : ocr[2] === 'not_found' ? '未发现目标' : ocr[2]
      return `  OCR   ${ocr[1]}｜${outcome}｜${seconds(ocr[4])}`
    }

    const bounds = text.match(/^capture: chat bounds=([^（]+)(.*)$/)
    if (bounds) return `  区域  正文截图 ${bounds[1]}${bounds[2]}`

    const seamSummary = text.match(/^capture: 接缝汇总已保存 .+（帧=(\d+)，接缝=(\d+)\/(\d+)，异常证据=(\d+)组）$/)
    if (seamSummary) return `  诊断  接缝汇总｜${seamSummary[1]}帧｜接缝${seamSummary[2]}/${seamSummary[3]}｜异常证据${seamSummary[4]}组`

    const completed = text.match(/^capture: 回答截图完成，帧=(\d+)，精确接缝=(\d+)\/(\d+)，安全重复接缝=(\d+)，重采=(\d+)，模式=([^，]+)，耗时=(\d+)ms$/)
    if (completed) {
      const fallback = Number(completed[4]) ? `｜安全重复${completed[4]}` : ''
      const recapture = Number(completed[5]) ? `｜重采${completed[5]}` : ''
      return `  截图  ${completed[1]}屏｜接缝${completed[2]}/${completed[3]}${fallback}${recapture}｜${seconds(completed[7])}`
    }

    if (/^capture: 回答滚动过程中未发现参考\/推荐药品入口/.test(text)) return '  药品  未发现参考/推荐药品入口'

    if (text.startsWith('{') && text.endsWith('}')) {
      try {
        const result = JSON.parse(text)
        if (result.screenshot) {
          const performance = shortFile(result.performance)
          return `  完成  ${shortFile(result.screenshot)}${performance ? `｜性能 ${performance}` : ''}`
        }
      } catch {}
    }

    const failed = text.match(/^failed: .*?: (.+)$/)
    if (failed) return `  失败  ${failed[1]}`
    if (text.startsWith('retry failed:')) return `  失败  ${text.slice('retry failed:'.length).trim()}`
    if (text.startsWith('recovery:')) return `  恢复  ${text.slice('recovery:'.length).trim()}`
    if (text.startsWith('diagnostic:')) return `  诊断  ${text.slice('diagnostic:'.length).trim()}`
    if (text.startsWith('capture:')) return `  截图  ${text.slice('capture:'.length).trim()}`
    return text
  }
}

module.exports = { ConsoleLogFormatter, shortFile }
