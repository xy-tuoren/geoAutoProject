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

已经停留在抖音或头条小程序全文页时，也可以复用当前回答验收正文接缝和参考药品，不会重新搜索、输入或发送。由于小程序正文不向 UI 层级暴露问题文字，命令末尾的问题只用于产物文件夹命名：

```bash
npm run run:android -- \
  --serial <设备序列号> \
  --output-dir ./captures/current-miniapp-answer \
  --entry douyin-xiaohe-miniapp \
  --capture-current-answer \
  "当前问题文字"
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

每次开始执行会新建一个时间批次目录，并将产物拆分为两部分：`交付图片/` 只包含可直接交付的正式 PNG，`调试产物/` 保存 UI 层级、质量元数据、事件日志和失败现场。多入口时两部分使用相同的入口及问题目录名，便于一一对应：

```text
captures/
  batch_20260711-235900/
    交付图片/
      01_小荷AI医生APP/              # 单入口批次省略入口层
        001_儿童腹泻脱水用什么药/
          回答_001.png               # 正文长图分片
          回答_参考药品_001.png      # 出现参考药品时保存
      02_抖音搜索框（小荷AI小程序）/
        001_儿童腹泻脱水用什么药/
          回答_智能总结.png
          回答_小程序入口.png       # 无智能总结、改走独立入口时保存
          回答_001.png
    调试产物/
      执行日志.jsonl                 # 整批事件时间线
      batch-summary.json             # 成功/失败数量和失败题索引
      01_小荷AI医生APP/
        001_儿童腹泻脱水用什么药/
          回答.xml                   # 最终 UI 层级
          回答.json                  # 截图质量、路径和验收字段
          执行日志.jsonl             # 本题完整事件时间线
        002_失败问题/
          失败.json
          执行日志.jsonl
```

`交付图片/` 不写入 XML、JSON、日志或失败截图；正式图片也不会在调试区重复保存。`回答.json` 通过绝对路径关联交付图片、XML、单题日志和批次日志，并用 `artifact_layout_version=2` 标记当前结构。抖音搜索超时等失败现场 PNG 只进入 `调试产物/`，不会污染交付内容。

`执行日志.jsonl` 每行是一条独立 JSON 事件，包含时间、顺序号、耗时、入口、问题及事件类别。回答翻页、接缝降级、引用资料、参考药品入口发现、抽屉展开、每页采集、末项确认、图片加载状态、重试和失败恢复都会形成可检索事件。排查时优先读取 `batch-summary.json` 定位失败题，再读取该题 `回答.json` 或 `失败.json`，最后按 `执行日志.jsonl` 的时间线结合 `回答.xml` 与失败现场复现判断。

截图严格按页面顺序单向执行：回答正文从上向下采集，遇到固定在回答尾部的参考药品入口后立即进入药品采集，药品完整后本题结束，不再关闭抽屉后回归或比对正文锚点。药品抽屉打开后先从标题拖拽区完全展开列表，确认全屏视口后才从首项开始截图，避免在药品内容区拖动导致第一帧落到中间卡片。随后不设置药品页数上限，持续滚动，只有连续滑动后稳定画面不再变化才确认到达末项；首屏、图片加载、列表到底或滚动接缝任一项未完成都会在尾部入口直接重试，最终仍失败则该题不算成功。超出单张长图高度时会分片保存，所有分片共同组成完整药品列表。

面板支持：

- 自动识别已授权的 ADB 手机；可在多台设备中选择一台执行
- 选择一个或多个执行入口：小荷AI医生APP、抖音搜索框（小荷AI小程序）、头条搜索框（小荷AI小程序）
- 多入口执行时按入口顺序逐个完成整批问题：先跑完第一个入口的全部问题，再切换到下一个入口
- 直接每行填写一个问题，或导入 TXT / CSV / JSON / XLSX 文件，默认读取 `问题` 列
- 按列表顺序逐题发送、等待回复稳定，并分别保存纯截图交付件与 UI XML、JSON、JSONL 调试产物
- 实时查看执行日志，并在需要时停止任务
- 可选“每题新建会话”

JSON 使用数组或 `questions` / `问题` 数组；Excel 读取第一个工作表，按界面配置的列名读取，默认列名为 `问题`。

多入口批次会在批次目录下按入口生成子目录，避免不同入口的同一问题产物互相覆盖。每题 JSON 会记录 `entry_id`、`entry_label` 和 `entry_package`，便于回溯产物来自哪个入口。

单个入口的单道题发生搜索无结果、回答超时、输入/点击不确定或截图失败时，只停止当前题，不重放有副作用的操作。失败原因写入该题调试目录的 `失败.json`，下一题开始前重新启动并校验当前入口，然后继续剩余问题和后续入口。批次结束后由 `调试产物/batch-summary.json` 汇总成功数、失败数和失败题路径。用户主动停止、ADB 设备断开或 uiautomator2 基础进程不可用仍会立即终止整个批次。

小荷 App 在发送前会强制清空并核对输入框文本；截图前必须通过右侧用户消息的气泡结构重新定位到本题，并确认气泡完整进入首屏，不能把包含同名药品的左侧回答标题误当成问题。引用资料展开后还会再次校验，否则会明确失败，绝不把旧会话或被裁掉问题文字的回答记为成功。成功元数据会记录 `reply_question_located=true` 和 `reply_question_fully_visible=true`。推荐药品入口在点击前会等待页面稳定并从最新层级刷新坐标，避免正文重排后点击旧位置；抽屉识别兼容普通窗口和华为弹窗窗口，并使用面板和列表相对竖屏高度确认全屏状态。元数据中的 `reference_products_trigger_refreshed` 记录本题是否刷新过入口坐标。抖音搜索超时会在当前题调试目录保留 `搜索超时.png` 和 `搜索超时.xml` 供本机诊断，这些采集产物仍受忽略规则保护。

抖音入口使用双路径流程：打开搜索页并搜索问题后，优先等待“小荷AI医生”智能总结卡片；出现时保存完整搜索结果页为 `回答_智能总结.png`，再点击“查看全文”。如果短暂优先等待后仍未出现智能总结，但识别到独立的“小荷AI医生”小程序入口卡片，则保存搜索页为 `回答_小程序入口.png`，按卡片标题区域的相对位置点击，并通过 `MiniAppHostActivity` 和小程序外壳强校验跳转成功。入口页会继续等待回答正文真正出现并稳定，不能把空白回答气泡当作成功。首屏没有两种结果时会有限向下扫描搜索结果；在总等待时间内两者均未出现则本题明确失败并保存搜索超时现场，批次继续后续任务。

两条路径最终都会先等待小程序回答连续 3 秒静止，再从全文顶部向下滚动并保存 `回答_001.png`。正文截图使用 ADB 原始 PNG，并根据小程序真实滚动视口排除固定的咨询人选择栏、顶部工具栏和底部输入区；相邻视口执行像素接缝校验，通过后才无缝裁掉重叠内容。顶部需要连续两次滚动无变化确认；没有参考药品时，末端也需要连续两次无变化。出现无文字的“参考药品”卡片时，脚本会按右上箭头和商品图的结构识别入口，立即进入药品终止序列：打开抖音 BottomSheet、确认首项图片已加载、持续滚动到真实末项并另存 `回答_参考药品_001.png`。入口、抽屉和商品图片均使用相对竖屏尺寸及节点层级识别，不依赖 1080×2400 固定坐标。JSON 的 `douyin_result_mode` 区分 `smart_summary` 与 `miniapp_entry_card`；入口路径额外记录 `douyin_miniapp_entry_detected`、入口截图及卡片/点击范围、宿主 Activity 和 `douyin_miniapp_entry_opened`，智能总结路径继续记录 `douyin_search_summary_captured`、`douyin_search_summary_screenshot` 和 `douyin_view_full_opened`。正文和药品验收分别记录 `reply_continuity_verified`、`reference_products_detected`、`reference_products_images_ready`、`reference_products_confirmed_end` 和 `reference_products_capture_complete`。

今日头条入口使用对应的独立搜索流程：通过头条搜索框输入并确认问题，等待“小荷AI医生·智能总结”和可点击的“查看更多”同时出现。先将完整搜索结果页保存为 `回答_智能总结.png`，再点击“查看更多”进入小荷 AI 全文页。全文首次打开后需等待连续 3 秒无画面活动，再从真实顶部向下采集并保存 `回答_001.png`；固定顶栏、底部工具栏和消息输入框不会进入长图。JSON 额外记录 `toutiao_search_summary_captured`、`toutiao_search_summary_screenshot`、`toutiao_view_more_opened`、`toutiao_full_page_confirmed_top` 和 `toutiao_full_page_confirmed_end`。

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
- UI层没有ADB降级：uiautomator2层级读取失败时只允许重启sidecar并重试一次；点击或输入失败会立即终止当前题且不重放该操作，下一题只能在重新启动并校验入口后继续。
- 正式截图始终使用ADB原始PNG，不使用uiautomator2截图接口。
- scrcpy观察器不解码、不保存也不参与拼接，只根据官方视频包的活动情况判断页面是否停稳；截图区域在滚动后必须等到最后一个活动帧后持续无活动，读取层级和截取PNG期间出现任意活动帧都会作废本次视口并重新等待重截，避免把两次生成/重排状态拼进同一张长图。只有观察器不可用、没有明确活动证据，或较慢设备的层级与PNG读取耗尽观察确认窗口时，才会记录原因并改用“ADB截图→uiautomator2层级→ADB截图”双帧夹心校验，不影响UI后端选择。
- 回答完成判定使用更严格的规则：最后一个活动帧后必须连续 3 秒没有任何新活动帧，任意单帧都会重置计时；读取最终 UI 层级期间若再出现活动帧，则继续等待而不进入截图。
- 每个普通回答接缝最多局部重采一次；若首轮仍无法通过像素连续性验证且尚未进入参考药品终止序列，会先等待最终静止并从问题顶部整题重采一次，避免把同一回答的两个文本版本拼进长图。重采后仍失败时保留下一屏完整视口并加浅色分隔，不依据不可靠的XML坐标或滚动距离裁掉文字。
- `captures/` 已被 Git 忽略，因为截图、UI XML 和元数据可能包含敏感健康信息。
- 健康问题和截图可能包含个人信息，请勿上传到公共仓库。
