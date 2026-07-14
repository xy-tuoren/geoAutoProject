const test = require('node:test')
const assert = require('node:assert/strict')
const { ScrcpyPacketParser } = require('../../src/automation/scrcpy-observer')

function sessionPacket(width, height) {
  const packet = Buffer.alloc(12)
  packet[0] = 0x80
  packet.writeUInt32BE(width, 4)
  packet.writeUInt32BE(height, 8)
  return packet
}

function streamPacket(codec = 'h264') {
  return Buffer.from(codec, 'ascii')
}

function mediaPacket(payload, { config = false, keyFrame = false, pts = 1n } = {}) {
  const header = Buffer.alloc(12)
  let flagsAndPts = pts
  if (config) flagsAndPts |= 1n << 62n
  if (keyFrame) flagsAndPts |= 1n << 61n
  header.writeBigUInt64BE(flagsAndPts, 0)
  header.writeUInt32BE(payload.length, 8)
  return Buffer.concat([header, payload])
}

test('scrcpy包解析器兼容分片输入并忽略编码配置包', () => {
  const sessions = []
  const streams = []
  const frames = []
  const parser = new ScrcpyPacketParser({
    onStream: value => streams.push(value),
    onSession: value => sessions.push(value),
    onFrame: value => frames.push(value),
  })
  const stream = Buffer.concat([
    streamPacket(),
    sessionPacket(360, 800),
    mediaPacket(Buffer.from('config'), { config: true }),
    mediaPacket(Buffer.from('frame-one'), { keyFrame: true, pts: 123n }),
    mediaPacket(Buffer.from('two'), { pts: 456n }),
  ])
  for (let offset = 0; offset < stream.length; offset += 7) parser.push(stream.subarray(offset, offset + 7))

  assert.deepEqual(streams, [{ codec: 'h264' }])
  assert.deepEqual(sessions, [{ codec: 'h264', width: 360, height: 800 }])
  assert.equal(frames.length, 2)
  assert.deepEqual(frames.map(frame => frame.size), [9, 3])
  assert.deepEqual(frames.map(frame => frame.pts), [123n, 456n])
  assert.equal(frames[0].keyFrame, true)
})

test('scrcpy包解析器拒绝异常大包', () => {
  const parser = new ScrcpyPacketParser()
  const header = Buffer.alloc(12)
  header.writeUInt32BE(40 * 1024 * 1024, 8)
  assert.throws(() => parser.push(Buffer.concat([streamPacket(), sessionPacket(360, 800), header])), /视频包异常/)
})

test('scrcpy包解析器拒绝缺失的会话信息', () => {
  const parser = new ScrcpyPacketParser()
  assert.throws(() => parser.push(Buffer.concat([streamPacket(), Buffer.alloc(12)])), /缺少会话信息/)
})
