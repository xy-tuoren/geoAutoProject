const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const html = fs.readFileSync(path.join(__dirname, '../../src/renderer/index.html'), 'utf8')
const renderer = fs.readFileSync(path.join(__dirname, '../../src/renderer/renderer.js'), 'utf8')

test('问题队列包含固定商品字段、XLSX 导入和人工确认入口', () => {
  for (const id of [
    'open-question-generator',
    'question-generator-dialog',
    'generator-fields',
    'add-generator-topic',
    'generator-product-dropzone',
    'clear-generator-products',
    'generator-import-state',
    'generator-templates',
    'generator-preview-list',
    'generate-product-questions',
    'confirm-generated-questions',
  ]) assert.match(html, new RegExp(`id="${id}"`))

  assert.ok(html.indexOf('question-generator.js') < html.indexOf('renderer.js'))
  assert.match(renderer, /GENERATOR_STORAGE_KEY/)
  assert.match(renderer, /generatorPreviewGroups\.flatMap/)
  assert.match(renderer, /topicGroups\.push\(defaultTopicGroup\(\)\)/)
  assert.match(renderer, /selectProductWorkbook/)
  assert.match(renderer, /importProductWorkbook/)
  assert.match(renderer, /importGeneratorProductFile/)
  assert.match(renderer, /generatorConfig\.topicGroups = products\.map\(normalizeGeneratorTopicGroup\)/)
  assert.doesNotMatch(renderer, /generatorImportedProducts/)
  assert.match(renderer, /generatorProductDropzone\.addEventListener\('dragenter'/)
  assert.match(renderer, /generatorProductDropzone\.addEventListener\('drop'/)
  assert.match(renderer, /getPathForFile\(file\)/)
  assert.match(renderer, /confirm-generated-questions/)
  assert.match(html, /id="generator-product-dropzone"[\s\S]*role="button"[\s\S]*tabindex="0"/)
  assert.match(html, /拖入 XLSX 批量导入/)
  assert.match(renderer, /generator-preview-group-heading/)
  assert.match(renderer, /第 \$\{groupIndex \+ 1\} 组/)
  assert.match(renderer, /movePreviewQuestion\(groupIndex, questionIndex/)
  assert.match(html, /<table class="generator-topic-table"/)
  for (const heading of ['商品名', '通用名', '适应症', '药品类型', '操作']) {
    assert.match(html, new RegExp(`<th scope="col">${heading}</th>`))
  }
  assert.match(renderer, /document\.createElement\('tr'\)/)
  assert.doesNotMatch(html, /id="add-generator-field"/)
  assert.doesNotMatch(html, /id="generator-missing-variable-mode"/)
  assert.doesNotMatch(html, /生成策略|generator-multi-value-mode|generator-max-questions|generator-deduplicate/)
  assert.doesNotMatch(renderer, /updateGeneratorStrategy|multiValueMode|maxQuestions/)
  assert.doesNotMatch(renderer, /上移字段|下移字段|删除字段/)
  assert.doesNotMatch(renderer, /generator-topic-group|generator-field-row/)
})

test('问题队列提供品牌分组语法、实时预览和分组任务载荷', () => {
  for (const id of ['questions', 'question-plan-preview', 'question-count', 'plan']) {
    assert.match(html, new RegExp(`id="${id}"`))
  }
  assert.ok(html.indexOf('../question-plan.js') < html.indexOf('renderer.js'))
  assert.match(html, /#品牌名/)
  assert.doesNotMatch(html, /# 品牌：名称/)
  assert.doesNotMatch(html, /## 产品：名称/)
  assert.match(renderer, /parseQuestionInput/)
  assert.match(renderer, /renderQuestionPlan/)
  assert.match(renderer, /brandGroups: questionPlan\.brandGroups/)
  assert.match(renderer, /品牌目录不加序号/)
})
