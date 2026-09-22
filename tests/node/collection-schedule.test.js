const test = require('node:test')
const assert = require('node:assert/strict')
const { normalizeQuestionPlan } = require('../../src/question-plan')
const { normalizeAutomationEntries } = require('../../src/automation/entry-catalog')
const { collectionSchedule, normalizeCollectionOrder } = require('../../src/automation/collection-schedule')
const { resumeItems } = require('../../src/automation/batch-state')
const { failedRetryItems } = require('../../src/automation/batch-recovery')

function scheduled(plan, ids, order) {
  return collectionSchedule(plan, normalizeAutomationEntries(ids), order)
    .flatMap(({ tasks, entry }) => tasks.map(task => ({ ...task, entry_id: entry.id, status: 'pending' })))
}

test('两种采集顺序覆盖所有品牌，平台优先级不被目录或默认入口顺序覆盖', () => {
  const plan = normalizeQuestionPlan({ brandGroups: [{ brand: '甲', questions: ['同题', '第二题'] }, { brand: '乙', questions: ['同题'] }] })
  for (const ids of [['doubao-app', 'xiaohe-app'], ['xiaohe-app', 'doubao-app']]) {
    const platform = scheduled(plan, ids, 'platform_first')
    const question = scheduled(plan, ids, 'question_first')
    const pairs = rows => rows.map(row => [row.entry_id, row.question_index])
    assert.deepEqual(pairs(platform), [[ids[0], 1], [ids[0], 2], [ids[0], 3], [ids[1], 1], [ids[1], 2], [ids[1], 3]])
    assert.deepEqual(pairs(question), [[ids[0], 1], [ids[1], 1], [ids[0], 2], [ids[1], 2], [ids[0], 3], [ids[1], 3]])
    assert.deepEqual(platform.filter(row => row.entry_id === ids[0]).map(row => [row.brand, row.question_index_in_brand]), [['甲', 1], ['甲', 2], ['乙', 1]])
    assert.deepEqual(scheduled(plan, ids), platform)
  }
})

test('普通问题和单平台保持题序，未知采集模式不能静默执行', () => {
  const plan = normalizeQuestionPlan({ questions: ['first', 'second'] })
  for (const order of ['platform_first', 'question_first']) {
    const segments = collectionSchedule(plan, normalizeAutomationEntries(['doubao-app']), order)
    assert.equal(segments.length, 1, '单平台无需逐题重新准备入口')
    assert.deepEqual(segments[0].tasks.map(task => task.question), ['first', 'second'])
  }
  assert.equal(normalizeCollectionOrder(), 'platform_first')
  for (const value of ['', null, 'brand_first', 'typo']) assert.throws(() => normalizeCollectionOrder(value), /采集顺序/)
})

test('续批次和失败重试按持久化计划过滤，旧版品牌优先计划同样不重排', () => {
  const plan = normalizeQuestionPlan({ questions: ['first', 'second', 'third'] })
  for (const collection_order of ['platform_first', 'question_first', undefined]) {
    const results = scheduled(plan, ['doubao-app', 'xiaohe-app'], collection_order)
    results.forEach((row, index) => { row.status = ['completed', 'needs_confirmation', 'pending', 'failed', 'failed', 'pending'][index] })
    const summary = { collection_order, results }
    assert.deepEqual(resumeItems(summary, { resume: true }).map(row => row.resultIndex), [2, 3, 4, 5])
    assert.deepEqual(resumeItems(summary, { resume: true, includeUncertain: true }).map(row => row.resultIndex), [1, 2, 3, 4, 5])
    assert.deepEqual(failedRetryItems(summary).map(row => row.resultIndex), [3, 4])
  }
})
