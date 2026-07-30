const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const XLSX = require('xlsx')
const { PRODUCT_COLUMNS, parseProductWorkbook } = require('../../src/product-question-import')

function writeWorkbook(rows) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'geo-product-import-'))
  const file = path.join(directory, 'products.xlsx')
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), '商品')
  XLSX.writeFile(workbook, file)
  return { directory, file }
}

test('XLSX 按四个固定列导入并跳过全空行', t => {
  const fixture = writeWorkbook([
    [...PRODUCT_COLUMNS, '备注'],
    ['立天舒', '降脂通便胶囊', '血脂高,便秘', '中成药', '忽略'],
    ['', '', '', '', ''],
    ['雅塑', '奥利司他胶囊', '肥胖', '西药', '忽略'],
  ])
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }))

  assert.deepEqual(parseProductWorkbook(fixture.file), [
    { '商品名': '立天舒', '通用名': '降脂通便胶囊', '适应症': '血脂高,便秘', '药品类型': '中成药' },
    { '商品名': '雅塑', '通用名': '奥利司他胶囊', '适应症': '肥胖', '药品类型': '西药' },
  ])
})

test('XLSX 缺少固定列时明确拒绝', t => {
  const fixture = writeWorkbook([
    ['商品名', '通用名', '适应症'],
    ['立天舒', '降脂通便胶囊', '便秘'],
  ])
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }))

  assert.throws(() => parseProductWorkbook(fixture.file), /缺少固定列：药品类型/)
})

test('XLSX 部分空值时指出真实表格行号', t => {
  const fixture = writeWorkbook([
    PRODUCT_COLUMNS,
    ['立天舒', '降脂通便胶囊', '便秘', '中成药'],
    ['雅塑', '', '肥胖', '西药'],
  ])
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }))

  assert.throws(() => parseProductWorkbook(fixture.file), /第 3 行缺少：通用名/)
})
