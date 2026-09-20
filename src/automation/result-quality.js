function hasAppLimitedNotice(text) {
  return /有一条消息暂时无法展示[，,。]*请下载(?:小荷AI医生)?APP查看/i.test(String(text).replace(/\s+/g, ''))
}
function resultQuality(meta) {
  const content_type = meta.search_result_only ? 'search_results_only' : meta.app_limited_notice ? 'app_limited' : 'answer'
  const quality_status = meta.reply_continuity_verified === false ? 'needs_review' : 'verified'
  const result_label = quality_status === 'needs_review' ? '已采集：建议核图'
    : content_type === 'search_results_only' ? '成功：仅搜索结果'
      : content_type === 'app_limited' ? '成功：应用限制提示' : '采集成功'
  return { content_type, quality_status, result_label, human_reviewed: false }
}
module.exports = { hasAppLimitedNotice, resultQuality }
