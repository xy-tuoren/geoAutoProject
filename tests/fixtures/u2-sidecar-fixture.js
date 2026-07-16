const readline = require('node:readline')
const fs = require('node:fs')

function countedFailure(method) {
  if (method !== process.env.U2_FIXTURE_COUNTED_FAIL_METHOD) return null
  const stateFile = process.env.U2_FIXTURE_COUNTED_FAIL_STATE_FILE
  const limit = Number(process.env.U2_FIXTURE_COUNTED_FAIL_LIMIT || 0)
  if (!stateFile || !Number.isInteger(limit) || limit <= 0) return null
  const count = fs.existsSync(stateFile) ? Number(fs.readFileSync(stateFile, 'utf8')) || 0 : 0
  if (count >= limit) return null
  fs.writeFileSync(stateFile, String(count + 1))
  return process.env.U2_FIXTURE_COUNTED_FAIL_MESSAGE || 'forced counted failure'
}

readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line)
  const countedFailureMessage = countedFailure(request.method)
  if (countedFailureMessage) {
    process.stdout.write(`${JSON.stringify({ id: request.id, ok: false, error: { type: 'FixtureError', message: countedFailureMessage } })}\n`)
    return
  }
  if (request.method === process.env.U2_FIXTURE_FAIL_METHOD) {
    process.stdout.write(`${JSON.stringify({ id: request.id, ok: false, error: { type: 'FixtureError', message: 'forced failure' } })}\n`)
    return
  }
  const result = request.method === 'dump_hierarchy'
    ? '<hierarchy><node text="fixture" /></hierarchy>'
    : request.method === 'current_app'
      ? { package: 'fixture.package', activity: '.FixtureActivity', pid: 123 }
      : request.method === 'foreground_window'
        ? { package: 'fixture.package', activity: 'fixture.package.MiniAppHostActivity0' }
      : { method: request.method, params: request.params }
  process.stdout.write(`${JSON.stringify({ id: request.id, ok: true, result })}\n`)
})
