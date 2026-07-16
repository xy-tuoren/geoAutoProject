const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')

const helper = path.resolve(__dirname, '../../scripts/ensure-node-runtime.sh')

function executable(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
}

function runHelper(environment) {
  return spawnSync('/bin/bash', ['-c', '. "$HELPER" && command -v node && command -v npm'], {
    encoding: 'utf8',
    env: {
      HELPER: helper,
      ...environment
    }
  })
}

test('loads the nvm default version when a non-interactive PATH lacks npm', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'node-runtime-nvm-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))

  const nvmDir = path.join(home, '.nvm')
  const binDir = path.join(nvmDir, 'versions/node/v22.23.1/bin')
  executable(path.join(binDir, 'node'), 'echo v22.23.1')
  executable(path.join(binDir, 'npm'), 'echo npm')
  fs.mkdirSync(nvmDir, { recursive: true })
  fs.writeFileSync(path.join(nvmDir, 'nvm.sh'), `export PATH="${binDir}:$PATH"\n`)

  const result = runHelper({ HOME: home, PATH: '/usr/bin:/bin' })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, new RegExp(`${binDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/node`))
  assert.match(result.stdout, new RegExp(`${binDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/npm`))
})

test('reports an actionable error when Node.js and npm cannot be resolved', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'node-runtime-missing-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))

  const result = runHelper({ HOME: home, PATH: '/usr/bin:/bin' })

  assert.equal(result.status, 127)
  assert.match(result.stderr, /找不到 Node\.js\/npm/)
  assert.match(result.stderr, /Node\.js 22\+/)
})

test('rejects Node.js versions older than the project minimum', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'node-runtime-old-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))

  const binDir = path.join(home, 'bin')
  executable(path.join(binDir, 'node'), 'echo v20.19.0')
  executable(path.join(binDir, 'npm'), 'echo npm')

  const result = runHelper({ HOME: home, PATH: `${binDir}:/usr/bin:/bin` })

  assert.equal(result.status, 1)
  assert.match(result.stderr, /需要 Node\.js 22\+/)
  assert.match(result.stderr, /v20\.19\.0/)
})
