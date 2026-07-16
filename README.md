# geo数据采集

这是一个通过桌面应用批量控制 Android 手机提问、截图和归档的工具。界面、任务调度和截图引擎使用 Electron/Node.js；UI 层级、点击和输入使用内置的 Python uiautomator2 sidecar，ADB 负责无损截图、长图滚动和设备连接，scrcpy server 只提供低分辨率画面活动信号以减少重复截图。对于画面已经显示、但 WebView/Canvas 未向 UI 层级暴露的文字，sidecar 还提供本地 RapidOCR 通用识别能力。

## Electron 操作面板（推荐）

开发调试环境需要 Node.js 22+ 与 uv。uv 会按 `python/.python-version` 自动准备 Python 3.11，安装包用户不需要安装 Python 或 uv。界面使用 Electron 渲染，macOS 与 Windows 的字体、间距、控件和响应式布局保持一致。

```bash
./start_electron.sh
```

macOS 上从 Finder、Codex 等非交互环境启动时，脚本会在 `PATH` 缺少
`node`/`npm` 的情况下自动加载 `NVM_DIR`（默认 `~/.nvm`）中的 nvm 默认版本，
并明确校验 Node.js 22+；仍无法找到运行时会直接给出安装或 nvm 配置提示。

Windows 开发环境在项目目录执行一次 `npm run setup`，再运行 `npm start`。`setup` 会安装 npm 依赖、准备内置 ADB，并用 uv/PyInstaller 构建 Python uiautomator2 sidecar。Electron 面板支持设备刷新、问题文件导入、目录选择、日志流、停止任务和响应式布局。

“重试失败项”默认置灰且不可点击；只有一批正常结束并且汇总中确实存在失败题时才会启用。开始新批次、任务异常退出、失败项全部重试成功或没有有效原批次目录时都会重新置灰。重试只重跑失败题，沿用原批次、原入口和原题号；成功结果会写回该批次的 `交付图片/`，汇总文件同步更新。此前失败记录会保留为 `失败_重试前_*.json`，不会覆盖成功题或重新生成一个批次。

常用开发命令：

```bash
npm run setup      # 首次初始化：安装依赖及自动化运行时
npm run clean      # 清理构建目录和缓存，保留 captures/
npm run clean:all  # 同时清理本地截图、UI层级和诊断产物
npm run check      # Node 语法检查
npm test           # 自动化核心逻辑测试
npm run prepare:u2 # 构建当前平台的Python uiautomator2 sidecar
npm run prepare:scrcpy # 下载并校验官方scrcpy server
npm run dist       # 准备内置运行时并打包桌面应用
```

更完整的本地开发、真机验收、Windows/macOS 打包、GitHub Release 发布和自动更新说明见 [开发、打包、发布与自动更新](docs/development-deployment.md)。

完整归档当前会话中已经存在的回答（不会新建会话、聚焦输入框、输入或发送问题），与正式任务使用同一流程采集回答正文、引用资料和从首项到末项的全部参考药品：

```bash
npm run run:android -- --serial <设备序列号> --output-dir ./captures/current-answer --capture-current-answer
```

也可以在命令末尾直接提供已知的问题文字。小荷正式批量流程本来就持有该文字；真机复用已有回答验收时提供它，可直接按新会话路径从物理顶部采集，不再识别问题气泡，且仍不会输入或发送：

```bash
npm run run:android -- --serial <设备序列号> --output-dir ./captures/current-answer --capture-current-answer "已知问题文字"
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

Windows 安装包由 GitHub Actions 在 `windows-latest` 上构建。手动运行 `Build Windows` 工作流只生成可下载的 Artifact；推送 `v*` 版本标签会在测试和打包成功后自动创建或更新 GitHub Release，并上传 `.exe`、`.blockmap` 与自动更新所需的 `latest.yml`。当前 macOS 工作流仅保留手动构建，不会随版本标签执行：

```bash
git tag v0.2.0
git push origin v0.2.0
```

标签必须与 `package.json` 内部版本完全一致，例如内部版本为 `0.2.0` 时只能发布 `v0.2.0`；不一致会在构建阶段明确失败。普通分支推送不会发布 Release。正式打标签前应先将需要发布的分支合并到稳定分支，并确认版本号尚未被其他提交使用。

Windows 安装包启动后会自动检查 GitHub Releases，每 6 小时再次检查一次，也可点击窗口右上角的版本按钮手动检查。发现新版本后由用户点击下载，下载完成后点击“重启并安装”；自动化任务执行期间禁止重启安装，任务结束后按钮会恢复。第一版带自动更新能力的安装包仍需手动安装，从下一版本开始才能在应用内完成更新。稳定版默认不会接收 GitHub 预发布版本，只有当前安装包本身是预发布版本时才会继续接收预发布更新。

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
          性能分析.json              # 每次底层操作耗时、阶段时间线和优化候选
          执行日志.jsonl             # 本题完整事件时间线
        002_失败问题/
          失败.json                 # 原始错误与所有诊断文件索引
          失败现场.png             # ADB 原始物理像素截图
          失败现场.xml             # 同时刻附近的 uiautomator2 逻辑层级
          失败现场.json            # 前台应用、窗口、尺寸、旋转和 scrcpy 状态
          失败现场_OCR.json        # 仅本题已调用 OCR 时生成，保留完整候选
          性能分析.json            # 失败前操作时间线、失败操作和最慢操作排行
          执行日志.jsonl           # 失败前的阶段与操作时间线
```

`交付图片/` 不写入 XML、JSON、日志或失败截图；正式图片也不会在调试区重复保存。`回答.json` 通过绝对路径关联交付图片、XML、单题日志、批次日志和性能分析，并用 `artifact_layout_version=4` 标记当前结构。版本 4 新增每题 `性能分析.json`：记录 UI、ADB、OCR、截图、滚动、scrcpy 等底层操作的开始/结束时间、耗时、结果和安全参数，汇总各操作的次数、失败数、总耗时、平均值、P95、最大值、最慢操作和优化候选。所有入口共用同一套失败现场采集，诊断文件只进入 `调试产物/`，不会污染交付内容。

`执行日志.jsonl` 每行是一条独立 JSON 事件，包含时间、顺序号、耗时、入口、问题及事件类别。回答翻页、接缝降级、引用资料、参考药品入口发现、抽屉展开、每页采集、末项确认、图片加载状态、重试、失败恢复以及每次底层操作的完成/失败都会形成可检索事件。排查时优先读取 `batch-summary.json` 定位失败题，再读取该题 `失败现场.json` 中的 `operation_telemetry`：这里直接给出当前阶段、最后失败操作、失败前操作链和最慢操作；随后查看 `性能分析.json` 的阶段耗时、按操作聚合排行与优化建议，必要时再结合 `执行日志.jsonl`、`回答.xml` 和失败截图复现判断。输入问题正文不会重复写入操作详情，输入操作只记录字符数。

截图严格按页面顺序单向执行：回答正文从上向下采集，遇到固定在回答尾部的参考药品入口后立即进入药品采集，药品完整后本题结束，不再关闭抽屉后回归或比对正文锚点。药品抽屉打开后先从标题拖拽区完全展开列表，确认全屏视口后才从首项开始截图，避免在药品内容区拖动导致第一帧落到中间卡片。随后不设置药品页数上限，持续滚动，只有连续滑动后稳定画面不再变化才确认到达末项；首屏、图片加载、列表到底或滚动接缝任一项未完成都会在尾部入口直接重试，最终仍失败则该题不算成功。超出单张长图高度时会分片保存，所有分片共同组成完整药品列表。

面板支持：

- 自动识别已授权的 ADB 手机；可在多台设备中选择一台执行
- 选择一个或多个执行入口：小荷AI医生APP、抖音搜索框（小荷AI小程序）、头条搜索框（小荷AI小程序）；面板默认同时勾选小荷AI医生APP和抖音搜索框入口
- 多入口执行时按入口顺序逐个完成整批问题：先跑完第一个入口的全部问题，再切换到下一个入口
- 直接每行填写一个问题，或导入 TXT / CSV / JSON / XLSX 文件，默认读取 `问题` 列
- 按列表顺序逐题发送、等待回复稳定，并分别保存纯截图交付件与 UI XML、JSON、JSONL 调试产物
- 实时查看执行日志，并在需要时停止任务
- 执行日志上方实时按入口显示成功数与失败数
- 控制台按题目折叠重复生成提示与逐页刷屏信息；完整逐操作日志仍保存在 `执行日志.jsonl`
- 开始新批次时清空桌面日志显示；重试失败项时保留原日志并继续追加
- 可选“每题新建会话”

JSON 使用数组或 `questions` / `问题` 数组；Excel 读取第一个工作表，按界面配置的列名读取，默认列名为 `问题`。

多入口批次会在批次目录下按入口生成子目录，避免不同入口的同一问题产物互相覆盖。每题 JSON 会记录 `entry_id`、`entry_label` 和 `entry_package`，便于回溯产物来自哪个入口。

单个入口的单道题发生搜索无结果、回答超时、输入/点击不确定或截图失败时，只停止当前题，不重放有副作用的操作。失败原因写入该题调试目录的 `失败.json`，同时尝试保存 `失败现场.png/.xml/.json`；如果本题调用过 OCR，还会保存 `失败现场_OCR.json` 的完整文字、置信度和物理坐标。任一诊断源采集失败只会在现场清单里记录原因，不会覆盖原始任务错误或阻止后续题。下一题开始前重新启动并校验当前入口，然后继续剩余问题和后续入口。批次结束后由 `调试产物/batch-summary.json` 汇总成功数、失败数和失败题路径。用户主动停止、ADB 设备断开或 uiautomator2 基础进程不可用仍会终止整个批次，但会先尽可能留下任务级失败现场。

所有入口在发送或搜索前都会强制清空并回读核对输入框文本。若 FastInputIME 的清空广播偶发失败、导致旧关键词与新问题拼接，脚本只在已确认回读不一致后，通过 uiautomator2 对当前聚焦输入控件执行一次原子 `setText` 替换；再次回读精确一致后才允许继续，仍不使用 ADB 输入，也不会重复提交问题。面板默认要求每题新建会话；小荷未能确认新会话入口时会在输入前停止，不能带着旧对话继续。问题发送后只比较聊天内容区域的 ADB 原始 PNG，顶部系统状态栏和底部输入区不参与稳定性判断；内容连续 3 秒无变化且层级不再显示生成状态后开始截图。小荷新会话不识别问题气泡：先使用两个交替横向触点持续向上滚动，只有连续两次稳定画面无变化才确认到顶；到顶后对 ADB 原始 PNG 执行 OCR，识别“根据…篇资料为你总结”并按物理截图与逻辑 UI 尺寸映射点击，确认资料展开后才截取第一屏。随后严格单向向下采集，任意内容位移都会清零到底计数，只有连续两次向下滚动无变化才确认到底。免责声明、操作栏和参考药品入口都不是必需的结束标记；参考药品仅在实际出现时进入药品终止序列。元数据中的 `reply_top_navigation_method`、`reply_top_confirmed`、`reply_top_confirmation_swipes` 和 `reply_question_structure_validation_required` 记录实际验收方式。推荐药品入口在点击前会等待页面稳定并从最新层级刷新坐标，避免正文重排后点击旧位置；抽屉识别兼容普通窗口和华为弹窗窗口，并使用面板和列表相对竖屏高度确认全屏状态。元数据中的 `reference_products_trigger_refreshed` 记录本题是否刷新过入口坐标。抖音搜索超时会在当前题调试目录保留 `搜索超时.png` 和 `搜索超时.xml` 供本机诊断，这些采集产物仍受忽略规则保护。

抖音入口使用双路径流程：打开搜索页并搜索问题后，识别“小荷AI医生”智能总结的居中全文控件和独立小程序入口卡片。抖音会把这些卡片文字绘制在画面中但不一定暴露给 UI XML，因此先使用层级结构；层级没有可靠目标时，才对稳定的 ADB 原始 PNG 启用 RapidOCR。OCR 必须同时高置信识别“小荷AI医生”、“根据医学数据智能总结”和位于其下方合理距离的“查看全文”，单独识别到通用按钮不会点击；图片物理坐标会按实时 UI 逻辑尺寸映射，最终仍由 uiautomator2 点击。只有全文控件时保存完整搜索结果页为 `回答_智能总结.png` 并点击全文，同时出现展开型回答和独立小程序卡片时优先走可强校验的独立卡片，避免把抖音自身的“AI生成回答/展开更多”误当成小荷总结。如果层级明确暴露“AI生成回答/展开更多”，脚本也会直接忽略它。如果短暂优先等待后仍未出现智能总结，但识别到独立入口卡片，则保存搜索页为 `回答_小程序入口.png`，按卡片标题区域的相对位置点击，并通过 `MiniAppHostActivity` 和小程序外壳强校验跳转成功。入口页会继续等待回答正文真正出现并稳定，不能把空白回答气泡当作成功。首屏没有两种结果时会有限向下扫描搜索结果；第一轮完成三次扫描仍无结果时，脚本按实际扫描距离回到顶部，确认搜索框仍是当前问题后下拉刷新，并完整执行第二轮识别和扫描。第二轮仍无结果才明确失败、保存搜索超时现场并继续后续任务，不进行第三轮，也不重新输入或重复点击搜索按钮。成功元数据中的 `douyin_search_attempts`、`douyin_search_refreshed` 和 `douyin_search_target_detection_method` 记录实际识别轮次、是否刷新及最终证据来源。

两条路径最终都会先等待小程序回答连续 3 秒静止，再从全文顶部向下滚动并保存 `回答_001.png`。正文截图使用 ADB 原始 PNG，并根据小程序真实滚动视口排除固定的咨询人选择栏、顶部工具栏和底部输入区；相邻视口执行像素接缝校验，通过后才无缝裁掉重叠内容。顶部需要连续两次滚动无变化确认；没有参考药品时，末端也需要连续两次无变化。出现无文字的“参考药品”卡片时，脚本会按右上箭头和商品图的结构识别入口，立即进入药品终止序列：打开抖音 BottomSheet、确认首项图片已加载、持续滚动到真实末项并另存 `回答_参考药品_001.png`。入口、抽屉和商品图片均使用相对竖屏尺寸及节点层级识别，不依赖 1080×2400 固定坐标。JSON 的 `douyin_result_mode` 区分 `smart_summary` 与 `miniapp_entry_card`；入口路径额外记录 `douyin_miniapp_entry_detected`、入口截图及卡片/点击范围、宿主 Activity 和 `douyin_miniapp_entry_opened`，智能总结路径继续记录 `douyin_search_summary_captured`、`douyin_search_summary_screenshot` 和 `douyin_view_full_opened`。正文和药品验收分别记录 `reply_continuity_verified`、`reference_products_detected`、`reference_products_images_ready`、`reference_products_confirmed_end` 和 `reference_products_capture_complete`。

今日头条入口使用对应的独立搜索流程：脚本先按头条首页顶部搜索框的语义节点打开搜索页，再通过搜索页编辑框输入并确认问题，两阶段均不使用固定坐标。头条冷启动时允许最多 30 秒等待其 UI 层级出现，其他入口仍保持 8 秒；该阶段仅执行只读层级检查，不会点击、输入或重放有副作用的操作。随后优先从 UI 层级等待“小荷AI医生·智能总结”和可点击的“查看更多”；只有结果页搜索框仍与当前原始问题逐字一致时才接受卡片，切换中的旧查询结果会被忽略。头条 WebView 未暴露文字时，才对稳定的 ADB 原始 PNG 启用 RapidOCR 兜底。OCR 必须同时高置信识别品牌标题和位于其下方合理距离的“查看更多”，单独识别到通用“查看更多”不会点击。OCR 返回图片物理坐标，脚本按实时 UI 层级逻辑尺寸显式映射，并在保存稳定搜索结果截图后再次识别确认，随后仍由 uiautomator2 点击且强校验全文页已经打开；若已确认进入小程序宿主但只读层级连接刚好重启，会按宿主就绪条件继续等待，而不会重放点击。若完整等待窗口内确实没有召回目标卡片，脚本只会在重新精确确认搜索框内容后，用同一个原始问题受控重试一次；UI 读取、点击或前台应用异常不会触发重试。完整搜索结果页保存为 `回答_智能总结.png`；全文首次打开后需等待连续 3 秒无画面活动，再从真实顶部向下采集并保存 `回答_001.png`。JSON 额外记录 `toutiao_search_attempts`、`toutiao_search_repeated_exact_question`、`toutiao_answer_card_detection_method`、OCR 引擎/耗时/置信度及物理和逻辑坐标、`toutiao_search_summary_captured`、`toutiao_view_more_opened`、`toutiao_full_page_confirmed_top` 和 `toutiao_full_page_confirmed_end`。

头条“查看更多”打开后还会检查全文目标页语义：带“发送消息”输入框的通用咨询页、药盒识别页等不能冒充本题全文。若明确进入了这类错误路由且本题尚未使用搜索重试额度，脚本会关闭该页、再次精确确认同一个原始问题并仅重试一次；读取或点击异常不会触发该路径。JSON 通过 `toutiao_full_answer_open_attempts` 和 `toutiao_full_answer_route_repeated` 记录全文路由尝试。

通用 OCR 的接口、坐标契约、调用示例、日志字段和扩展规则见 [本地 OCR 设计与使用](docs/ocr.md)。正常 UI 层级可识别时不会调用 OCR，因此不会给所有任务增加固定等待。

## 项目结构

```text
src/
  main/          # Electron 主进程和 preload
  renderer/      # 桌面面板页面、样式和交互
  automation/
    runner.js                    # 组合根：设备会话、批次生命周期和公开接口
    entry-catalog.js             # 入口定义、选择、包名与启动策略
    question-input-workflow.js   # 输入、发送、新会话与搜索框准备
    douyin-search-workflow.js    # 抖音搜索、OCR证据链和全文路由
    toutiao-search-workflow.js   # 头条搜索、OCR证据链和全文路由
    question-workflows.js        # 单题入口编排，不承载底层截图算法
    capture-stability.js         # scrcpy门控与ADB区域稳定复核
    reply-capture.js             # 正文、引用资料和小程序全文采集状态机
    reference-products.js        # 参考药品入口、抽屉与就绪判定
    reference-product-capture.js # 参考药品从首项到末项的采集状态机
    artifact-writer.js           # 交付图片、层级和元数据写入
    capture-primitives.js        # 无状态截图、输入与拼接辅助接口
    miniapp-locators.js          # 分辨率自适应的层级/OCR定位器
    device-bridge.js             # ADB连接、原始PNG和断连恢复
    batch-recovery.js            # 批次失败隔离和失败题重试
    failure-diagnostics.js       # 失败现场证据采集
    search-recovery.js           # 搜索与全文路由的有限恢复策略
    hierarchy.js                 # UI层级解析与结构识别
    images.js                    # 图片稳定性、接缝验证和长图拼接
    u2-client.js                 # Python uiautomator2/OCR sidecar客户端
    scrcpy-observer.js           # 低分辨率画面活动观察器
  questions.js   # 问题文件导入
  runtime-paths.js
  cli.js
python/          # uv管理的Python uiautomator2与RapidOCR sidecar、测试和PyInstaller配置
scripts/         # 打包前准备ADB、Python sidecar和scrcpy server
tests/node/      # Node 内置 test runner 测试
```

## 使用前检查

- 手机必须完成 USB 调试授权（打包版已内置 adb，无需本机安装）。
- 仓库内置 macOS 与 Windows 两套 Android Platform Tools；打包命令 `npm run dist` 会使用目标平台的ADB，并内置PyInstaller生成的Python uiautomator2 sidecar及校验过的官方scrcpy server。运营不需要安装Node、Python、uv、ADB或scrcpy客户端。
- UI层没有ADB降级：uiautomator2层级读取失败时只允许重启sidecar并重试一次；点击或输入失败会立即终止当前题且不重放该操作，下一题只能在重新启动并校验入口后继续。
- 正式截图始终使用ADB原始PNG，不使用uiautomator2截图接口。
- scrcpy观察器不解码、不保存也不参与拼接，只根据官方视频包的活动情况快速判断页面是否停稳。读取层级和截取PNG期间没有活动时直接使用当前无损PNG；检测到全屏活动时不再仅凭视频包判定回答失败，而是复用已取得的回答区域PNG，升级为连续两组“ADB截图→uiautomator2层级→ADB截图”像素夹心校验。只有目标回答区域也持续变化才继续等待或超时失败，状态栏、浮动控件等区域外活动不会误伤正式截图。观察器不可用、没有明确活动证据，或较慢设备耗尽观察确认窗口时使用普通单组夹心校验，不影响UI后端选择。元数据中的 `scrcpy_observer_activity_region_checks` 和 `scrcpy_observer_question_activity_region_checks` 记录这种严格区域复核发生次数。
- 回答完成判定使用更严格的规则：最后一个活动帧后必须连续 3 秒没有任何新活动帧，任意单帧都会重置计时；读取最终 UI 层级期间若再出现活动帧，则继续等待而不进入截图。
- 每个普通回答接缝最多局部重采一次；末屏短距离滚动遇到一侧大面积同色区域时，会将各区域候选位移重新交给全部内容区域进行像素校验，只有唯一候选通过才允许无缝拼接。局部重采后仍无法验证时保留下一屏完整视口并加浅色分隔，不依据不可靠的 XML 坐标或滚动距离裁掉文字，也不再把整道回答回滚重采。
- `captures/` 已被 Git 忽略，因为截图、UI XML 和元数据可能包含敏感健康信息。
- 健康问题和截图可能包含个人信息，请勿上传到公共仓库。
