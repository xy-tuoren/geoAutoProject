const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')
const { Worker } = require('node:worker_threads')
const { automationErrorInfo } = require('../automation/batch-recovery')
const { initializeEntryProgress, applyEntryProgress } = require('../renderer/entry-progress')

function deviceDirectory(serial) {
  const label = serial.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
  return `device-${label}-${createHash('sha256').update(serial).digest('hex').slice(0, 8)}`
}

// A worker owns one runner and Python sidecar. CPU work and cancellation stay local to that phone.
function createDeviceTasks({ runnerOptions, emit, changed = () => {}, createWorker = data => new Worker(path.join(__dirname, 'automation-worker.js'), { workerData: data }) }) {
  const tasks = new Map()
  const batchOwners = new Map()
  const snapshot = () => [...tasks.values()].map(({ serial, taskId, status, progress }) => ({ serial, taskId, status, progress }))
  function start(payload, method = 'run') {
    const serial = payload.serial
    if (typeof serial !== 'string' || !serial.trim()) throw new Error('请选择已连接的手机。')
    if (tasks.has(serial)) throw new Error(`手机 ${serial} 已有任务执行或正在收尾，请等待完成。`)
    const batchPath = payload.batchDirectory ? path.resolve(payload.batchDirectory) : null
    let batchKey = process.platform === 'win32' ? batchPath?.toLowerCase() : batchPath
    if (batchKey && batchOwners.has(batchKey)) throw new Error('该批次正在另一台手机上执行，不能同时写入。')
    const taskId = randomUUID()
    const task = { serial, taskId, status: 'running', progress: null, result: null, worker: null }
    task.done = new Promise(resolve => { task.resolve = resolve })
    tasks.set(serial, task)
    if (batchKey) batchOwners.set(batchKey, serial)
    const tagged = value => ({ ...value, serial, taskId })
    try {
      const workerPayload = { ...payload, ...(method === 'run' ? { outputDir: path.join(payload.outputDir, deviceDirectory(serial)) } : {}) }
      task.worker = createWorker({ runnerOptions, payload: workerPayload, method })
      task.worker.on('message', message => {
        if (tasks.get(serial) !== task) return
        if (message.type === 'finished') { task.result = message.value; return }
        if (message.type === 'progress') {
          if (message.value.type === 'batch_created') {
            batchKey = process.platform === 'win32' ? message.value.batch_directory.toLowerCase() : message.value.batch_directory
            batchOwners.set(batchKey, serial)
          }
          task.progress = applyEntryProgress(task.progress || initializeEntryProgress(), message.value)
        }
        if (message.type === 'log' || message.type === 'progress') emit(message.type, tagged(message.type === 'log' ? { text: message.value } : message.value))
      })
      task.worker.on('error', error => { task.result = { code: 1, error: automationErrorInfo(error) } })
      task.worker.once('exit', code => {
        const result = task.result || { code: 1, error: automationErrorInfo(new Error(`手机 ${serial} 的采集进程意外退出（${code}），请查看原批次并确认中断题。`)) }
        tasks.delete(serial)
        if (batchKey) batchOwners.delete(batchKey)
        emit('finished', tagged(result))
        task.resolve()
        changed()
      })
    } catch (error) {
      tasks.delete(serial)
      if (batchKey) batchOwners.delete(batchKey)
      task.resolve()
      throw error
    }
    emit('progress', tagged({ type: 'starting' }))
    changed()
    return { serial, taskId }
  }
  function stop(serial) {
    const selected = serial ? [tasks.get(serial)].filter(Boolean) : [...tasks.values()]
    for (const task of selected) {
      if (task.status === 'stopping') continue
      task.status = 'stopping'
      task.worker.postMessage({ type: 'stop' })
      emit('progress', { type: 'stopping', serial: task.serial, taskId: task.taskId })
    }
    changed()
    return { stopping: selected.length > 0 }
  }
  function manualInteraction(serial, interaction) {
    const task = tasks.get(serial)
    if (!task?.worker) return
    try { task.worker.postMessage({ type: 'manual-interaction', interaction }) }
    catch (error) { emit('log', { serial, taskId: task.taskId, text: `手动操作记录未送达采集进程：${error.message}\n` }) }
  }
  return { start, stop, snapshot, manualInteraction, get size() { return tasks.size }, whenIdle: () => Promise.all([...tasks.values()].map(task => task.done)) }
}

module.exports = { createDeviceTasks, deviceDirectory }
