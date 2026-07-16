const { adbConnectionLost } = require('./device-bridge')

class CancelledError extends Error {
  constructor() {
    super('任务已停止。')
    this.name = 'CancelledError'
  }
}

function fatalBatchError(error) {
  if (error instanceof CancelledError || error?.name === 'CancelledError') return true
  const message = String(error?.message || error)
  return adbConnectionLost(error)
    || /ADB 设备 .*未连接或未授权/.test(message)
    || /(?:无法启动|尚未启动)Python uiautomator2|Python uiautomator2(?:进程已退出|已停止)/.test(message)
}

async function runQuestionsWithRecovery({
  questions,
  beforeQuestion = async () => {},
  prepare,
  execute,
  recordFailure,
  isFatal = fatalBatchError,
  checkCancelled = () => {},
}) {
  let prepared = false
  let completed = 0
  let failed = 0
  for (const [zeroIndex, question] of questions.entries()) {
    checkCancelled()
    const index = zeroIndex + 1
    try {
      await beforeQuestion(question, index)
      if (!prepared) {
        await prepare()
        prepared = true
      }
      await execute(question, index)
      completed += 1
    } catch (error) {
      if (isFatal(error)) throw error
      prepared = false
      failed += 1
      await recordFailure(error, question, index)
    }
  }
  return { completed, failed }
}

function failedRetryItems(summary) {
  if (!summary || !Array.isArray(summary.results)) throw new Error('批次汇总缺少 results，无法识别失败题。')
  return summary.results
    .map((result, resultIndex) => ({ ...result, resultIndex }))
    .filter(result => result.status === 'failed')
    .map(result => {
      if (!result.entry_id || !result.question || !Number.isInteger(result.question_index)) {
        throw new Error('批次汇总中的失败题信息不完整，无法安全重试。')
      }
      return result
    })
}

function retryAttemptCount(summary) {
  return Math.max(0, Number(summary?.retry_count) || 0) + 1
}

module.exports = {
  CancelledError,
  fatalBatchError,
  runQuestionsWithRecovery,
  failedRetryItems,
  retryAttemptCount,
}
