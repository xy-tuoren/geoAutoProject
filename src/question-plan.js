(function exposeQuestionPlan(root, factory) {
  const api = factory()
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.questionPlan = api
})(typeof globalThis !== 'undefined' ? globalThis : window, function createQuestionPlanModule() {
  function cleanText(value) {
    return String(value ?? '').trim()
  }

  function safeDirectorySegment(value, limit = 48) {
    return cleanText(value).replace(/\s+/g, '_').replace(/[\\/:*?"<>|]+/g, '_').slice(0, limit) || '未命名'
  }

  function uniqueQuestions(items) {
    const seen = new Set()
    const questions = []
    for (const item of items || []) {
      const question = cleanText(item)
      if (!question || seen.has(question)) continue
      seen.add(question)
      questions.push(question)
    }
    return questions
  }

  function normalizeBrandGroups(input) {
    const errors = []
    if (!Array.isArray(input) || !input.length) return { brandGroups: [], errors: ['请至少添加一个品牌。'] }
    const brandGroups = []
    const seenBrands = new Set()
    const brandFolders = new Map()
    for (const [brandIndex, candidate] of input.entries()) {
      const brand = cleanText(candidate?.brand)
      const questions = uniqueQuestions(candidate?.questions)
      if (!brand) errors.push(`第 ${brandIndex + 1} 个品牌名称为空。`)
      else if (seenBrands.has(brand)) errors.push(`品牌“${brand}”重复出现，请合并为同一个品牌分组。`)
      else seenBrands.add(brand)
      if (!questions.length) errors.push(`品牌“${brand || brandIndex + 1}”没有问题。`)
      const brandFolder = safeDirectorySegment(brand)
      const existingBrand = brandFolders.get(brandFolder)
      if (brand && existingBrand && existingBrand !== brand) {
        errors.push(`品牌“${brand}”与“${existingBrand}”会生成相同目录“${brandFolder}”，请修改名称。`)
      } else if (brand) brandFolders.set(brandFolder, brand)
      brandGroups.push({ brand, questions })
    }
    return { brandGroups, errors }
  }

  function flattenBrandGroups(brandGroups) {
    const tasks = []
    let globalQuestionIndex = 0
    for (const [brandOffset, group] of brandGroups.entries()) {
      for (const [questionOffset, question] of group.questions.entries()) {
        globalQuestionIndex += 1
        tasks.push({
          question,
          question_index: globalQuestionIndex,
          global_question_index: globalQuestionIndex,
          question_index_in_brand: questionOffset + 1,
          brand: group.brand,
          brand_index: brandOffset + 1,
        })
      }
    }
    return tasks
  }

  function parseQuestionInput(text) {
    const lines = String(text ?? '').split(/\r?\n/)
    const hasGroupingHeader = lines.some(line => /^#/.test(line.trim()))
    if (!hasGroupingHeader) {
      const questions = uniqueQuestions(lines)
      return {
        mode: 'flat', questions, brandGroups: [], tasks: questions.map((question, index) => ({ question, question_index: index + 1 })), errors: [],
      }
    }

    const errors = []
    const brandGroups = []
    let currentBrand = null
    for (const [lineOffset, rawLine] of lines.entries()) {
      const line = rawLine.trim()
      if (!line) continue
      if (/^##/.test(line)) {
        errors.push(`第 ${lineOffset + 1} 行只需一个“#”，格式应为“#品牌名”。`)
        currentBrand = null
        continue
      }
      const brandMatch = /^#(?!#)\s*(.*)$/.exec(line)
      if (brandMatch) {
        const brand = cleanText(brandMatch[1])
        if (/^品牌\s*[：:]/.test(brand)) {
          errors.push(`第 ${lineOffset + 1} 行无需填写“品牌：”，请直接写“#${brand.replace(/^品牌\s*[：:]\s*/, '')}”。`)
          currentBrand = null
          continue
        }
        if (!brand) { errors.push(`第 ${lineOffset + 1} 行的品牌名称为空。`); currentBrand = null; continue }
        currentBrand = brandGroups.find(group => group.brand === brand)
        if (!currentBrand) { currentBrand = { brand, questions: [] }; brandGroups.push(currentBrand) }
        continue
      }
      if (!currentBrand) {
        errors.push(`第 ${lineOffset + 1} 行的问题没有所属品牌。`)
        continue
      }
      if (!currentBrand.questions.includes(line)) currentBrand.questions.push(line)
    }
    const normalized = normalizeBrandGroups(brandGroups)
    errors.push(...normalized.errors)
    const tasks = flattenBrandGroups(normalized.brandGroups)
    return { mode: 'grouped', questions: tasks.map(task => task.question), brandGroups: normalized.brandGroups, tasks, errors }
  }

  function normalizeQuestionPlan({ questions = [], brandGroups = [] } = {}) {
    if (Array.isArray(brandGroups) && brandGroups.length) {
      const normalized = normalizeBrandGroups(brandGroups)
      if (normalized.errors.length) throw new Error(normalized.errors.join('\n'))
      const tasks = flattenBrandGroups(normalized.brandGroups)
      return { mode: 'grouped', brandGroups: normalized.brandGroups, tasks, questions: tasks.map(task => task.question) }
    }
    const flatQuestions = uniqueQuestions(questions)
    if (!flatQuestions.length) throw new Error('请至少填写或导入一条问题。')
    return {
      mode: 'flat', brandGroups: [], questions: flatQuestions,
      tasks: flatQuestions.map((question, index) => ({ question, question_index: index + 1, global_question_index: index + 1 })),
    }
  }

  function brandExecutionUnits(plan) {
    if (plan.mode !== 'grouped') return [{ brand: null, tasks: plan.tasks }]
    return plan.brandGroups.map((brand, brandOffset) => ({
      brand: brand.brand,
      tasks: plan.tasks.filter(task => task.brand_index === brandOffset + 1),
    }))
  }

  return {
    safeDirectorySegment,
    uniqueQuestions,
    normalizeBrandGroups,
    flattenBrandGroups,
    parseQuestionInput,
    normalizeQuestionPlan,
    brandExecutionUnits,
  }
})
