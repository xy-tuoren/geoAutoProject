(function exposeQuestionGenerator(root, factory) {
  const api = factory()
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.questionGenerator = api
})(typeof globalThis !== 'undefined' ? globalThis : window, function createQuestionGeneratorModule() {
  const FIXED_FIELDS = [
    { id: 'field-brand', label: '商品名', token: '商品名', defaultValue: '' },
    { id: 'field-generic', label: '通用名', token: '通用名', defaultValue: '' },
    { id: 'field-indication', label: '适应症', token: '适应症', defaultValue: '' },
    { id: 'field-drug-type', label: '药品类型', token: '药品类型', defaultValue: '中成药' },
  ]

  const DEFAULT_CONFIG = {
    schemaVersion: 3,
    topicGroups: [defaultTopicGroup()],
    templates: [
      { id: 'template-generic', name: '通用名', enabled: true, content: '{通用名}' },
      { id: 'template-product', name: '商品全称', enabled: true, content: '{商品名}{通用名}' },
      { id: 'template-effect', name: '作用功效', enabled: true, content: '{通用名}作用与功效' },
      { id: 'template-indication', name: '适应症用药', enabled: true, content: '{适应症}吃什么{药品类型}' },
      { id: 'template-effective', name: '产品有效性', enabled: true, content: '{适应症}吃{通用名}有效吗' },
    ],
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value))
  }

  function text(value) {
    return String(value ?? '').trim()
  }

  function defaultTopicGroup() {
    return Object.fromEntries(FIXED_FIELDS.map(field => [field.token, field.defaultValue]))
  }

  function defaultConfig() {
    return clone(DEFAULT_CONFIG)
  }

  function normalizeTopicGroup(input) {
    return Object.fromEntries(FIXED_FIELDS.map(field => [field.token, text(input?.[field.token] ?? input?.[field.label] ?? field.defaultValue)]))
  }

  function legacyTopicGroup(fields) {
    const values = {}
    for (const fixed of FIXED_FIELDS) {
      const field = fields.find(item => text(item?.token) === fixed.token || text(item?.label) === fixed.label)
      values[fixed.token] = field ? text(field.value) : fixed.defaultValue
    }
    return values
  }

  function normalizeConfig(input) {
    const fallback = defaultConfig()
    if (!input || typeof input !== 'object') return fallback
    let topicGroups = []
    if (Array.isArray(input.topicGroups)) topicGroups = input.topicGroups.map(normalizeTopicGroup)
    else if (Array.isArray(input.fields)) topicGroups = [legacyTopicGroup(input.fields)]
    if (!topicGroups.length) topicGroups = fallback.topicGroups
    const templates = Array.isArray(input.templates) ? input.templates.map((template, index) => ({
      id: text(template?.id) || `template-${index + 1}`,
      name: text(template?.name),
      enabled: template?.enabled !== false,
      content: text(template?.content),
    })) : fallback.templates
    return { schemaVersion: 3, topicGroups, templates }
  }

  function variableTokens(template) {
    return [...String(template || '').matchAll(/\{([^{}]+)\}/g)].map(match => match[1].trim())
  }

  function canonicalQuestion(value) {
    return text(value).normalize('NFKC').replace(/\s+/g, '').replace(/[？?。！!，,；;：:]/g, '')
  }

  function validateTemplates(config) {
    const errors = []
    const tokens = new Set(FIXED_FIELDS.map(field => field.token))
    if (!config.templates.some(template => template.enabled)) errors.push('请至少启用一条问题模板。')
    for (const [index, template] of config.templates.entries()) {
      if (!template.enabled) continue
      if (!template.name) errors.push(`第 ${index + 1} 条模板缺少名称。`)
      if (!template.content) errors.push(`模板“${template.name || index + 1}”缺少内容。`)
      if (template.content.replace(/\{[^{}]+\}/g, '').match(/[{}]/)) {
        errors.push(`模板“${template.name || index + 1}”的变量大括号不完整。`)
      }
      for (const token of variableTokens(template.content)) {
        if (!tokens.has(token)) errors.push(`模板“${template.name || index + 1}”引用了未配置变量 {${token}}。`)
      }
    }
    return errors
  }

  function validateTopicGroups(topicGroups) {
    const errors = []
    for (const [index, group] of topicGroups.entries()) {
      const missing = FIXED_FIELDS.filter(field => !text(group?.[field.token])).map(field => field.label)
      if (missing.length) errors.push(`第 ${index + 1} 组话题不完整，请填写：${missing.join('、')}。`)
    }
    return errors
  }

  function validateConfig(input) {
    const config = normalizeConfig(input)
    return [...new Set([...validateTemplates(config), ...validateTopicGroups(config.topicGroups)])]
  }

  function renderTemplate(template, topic) {
    return template.content.replace(/\{([^{}]+)\}/g, (_match, rawToken) => text(topic[rawToken.trim()])).replace(/[ \t]+/g, ' ').trim()
  }

  function generateProductBatch(input, products) {
    const config = normalizeConfig(input)
    const topicGroups = Array.isArray(products) && products.length
      ? products.map(normalizeTopicGroup)
      : config.topicGroups
    const errors = [...new Set([...validateTemplates(config), ...validateTopicGroups(topicGroups)])]
    const effectiveConfig = { ...config, topicGroups }
    if (errors.length) return { questions: [], questionGroups: [], errors, warnings: [], config: effectiveConfig }

    const questions = []
    const seen = new Set()
    const questionGroups = topicGroups.map((topic, topicIndex) => ({
      topicIndex,
      topic: normalizeTopicGroup(topic),
      questions: [],
    }))
    for (const [topicIndex, topic] of topicGroups.entries()) {
      for (const template of config.templates.filter(item => item.enabled)) {
        const question = renderTemplate(template, topic)
        const key = canonicalQuestion(question)
        if (!key || seen.has(key)) continue
        seen.add(key)
        questions.push(question)
        questionGroups[topicIndex].questions.push(question)
      }
    }
    return { questions, questionGroups, errors: [], warnings: [], config: effectiveConfig }
  }

  function generateQuestions(input) {
    return generateProductBatch(input)
  }

  return {
    FIXED_FIELDS,
    DEFAULT_CONFIG,
    defaultTopicGroup,
    defaultConfig,
    normalizeTopicGroup,
    normalizeConfig,
    validateConfig,
    generateQuestions,
    generateProductBatch,
    canonicalQuestion,
    variableTokens,
  }
})
