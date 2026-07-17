const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

test('Windows 安装包使用服务器 generic 更新源', () => {
  const manifest = require(path.join(__dirname, '..', '..', 'package.json'))
  assert.deepEqual(manifest.build.publish, [{
    provider: 'generic',
    url: 'http://104.168.30.172/geo-updates/win/',
  }])
})
