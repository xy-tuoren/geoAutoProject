const { parentPort, workerData } = require('node:worker_threads')
const { createRunner } = require('../automation/runner')
const { automationErrorInfo } = require('../automation/batch-recovery')

const send = (type, value) => parentPort.postMessage({ type, value })
const runner = createRunner({ ...workerData.runnerOptions,
  log: text => send('log', text),
  progress: value => send('progress', value),
})
parentPort.on('message', message => {
  if (message.type === 'stop') void runner.stop().catch(error => send('log', `错误：停止控制服务失败：${error.message}\n`))
})
process.on('exit', () => {
  try { runner.restoreDevicePowerOnProcessExit() } catch {}
})

async function main() {
  try {
    const summary = await runner[workerData.method](workerData.payload)
    send('finished', { code: 0, summary, retried: workerData.method !== 'run' })
  } catch (error) {
    const info = automationErrorInfo(error)
    send('log', `${info.code === 'TASK_CANCELLED' ? '停止' : '错误'}：${info.title}｜${info.message}\n处理：${info.action}${info.diagnostic_path ? `\n诊断：${info.diagnostic_path}` : ''}\n`)
    send('finished', { code: info.code === 'TASK_CANCELLED' ? 130 : 1, error: info, summary: error.batchSummary, retried: workerData.method !== 'run' })
  } finally { parentPort.close() }
}
void main()
