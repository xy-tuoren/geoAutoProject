(function attachRetryState(root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  if (root) root.retryState = api
})(typeof globalThis === 'undefined' ? this : globalThis, () => {
  function retryableBatchDirectory({ code = 0, summary } = {}) {
    if (Number(code) !== 0 || Number(summary?.failed) <= 0) return null
    const directory = typeof summary?.batch_directory === 'string' ? summary.batch_directory.trim() : ''
    return directory || null
  }

  return { retryableBatchDirectory }
})
