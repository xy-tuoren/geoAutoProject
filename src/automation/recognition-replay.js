const locators = require('./miniapp-locators')
const { evidenceSummaryOcrTarget, evidenceSummaryExpandedByOcr, suspiciousEvidenceSummaryOcrTarget } = require('./capture-primitives')
const { miniAppQuestionOcrTarget } = require('./reply-capture')

function replayRecognition(evidence) {
  const { purpose, recognition, logical_size: size, hierarchy: xml = '', chat_bounds: bounds } = evidence
  if (!recognition?.results || !size?.width || !size?.height) throw new Error('证据缺少 OCR 结果或 UI 逻辑尺寸。')
  let target
  if (/^douyin_(answer_card|summary_recapture)$/.test(purpose)) {
    target = locators.douyinOcrConsultEntryTarget(recognition, size) || locators.douyinOcrViewFullTarget(recognition, size) || locators.douyinOcrBrandEntryTarget(recognition, xml, size)
  } else if (/^toutiao_(answer_card|summary_recapture)$/.test(purpose)) {
    target = locators.toutiaoOcrViewMoreTarget(recognition, size) || locators.toutiaoOcrMiniAppEntryTarget(recognition, size)
  } else if (/^xiaohe_embedded_evidence/.test(purpose)) {
    if (!bounds) throw new Error('引用证据缺少正文视口；不能猜测裁剪范围。')
    target = evidenceSummaryOcrTarget(recognition, size, bounds)
    return { purpose, matched: Boolean(target), target, expanded: evidenceSummaryExpandedByOcr(recognition, target), suspicious_target: target ? null : suspiciousEvidenceSummaryOcrTarget(recognition, size, bounds), offline: true }
  } else if (/question_(top|first_frame|recovery)/.test(purpose)) {
    target = miniAppQuestionOcrTarget(recognition, evidence.question, size)
  } else throw new Error(`暂不支持该证据用途的离线定位：${purpose}`)
  return { purpose, matched: Boolean(target), target, offline: true, rejection_reason: target ? null : '候选未同时满足身份、置信度与空间位置规则；请结合 matcher 和原图查看。' }
}
module.exports = { replayRecognition }
