const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const css = fs.readFileSync(path.join(__dirname, '../../src/renderer/styles.css'), 'utf8')

function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] || ''
}

test('顶部状态区域保留剩余宽度且状态文字完整显示', () => {
  const actions = rule('.topbar-actions')
  const status = rule('.status')

  assert.match(actions, /flex:\s*1\b/)
  assert.match(status, /white-space:\s*normal/)
  assert.match(status, /text-overflow:\s*clip/)
  assert.doesNotMatch(status, /overflow:\s*hidden/)
})

test('次要按钮禁用时使用明确的置灰样式且不响应悬停', () => {
  const disabled = rule('.secondary:disabled')

  assert.match(disabled, /color:\s*#8d99aa/)
  assert.match(disabled, /background:\s*#edf1f5/)
  assert.match(disabled, /border-color:\s*#d8dfe8/)
  assert.match(css, /\.secondary:hover:not\(:disabled\)/)
})
