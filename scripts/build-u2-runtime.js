const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const pythonRoot = path.join(root, 'python')
const executable = process.platform === 'win32' ? 'geoauto-u2.exe' : 'geoauto-u2'
const source = path.join(pythonRoot, 'dist', 'geoauto-u2')
const destination = path.join(root, 'vendor', 'u2-runtime', `${process.platform}-${process.arch}`)

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: pythonRoot, stdio: 'inherit', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} 执行失败（退出码 ${result.status}）`)
}

run(process.env.UV_EXECUTABLE || 'uv', ['lock', '--check'])
run(process.env.UV_EXECUTABLE || 'uv', ['sync', '--locked'])
run(process.env.UV_EXECUTABLE || 'uv', ['run', '--locked', 'pyinstaller', '--noconfirm', '--clean', 'u2_runtime.spec'])

if (!fs.existsSync(path.join(source, executable))) throw new Error(`Python uiautomator2构建产物缺失：${path.join(source, executable)}`)
fs.rmSync(destination, { recursive: true, force: true })
fs.mkdirSync(path.dirname(destination), { recursive: true })
fs.cpSync(source, destination, { recursive: true })
if (process.platform !== 'win32') fs.chmodSync(path.join(destination, executable), 0o755)
process.stdout.write(`已准备Python uiautomator2运行时：${destination}\n`)
