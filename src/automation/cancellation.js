const { AsyncLocalStorage } = require('node:async_hooks')
const { setTimeout } = require('node:timers/promises')

// One signal follows the whole async task, including nested capture helpers.
// Cleanup runs outside this context so cancelling cannot prevent power restore.
const context = new AsyncLocalStorage()
function cancellationSignal() { return context.getStore() || undefined }
function withCancellation(signal, task) { return context.run(signal, task) }
function checkCancellation() { cancellationSignal()?.throwIfAborted() }
async function cancellableSleep(milliseconds, signal = cancellationSignal()) {
  signal?.throwIfAborted()
  try { await setTimeout(milliseconds, undefined, { signal }) }
  catch (error) { if (signal?.aborted) throw signal.reason; throw error }
}

module.exports = { cancellationSignal, withCancellation, checkCancellation, cancellableSleep }
