const { iterNodes, nodeAttr } = require('./hierarchy')

const DEFAULT_PACKAGE = 'com.aurora.xiaohe.aidoctor'
const DEFAULT_ENTRY_ID = 'douyin-xiaohe-miniapp'
const DEFAULT_SELECTED_ENTRY_IDS = new Set(['xiaohe-app', 'douyin-xiaohe-miniapp'])
const DEFAULT_ENTRY_HIERARCHY_STARTUP_TIMEOUT_MS = 8_000
const TOUTIAO_ENTRY_HIERARCHY_STARTUP_TIMEOUT_MS = 30_000

const ENTRY_DEFINITIONS = Object.freeze({
  'xiaohe-app': Object.freeze({
    id: 'xiaohe-app',
    label: '小荷AI医生APP',
    packageName: DEFAULT_PACKAGE,
    resourcePackage: DEFAULT_PACKAGE,
    packageLabel: '小荷App',
    inputHints: ['输入问题'],
    submitLabels: ['发送'],
    supportsNewSession: true,
  }),
  'douyin-xiaohe-miniapp': Object.freeze({
    id: 'douyin-xiaohe-miniapp',
    label: '抖音搜索框（小荷AI小程序）',
    packageName: 'com.ss.android.ugc.aweme',
    packageLabel: '抖音小荷AI小程序',
    workflow: 'douyin-search',
    supportsNewSession: false,
  }),
  'toutiao-xiaohe-miniapp': Object.freeze({
    id: 'toutiao-xiaohe-miniapp',
    label: '头条搜索框（小荷AI小程序）',
    packageName: 'com.ss.android.article.news',
    packageLabel: '头条小荷AI小程序',
    workflow: 'toutiao-search',
    supportsNewSession: false,
  }),
})

const ENTRY_LIST = Object.freeze(Object.values(ENTRY_DEFINITIONS))

function hierarchyBelongsToPackage(xml, packageName = DEFAULT_PACKAGE) {
  return iterNodes(xml).some(attrs => nodeAttr(attrs, 'package') === packageName)
}

function automationEntries() {
  return ENTRY_LIST.map(entry => ({
    ...entry,
    defaultSelected: DEFAULT_SELECTED_ENTRY_IDS.has(entry.id),
  }))
}

function normalizeEntryId(value) {
  const id = String(value || '').trim()
  if (!id) return DEFAULT_ENTRY_ID
  if (!ENTRY_DEFINITIONS[id]) {
    throw new Error(`未知入口：${id}。请从桌面端入口列表中选择。`)
  }
  return id
}

function normalizeAutomationEntries(entries) {
  const raw = Array.isArray(entries) && entries.length ? entries : [DEFAULT_ENTRY_ID]
  const seen = new Set()
  const result = []
  for (const value of raw) {
    const id = normalizeEntryId(value)
    if (seen.has(id)) continue
    seen.add(id)
    result.push(ENTRY_DEFINITIONS[id])
  }
  return result
}

function entryHierarchyStartupTimeout(entry) {
  return entry?.workflow === 'toutiao-search'
    ? TOUTIAO_ENTRY_HIERARCHY_STARTUP_TIMEOUT_MS
    : DEFAULT_ENTRY_HIERARCHY_STARTUP_TIMEOUT_MS
}

module.exports = {
  DEFAULT_PACKAGE,
  DEFAULT_ENTRY_ID,
  DEFAULT_ENTRY_HIERARCHY_STARTUP_TIMEOUT_MS,
  TOUTIAO_ENTRY_HIERARCHY_STARTUP_TIMEOUT_MS,
  ENTRY_DEFINITIONS,
  automationEntries,
  normalizeAutomationEntries,
  hierarchyBelongsToPackage,
  entryHierarchyStartupTimeout,
}
