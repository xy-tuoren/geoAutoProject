const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

test('语法检查通过 Node 脚本枚举文件，不依赖 shell 通配符', () => {
  const manifest = require(path.join(__dirname, '..', '..', 'package.json'))
  assert.equal(manifest.scripts.check, 'node scripts/check-syntax.js')
  assert.doesNotMatch(manifest.scripts.check, /\*/)
})
