const test = require('node:test')
const assert = require('node:assert/strict')
const { CaptureSequence } = require('../../src/automation/capture-sequence')

test('CaptureSequence atomically derives one transition for every frame after the first', () => {
  const sequence = new CaptureSequence()
  sequence.addInitial('first')
  sequence.append('second', { verified: true, overlap: 420 })
  sequence.append('third', { verified: false, fallbackOverlap: 0, reason: 'dynamic content' })

  assert.deepEqual(sequence.pages, [
    { frame: 'first', transition: null },
    { frame: 'second', transition: { verified: true, overlap: 420 } },
    { frame: 'third', transition: { verified: false, fallbackOverlap: 0, reason: 'dynamic content' } },
  ])
  assert.deepEqual(sequence.toCaptureResult(), {
    frames: ['first', 'second', 'third'],
    transitions: [
      { verified: true, overlap: 420 },
      { verified: false, fallbackOverlap: 0, reason: 'dynamic content' },
    ],
  })
})

test('CaptureSequence rejects every unpaired append path', () => {
  const sequence = new CaptureSequence()
  assert.throws(() => sequence.append('second', { verified: true, overlap: 10 }), /首帧/)
  sequence.addInitial('first')
  assert.throws(() => sequence.append('second', null), /接缝状态/)
  assert.throws(() => sequence.append('second', {}), /接缝状态/)
  assert.equal(sequence.length, 1)
})
