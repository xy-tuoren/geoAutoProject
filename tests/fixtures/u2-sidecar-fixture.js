const readline = require('node:readline')

readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line)
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
