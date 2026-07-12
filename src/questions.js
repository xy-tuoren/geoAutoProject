const fs = require('node:fs/promises')
const path = require('node:path')
const XLSX = require('xlsx')

function cleanQuestions(items) {
  return [...new Set(items.map(item => String(item ?? '').trim()).filter(Boolean))]
}

async function loadQuestionFile(filePath, questionColumn = '问题') {
  const extension = path.extname(filePath).toLowerCase()
  if (extension === '.txt') {
    return cleanQuestions((await fs.readFile(filePath, 'utf8')).split(/\r?\n/).filter(line => !line.trim().startsWith('#')))
  }
  if (extension === '.json') {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'))
    const values = Array.isArray(parsed) ? parsed : (parsed.questions || parsed['问题'])
    if (!Array.isArray(values)) throw new Error('JSON 文件应为问题数组，或包含 questions / 问题 数组。')
    return cleanQuestions(values.map(item => typeof item === 'object' && item ? item[questionColumn] ?? item.question ?? item['问题'] : item))
  }
  if (extension === '.csv' || extension === '.xlsx' || extension === '.xlsm') {
    // XLSX.readFile treats UTF-8 CSV as a legacy code page on some platforms.
    // Reading the bytes explicitly keeps the default Chinese “问题” header intact.
    const workbook = extension === '.csv'
      ? XLSX.read(await fs.readFile(filePath), { type: 'buffer', raw: false, codepage: 65001 })
      : XLSX.readFile(filePath, { raw: false })
    const firstSheet = workbook.Sheets[workbook.SheetNames[0]]
    const rows = XLSX.utils.sheet_to_json(firstSheet, { defval: '' })
    if (!rows.length || !Object.prototype.hasOwnProperty.call(rows[0], questionColumn)) throw new Error(`文件中未找到“${questionColumn}”列。`)
    return cleanQuestions(rows.map(row => row[questionColumn]))
  }
  throw new Error('仅支持 TXT、CSV、JSON、XLSX 和 XLSM 问题文件。')
}

module.exports = { cleanQuestions, loadQuestionFile }
