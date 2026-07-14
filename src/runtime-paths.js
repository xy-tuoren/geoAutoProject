const fs = require('node:fs')
const path = require('node:path')

function projectRoot() {
  return path.resolve(__dirname, '..')
}

function adbExecutableName() {
  return process.platform === 'win32' ? 'adb.exe' : 'adb'
}

function bundledAssetsRoot({ isPackaged = false, resourcesPath = '', root = projectRoot() } = {}) {
  return isPackaged ? resourcesPath : root
}

function bundledPlatformToolsDirectory(options = {}) {
  return path.join(bundledAssetsRoot(options), 'vendor', 'platform-tools', process.platform)
}

function bundledAdbPath(options = {}) {
  return path.join(bundledPlatformToolsDirectory(options), adbExecutableName())
}

function resolveAdbPath(options = {}) {
  const bundled = bundledAdbPath(options)
  return fs.existsSync(bundled) ? bundled : (process.env.ADBUTILS_ADB_PATH || adbExecutableName())
}

function u2RuntimePlatformDirectory(options = {}) {
  const platform = options.platform || process.platform
  const arch = options.arch || process.arch
  return path.join(bundledAssetsRoot(options), 'vendor', 'u2-runtime', `${platform}-${arch}`)
}

function u2ExecutableName(platform = process.platform) {
  return platform === 'win32' ? 'geoauto-u2.exe' : 'geoauto-u2'
}

function bundledU2Executable(options = {}) {
  const platform = options.platform || process.platform
  return path.join(u2RuntimePlatformDirectory(options), u2ExecutableName(platform))
}

function pythonProjectDirectory(root = projectRoot()) {
  return path.join(root, 'python')
}

module.exports = {
  projectRoot,
  adbExecutableName,
  bundledAssetsRoot,
  bundledPlatformToolsDirectory,
  bundledAdbPath,
  resolveAdbPath,
  u2RuntimePlatformDirectory,
  u2ExecutableName,
  bundledU2Executable,
  pythonProjectDirectory,
}
