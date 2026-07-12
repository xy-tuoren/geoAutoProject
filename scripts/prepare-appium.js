const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const AdmZip = require('adm-zip')
const { appiumEntry, vendorAppiumHome, vendorAppiumHomeArchive } = require('../src/runtime-paths')

const root = path.resolve(__dirname, '..')
const appiumHome = vendorAppiumHome(root)
const archive = vendorAppiumHomeArchive(root)

fs.mkdirSync(appiumHome, { recursive: true })
if (!fs.existsSync(path.join(appiumHome, 'node_modules', '.cache', 'appium', 'extensions.yaml'))) {
  const result = spawnSync(process.execPath, [appiumEntry(root), 'driver', 'install', '--source=npm', 'appium-uiautomator2-driver'], {
    cwd: root,
    env: { ...process.env, APPIUM_HOME: appiumHome },
    stdio: 'inherit',
  })
  if (result.status !== 0) process.exit(result.status || 1)
}
const zip = new AdmZip()
zip.addLocalFolder(appiumHome)
zip.writeZip(archive)
process.stdout.write(`已准备内置 UiAutomator2 驱动：${archive}\n`)
