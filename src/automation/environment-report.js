const os = require('node:os')
const { adbCommand } = require('./device-bridge')
const { diagnosticError } = require('./failure-diagnostics')

async function captureEnvironment(adbPath, serial, entries) {
  const read = async args => {
    try { return { status: 'captured', value: await adbCommand(adbPath, serial, args, { timeout: 5_000 }) } }
    catch (error) { return { status: 'failed', error: diagnosticError(error) } }
  }
  const props = ['ro.product.manufacturer', 'ro.product.model', 'ro.build.version.release', 'ro.build.version.incremental', 'ro.miui.ui.version.name', 'ro.build.fingerprint']
  const [properties, ...applications] = await Promise.all([
    read(['shell', 'getprop']),
    ...entries.map(entry => read(['shell', 'dumpsys', 'package', entry.packageName || entry.package])),
  ])
  return {
    created_at: new Date().toISOString(), tool_version: require('../../package.json').version,
    computer: { platform: process.platform, architecture: process.arch, release: os.release(), node: process.versions.node, electron: process.versions.electron || null },
    device: properties.status === 'captured' ? Object.fromEntries(props.map(key => [key, properties.value.split('\n').find(line => line.startsWith(`[${key}]:`))?.split(']: [')[1]?.replace(/\]\s*$/, '') || null])) : properties,
    applications: applications.map((item, index) => ({ entry_id: entries[index].id, package: entries[index].packageName || entries[index].package,
      ...(item.status === 'captured' ? { status: 'captured', version_name: item.value.match(/versionName=(\S+)/)?.[1] || null, version_code: item.value.match(/versionCode=(\d+)/)?.[1] || null } : item),
    })),
  }
}
module.exports = { captureEnvironment }
