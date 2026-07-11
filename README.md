# 小荷 AI 医生 ADB 自动化

这是一个在电脑上通过 ADB 控制安卓手机的小荷 AI 医生自动化工具。运营人员日常使用桌面面板，不需要打开 AutoX 或手工执行命令。

## 给运营同事：安装即用（推荐）

开发者打包后发给同事对应系统的压缩包即可。**不需要**安装 Python、ADB 或配置环境变量。

### macOS

文件：`小荷AI医生自动化-macOS.zip` / `小荷AI医生自动化.app`

1. 解压后把应用拖到「应用程序」或任意文件夹
2. USB 连接手机，打开「开发者选项 → USB 调试」，首次弹出时点「允许」
3. 双击打开 → 刷新设备 → 填写/导入问题 → 开始执行

若提示「无法验证开发者」，右键应用选「打开」，或在「系统设置 → 隐私与安全性」中仍要打开。

### Windows

文件：`小荷AI医生自动化-Windows.zip`

1. 解压到任意文件夹（不要只打开 zip 里运行）
2. USB 连接手机，打开「开发者选项 → USB 调试」，首次弹出时点「允许」
3. 双击 `小荷AI医生自动化.exe`
4. 若 SmartScreen 提示未知应用，选「更多信息 → 仍要运行」

截图默认保存在 `文档/XiaoheCaptures/captures/`（macOS / Windows 均为用户文档目录下）。

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

### 开发者如何打包

**macOS 包**（在 Mac 上执行）：

```bash
./scripts/build_desktop.sh
```

产物：`dist/小荷AI医生自动化.app`、`dist/小荷AI医生自动化-macOS.zip`

**Windows 包**（必须在 Windows 上执行；Mac 无法交叉编译出 `.exe`）：

```powershell
.\scripts\build_desktop.ps1
```

产物：`dist/小荷AI医生自动化\`、`dist/小荷AI医生自动化-Windows.zip`

也可在 GitHub 仓库里打开 **Actions → Build desktop packages → Run workflow**，下载 `xiaohe-panel-windows` / `xiaohe-panel-macos` 产物。

## 桌面操作面板（开发调试）

需安装 [uv](https://docs.astral.sh/uv/)。macOS 还需可用的 Tk：

```bash
brew install python-tk
```

首次运行会用 uv 创建 `.venv` 并同步依赖：

```bash
./start_desktop.sh
```

或手动：

```bash
uv sync
uv run python desktop_app.py
```

> 不要用苹果自带的系统 Python/Tk（会白屏）。脚本会自动选用 Homebrew 的 Python。

面板支持：

- 自动识别已授权的 ADB 手机；可在多台设备中选择一台执行
- 直接每行填写一个问题，或导入 TXT / CSV / JSON / XLSX 文件
- 按列表顺序逐题发送、等待回复稳定、保存每一题的截图、UI XML 和 JSON 元数据
- 实时查看执行日志，并在需要时停止任务
- 可选“每题新建会话”与“仅输入测试（不发送）”

JSON 使用数组或 `questions` / `问题` 数组；Excel 读取第一个工作表，优先读取 `问题`、`question`、`questions`、`提问` 列，否则读取第一列。

## Quick Start

```bash
uv sync
./run.sh "小孩咳嗽三天怎么办？"
```

Outputs are written to `captures/` by default:

- `batch_年月日-时分秒/`: one directory per run
- `序号_问题名称/`: one directory per question
- `.png`: reply screenshot (and optional expanded evidence card)
- `.xml`: UI hierarchy at capture time
- `.json`: question, status, device serial, batch and artifact paths

## 命令行批量模式

Create a text file with one question per line:

```bash
./run.sh --file questions.txt
```

## 常用选项

```bash
./run.sh --dry-run "测试中文输入"
./run.sh --new-session "重新开一轮会话的问题"
./run.sh --timeout 150 --stable-seconds 8 "回复较慢的问题"
./run.sh --output-dir ~/Desktop/xiaohe-captures "保存到桌面"
```

## 使用前检查

- 手机必须完成 USB 调试授权（打包版已内置 adb，无需本机安装）。
- 工具使用 `uiautomator2` 稳定定位控件并支持中文输入。
- `captures/` 已被 Git 忽略，因为截图、UI XML 和元数据可能包含敏感健康信息。
- 若任务中断，脚本会自动清理遗留的 `com.github.uiautomator` 服务并重新连接。
- 健康问题和截图可能包含个人信息，请勿上传到公共仓库。
