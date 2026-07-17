const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createArtifactWriter, ARTIFACT_LAYOUT_VERSION } = require('../../src/automation/artifact-writer')

test('帧与接缝数量不一致时先写接缝汇总再抛出拼图错误', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'artifact-writer-seams-'))
  const artifacts = {
    deliveryDirectory: path.join(root, '交付图片', '001_测试'),
    diagnosticDirectory: path.join(root, '调试产物', '001_测试'),
  }
  const writer = createArtifactWriter({
    defaultCaptureMethod: async () => ({
      frames: [Buffer.from('first'), Buffer.from('second')],
      transitions: [],
      bounds: [0, 333, 1080, 1816],
      recaptureCount: 0,
      fullRetryCount: 0,
      fallbackReasons: [],
      productDetected: false,
      products: null,
      productCaptureAttempts: 0,
      productCaptureMs: 0,
      seamRecords: [],
      seamDiagnostics: [],
      scrollDecisions: [{ outcome: 'unpaired_frame_appended' }],
    }),
    getMaxLongImageHeight: () => 12_000,
    screenshot: async () => Buffer.from('screen'),
    normalizedHierarchy: async () => '<hierarchy />',
    observerMetadata: () => ({}),
    getBatchEventLog: () => null,
    log: () => {},
  })
  try {
    let thrown
    await assert.rejects(async () => {
      try {
        await writer.saveArtifacts({ artifacts, stem: '回答', question: '测试', status: 'stable' })
      } catch (error) {
        thrown = error
        throw error
      }
    }, /每对相邻截图都必须提供接缝状态/)
    assert.equal(ARTIFACT_LAYOUT_VERSION, 5)
    assert.ok(thrown.replySeamDiagnostics)
    const summary = JSON.parse(await fs.readFile(path.join(artifacts.diagnosticDirectory, '接缝汇总.json'), 'utf8'))
    assert.equal(summary.frame_count, 2)
    assert.equal(summary.transition_count, 0)
    assert.equal(summary.expected_transition_count, 1)
    assert.equal(summary.frame_transition_invariant_valid, false)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
