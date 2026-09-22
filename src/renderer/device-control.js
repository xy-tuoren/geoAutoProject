(function expose(root, factory) {
  root.deviceControl = factory()
})(globalThis, () => {
  function attach({ card, available, invoke }) {
    const { canvas, element } = card
    let busy = false, gesture = null, wheelAt = 0
    const toolbar = document.createElement('div')
    toolbar.className = 'device-control-toolbar'
    toolbar.setAttribute('aria-label', `${card.serial} 手机操作`)
    const message = document.createElement('span')
    message.className = 'device-control-message'
    message.setAttribute('role', 'status')
    const editor = document.createElement('form')
    editor.className = 'device-text-entry'
    editor.hidden = true
    const input = document.createElement('textarea')
    input.rows = 3
    input.maxLength = 10000
    input.placeholder = '先点击手机输入框，再输入文字'
    input.setAttribute('aria-label', `写入 ${card.serial} 的文字`)
    const submit = document.createElement('button')
    submit.type = 'submit'; submit.className = 'secondary'; submit.textContent = '写入手机'
    editor.append(input, submit)

    const buttons = []
    const ready = () => available() && !busy && canvas.width > 0 && canvas.height > canvas.width
    function refresh() {
      const enabled = ready()
      buttons.forEach(button => { button.disabled = !enabled })
      submit.disabled = !enabled
      canvas.setAttribute('aria-disabled', String(!enabled))
      canvas.classList.toggle('is-controllable', enabled)
      if (!available()) { gesture = null; editor.hidden = true }
    }
    async function send(action) {
      if (!ready()) return false
      const streamId = card.streamId
      busy = true; message.textContent = '操作中…'; refresh()
      try {
        await invoke(streamId, { ...action, aspect: canvas.width / canvas.height })
        if (card.streamId === streamId) message.textContent = ''
        return true
      } catch (error) {
        if (card.streamId === streamId) {
          message.textContent = (error.message || '手机操作失败').replace(/^Error invoking remote method 'automation:device-control': (?:Error: )?/, '')
          message.title = message.textContent
        }
        return false
      } finally { busy = false; refresh() }
    }
    for (const [label, symbol, key] of [['返回', '←', 'back'], ['主页', '⌂', 'home'], ['最近任务', '▢', 'recent'], ['输入文字', 'T', null]]) {
      const button = document.createElement('button')
      button.type = 'button'; button.className = 'icon-button small'
      button.title = label; button.setAttribute('aria-label', `${card.serial} ${label}`)
      button.textContent = symbol
      button.addEventListener('click', () => {
        if (key) void send({ kind: 'key', key })
        else { editor.hidden = !editor.hidden; if (!editor.hidden) input.focus() }
      })
      toolbar.append(button); buttons.push(button)
    }
    toolbar.append(message)
    element.querySelector('.device-screen').after(toolbar)
    element.append(editor)
    editor.addEventListener('submit', async event => {
      event.preventDefault()
      if (!input.value || !ready()) return
      input.disabled = true
      try {
        if (await send({ kind: 'text', text: input.value })) { input.value = ''; editor.hidden = true }
      } finally { input.disabled = false }
    })
    editor.addEventListener('keydown', event => { if (event.key === 'Escape') { editor.hidden = true; canvas.focus() } })

    // object-fit: contain may leave letterboxing; map only the actual image.
    function point(event) {
      const rect = canvas.getBoundingClientRect()
      const scale = Math.min(rect.width / canvas.width, rect.height / canvas.height)
      const width = canvas.width * scale, height = canvas.height * scale
      const x = (event.clientX - rect.left - (rect.width - width) / 2) / width
      const y = (event.clientY - rect.top - (rect.height - height) / 2) / height
      return Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null
    }
    canvas.tabIndex = 0
    canvas.title = '点击操作 · 拖动滑动 · 按住后松开长按 · 滚轮浏览；采集中也可操作'
    canvas.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !event.isPrimary || !ready()) return
      const start = point(event)
      if (!start) return
      event.preventDefault(); canvas.focus()
      gesture = { start, pointerId: event.pointerId, time: performance.now(), streamId: card.streamId, aspect: canvas.width / canvas.height }
      canvas.setPointerCapture(event.pointerId)
    })
    canvas.addEventListener('pointerup', event => {
      const current = gesture; gesture = null
      if (!current || current.pointerId !== event.pointerId) return
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
      if (!ready() || current.streamId !== card.streamId || current.aspect !== canvas.width / canvas.height) return
      const end = point(event)
      if (!end) return
      const elapsed = performance.now() - current.time
      const distance = Math.hypot(end.x - current.start.x, (end.y - current.start.y) / current.aspect)
      if (distance > 0.025) void send({ kind: 'swipe', start: current.start, end, duration: Math.max(100, Math.min(1500, elapsed)) })
      else void send({ kind: elapsed >= 550 ? 'long_press' : 'tap', point: current.start })
    })
    for (const name of ['pointercancel', 'lostpointercapture', 'blur']) canvas.addEventListener(name, () => { gesture = null })
    canvas.addEventListener('contextmenu', event => { event.preventDefault(); void send({ kind: 'key', key: 'back' }) })
    canvas.addEventListener('wheel', event => {
      event.preventDefault()
      if (!ready() || !event.deltaY || performance.now() - wheelAt < 450) return
      wheelAt = performance.now()
      const down = event.deltaY > 0
      void send({ kind: 'swipe', start: { x: 0.5, y: down ? 0.75 : 0.3 }, end: { x: 0.5, y: down ? 0.3 : 0.75 }, duration: 300 })
    }, { passive: false })
    canvas.addEventListener('keydown', event => {
      const key = { Escape: 'back', Home: 'home', Enter: 'enter', Backspace: 'delete' }[event.key]
      if (!key || event.repeat) return
      event.preventDefault(); void send({ kind: 'key', key })
    })
    refresh()
    return { refresh }
  }
  return { attach }
})
