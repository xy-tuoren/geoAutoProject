const { adbConnectionLost } = require('./device-bridge')

class CancelledError extends Error {
  constructor() {
    super('任务已停止。')
    this.name = 'CancelledError'
  }
}

function automationErrorInfo(error) {
  const message = String(error?.message || error)
  const common = {
    technical_message: message,
    diagnostic_path: error?.diagnosticPath || null,
    batch_directory: error?.batchDirectory || null,
  }
  if (error instanceof CancelledError || error?.name === 'CancelledError' || error?.code === 'U2_STOPPED') {
    return { code: 'TASK_CANCELLED', title: '任务已停止', message: '任务已按请求停止。', action: '可使用“继续原批次”恢复未完成题。', fatal: true, ...common }
  }
  if (error?.code === 'ADB_COMMAND_TIMEOUT') {
    return {
      code: 'ADB_COMMAND_TIMEOUT',
      title: '手机指令等待超时',
      message: '手机未在规定时间内返回结果，任务已停止；未重复执行可能已生效的操作。',
      action: '请检查手机与 USB 连接，确认手机当前页面后重新开始。',
      fatal: true,
      ...common,
    }
  }
  if (adbConnectionLost(error) || /ADB 设备 .*未连接或未授权/.test(message)) {
    return {
      code: 'ADB_DISCONNECTED',
      title: '手机连接已中断',
      message: '电脑已无法通过 ADB 访问当前手机，任务已停止以避免误操作。',
      action: '请保持手机解锁，使用直连 USB 口重新连接并确认 USB 调试授权。',
      fatal: true,
      ...common,
    }
  }
  if (error?.code === 'APP_FOREGROUND_MISMATCH' || /应用启动后前台应用不正确|当前前台页面不是/.test(message)) {
    const expected = error?.details?.expected_package
    const actual = error?.details?.actual_package
    return {
      code: 'APP_NOT_FOREGROUND',
      title: '目标应用未能打开',
      message: expected && actual
        ? `尝试打开 ${expected}，但手机仍停留在 ${actual}，任务已停止。`
        : '手机当前页面与目标应用不一致，任务已停止以避免误操作。',
      action: '请确认手机已解锁且目标应用可手动打开；仍失败时查看诊断文件中的实际前台页面。',
      fatal: true,
      ...common,
    }
  }
  if (error?.name === 'U2RequestTimeoutError'
    || error?.code === 'U2_REQUEST_TIMEOUT'
    || /无法启动Python uiautomator2|Python uiautomator2(?:尚未启动|进程已退出|已停止| 请求超时)|Remote end closed connection|ECONNRESET|ECONNREFUSED|broken pipe|connection reset/i.test(message)) {
    return {
      code: 'UI_CONTROL_UNAVAILABLE',
      title: '手机控制服务未恢复',
      message: 'uiautomator2 控制服务不可用，任务已停止以避免继续操作错误页面。',
      action: '请保持手机解锁并重新连接 USB；仍失败时重启手机后再试。',
      fatal: true,
      ...common,
    }
  }
  if (/手机仍处于锁屏状态|无法可靠判断手机是否已经解锁|无法确认手机屏幕已经唤醒/.test(message)) {
    return {
      code: 'DEVICE_LOCKED',
      title: '手机尚未解锁',
      message: '无法确认手机处于已解锁且可操作状态，任务已停止。',
      action: '请点亮并解锁手机，保持在正常竖屏后重新开始。',
      fatal: true,
      ...common,
    }
  }
  const collectionErrors = [
    ['INPUT_NOT_CONFIRMED', /输入.*(?:不一致|失败|未确认)|回读.*不一致|未找到.*输入框/, '问题输入未确认', '请检查输入框和输入法；确认手机当前问题后再重试。'],
    ['QUESTION_MISMATCH', /原题|本题.*(?:气泡|匹配|顶部)|旧会话|旧问题|问题气泡/, '未确认当前题目', '请查看本题截图，确认搜索是否带入正确问题；程序不会在小程序内补发。'],
    ['EVIDENCE_NOT_EXPANDED', /引用|资料.*展开|文献.*展开/, '引用资料展开未确认', '查看引用卡片的点击前后证据；已执行的点击不会盲目重复。'],
    ['PRODUCTS_INCOMPLETE', /药品.*(?:未完成|未完整|未加载|失败|到底)|图片.*未.*加载/, '参考药品采集未完成', '查看药品首屏、图片加载和末屏证据，确认网络与药品列表后重试本题。'],
    ['SEAM_NOT_VERIFIED', /接缝|拼接/, '截图接缝未确认', '打开接缝诊断中的前后帧，确认是否有内容重排或浮层遮挡。'],
    ['ANSWER_PAGE_NOT_OPENED', /全文.*(?:未|无法)|入口.*(?:消失|仍停留|未能)|错误应用/, '未确认进入回答页面', '查看入口点击证据和实际前台页面；程序不会重复点击状态不明的入口。'],
    ['ANSWER_NOT_READY', /超时|持续变化|未出现.*正文/, '回答未在等待时间内就绪', '查看回答是否仍在生成、网络是否正常，再重试该题。'],
  ]
  for (const [code, pattern, title, action] of collectionErrors) {
    if (error?.code === code || pattern.test(message)) return { code, title, message, action, fatal: false, ...common }
  }
  if (['ENOSPC', 'EACCES', 'EROFS'].includes(error?.code)) return {
    code: 'ARTIFACT_WRITE_FAILED', title: '采集文件无法保存', message,
    action: '请检查输出目录的可用空间和写入权限，已有采集结果已保留。', fatal: true, ...common,
  }
  return {
    code: 'AUTOMATION_FAILED',
    title: '自动化任务失败',
    message,
    action: '请查看诊断文件；普通单题失败可以使用“重试失败项”。',
    fatal: false,
    ...common,
  }
}

function fatalBatchError(error) {
  return automationErrorInfo(error).fatal
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
      if (summary.question_plan_mode === 'grouped' && (
        !result.brand
        || !Number.isInteger(result.brand_index)
        || !Number.isInteger(result.question_index_in_brand)
      )) throw new Error('批次汇总中的品牌归档信息不完整，无法安全重试。')
      return result
    })
}

function retryAttemptCount(summary) {
  return Math.max(0, Number(summary?.retry_count) || 0) + 1
}

module.exports = {
  CancelledError,
  automationErrorInfo,
  fatalBatchError,
  runQuestionsWithRecovery,
  failedRetryItems,
  retryAttemptCount,
}
