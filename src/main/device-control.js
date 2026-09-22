const { U2Client } = require('../automation/u2-client')

// Explicit user actions have a separate sidecar from the collection worker.
// One in-flight gesture per phone; never queue clicks against an old screen.
function createDeviceControl({ clientOptions, isAvailable, onInteraction = () => {}, log = () => {} }) {
  const sessions = new Map(), closing = new Set()
  function close(entry) {
    if (entry.closed) return entry.closed
    entry.stopped = true
    entry.closed = entry.client.stop()
    closing.add(entry.closed)
    entry.closed.finally(() => closing.delete(entry.closed)).catch(() => {})
    return entry.closed
  }
  function stop(serial, streamId, owner) {
    for (const [key, entry] of sessions) {
      if ((!serial || serial === key) && (!streamId || streamId === entry.streamId) && (owner === undefined || owner === entry.owner)) {
        sessions.delete(key)
        close(entry)
      }
    }
    return Promise.allSettled([...closing])
  }
  async function perform(serial, streamId, owner, action) {
    const receivedAt = Date.now()
    if (!isAvailable(serial, streamId, owner)) throw new Error('实时画面已暂停或失效，请刷新画面后操作。')
    if (!action || !['tap', 'swipe', 'long_press', 'key', 'text'].includes(action.kind)) throw new Error('不支持的手机操作。')
    if (!Number.isFinite(action.aspect) || action.aspect <= 0 || action.aspect >= 1) throw new Error('请使用正常竖屏手机画面操作。')
    if (action.kind === 'text' && (typeof action.text !== 'string' || !action.text.length || action.text.length > 10_000)) throw new Error('输入内容需为 1–10000 个字符。')
    let entry = sessions.get(serial)
    if (entry && (entry.owner !== owner || entry.streamId !== streamId)) {
      await stop(serial)
      if (!isAvailable(serial, streamId, owner)) throw new Error('手机画面已切换，请重新操作。')
      entry = sessions.get(serial)
    }
    if (!entry) {
      entry = { serial, streamId, owner, client: new U2Client(clientOptions()), busy: false, stopped: false }
      sessions.set(serial, entry)
    }
    if (entry.busy) throw new Error('上一项手机操作尚未完成，请稍后操作。')
    entry.busy = true
    let dispatched = false
    const interactionId = `${streamId}:${receivedAt}`
    try {
      await entry.client.start(serial)
      if (entry.stopped || !isAvailable(serial, streamId, owner)) throw new Error('实时画面已停止，未继续派发操作。')
      if (Date.now() - receivedAt > 5_000) {
        throw Object.assign(new Error('控制服务已连接，但这次操作等待过久，未执行。请根据当前画面重新操作。'), { code: 'CONTROL_GESTURE_EXPIRED' })
      }
      dispatched = true
      onInteraction(serial, { phase: 'started', id: interactionId, action: action.kind })
      const result = await entry.client.request('manual_control', action, { timeout: action.kind === 'text' ? 45_000 : 10_000, recover: false })
      log(`manual_control serial=${serial} action=${action.kind} completed`)
      return result
    } catch (error) {
      log(`manual_control serial=${serial} action=${action.kind} failed: ${error.message}`)
      if (!dispatched && error.code === 'CONTROL_GESTURE_EXPIRED') throw error
      // An action may have reached the phone. Close the local control channel,
      // do not replay it and do not restart the collection worker's sidecar.
      if (sessions.get(serial) === entry) sessions.delete(serial)
      await close(entry).catch(() => {})
      throw new Error(`手机操作未确认：${error.message}。请查看手机当前画面，未自动重放。`)
    } finally {
      entry.busy = false
      if (dispatched) onInteraction(serial, { phase: 'finished', id: interactionId, action: action.kind })
    }
  }
  return { perform, stop, get size() { return sessions.size + closing.size } }
}

module.exports = { createDeviceControl }
