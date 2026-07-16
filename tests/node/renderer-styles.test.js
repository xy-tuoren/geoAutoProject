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
