const { responseTimeoutRetryTarget } = require('./hierarchy')

function retryMetadata({ detected, performed, succeeded }) {
  return {
    existing_reply_timeout_detected: detected,
    existing_reply_retry_performed: performed,
    existing_reply_retry_attempts: performed ? 1 : 0,
    existing_reply_retry_succeeded: succeeded,
  }
}

async function recoverTimedOutExistingReply({
  xml,
  chatBounds,
  timeout,
  source,
  tap,
  waitForStableReply,
  log = () => {},
  record = async () => {},
}) {
  const initialTarget = responseTimeoutRetryTarget(xml, chatBounds)
  if (!initialTarget) {
    return {
      xml,
      meta: retryMetadata({ detected: false, performed: false, succeeded: null }),
    }
  }

  await record('existing_reply_timeout_detected', {
    prompt_bounds: initialTarget.promptBounds,
    retry_bounds: initialTarget.retryBounds,
  })
  log('stage: 当前已有回答显示响应超时，正在刷新层级并执行唯一一次重试')

  // Refresh immediately before the side effect. If Compose reflows or the
  // timeout state disappears, do not tap a stale coordinate.
  const refreshedXml = await source()
  const refreshedTarget = responseTimeoutRetryTarget(refreshedXml, chatBounds)
  if (!refreshedTarget) {
    throw new Error('响应超时重试控件在点击前已经消失；为避免点击旧坐标，本次未执行重试。')
  }
  await record('existing_reply_timeout_retry_started', {
    attempt: 1,
    retry_bounds: refreshedTarget.retryBounds,
    coordinate_space: 'uiautomator2_logical_pixels',
  })
  const startedAt = Date.now()
  await tap(refreshedTarget.tap[0], refreshedTarget.tap[1])
  await record('existing_reply_timeout_retry_clicked', {
    attempt: 1,
    tap: refreshedTarget.tap,
    retry_bounds: refreshedTarget.retryBounds,
    coordinate_space: 'uiautomator2_logical_pixels',
  })
  log('stage: 已点击响应超时重试，等待回答重新生成并稳定')

  const settled = await waitForStableReply(timeout, { startedAt })
  const settledXml = settled.xml || await source()
  if (responseTimeoutRetryTarget(settledXml, chatBounds)) {
    await record('existing_reply_timeout_retry_failed', { attempt: 1, reason: 'response_timeout_visible' })
    throw new Error('当前已有回答在唯一一次重试后仍显示响应超时；为避免重复生成，本次不会第二次点击重试。')
  }
  if (settled.status !== 'stable') {
    await record('existing_reply_timeout_retry_failed', { attempt: 1, reason: settled.status || 'unknown' })
    throw new Error(`当前已有回答执行唯一一次重试后未能确认稳定（${settled.status || 'unknown'}）；本次不会第二次点击重试。`)
  }

  await record('existing_reply_timeout_retry_completed', { attempt: 1, status: settled.status })
  log('stage: 响应超时重试后的回答已稳定，继续当前已有回答采集')
  return {
    xml: settledXml,
    meta: retryMetadata({ detected: true, performed: true, succeeded: true }),
  }
}

module.exports = { recoverTimedOutExistingReply }
