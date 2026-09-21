const test = require('node:test')
const assert = require('node:assert/strict')
const { createPreviewPlayer, avcCodec } = require('../../src/renderer/preview-player')

test('视频解码遵循 SPS 配置，旋转/缩放后适配尺寸，并释放每张解码帧', () => {
  let callbacks, decoder, released = 0, drawn = 0
  const errors = [], outputs = [], chunks = []
  class Decoder {
    constructor(value) { callbacks = value; decoder = this; this.state = 'unconfigured'; this.decodeQueueSize = 0 }
    configure(config) { this.config = config; this.state = 'configured' }
    decode(chunk) { chunks.push(chunk) }
    close() { this.state = 'closed' }
  }
  const canvas = { getContext: () => ({ drawImage() { drawn++ } }) }
  const player = createPreviewPlayer({ canvas, Decoder, Chunk: class { constructor(value) { Object.assign(this, value) } }, onFrame: v => outputs.push(v), onError: e => errors.push(e) })
  const config = new Uint8Array([0, 0, 0, 1, 103, 100, 0, 40, 0, 0, 1, 104, 1])
  assert.equal(avcCodec(config), 'avc1.640028')
  for (const [width, height] of [[540, 1200], [720, 960]]) {
    player.push({ type: 'session', codec: 'h264', width: width - 12, height, displayWidth: width * 2, displayHeight: height * 2 })
    player.push({ type: 'packet', config: true, data: config })
    player.push({ type: 'packet', data: [1], keyFrame: false, timestamp: 0 })
    const before = chunks.length
    player.push({ type: 'packet', data: [0, 0, 1, 101], keyFrame: true, timestamp: 100 })
    assert.equal(chunks.length, before + 1)
    assert.equal(decoder.config.codec, 'avc1.640028')
    assert.deepEqual(Array.from(chunks.at(-1).data.slice(0, config.length)), Array.from(config))
    callbacks.output({ displayWidth: width - 12, displayHeight: height, close() { released++ } })
    assert.deepEqual(outputs.at(-1), { width, height })
  }
  decoder.decodeQueueSize = 8
  player.push({ type: 'packet', data: [1], timestamp: 200 })
  assert.match(errors[0].message, /内存堆积/)
  assert.equal(decoder.state, 'closed')
  callbacks.output({ close() { released++ } })
  assert.equal(drawn, 2); assert.equal(released, 3)
  player.close()
})
