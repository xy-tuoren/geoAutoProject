(function expose(root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory()
  else root.deviceState = factory()
})(globalThis, () => {
  function createSession(draft) {
    return { draft: structuredClone(draft), taskId: null, running: false, stopping: false, importing: false,
      result: null, progress: null, logs: [], routineCount: 0, message: '待配置', connected: false }
  }
  function retainLog(session, text, kind) {
    session.logs.push({ text, kind })
    if (kind !== 'failure') session.routineCount += 1
    while (session.routineCount > 100) {
      session.logs.splice(session.logs.findIndex(item => item.kind !== 'failure'), 1)
      session.routineCount -= 1
    }
  }
  function acceptEvent(session, event) {
    if (event.type === 'starting') { session.taskId = event.taskId; session.running = true }
    if (!session.taskId) session.taskId = event.taskId
    return Boolean(event.taskId && session.taskId === event.taskId)
  }
  function screenLayout(width, height, aspects) {
    if (!aspects.length) return { screenHeight: 0, widths: [] }
    // Reserve card padding, gaps and controls (including wrapped controls in narrow cards).
    const screenHeight = Math.max(0, Math.min((width - 12 * (aspects.length - 1) - 22 * aspects.length) / aspects.reduce((sum, aspect) => sum + aspect, 0), height - 180))
    return { screenHeight, widths: aspects.map(aspect => screenHeight * aspect + 22) }
  }
  return { createSession, retainLog, acceptEvent, screenLayout }
})
