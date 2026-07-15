# 开发、打包、发布与自动更新

本文档记录本项目从本地开发到 GitHub Release 发布的完整流程。仓库主分支功能说明仍以 `README.md` 为准；这里专门放开发部署相关操作，方便后续按步骤发版。

## 环境要求

- Node.js 22+
- npm
- uv
- Git
- Android 手机已开启 USB 调试并完成授权

安装包用户不需要安装 Node.js、Python、uv、ADB 或 scrcpy。打包时会把运行所需的 ADB、Python uiautomator2 sidecar 和 scrcpy server 一起放进应用资源。

## 本地开发

首次初始化：

```bash
npm run setup
```

启动 Electron 面板：

```bash
./start_electron.sh
```

Windows 开发环境可在项目目录执行：

```bash
npm start
```

常用命令：

```bash
npm run check
npm test
npm run prepare:u2
npm run prepare:scrcpy
npm run dist
```

命令含义：

- `npm run check`：检查 Node.js 源码语法。
- `npm test`：运行 Node 自动化核心测试。
- `npm run prepare:u2`：构建当前平台的 Python uiautomator2 sidecar。
- `npm run prepare:scrcpy`：下载并校验官方 scrcpy server。
- `npm run dist`：准备运行时并用 electron-builder 打包桌面应用。

Python sidecar 测试在 `python/` 目录中执行：

```bash
uv sync --locked
uv run --locked pytest -q
```

## 真机验收

涉及自动化状态机、滚动、截图、拼接、uiautomator2 sidecar、scrcpy 观察器或 ADB 行为的改动，单元测试通过后需要做一次真机验收。

优先复用当前已经存在的回答，不发送新问题：

```bash
npm run run:android -- \
  --serial <设备序列号> \
  --output-dir ./captures/current-answer \
  --capture-current-answer
```

验收重点：

- 没有新建会话、聚焦输入框、输入或发送问题。
- 回答正文从当前问题开始。
- 引用资料已展开，并和回答截图一起采集。
- 参考药品第一张包含首项，最后一张包含末项。
- 正文没有漏字、断字或错误裁切。
- 无法验证连续性时必须保留完整视口并明确记录降级。
- `回答.json` 中的完成字段与实际图片一致。

`captures/` 可能包含健康问题、截图、UI XML 和设备信息，已经被 Git 忽略，不要提交到公共仓库。

## 本地打包

构建当前平台安装包：

```bash
npm run dist
```

Windows NSIS 安装包：

```bash
npm run dist -- --win nsis --x64 --publish never
```

macOS DMG：

```bash
npm run dist -- --mac dmg --publish never
```

Windows 打包成功后，`dist/` 中应至少包含：

- `question-automation-electron-setup-<version>.exe`
- `question-automation-electron-setup-<version>.exe.blockmap`
- `latest.yml`

其中 `latest.yml` 是自动更新必需的元数据。Release 中缺少它时，已安装的应用无法发现新版本。

## GitHub Actions

仓库目前有两个桌面打包工作流：

- `.github/workflows/build-windows.yml`
- `.github/workflows/build-desktop.yml`

`Build Windows` 的行为：

- 手动运行 `workflow_dispatch`：构建 Windows 安装包并上传 Actions Artifact，不发布 Release。
- 推送 `v*` 标签：先测试和打包，再创建或更新 GitHub Release，并上传 `.exe`、`.blockmap`、`latest.yml`。
- 标签发布时会校验 `v<package.json version>` 是否完全匹配，不匹配会失败。

`Build macOS package` 的行为：

- 手动运行或推送 `v*` 标签：构建 macOS DMG 并上传 Actions Artifact。
- 当前 macOS 工作流不会把 DMG 上传到 GitHub Release。

## 发布 Windows 新版本

发布前确认工作区干净，并完成检查：

```bash
git status --short
npm run check
npm test
uv run --project python --locked pytest -q
git diff --check
```

更新版本号：

```bash
npm version patch --no-git-tag-version
```

也可以手动编辑 `package.json`，但标签必须与版本号一致。例如 `package.json` 版本为 `0.1.2` 时，只能发布 `v0.1.2`。

提交并推送分支：

```bash
git add package.json package-lock.json
git commit -m "chore: release v0.1.2"
git push origin <branch>
```

创建并推送标签：

```bash
git tag v0.1.2
git push origin v0.1.2
```

标签推送后，GitHub Actions 会自动：

1. 在 Windows 环境安装依赖。
2. 校验 Python lock。
3. 运行 Python 测试。
4. 运行 Node 检查和测试。
5. 校验标签和 `package.json` 版本一致。
6. 构建 NSIS 安装包。
7. 确认 `dist/latest.yml` 存在。
8. 上传 Windows Artifact。
9. 创建或更新 GitHub Release。

发布完成后检查 Release 页面是否包含：

- `question-automation-electron-setup-<version>.exe`
- `question-automation-electron-setup-<version>.exe.blockmap`
- `latest.yml`

## 自动更新机制

Windows 安装包使用 `electron-updater` 从 GitHub Releases 检查更新。

应用行为：

- 仅 Windows 打包版启用自动更新。
- 开发模式不启用自动更新。
- 启动约 3 秒后自动检查一次。
- 之后每 6 小时检查一次。
- 用户也可以点击右上角版本按钮手动检查。
- 发现新版本后不会自动下载，需要用户点击下载。
- 下载完成后需要用户点击重启并安装。
- 自动化任务执行中禁止重启安装，任务结束后再允许安装。
- 稳定版不会接收 GitHub 预发布版本。
- 当前安装包本身是预发布版本时，才会继续接收预发布更新。

重要限制：

- 第一个带自动更新能力的安装包仍然需要手动安装。
- 从下一次发布开始，已安装该版本的用户才能在应用内更新。
- Release 必须包含 `latest.yml`，否则自动更新不可用。
- Release 的标签版本必须高于用户当前安装版本。

## 乱码输入问题

Windows 包输入中文乱码时，优先检查是否走了 uiautomator2 sidecar 的输入链路，以及是否使用了兼容中文的输入策略。当前项目约束是：点击、输入和 UI 层级读取必须走 Python uiautomator2 sidecar，ADB 不能作为输入失败后的隐式降级方案。

相关检查：

- 确认 Windows 包中已包含 `vendor/u2-runtime`。
- 确认运行日志中没有回退到 ADB 文本输入。
- 确认目标应用前台包名是 `com.aurora.xiaohe.aidoctor`。
- 确认输入前后有读取输入框内容并校验。

如果复现乱码，应保存该题调试目录中的日志和 UI 层级，只分析本地文件，不上传包含健康信息的截图或 XML。

## 常见问题

普通 `git push` 会自动打包发布吗？

不会。普通分支推送只更新代码。只有推送 `v*` 标签才会触发 Windows Release 发布。

手动运行 `Build Windows` 会发 Release 吗？

不会。手动运行只生成 Actions Artifact，用于临时下载测试。

为什么 Release 里一定要有 `latest.yml`？

`electron-updater` 依赖它判断最新版本、下载地址和校验信息。没有 `latest.yml`，应用即使能访问 Release，也不会完成自动更新。

为什么标签要和 `package.json` 一致？

安装包内部版本来自 `package.json`。如果标签和内部版本不一致，用户看到的版本、Release 版本和自动更新判断会混乱，所以 workflow 会直接失败。

macOS 包会自动进 Release 吗？

当前不会。macOS workflow 只上传 Actions Artifact。如果需要 macOS 也进入 Release，需要扩展 `.github/workflows/build-desktop.yml` 的 release 上传步骤。

## 发布检查清单

- 本地功能改动已经完成。
- `npm run check` 通过。
- `npm test` 通过。
- `uv run --project python --locked pytest -q` 通过。
- 涉及真机流程时已经完成 `--capture-current-answer` 验收。
- 没有提交 `captures/`、截图、XML、健康问题或设备隐私信息。
- `package.json` 版本号已递增。
- Git tag 与版本号完全一致。
- GitHub Actions 的 Windows workflow 成功。
- Release 中存在 `.exe`、`.blockmap` 和 `latest.yml`。
- 下载链接返回正常。
