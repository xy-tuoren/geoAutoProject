(function expose(root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory()
  else root.previewPlayer = factory()
})(globalThis, () => {
  function avcCodec(data) {
    for (let i = 0; i + 6 < data.length; i++) {
      if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1 && (data[i + 3] & 31) === 7) {
        return `avc1.${Array.from(data.subarray(i + 4, i + 7), byte => byte.toString(16).padStart(2, '0')).join('')}`
      }
    }
    return null
  }

  function createPreviewPlayer({ canvas, onFrame, onError, Decoder = globalThis.VideoDecoder, Chunk = globalThis.EncodedVideoChunk }) {
    if (!Decoder || !Chunk) throw new Error('当前运行环境不支持实时视频解码，请使用最新版桌面应用')
    let decoder, session, config = new Uint8Array(), needsKey = true, closed = false, configuring = false
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) throw new Error('无法创建视频显示画布')
    function close() {
      closed = true
      if (decoder && decoder.state !== 'closed') decoder.close()
      config = new Uint8Array()
    }
    function fail(error) { if (!closed) { close(); onError(error) } }
    function reset() {
      if (decoder && decoder.state !== 'closed') decoder.close()
      decoder = new Decoder({ error: fail, output: frame => {
        try {
          if (closed) return
          // Android encoders round video dimensions; restore the display's aspect ratio for presentation.
          const width = session.displayWidth > 0 && session.displayHeight > 0
            ? Math.round(frame.displayHeight * session.displayWidth / session.displayHeight) : frame.displayWidth
          if (canvas.width !== width || canvas.height !== frame.displayHeight) {
            canvas.width = width; canvas.height = frame.displayHeight
          }
          context.drawImage(frame, 0, 0, canvas.width, canvas.height)
          onFrame({ width: canvas.width, height: canvas.height })
        } catch (error) { fail(error) }
        finally { frame.close() }
      } })
      needsKey = true
    }
    function push(event) {
      if (closed) return
      try {
        if (event.type === 'session') {
          if (event.codec !== 'h264' || event.width <= 0 || event.height <= 0) throw new Error('手机返回了不支持的视频格式')
          session = event; config = new Uint8Array(); configuring = false; reset(); return
        }
        if (event.type !== 'packet') return
        if (!session) throw new Error('视频数据缺少尺寸信息')
        let data = new Uint8Array(event.data)
        if (event.config) {
          if (!configuring) { config = new Uint8Array(); reset(); configuring = true }
          if (config.length + data.length > 65_536) throw new Error('视频编码配置异常')
          const combined = new Uint8Array(config.length + data.length)
          combined.set(config); combined.set(data, config.length); config = combined
          return
        }
        if (needsKey) {
          if (!event.keyFrame) return
          const codec = avcCodec(config) || avcCodec(data)
          if (!codec) throw new Error('视频关键帧缺少 H.264 编码配置')
          decoder.configure({ codec, optimizeForLatency: true })
          const combined = new Uint8Array(config.length + data.length)
          combined.set(config); combined.set(data, config.length); data = combined
          needsKey = false; configuring = false
        }
        if (decoder.decodeQueueSize >= 8) throw new Error('视频解码过慢，已暂停预览以防止内存堆积')
        decoder.decode(new Chunk({ type: event.keyFrame ? 'key' : 'delta', timestamp: event.timestamp, data }))
      } catch (error) { fail(error) }
    }
    return { push, close }
  }
  return { avcCodec, createPreviewPlayer }
})
