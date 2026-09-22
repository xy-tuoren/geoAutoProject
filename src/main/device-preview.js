const { ScrcpyObserver } = require('../automation/scrcpy-observer')

function createDevicePreview({ adbPath, serverPath, log = () => {}, onClose = () => {}, createObserver = options => new ScrcpyObserver(options) }) {
  const streams = new Map(), closing = new Set()
  function close(entry) {
    if (entry.closed) return entry.closed
    entry.controller.abort()
    clearTimeout(entry.watchdog)
    entry.closed = Promise.allSettled([entry.ready, entry.observer.stop(), onClose(entry.serial, entry.streamId, entry.owner)]).then(() => entry.observer.stop())
    closing.add(entry.closed)
    entry.closed.finally(() => closing.delete(entry.closed)).catch(() => {})
    return entry.closed
  }
  function stop(serial, streamId, owner) {
    for (const [key, entry] of streams) {
      if ((!serial || key === serial) && (!streamId || entry.streamId === streamId) && (owner === undefined || owner === entry.owner)) {
        streams.delete(key)
        close(entry)
      }
    }
    return Promise.allSettled([...closing])
  }
  function start(serial, streamId, owner, send) {
    const previous = streams.get(serial)
    if (previous?.streamId === streamId && previous.owner === owner) return previous.ready
    const entry = { serial, streamId, owner, controller: new AbortController(), awaiting: new Set(), sequence: 0 }
    const current = () => streams.get(serial) === entry && !entry.controller.signal.aborted
    const emit = event => { if (current()) send({ serial, streamId, ...event }) }
    const fail = error => {
      if (!current()) return
      log(`scrcpy预览停止 ${serial}: ${error.message}`)
      try { emit({ type: 'error', message: `实时预览已停止：${error.message}。请检查连接后点击“刷新设备”。` }) }
      finally { void stop(serial, streamId, owner) }
    }
    entry.observer = createObserver({ adbPath: adbPath(), serverPath: serverPath(), log,
      onVideoSession: session => emit({ type: 'session', ...session }),
      onVideoPacket: packet => {
        if (!current()) return
        // Bound IPC memory when the renderer is slow or gone; never drop dependent H.264 frames silently.
        if (entry.awaiting.size >= 8 || packet.size > 4 * 1024 * 1024) return fail(new Error('画面处理跟不上视频流'))
        const sequence = ++entry.sequence
        entry.awaiting.add(sequence)
        if (!entry.watchdog) entry.watchdog = setTimeout(() => fail(new Error('界面未响应视频数据')), 5_000)
        emit({ type: 'packet', sequence, config: packet.config, keyFrame: packet.keyFrame, timestamp: Number(packet.pts), data: packet.data })
      }, onFailure: fail,
    })
    streams.set(serial, entry)
    entry.ready = (async () => {
      if (previous) await close(previous)
      if (!current()) return
      try { await entry.observer.start(serial, { signal: entry.controller.signal }) }
      catch (error) { fail(error) }
    })()
    return entry.ready
  }
  function acknowledge(serial, streamId, sequence, owner) {
    const entry = streams.get(serial)
    if (!entry || entry.streamId !== streamId || entry.owner !== owner || !entry.awaiting.delete(sequence)) return
    if (!entry.awaiting.size) { clearTimeout(entry.watchdog); entry.watchdog = null }
  }
  function isActive(serial, streamId, owner) {
    const entry = streams.get(serial)
    return Boolean(entry && entry.streamId === streamId && entry.owner === owner && !entry.controller.signal.aborted && entry.sequence > 0)
  }
  return { start, stop, acknowledge, isActive, get size() { return streams.size + closing.size } }
}

module.exports = { createDevicePreview }
