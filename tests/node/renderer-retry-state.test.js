const test = require('node:test')
const assert = require('node:assert/strict')
const { retryableBatchDirectory } = require('../../src/renderer/retry-state')

test('仅正常结束且存在失败题和原批次目录时允许重试失败项', () => {
  assert.equal(retryableBatchDirectory(), null)
  assert.equal(retryableBatchDirectory({ code: 0, summary: { failed: 0, batch_directory: '/batch' } }), null)
  assert.equal(retryableBatchDirectory({ code: 1, summary: { failed: 2, batch_directory: '/batch' } }), null)
  assert.equal(retryableBatchDirectory({ code: 0, summary: { failed: 2 } }), null)
  assert.equal(retryableBatchDirectory({ code: 0, summary: { failed: 2, batch_directory: '  /batch  ' } }), '/batch')
})
