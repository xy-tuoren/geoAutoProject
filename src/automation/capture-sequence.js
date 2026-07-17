class CaptureSequence {
  constructor() {
    this.pages = []
  }

  addInitial(frame) {
    if (!frame) throw new Error('首帧不能为空。')
    if (this.pages.length) throw new Error('首帧只能添加一次。')
    this.pages.push({ frame, transition: null })
    return this.pages.length
  }

  append(frame, transition) {
    if (!this.pages.length) throw new Error('添加后续帧前必须先添加首帧。')
    if (!frame) throw new Error('后续帧不能为空。')
    if (!transition || typeof transition.verified !== 'boolean') {
      throw new Error('添加后续帧时必须同时提供与上一帧的接缝状态。')
    }
    this.pages.push({ frame, transition })
    return this.pages.length
  }

  get length() { return this.pages.length }

  get lastFrame() { return this.pages.at(-1)?.frame || null }

  toCaptureResult() {
    return {
      frames: this.pages.map(item => item.frame),
      transitions: this.pages.slice(1).map(item => item.transition),
    }
  }
}

module.exports = { CaptureSequence }
