const test = require('node:test')
const assert = require('node:assert/strict')
const { parseQuestionInput, normalizeQuestionPlan, brandExecutionUnits, safeDirectorySegment } = require('../../src/question-plan')

test('普通问题列表保持旧模式并全局去重', () => {
  const plan = parseQuestionInput('问题一\n问题二\n问题一')
  assert.equal(plan.mode, 'flat')
  assert.deepEqual(plan.questions, ['问题一', '问题二'])
  assert.deepEqual(plan.errors, [])
})

test('一次粘贴可解析品牌和品牌内问题顺序', () => {
  const plan = parseQuestionInput(`#诺和诺德
问题一
问题二
# 礼来
问题一
问题三`)
  assert.equal(plan.mode, 'grouped')
  assert.deepEqual(plan.errors, [])
  assert.deepEqual(plan.brandGroups, [
    { brand: '诺和诺德', questions: ['问题一', '问题二'] },
    { brand: '礼来', questions: ['问题一', '问题三'] },
  ])
  assert.deepEqual(plan.tasks.map(task => [task.brand_index, task.question_index_in_brand, task.question]), [
    [1, 1, '问题一'], [1, 2, '问题二'], [2, 1, '问题一'], [2, 2, '问题三'],
  ])
})

test('相同问题只在同一品牌内去重，不跨品牌删除', () => {
  const plan = normalizeQuestionPlan({ brandGroups: [
    { brand: '品牌A', questions: ['同一个问题', '同一个问题'] },
    { brand: '品牌B', questions: ['同一个问题'] },
  ] })
  assert.equal(plan.tasks.length, 2)
  assert.deepEqual(plan.tasks.map(task => task.brand), ['品牌A', '品牌B'])
})

test('分组执行单元严格保持品牌输入顺序', () => {
  const plan = normalizeQuestionPlan({ brandGroups: [
    { brand: '品牌B', questions: ['B-1', 'B-2'] },
    { brand: '品牌A', questions: ['A-1'] },
  ] })
  assert.deepEqual(brandExecutionUnits(plan).map(unit => [unit.brand, unit.tasks.map(task => task.question)]), [
    ['品牌B', ['B-1', 'B-2']],
    ['品牌A', ['A-1']],
  ])
})

test('无品牌问题、空品牌和目录名称冲突会在执行前报错', () => {
  const missing = parseQuestionInput('没有品牌的问题\n#品牌A')
  assert.equal(missing.mode, 'grouped')
  assert.ok(missing.errors.some(error => /没有所属品牌/.test(error)))
  assert.ok(missing.errors.some(error => /没有问题/.test(error)))
  assert.throws(() => normalizeQuestionPlan({ brandGroups: [
    { brand: 'A/B', questions: ['问题'] },
    { brand: 'A:B', questions: ['问题'] },
  ] }), /相同目录/)
  assert.equal(safeDirectorySegment('A/B'), 'A_B')
})

test('品牌标题只接受井号后直接跟品牌名', () => {
  const plan = parseQuestionInput('# 品牌：诺和诺德\n问题一')
  assert.ok(plan.errors.some(error => /无需填写“品牌：”/.test(error)))
  assert.equal(plan.tasks.length, 0)
  assert.ok(parseQuestionInput('## 产品：司美格鲁肽\n问题一').errors.some(error => /只需一个“#”/.test(error)))
})
