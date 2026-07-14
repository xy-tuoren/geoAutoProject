# geo数据采集

这是一个通过桌面应用批量控制 Android 手机提问、截图和归档的工具。界面、任务调度和截图引擎使用 Electron/Node.js；UI 层级、点击和输入使用内置的 Python uiautomator2 sidecar，ADB 负责无损截图、长图滚动和设备连接，scrcpy server 只提供低分辨率画面活动信号以减少重复截图。

## Electron 操作面板（推荐）

开发调试环境需要 Node.js 22+ 与 uv。uv 会按 `python/.python-version` 自动准备 Python 3.11，安装包用户不需要安装 Python 或 uv。界面使用 Electron 渲染，macOS 与 Windows 的字体、间距、控件和响应式布局保持一致。

```bash
./start_electron.sh
```

Windows 开发环境在项目目录执行一次 `npm run setup`，再运行 `npm start`。`setup` 会安装 npm 依赖、准备内置 ADB，并用 uv/PyInstaller 构建 Python uiautomator2 sidecar。Electron 面板支持设备刷新、问题文件导入、目录选择、日志流、停止任务和响应式布局。

常用开发命令：

```bash
npm run setup      # 首次初始化：安装依赖及自动化运行时
npm run check      # Node 语法检查
npm test           # 自动化核心逻辑测试
npm run prepare:u2 # 构建当前平台的Python uiautomator2 sidecar
npm run prepare:scrcpy # 下载并校验官方scrcpy server
npm run dist       # 准备内置运行时并打包桌面应用
```

完整归档当前会话中已经存在的回答（不会新建会话、聚焦输入框、输入或发送问题），与正式任务使用同一流程采集回答正文、引用资料和从首项到末项的全部参考药品：

```bash
npm run run:android -- --serial <设备序列号> --output-dir ./captures/current-answer --capture-current-answer
```

使用 TXT 问题文件直接验收抖音入口：

```bash
npm run run:android -- \
  --serial <设备序列号> \
  --output-dir ./captures/douyin-test \
  --entry douyin-xiaohe-miniapp \
  --questions-file ./questions.batch.txt
```

Windows 安装包由 GitHub Actions 在 `windows-latest` 上构建。手动运行 `Build Windows` 工作流只生成可下载的 Artifact；推送 `v*` 版本标签会在测试和打包成功后自动创建或更新 GitHub Release，并上传 `.exe` 与 `.blockmap`：

```bash
git tag v0.2.0
git push origin v0.2.0
```

普通分支推送不会发布 Release。正式打标签前应先将需要发布的分支合并到稳定分支，并确认版本号尚未被其他提交使用。

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

截图严格按页面顺序单向执行：回答正文从上向下采集，遇到固定在回答尾部的参考药品入口后立即进入药品采集，药品完整后本题结束，不再关闭抽屉后回归或比对正文锚点。药品抽屉打开后先从标题拖拽区完全展开列表，确认全屏视口后才从首项开始截图，避免在药品内容区拖动导致第一帧落到中间卡片。随后不设置药品页数上限，持续滚动，只有连续滑动后稳定画面不再变化才确认到达末项；首屏、图片加载、列表到底或滚动接缝任一项未完成都会在尾部入口直接重试，最终仍失败则该题不算成功。超出单张长图高度时会分片保存，所有分片共同组成完整药品列表。

面板支持：

- 自动识别已授权的 ADB 手机；可在多台设备中选择一台执行
- 选择一个或多个执行入口：小荷AI医生APP、抖音搜索框（小荷AI小程序）、头条搜索框（小荷AI小程序）
- 多入口执行时按入口顺序逐个完成整批问题：先跑完第一个入口的全部问题，再切换到下一个入口
- 直接每行填写一个问题，或导入 TXT / CSV / JSON / XLSX 文件，默认读取 `问题` 列
- 按列表顺序逐题发送、等待回复稳定、保存每一题的截图、UI XML 和 JSON 元数据
- 实时查看执行日志，并在需要时停止任务
- 可选“每题新建会话”

JSON 使用数组或 `questions` / `问题` 数组；Excel 读取第一个工作表，按界面配置的列名读取，默认列名为 `问题`。

多入口批次会在批次目录下按入口生成子目录，避免不同入口的同一问题产物互相覆盖。每题 JSON 会记录 `entry_id`、`entry_label` 和 `entry_package`，便于回溯产物来自哪个入口。

抖音入口使用独立流程：打开抖音搜索页，在搜索框输入问题并点击搜索，等待“小荷AI医生”结果卡片。卡片稳定后先保存一张完整搜索结果页为 `回答_智能总结.png`，再点击“查看全文”，向上滚动并确认真实顶部，最后从顶部向下滚动到真实末端并保存全文长图 `回答_001.png`。正文截图使用 ADB 原始 PNG，相邻视口执行像素接缝校验；顶部和末端都需要连续两次滚动无变化才允许结束。JSON 额外记录 `douyin_search_summary_captured`、`douyin_search_summary_screenshot`、`douyin_view_full_opened`、`douyin_full_page_confirmed_top` 和 `douyin_full_page_confirmed_end`。

## 项目结构

```text
src/
  main/          # Electron 主进程和 preload
  renderer/      # 桌面面板页面、样式和交互
  automation/    # uiautomator2客户端、scrcpy观察器、ADB截图、长图拼接和UI层级解析
  questions.js   # 问题文件导入
  runtime-paths.js
  cli.js
python/          # uv管理的Python uiautomator2 sidecar、测试和PyInstaller配置
scripts/         # 打包前准备ADB、Python sidecar和scrcpy server
tests/node/      # Node 内置 test runner 测试
```

## 使用前检查

- 手机必须完成 USB 调试授权（打包版已内置 adb，无需本机安装）。
- 仓库内置 macOS 与 Windows 两套 Android Platform Tools；打包命令 `npm run dist` 会使用目标平台的ADB，并内置PyInstaller生成的Python uiautomator2 sidecar及校验过的官方scrcpy server。运营不需要安装Node、Python、uv、ADB或scrcpy客户端。
- UI层没有ADB降级：uiautomator2层级读取失败时只允许重启sidecar并重试一次；点击或输入失败会直接终止任务，避免表面成功但实际走回旧路径。
- 正式截图始终使用ADB原始PNG，不使用uiautomator2截图接口。
- scrcpy观察器不解码、不保存也不参与拼接，只根据官方视频包的活动情况判断页面是否停稳；截图区域在滚动后必须等到最后一个活动帧后持续无活动，读取层级和截取PNG期间出现任意活动帧都会作废本次视口并重新等待重截，避免把两次生成/重排状态拼进同一张长图。只有观察器不可用或没有明确活动证据时，才会记录原因并改用“ADB截图→uiautomator2层级→ADB截图”双帧夹心校验，不影响UI后端选择。
- 回答完成判定使用更严格的规则：最后一个活动帧后必须连续 3 秒没有任何新活动帧，任意单帧都会重置计时；读取最终 UI 层级期间若再出现活动帧，则继续等待而不进入截图。
- 每个普通回答接缝最多局部重采一次；若首轮仍无法通过像素连续性验证且尚未进入参考药品终止序列，会先等待最终静止并从问题顶部整题重采一次，避免把同一回答的两个文本版本拼进长图。重采后仍失败时保留下一屏完整视口并加浅色分隔，不依据不可靠的XML坐标或滚动距离裁掉文字。
- `captures/` 已被 Git 忽略，因为截图、UI XML 和元数据可能包含敏感健康信息。
- 健康问题和截图可能包含个人信息，请勿上传到公共仓库。
