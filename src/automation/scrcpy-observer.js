const fs = require('node:fs')
const crypto = require('node:crypto')
const net = require('node:net')
const { execFile, spawn } = require('node:child_process')
const { sleep } = require('./utils')

const SCRCPY_VERSION = '4.1'
const MAX_PACKET_SIZE = 32 * 1024 * 1024
const MIN_ACTIVITY_PACKET_SIZE = 1024
const ACTIVITY_BURST_WINDOW_MS = 220

function frameCarriesActivity(packet) {
  // At max_size=360, encoder heartbeat/repeat packets on a pixel-stable page
  // are typically only tens or hundreds of bytes. A real viewport change is
  // materially larger; keyframes remain activity regardless of packet size.
  return Boolean(packet.keyFrame || packet.size >= MIN_ACTIVITY_PACKET_SIZE)
}

class ActivityBurstDetector {
  constructor({ windowMs = ACTIVITY_BURST_WINDOW_MS } = {}) {
    this.windowMs = windowMs
    this.lastCandidateAt = null
    this.inBurst = false
    this.lastPromotionCount = 0
  }

  push(packet, at) {
    this.lastPromotionCount = 0
    if (!frameCarriesActivity(packet)) return false
    const burst = Number.isFinite(this.lastCandidateAt)
      && Number.isFinite(at)
      && at - this.lastCandidateAt >= 0
      && at - this.lastCandidateAt <= this.windowMs
    if (burst) {
      this.lastPromotionCount = this.inBurst ? 1 : 2
      this.inBurst = true
    } else this.inBurst = false
    this.lastCandidateAt = at
    return burst
  }

  reset() {
    this.lastCandidateAt = null
    this.inBurst = false
    this.lastPromotionCount = 0
  }
}

function quietWindowState(frames, { now, startedAt, windowMs, quietMs, maxFrames }) {
  const timestamps = frames
    .map(frame => frame.at)
    .filter(at => Number.isFinite(at) && at <= now)
  const framesInWindow = timestamps.filter(at => at >= now - windowMs).length
  let quietSince = Number.isFinite(startedAt) ? Math.min(startedAt, now) : now

  // Find the end of the most recent period where the rolling window had
  // more frames than the caller tolerates. This lets a later call reuse
  // quiet time which already elapsed instead of restarting its timer.
  for (let index = maxFrames; index < timestamps.length; index += 1) {
    const oldest = timestamps[index - maxFrames]
    if (timestamps[index] - oldest <= windowMs) quietSince = Math.max(quietSince, oldest + windowMs)
  }

  const quietForMs = framesInWindow <= maxFrames ? Math.max(0, now - quietSince) : 0
  return { quiet: framesInWindow <= maxFrames && quietForMs >= quietMs, framesInWindow, quietForMs }
}

function execFileText(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${error.message}: ${String(stderr || stdout).trim()}`))
      else resolve(String(stdout).trim())
    })
  })
}

class ScrcpyPacketParser {
  constructor({ onStream = () => {}, onSession = () => {}, onFrame = () => {} } = {}) {
    this.onStream = onStream
    this.onSession = onSession
    this.onFrame = onFrame
    this.buffer = Buffer.alloc(0)
    this.pending = null
    this.codec = null
    this.session = null
  }

  push(chunk) {
    if (!chunk?.length) return
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : Buffer.from(chunk)
    this.#drain()
  }

  #drain() {
    while (true) {
      if (!this.codec) {
        if (this.buffer.length < 4) return
        this.codec = this.buffer.subarray(0, 4).toString('ascii')
        this.buffer = this.buffer.subarray(4)
        this.onStream({ codec: this.codec })
        continue
      }
      if (!this.session) {
        if (this.buffer.length < 12) return
        if ((this.buffer[0] & 0x80) === 0) throw new Error('scrcpy视频流缺少会话信息。')
        const packet = this.buffer.subarray(0, 12)
        this.buffer = this.buffer.subarray(12)
        this.session = { codec: this.codec, width: packet.readUInt32BE(4), height: packet.readUInt32BE(8) }
        this.onSession(this.session)
        continue
      }
      if (this.pending) {
        if (this.buffer.length < this.pending.size) return
        this.buffer = this.buffer.subarray(this.pending.size)
        const packet = this.pending
        this.pending = null
        if (!packet.config) this.onFrame(packet)
        continue
      }
      if (this.buffer.length < 12) return
      if ((this.buffer[0] & 0x80) !== 0) {
        const packet = this.buffer.subarray(0, 12)
        this.buffer = this.buffer.subarray(12)
        this.session = { codec: this.codec, width: packet.readUInt32BE(4), height: packet.readUInt32BE(8) }
        this.onSession(this.session)
        continue
      }
      const flagsAndPts = this.buffer.readBigUInt64BE(0)
      const size = this.buffer.readUInt32BE(8)
      if (size > MAX_PACKET_SIZE) throw new Error(`scrcpy视频包异常：${size} bytes`)
      this.buffer = this.buffer.subarray(12)
      this.pending = {
        size,
        config: Boolean(flagsAndPts & (1n << 62n)),
        keyFrame: Boolean(flagsAndPts & (1n << 61n)),
        pts: flagsAndPts & ((1n << 61n) - 1n),
      }
    }
  }
}

class ScrcpyObserver {
  constructor({ adbPath, serverPath, log = () => {}, now = Date.now, delay = sleep } = {}) {
    this.adbPath = adbPath
    this.serverPath = serverPath
    this.log = log
    this.now = now
    this.delay = delay
    this.serial = null
    this.scid = null
    this.port = null
    this.serverProcess = null
    this.socket = null
    this.session = null
    this.frames = []
    this.frameCount = 0
    this.activityFrameCount = 0
    this.burstActivityFrameCount = 0
    this.activityBurstDetector = new ActivityBurstDetector()
    this.failure = null
    this.stopping = false
    this.startedAt = null
    this.quietChecks = 0
    this.quietSuccesses = 0
    this.quietTimeouts = 0
    this.noActivityChecks = 0
    this.noActivitySuccesses = 0
    this.noActivityTimeouts = 0
    this.noActivityWaitMs = 0
    this.activityChecks = 0
    this.activitySuccesses = 0
    this.activityTimeouts = 0
    this.settleChecks = 0
    this.settleSuccesses = 0
    this.settleTimeouts = 0
    this.settleFastSuccesses = 0
    this.settleConservativeSuccesses = 0
    this.settleNoActivity = 0
    this.settleWaitMs = 0
  }

  get active() {
    return Boolean(this.socket && !this.socket.destroyed && this.session && !this.failure)
  }

  async start(serial) {
    if (this.active && this.serial === serial) return this.snapshot()
    await this.stop()
    this.stopping = false
    if (!this.adbPath || !this.serverPath || !fs.existsSync(this.serverPath)) {
      throw new Error('缺少 scrcpy server 运行时，请先执行 npm run prepare:scrcpy。')
    }
    this.serial = serial
    this.failure = null
    this.frames = []
    this.activityBurstDetector.reset()
    this.startedAt = null
    this.scid = (crypto.randomBytes(4).readUInt32BE(0) & 0x7fffffff).toString(16).padStart(8, '0')
    const remote = `/data/local/tmp/geoauto-scrcpy-server-v${SCRCPY_VERSION}.jar`
    await execFileText(this.adbPath, ['-s', serial, 'push', this.serverPath, remote])
    const localAbstract = `scrcpy_${this.scid}`
    this.port = Number(await execFileText(this.adbPath, ['-s', serial, 'forward', 'tcp:0', `localabstract:${localAbstract}`]))
    if (!Number.isInteger(this.port) || this.port <= 0) throw new Error('ADB未能为scrcpy观察器分配本地端口。')

    const args = [
      '-s', serial, 'shell', `CLASSPATH=${remote}`, 'app_process', '/',
      'com.genymobile.scrcpy.Server', SCRCPY_VERSION,
      `scid=${this.scid}`, 'log_level=warn', 'audio=false', 'control=false',
      'cleanup=false', 'tunnel_forward=true', 'send_device_meta=false',
      'send_dummy_byte=false', 'send_stream_meta=true', 'max_size=360',
      'max_fps=15', 'video_bit_rate=500000',
      'video_codec_options=repeat-previous-frame-after=0',
    ]
    this.serverProcess = spawn(this.adbPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const errors = []
    this.serverProcess.stdout.on('data', chunk => errors.push(String(chunk)))
    this.serverProcess.stderr.on('data', chunk => errors.push(String(chunk)))
    this.serverProcess.once('exit', code => {
      if (!this.stopping && this.socket && !this.socket.destroyed && code !== 0) this.#markFailed(new Error(`scrcpy server异常退出（${code}）：${errors.join('').trim()}`))
    })

    try {
      await this.#connectAndReadSession(8_000)
      this.log(`scrcpy观察器已连接：${this.session.width}x${this.session.height}，仅用于画面活动检测`)
      return this.snapshot()
    } catch (error) {
      const serverLog = errors.join('').trim()
      await this.stop()
      throw new Error(`${error.message}${serverLog ? `\nscrcpy server: ${serverLog}` : ''}`)
    }
  }

  async #connectAndReadSession(timeout) {
    const deadline = Date.now() + timeout
    let lastError
    while (Date.now() < deadline) {
      try {
        const socket = await new Promise((resolve, reject) => {
          const socket = net.createConnection({ host: '127.0.0.1', port: this.port })
          socket.once('connect', () => resolve(socket))
          socket.once('error', reject)
        })
        this.socket = socket
        await this.#readSession(Math.max(100, deadline - Date.now()))
        return
      } catch (error) {
        lastError = error
        if (this.socket && !this.socket.destroyed) this.socket.destroy()
        this.socket = null
        await this.delay(100)
      }
    }
    throw new Error(`无法完成scrcpy视频握手：${lastError?.message || '超时'}`)
  }

  #readSession(timeout) {
    return new Promise((resolve, reject) => {
      let settled = false
      let timer
      const finish = (callback, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        callback(value)
      }
      const parser = new ScrcpyPacketParser({
        onSession: session => {
          this.session = session
          this.startedAt ??= this.now()
          finish(resolve, session)
        },
        onFrame: packet => this.#recordFrame(packet),
      })
      timer = setTimeout(() => finish(reject, new Error('等待scrcpy视频会话超时。')), timeout)
      const onData = chunk => {
        try {
          parser.push(chunk)
        } catch (error) {
          if (this.session) this.#markFailed(error)
          finish(reject, error)
        }
      }
      this.socket.on('data', onData)
      this.socket.once('error', error => {
        if (!this.stopping && this.session) this.#markFailed(error)
        finish(reject, error)
      })
      this.socket.once('close', () => {
        const error = new Error('scrcpy视频通道已关闭。')
        if (!this.stopping && this.session) this.#markFailed(error)
        finish(reject, error)
      })
      // Keep the data listener after session initialization: it owns the
      // parser for the lifetime of this socket.
    })
  }

  #recordFrame(packet) {
    const at = this.now()
    const activity = frameCarriesActivity(packet)
    const burstActivity = this.activityBurstDetector.push(packet, at)
    this.frameCount += 1
    if (activity) this.activityFrameCount += 1
    if (burstActivity) this.burstActivityFrameCount += this.activityBurstDetector.lastPromotionCount
    this.frames.push({ at, size: packet.size, keyFrame: packet.keyFrame, activity, burstActivity })
    const cutoff = at - 10_000
    while (this.frames.length && this.frames[0].at < cutoff) this.frames.shift()
  }

  #markFailed(error) {
    if (!this.failure) {
      this.failure = error
      this.log(`scrcpy观察器不可用：${error.message}`)
    }
  }

  mark() {
    return {
      at: this.now(),
      frameCount: this.frameCount,
      activityFrameCount: this.activityFrameCount,
      burstActivityFrameCount: this.burstActivityFrameCount,
    }
  }

  async waitForQuiet({ timeout = 3_000, windowMs = 600, quietMs = 300, maxFrames = 2, minWaitMs = 0 } = {}) {
    if (!this.active) throw this.failure || new Error('scrcpy观察器未启动。')
    this.quietChecks += 1
    const started = this.now()
    const deadline = started + timeout
    while (true) {
      if (!this.active) throw this.failure || new Error('scrcpy观察器已断开。')
      const now = this.now()
      const activityFrames = this.frames.filter(frame => frame.activity ?? frameCarriesActivity(frame))
      const state = quietWindowState(activityFrames, {
        now,
        startedAt: this.startedAt,
        windowMs,
        quietMs,
        maxFrames,
      })
      if (state.quiet && now - started >= minWaitMs) {
        this.quietSuccesses += 1
        return { ...state, waitedMs: now - started }
      }
      if (now >= deadline) {
        this.quietTimeouts += 1
        return { ...state, quiet: false, waitedMs: now - started }
      }
      await this.delay(Math.min(50, deadline - now))
    }
  }

  async waitForNoActivity({ timeout = 6_000, quietMs = 3_000, minWaitMs = 0 } = {}) {
    if (!this.active) throw this.failure || new Error('scrcpy观察器未启动。')
    this.noActivityChecks += 1
    const started = this.now()
    const deadline = started + timeout
    while (true) {
      if (!this.active) throw this.failure || new Error('scrcpy观察器已断开。')
      const now = this.now()
      const lastActivity = this.frames.findLast(frame => frame.activity ?? frameCarriesActivity(frame))
      const lastActivityAt = Number.isFinite(lastActivity?.at)
        ? lastActivity.at
        : (Number.isFinite(this.startedAt) ? this.startedAt : started)
      const quietForMs = Math.max(0, now - lastActivityAt)
      if (quietForMs >= quietMs && now - started >= minWaitMs) {
        const waitedMs = now - started
        this.noActivitySuccesses += 1
        this.noActivityWaitMs += waitedMs
        return { quiet: true, quietForMs, lastActivityAt, waitedMs }
      }
      if (now >= deadline) {
        const waitedMs = now - started
        this.noActivityTimeouts += 1
        this.noActivityWaitMs += waitedMs
        return { quiet: false, quietForMs, lastActivityAt, waitedMs }
      }
      await this.delay(Math.min(50, deadline - now))
    }
  }

  async waitForActivity({ timeout = 1_000, since = this.mark(), minFrames = 1 } = {}) {
    if (!this.active) throw this.failure || new Error('scrcpy观察器未启动。')
    this.activityChecks += 1
    const started = this.now()
    const deadline = started + timeout
    const baseline = since.activityFrameCount ?? since.frameCount ?? this.activityFrameCount
    while (true) {
      if (!this.active) throw this.failure || new Error('scrcpy观察器已断开。')
      const now = this.now()
      const activityFrames = this.activityFrameCount - baseline
      if (activityFrames >= minFrames) {
        this.activitySuccesses += 1
        return { activity: true, activityFrames, waitedMs: now - started }
      }
      if (now >= deadline) {
        this.activityTimeouts += 1
        return { activity: false, activityFrames, waitedMs: now - started }
      }
      await this.delay(Math.min(50, deadline - now))
    }
  }

  async waitForSettleSince(since, {
    activityTimeout = 200,
    quietMs = 140,
    conservativeQuietMs = 250,
    fastTimeout = 900,
    hardTimeout = 2_500,
  } = {}) {
    if (!this.active) throw this.failure || new Error('scrcpy观察器未启动。')
    const started = this.now()
    const sinceAt = Number.isFinite(since?.at) ? since.at : started
    // The mark is taken before the ADB swipe command. Command latency must not
    // consume the observer's own wait budget, especially on slower devices.
    const deadline = started + hardTimeout
    this.settleChecks += 1
    const finish = result => {
      const waitedMs = this.now() - started
      this.settleWaitMs += waitedMs
      if (result.settled) this.settleSuccesses += 1
      else this.settleTimeouts += 1
      if (!result.activity) this.settleNoActivity += 1
      else if (result.settled && result.conservative) this.settleConservativeSuccesses += 1
      else if (result.settled) this.settleFastSuccesses += 1
      return { ...result, waitedMs }
    }

    const activity = await this.waitForActivity({ timeout: activityTimeout, since })
    if (!activity.activity) return finish({ settled: true, activity: false, conservative: false, lastActivityAt: null })

    while (true) {
      if (!this.active) throw this.failure || new Error('scrcpy观察器已断开。')
      const now = this.now()
      const activityFrames = this.frames.filter(frame => (frame.activity ?? frameCarriesActivity(frame)) && frame.at >= sinceAt && frame.at <= now)
      const lastActivityAt = activityFrames.at(-1)?.at ?? now
      const conservative = now - started >= fastTimeout
      const requiredQuietMs = conservative ? conservativeQuietMs : quietMs
      if (now - lastActivityAt >= requiredQuietMs) {
        return finish({ settled: true, activity: true, conservative, lastActivityAt, quietForMs: now - lastActivityAt })
      }
      if (now >= deadline) {
        return finish({ settled: false, activity: true, conservative: true, lastActivityAt, quietForMs: Math.max(0, now - lastActivityAt) })
      }
      await this.delay(Math.min(50, deadline - now))
    }
  }

  snapshot() {
    const now = this.now()
    const recent = this.frames.filter(frame => frame.at >= now - 1_000)
    const recentActivity = recent.filter(frame => frame.activity ?? frameCarriesActivity(frame))
    return {
      active: this.active,
      version: SCRCPY_VERSION,
      session: this.session,
      frames: this.frameCount,
      activity_frames: this.activityFrameCount,
      burst_activity_frames: this.burstActivityFrameCount,
      sparse_activity_frames: Math.max(0, this.activityFrameCount - this.burstActivityFrameCount),
      noise_frames: this.frameCount - this.activityFrameCount,
      frames_last_second: recent.length,
      activity_frames_last_second: recentActivity.length,
      bytes_last_second: recent.reduce((sum, frame) => sum + frame.size, 0),
      quiet_checks: this.quietChecks,
      quiet_successes: this.quietSuccesses,
      quiet_timeouts: this.quietTimeouts,
      no_activity_checks: this.noActivityChecks,
      no_activity_successes: this.noActivitySuccesses,
      no_activity_timeouts: this.noActivityTimeouts,
      no_activity_wait_ms: this.noActivityWaitMs,
      activity_checks: this.activityChecks,
      activity_successes: this.activitySuccesses,
      activity_timeouts: this.activityTimeouts,
      settle_checks: this.settleChecks,
      settle_successes: this.settleSuccesses,
      settle_timeouts: this.settleTimeouts,
      settle_fast_successes: this.settleFastSuccesses,
      settle_conservative_successes: this.settleConservativeSuccesses,
      settle_no_activity: this.settleNoActivity,
      settle_wait_ms: this.settleWaitMs,
      failure: this.failure?.message || null,
    }
  }

  async stop() {
    this.stopping = true
    const socket = this.socket
    this.socket = null
    this.session = null
    if (socket && !socket.destroyed) socket.destroy()
    const child = this.serverProcess
    this.serverProcess = null
    if (child && child.exitCode === null) child.kill('SIGTERM')
    if (this.port && this.adbPath && this.serial) {
      await execFileText(this.adbPath, ['-s', this.serial, 'forward', '--remove', `tcp:${this.port}`]).catch(() => {})
    }
    this.port = null
    this.frames = []
    this.activityBurstDetector.reset()
    this.startedAt = null
  }
}

module.exports = { ACTIVITY_BURST_WINDOW_MS, ActivityBurstDetector, SCRCPY_VERSION, ScrcpyPacketParser, ScrcpyObserver, frameCarriesActivity }
