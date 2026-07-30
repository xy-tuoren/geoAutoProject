const test = require('node:test')
const assert = require('node:assert/strict')
const {
  defaultConfig,
  normalizeConfig,
  generateQuestions,
  generateProductBatch,
} = require('../../src/renderer/question-generator')

function withTopic(values) {
  const config = defaultConfig()
  Object.assign(config.topicGroups[0], values)
  return config
}

test('一组完整话题按五条默认模板生成问题', () => {
  const result = generateQuestions(withTopic({
    '商品名': '立天舒',
    '通用名': '降脂通便胶囊',
    '适应症': '血脂高便秘',
    '药品类型': '中成药',
  }))

  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.questions, [
    '降脂通便胶囊',
    '立天舒降脂通便胶囊',
    '降脂通便胶囊作用与功效',
    '血脂高便秘吃什么中成药',
    '血脂高便秘吃降脂通便胶囊有效吗',
  ])
  assert.equal(result.questionGroups.length, 1)
  assert.deepEqual(result.questionGroups[0].topic, {
    '商品名': '立天舒',
    '通用名': '降脂通便胶囊',
    '适应症': '血脂高便秘',
    '药品类型': '中成药',
  })
  assert.deepEqual(result.questionGroups[0].questions, result.questions)
})

test('多个完整话题按组生成，不在四个字段之间交叉组合', () => {
  const config = defaultConfig()
  config.topicGroups = [
    { '商品名': '甲', '通用名': '药品A', '适应症': '症状A', '药品类型': '中成药' },
    { '商品名': '乙', '通用名': '药品B', '适应症': '症状B', '药品类型': '西药' },
  ]
  config.templates = [{ id: 'paired', name: '组内配对', enabled: true, content: '{商品名}-{通用名}-{适应症}-{药品类型}' }]

  assert.deepEqual(generateQuestions(config).questions, [
    '甲-药品A-症状A-中成药',
    '乙-药品B-症状B-西药',
  ])
})

test('字段中的逗号作为当前话题内容保留，不再拆值或生成组合', () => {
  const config = withTopic({ '商品名': '甲', '通用名': '药品A', '适应症': '头痛,发热', '药品类型': '药' })
  config.templates = [{ id: 't', name: '症状', enabled: true, content: '{适应症}吃什么药' }]

  assert.deepEqual(generateQuestions(config).questions, ['头痛,发热吃什么药'])
})

test('任一话题组缺少任何固定字段都会阻止整批生成', () => {
  const config = withTopic({ '商品名': '甲', '通用名': '药品A', '适应症': '症状A', '药品类型': '中成药' })
  config.topicGroups.push({ '商品名': '乙', '通用名': '', '适应症': '', '药品类型': '西药' })
  const result = generateQuestions(config)

  assert.deepEqual(result.questions, [])
  assert.match(result.errors[0], /第 2 组话题不完整/)
  assert.match(result.errors[0], /通用名、适应症/)
})

test('旧版单组字段配置迁移为一个完整话题组', () => {
  const config = normalizeConfig({ fields: [
    { label: '商品名', token: '商品名', value: '立天舒' },
    { label: '通用名', token: '通用名', value: '降脂通便胶囊' },
    { label: '适应症', token: '适应症', value: '便秘' },
    { label: '药品类型', token: '药品类型', value: '中成药' },
  ] })

  assert.deepEqual(config.topicGroups, [{
    '商品名': '立天舒',
    '通用名': '降脂通便胶囊',
    '适应症': '便秘',
    '药品类型': '中成药',
  }])
  assert.equal(config.strategy, undefined)
})

test('问题模板可配置并使用四个固定变量', () => {
  const config = withTopic({
    '商品名': '立天舒',
    '通用名': '降脂通便胶囊',
    '适应症': '成人便秘',
    '药品类型': '中成药',
  })
  config.templates = [{ id: 'custom', name: '自定义', enabled: true, content: '{适应症}可以使用{商品名}{通用名}吗' }]

  assert.deepEqual(generateQuestions(config).questions, ['成人便秘可以使用立天舒降脂通便胶囊吗'])
})

test('未配置变量和不完整大括号都会在生成前明确拒绝', () => {
  const config = withTopic({ '商品名': '甲', '通用名': '药品A', '适应症': '症状A', '药品类型': '中成药' })
  config.templates = [{ id: 'bad', name: '错误模板', enabled: true, content: '{不存在字段}有效吗' }]
  assert.match(generateQuestions(config).errors[0], /未配置变量/)

  config.templates = [{ id: 'bad-brace', name: '不完整模板', enabled: true, content: '{通用名有效吗' }]
  assert.match(generateQuestions(config).errors[0], /大括号不完整/)
})

test('XLSX 多行按完整话题生成并固定去重', () => {
  const config = defaultConfig()
  config.templates = [{ id: 'generic', name: '通用名', enabled: true, content: '{通用名}' }]
  const result = generateProductBatch(config, [
    { '商品名': '甲', '通用名': '药品A', '适应症': '症状A', '药品类型': '中成药' },
    { '商品名': '乙', '通用名': '药品A', '适应症': '症状B', '药品类型': '中成药' },
    { '商品名': '丙', '通用名': '药品C', '适应症': '症状C', '药品类型': '西药' },
  ])

  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.questions, ['药品A', '药品C'])
  assert.deepEqual(result.questionGroups.map(group => group.questions), [['药品A'], [], ['药品C']])
  assert.deepEqual(result.config.topicGroups, [
    { '商品名': '甲', '通用名': '药品A', '适应症': '症状A', '药品类型': '中成药' },
    { '商品名': '乙', '通用名': '药品A', '适应症': '症状B', '药品类型': '中成药' },
    { '商品名': '丙', '通用名': '药品C', '适应症': '症状C', '药品类型': '西药' },
  ])
})
