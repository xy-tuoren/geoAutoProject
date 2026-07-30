const path = require('node:path')
const XLSX = require('xlsx')

const PRODUCT_COLUMNS = ['商品名', '通用名', '适应症', '药品类型']

function cellText(value) {
  return String(value ?? '').trim()
}

function parseProductWorkbook(filePath) {
  if (path.extname(String(filePath || '')).toLowerCase() !== '.xlsx') {
    throw new Error('产品批量导入仅支持 XLSX 文件。')
  }

  const workbook = XLSX.readFile(filePath, { raw: false })
  const firstSheetName = workbook.SheetNames[0]
  if (!firstSheetName) throw new Error('XLSX 文件中没有工作表。')

  const matrix = XLSX.utils.sheet_to_json(workbook.Sheets[firstSheetName], {
    header: 1,
    defval: '',
    raw: false,
  })
  if (!matrix.length) throw new Error('XLSX 文件为空。')

  const headers = matrix[0].map(cellText)
  const missingColumns = PRODUCT_COLUMNS.filter(column => !headers.includes(column))
  if (missingColumns.length) {
    throw new Error(`XLSX 缺少固定列：${missingColumns.join('、')}。列名必须为：${PRODUCT_COLUMNS.join('、')}。`)
  }
  const indexes = Object.fromEntries(PRODUCT_COLUMNS.map(column => [column, headers.indexOf(column)]))
  const duplicateColumns = PRODUCT_COLUMNS.filter(column => headers.filter(header => header === column).length > 1)
  if (duplicateColumns.length) throw new Error(`XLSX 列名重复：${duplicateColumns.join('、')}。`)

  const products = []
  const rowErrors = []
  for (let index = 1; index < matrix.length; index += 1) {
    const product = Object.fromEntries(PRODUCT_COLUMNS.map(column => [column, cellText(matrix[index][indexes[column]])]))
    if (PRODUCT_COLUMNS.every(column => !product[column])) continue
    const missing = PRODUCT_COLUMNS.filter(column => !product[column])
    if (missing.length) {
      rowErrors.push(`第 ${index + 1} 行缺少：${missing.join('、')}`)
      continue
    }
    products.push(product)
  }

  if (rowErrors.length) throw new Error(`XLSX 商品数据不完整：${rowErrors.join('；')}。`)
  if (!products.length) throw new Error('XLSX 中没有可导入的商品数据。')
  return products
}

module.exports = { PRODUCT_COLUMNS, parseProductWorkbook }
