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

test('安装包只携带目标平台的 Android Platform Tools', () => {
  const manifest = require(path.join(__dirname, '..', '..', 'package.json'))
  assert.equal(manifest.build.extraResources.some(item => item.to?.includes('platform-tools')), false)
  assert.deepEqual(manifest.build.mac.extraResources, [{
    from: 'vendor/platform-tools/darwin',
    to: 'vendor/platform-tools/darwin',
  }])
  assert.deepEqual(manifest.build.win.extraResources, [{
    from: 'vendor/platform-tools/win32',
    to: 'vendor/platform-tools/win32',
  }])
})
