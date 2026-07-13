# 提问自动化

这是一个通过桌面应用批量控制 Android 手机提问、截图和归档的工具。界面与自动化后端均使用 Node.js；Android 自动化采用 Electron 内置 ADB、Appium 与 UiAutomator2。

## Electron 操作面板（推荐）

开发调试环境只需要 Node.js 22+。界面使用 Electron 渲染，macOS 与 Windows 的字体、间距、控件和响应式布局保持一致。

```bash
./start_electron.sh
```

Windows 开发环境执行 `npm install` 后运行 `npm start`。Electron 面板支持设备刷新、问题文件导入、目录选择、日志流、停止任务和响应式布局；底层由 Appium UiAutomator2 执行。

常用开发命令：

```bash
npm run check      # Node 语法检查
npm test           # 自动化核心逻辑测试
npm run dist       # 准备内置运行时并打包桌面应用
```

截图默认保存在 `文档/QuestionCaptures/`（macOS / Windows 均为用户文档目录下）。

每次开始执行会新建一个时间批次目录；每个问题再拥有独立子目录，避免截图、资料图和元数据混在一起：

```text
captures/
  batch_20260711-235900/
    001_儿童腹泻脱水用什么药/
      回答_001.png       # 每 3 个滚动画面拼接为一张，便于预览
      回答_002.png
      回答_资料.png      # 仅在出现资料卡时保存
      回答_参考药品_001.png  # 仅在出现参考药品时保存，每 3 屏一张
      回答.xml
      回答.json
```

参考药品采用完整视口保存：每次仅滚动约 40%，每 3 个视口无裁剪纵向堆叠。允许内容重复，但不会因重叠算法裁掉药品信息；只有确认列表到底才写入 `reference_products_confirmed_end: true`。

面板支持：

- 自动识别已授权的 ADB 手机；可在多台设备中选择一台执行
- 直接每行填写一个问题，或导入 TXT / CSV / JSON / XLSX 文件，默认读取 `问题` 列
- 按列表顺序逐题发送、等待回复稳定、保存每一题的截图、UI XML 和 JSON 元数据
- 实时查看执行日志，并在需要时停止任务
- 可选“每题新建会话”

JSON 使用数组或 `questions` / `问题` 数组；Excel 读取第一个工作表，按界面配置的列名读取，默认列名为 `问题`。

## 项目结构

```text
src/
  main/          # Electron 主进程和 preload
  renderer/      # 桌面面板页面、样式和交互
  automation/    # Appium、UiAutomator2、截图和 UI 层级解析
  questions.js   # 问题文件导入
  runtime-paths.js
  cli.js
scripts/         # 打包前准备 ADB 和 Appium 运行时
tests/node/      # Node 内置 test runner 测试
```

## 使用前检查

- 手机必须完成 USB 调试授权（打包版已内置 adb，无需本机安装）。
- 仓库内置 macOS 与 Windows 两套 Android Platform Tools；打包命令 `npm run dist` 会直接使用目标平台对应的 ADB，并内置 Appium 与 UiAutomator2 驱动。运营不需要安装 Node、Python、ADB 或 Appium。
- 首次连接手机时，Appium 会自动安装必要的辅助组件；手机需保持 USB 调试已授权。
- `captures/` 已被 Git 忽略，因为截图、UI XML 和元数据可能包含敏感健康信息。
- 健康问题和截图可能包含个人信息，请勿上传到公共仓库。
