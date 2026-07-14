const test = require('node:test')
const assert = require('node:assert/strict')
const { ActivityBurstDetector, ScrcpyObserver, ScrcpyPacketParser, frameCarriesActivity } = require('../../src/automation/scrcpy-observer')

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

test('静止检测复用调用前已经积累的安静时长', async () => {
  let now = 7_000
  const observer = new ScrcpyObserver({
    now: () => now,
    delay: async milliseconds => { now += milliseconds },
  })
  observer.socket = { destroyed: false }
  observer.session = { codec: 'h264', width: 160, height: 360 }
  observer.startedAt = 0
  observer.frames = [
    { at: 100, size: 2_000, keyFrame: true, activity: true },
    { at: 200, size: 2_000, keyFrame: false, activity: true },
  ]

  const result = await observer.waitForQuiet({ timeout: 6_000, windowMs: 1_000, quietMs: 5_000, maxFrames: 1 })

  assert.equal(result.quiet, true)
  assert.equal(result.waitedMs, 0)
  assert.ok(result.quietForMs >= 5_000)
})

test('小编码包作为静止画面噪声，关键帧始终作为活动', () => {
  assert.equal(frameCarriesActivity({ size: 1_023, keyFrame: false }), false)
  assert.equal(frameCarriesActivity({ size: 1_024, keyFrame: false }), true)
  assert.equal(frameCarriesActivity({ size: 32, keyFrame: true }), true)
})

test('零散大包和关键帧不形成画面活动突发', () => {
  const detector = new ActivityBurstDetector({ windowMs: 220 })

  assert.equal(detector.push({ size: 2_000, keyFrame: false }, 0), false)
  assert.equal(detector.push({ size: 32, keyFrame: true }, 300), false)
  assert.equal(detector.push({ size: 2_000, keyFrame: false }, 600), false)
})

test('连续大包仍被判定为真实画面活动', () => {
  const detector = new ActivityBurstDetector({ windowMs: 220 })

  assert.equal(detector.push({ size: 2_000, keyFrame: false }, 0), false)
  assert.equal(detector.push({ size: 2_000, keyFrame: false }, 100), true)
  assert.equal(detector.lastPromotionCount, 2)
  assert.equal(detector.push({ size: 32, keyFrame: true }, 180), true)
  assert.equal(detector.lastPromotionCount, 1)
})

test('二次确认即使已有静止历史也会观察指定时长', async () => {
  let now = 7_000
  const observer = new ScrcpyObserver({
    now: () => now,
    delay: async milliseconds => { now += milliseconds },
  })
  observer.socket = { destroyed: false }
  observer.session = { codec: 'h264', width: 160, height: 360 }
  observer.startedAt = 0

  const result = await observer.waitForQuiet({
    timeout: 500,
    windowMs: 250,
    quietMs: 120,
    maxFrames: 1,
    minWaitMs: 120,
  })

  assert.equal(result.quiet, true)
  assert.ok(result.waitedMs >= 120)
  assert.ok(result.waitedMs < 200)
})

test('回答静止判定遇到任意单个活动帧都重置3秒计时', async () => {
  let now = 0
  let injected = false
  const observer = new ScrcpyObserver({
    now: () => now,
    delay: async milliseconds => {
      now += milliseconds
      if (!injected && now >= 2_000) {
        injected = true
        observer.activityFrameCount += 1
        observer.frames.push({ at: now, size: 2_000, keyFrame: false, activity: true })
      }
    },
  })
  observer.socket = { destroyed: false }
  observer.session = { codec: 'h264', width: 162, height: 360 }
  observer.startedAt = 0

  const result = await observer.waitForNoActivity({ timeout: 8_000, quietMs: 3_000 })

  assert.equal(result.quiet, true)
  assert.equal(result.lastActivityAt, 2_000)
  assert.equal(result.waitedMs, 5_000)
  assert.equal(result.quietForMs, 3_000)
})

test('回答静止判定复用调用前已经累积的零活动时长', async () => {
  let now = 5_000
  const observer = new ScrcpyObserver({
    now: () => now,
    delay: async milliseconds => { now += milliseconds },
  })
  observer.socket = { destroyed: false }
  observer.session = { codec: 'h264', width: 162, height: 360 }
  observer.startedAt = 0
  observer.frames = [{ at: 1_000, size: 2_000, keyFrame: false, activity: true }]

  const result = await observer.waitForNoActivity({ timeout: 2_000, quietMs: 3_000 })

  assert.equal(result.quiet, true)
  assert.equal(result.waitedMs, 0)
  assert.equal(result.quietForMs, 4_000)
})

test('回答最终层级确认即使已有静止历史也会观察最短窗口', async () => {
  let now = 5_000
  const observer = new ScrcpyObserver({
    now: () => now,
    delay: async milliseconds => { now += milliseconds },
  })
  observer.socket = { destroyed: false }
  observer.session = { codec: 'h264', width: 162, height: 360 }
  observer.startedAt = 0

  const result = await observer.waitForNoActivity({ timeout: 500, quietMs: 300, minWaitMs: 120 })

  assert.equal(result.quiet, true)
  assert.ok(result.waitedMs >= 120)
  assert.ok(result.waitedMs < 200)
})

test('活动等待在新活动帧到达后立即返回', async () => {
  let now = 1_000
  const observer = new ScrcpyObserver({
    now: () => now,
    delay: async milliseconds => {
      now += milliseconds
      if (now >= 1_150) observer.activityFrameCount += 1
    },
  })
  observer.socket = { destroyed: false }
  observer.session = { codec: 'h264', width: 160, height: 360 }
  const since = observer.mark()

  const result = await observer.waitForActivity({ timeout: 600, since })

  assert.equal(result.activity, true)
  assert.equal(result.activityFrames, 1)
  assert.equal(result.waitedMs, 150)
  assert.equal(observer.snapshot().activity_successes, 1)
})

test('停止和重启观察器不会清空批次累计指标', async () => {
  const observer = new ScrcpyObserver()
  observer.frameCount = 12
  observer.activityFrameCount = 5
  observer.quietChecks = 3

  await observer.stop()

  const snapshot = observer.snapshot()
  assert.equal(snapshot.frames, 12)
  assert.equal(snapshot.activity_frames, 5)
  assert.equal(snapshot.quiet_checks, 3)
})

test('活动等待超时会返回可观测结果', async () => {
  let now = 0
  const observer = new ScrcpyObserver({
    now: () => now,
    delay: async milliseconds => { now += milliseconds },
  })
  observer.socket = { destroyed: false }
  observer.session = { codec: 'h264', width: 160, height: 360 }

  const result = await observer.waitForActivity({ timeout: 120 })

  assert.equal(result.activity, false)
  assert.equal(result.waitedMs, 120)
  assert.equal(observer.snapshot().activity_timeouts, 1)
})

test('滑动静止检测按最后活动帧快速返回', async () => {
  let now = 1_000
  const observer = new ScrcpyObserver({
    now: () => now,
    delay: async milliseconds => {
      now += milliseconds
      if ([1_050, 1_100, 1_150].includes(now)) {
        observer.activityFrameCount += 1
        observer.frames.push({ at: now, size: 2_000, keyFrame: false, activity: true })
      }
    },
  })
  observer.socket = { destroyed: false }
  observer.session = { codec: 'h264', width: 160, height: 360 }
  const since = observer.mark()

  const result = await observer.waitForSettleSince(since, {
    activityTimeout: 200,
    quietMs: 140,
    fastTimeout: 900,
    hardTimeout: 2_500,
  })

  assert.equal(result.settled, true)
  assert.equal(result.activity, true)
  assert.equal(result.conservative, false)
  assert.equal(result.lastActivityAt, 1_150)
  assert.equal(result.waitedMs, 300)
})

test('长动画超过快速窗口后使用保守静止阈值', async () => {
  let now = 0
  const observer = new ScrcpyObserver({
    now: () => now,
    delay: async milliseconds => {
      now += milliseconds
      if (now <= 1_000) {
        observer.activityFrameCount += 1
        observer.frames.push({ at: now, size: 2_000, keyFrame: false, activity: true })
      }
    },
  })
  observer.socket = { destroyed: false }
  observer.session = { codec: 'h264', width: 160, height: 360 }
  const since = observer.mark()

  const result = await observer.waitForSettleSince(since, {
    activityTimeout: 200,
    quietMs: 140,
    conservativeQuietMs: 250,
    fastTimeout: 900,
    hardTimeout: 2_500,
  })

  assert.equal(result.settled, true)
  assert.equal(result.conservative, true)
  assert.equal(result.lastActivityAt, 1_000)
  assert.equal(result.waitedMs, 1_250)
})

test('快速窗口从静止等待开始计算而不是从滑动命令开始', async () => {
  let now = 1_500
  const observer = new ScrcpyObserver({
    now: () => now,
    delay: async milliseconds => { now += milliseconds },
  })
  observer.socket = { destroyed: false }
  observer.session = { codec: 'h264', width: 160, height: 360 }
  observer.activityFrameCount = 1
  observer.frames = [{ at: 1_400, size: 2_000, keyFrame: false, activity: true }]

  const result = await observer.waitForSettleSince({ at: 0, frameCount: 0, activityFrameCount: 0 }, {
    quietMs: 140,
    conservativeQuietMs: 250,
    fastTimeout: 900,
  })

  assert.equal(result.settled, true)
  assert.equal(result.conservative, false)
  assert.equal(result.waitedMs, 50)
})

test('滑动没有产生画面活动时短等待后返回', async () => {
  let now = 0
  const observer = new ScrcpyObserver({
    now: () => now,
    delay: async milliseconds => { now += milliseconds },
  })
  observer.socket = { destroyed: false }
  observer.session = { codec: 'h264', width: 160, height: 360 }

  const result = await observer.waitForSettleSince(observer.mark(), { activityTimeout: 200 })

  assert.equal(result.settled, true)
  assert.equal(result.activity, false)
  assert.equal(result.waitedMs, 200)
  assert.equal(observer.snapshot().settle_no_activity, 1)
})

test('持续活动超过硬上限时返回静止超时', async () => {
  let now = 0
  const observer = new ScrcpyObserver({
    now: () => now,
    delay: async milliseconds => {
      now += milliseconds
      observer.activityFrameCount += 1
      observer.frames.push({ at: now, size: 2_000, keyFrame: false, activity: true })
    },
  })
  observer.socket = { destroyed: false }
  observer.session = { codec: 'h264', width: 160, height: 360 }

  const result = await observer.waitForSettleSince(observer.mark(), {
    activityTimeout: 100,
    fastTimeout: 200,
    hardTimeout: 500,
  })

  assert.equal(result.settled, false)
  assert.equal(result.waitedMs, 500)
  assert.equal(observer.snapshot().settle_timeouts, 1)
})

test('静止硬上限从实际开始等待时计算', async () => {
  let now = 1_000
  const observer = new ScrcpyObserver({
    now: () => now,
    delay: async milliseconds => {
      now += milliseconds
      observer.activityFrameCount += 1
      observer.frames.push({ at: now, size: 2_000, keyFrame: false, activity: true })
    },
  })
  observer.socket = { destroyed: false }
  observer.session = { codec: 'h264', width: 160, height: 360 }

  const result = await observer.waitForSettleSince({ at: 0, frameCount: 0, activityFrameCount: 0 }, {
    activityTimeout: 100,
    fastTimeout: 200,
    hardTimeout: 500,
  })

  assert.equal(result.settled, false)
  assert.equal(result.waitedMs, 500)
})
