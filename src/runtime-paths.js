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

function bundledAdbPath(options = {}) {
  return path.join(bundledAssetsRoot(options), 'vendor', 'platform-tools', adbExecutableName())
}

function resolveAdbPath(options = {}) {
  const bundled = bundledAdbPath(options)
  return fs.existsSync(bundled) ? bundled : (process.env.ADBUTILS_ADB_PATH || adbExecutableName())
}

function vendorAppiumHome(root = projectRoot()) {
  return path.join(root, 'vendor', 'appium-home')
}

function vendorAppiumHomeArchive(root = projectRoot()) {
  return path.join(root, 'vendor', 'appium-home.zip')
}

function appiumEntry(root = projectRoot()) {
  return path.join(root, 'node_modules', 'appium', 'build', 'lib', 'main.js')
}

module.exports = {
  projectRoot,
  adbExecutableName,
  bundledAssetsRoot,
  bundledAdbPath,
  resolveAdbPath,
  vendorAppiumHome,
  vendorAppiumHomeArchive,
  appiumEntry,
}
