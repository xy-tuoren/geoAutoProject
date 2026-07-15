# 本地 OCR 设计与使用

## 目标与边界

OCR 是 UI 层级的通用视觉文字补充能力，用于 WebView、Canvas 或自绘控件已经显示文字但 uiautomator2 XML 不暴露语义的场景。它不是点击、输入或层级读取的替代后端。

- 正式输入图片来自 ADB 原始 PNG；scrcpy 画面不参与 OCR。
- OCR 使用本地 RapidOCR、PP-OCRv6 small 模型和 ONNX Runtime，不上传截图。
- OCR 只返回识别结果，不产生 UI 副作用；点击仍由 Python uiautomator2 执行。
- 正常 UI 层级路径优先，只有业务明确需要视觉兜底时才调用 OCR。
- 通用 OCR 层不包含“小荷AI医生”“查看更多”等入口业务规则。

## 分层结构

```text
runner业务状态机
  -> src/automation/ocr.js
       结果校验、文字规范化、匹配、物理/逻辑坐标映射
  -> src/automation/u2-client.js
       PNG Buffer和选项通过JSONL发送到sidecar
  -> python/src/geoauto_u2/ocr.py
       图片解码、区域裁剪、RapidOCR推理、坐标回填
```

Python `ocr_recognize` 与 Android 设备连接无关，是只读请求。RapidOCR 引擎在首次请求时懒加载，冻结安装包首次调用可能需要数秒，后续请求复用同一实例并明显更快；未使用 OCR 的入口不承担模型初始化时间。只读请求超时为 60 秒，以覆盖较慢机器的首次原生库加载。PyInstaller 配置会同时收集 RapidOCR 模型、ONNX Runtime 动态库和相关数据文件，安装包不依赖运营机器另装 Python 或 OCR 模型。

## 通用调用

Node 调用方通过 `OcrRecognizer` 传入 PNG/JPEG Buffer：

```js
const { OcrRecognizer, findOcrText } = require('./src/automation/ocr')

const ocr = new OcrRecognizer({ transport: uiClient })
const recognition = await ocr.recognize(adbPngBuffer, {
  region: [left, top, right, bottom],
  minConfidence: 0.5,
  useDetection: true,
  useClassification: false,
  useRecognition: true,
})
const matches = findOcrText(recognition, /目标文字/, { minConfidence: 0.85 })
```

`region` 可省略；传入时使用原始图片物理像素坐标。区域会限制模型工作量，但返回的 `polygon` 和 `bounds` 已加回裁剪偏移，始终对应完整输入图片。

主要返回字段：

| 字段 | 含义 |
| --- | --- |
| `engine` | 当前为 `rapidocr` |
| `coordinateSpace` | 固定为 `image_physical_pixels` |
| `image` | 输入图片物理宽高 |
| `region` | 实际识别的完整图片物理区域 |
| `elapsedMs` | 包含推理和结果整理的总耗时 |
| `results[].text` | 原始识别文字 |
| `results[].normalizedText` | NFKC、空白和常见分隔符规范化后的匹配文字 |
| `results[].confidence` | 识别置信度 |
| `results[].bounds` | 完整图片中的物理像素外接矩形 |
| `results[].polygon` | 完整图片中的四点物理坐标 |

## 坐标与竖屏适配

ADB PNG 物理尺寸可能不同于 uiautomator2 XML 的逻辑尺寸。禁止直接拿 OCR 坐标点击。调用方必须从实时层级取得逻辑视口，再使用 `mapPhysicalBoundsToLogical()` 分别按 X/Y 比例映射。

映射前会验证两侧都是正常竖屏。横屏、分屏、折叠态或无有效层级尺寸时明确失败，不继续产生 UI 副作用。新增 OCR 定位测试至少覆盖两种不同物理/逻辑尺寸组合。

## 业务识别规则

OCR 只提供文字候选，业务流程必须自行组合以下证据：

1. 目标文字及允许的标点、空白变体。
2. 最低置信度。
3. 相对位置、排列顺序和同一区域关系。
4. 操作前在稳定正式截图上再次识别。
5. 点击后使用 UI 层级、Activity 或明确页面结构校验跳转结果。

禁止只凭一个常见按钮文字点击。头条当前要求“小荷AI医生·智能总结”和其下方“查看更多”同时达到 `0.85`，并限制垂直距离及按钮水平位置。

## 调试记录与隐私

OCR 调用写入 `执行日志.jsonl` 的 `ocr_recognition` 事件，包括用途、匹配结果、引擎、耗时、识别行数、命中置信度和坐标。回答 JSON 记录本题最终采用的检测方式及关键验收字段。

结构化日志不写入整屏 OCR 正文，避免重复扩散健康内容。任务失败时，通用失败现场采集器会将本题最近一次 OCR 的完整候选、置信度、匹配规则、物理坐标和最终目标写入 `失败现场_OCR.json`，供本地排查；它不写入批次 JSONL，也不进入交付目录。正式图片仍只写入 `交付图片/`，失败现场和元数据继续遵守现有 `调试产物/` 契约，不得提交仓库或上传公共服务。
