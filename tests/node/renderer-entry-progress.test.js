const test = require('node:test')
const assert = require('node:assert/strict')
const { initializeEntryProgress, applyEntryProgress } = require('../../src/renderer/entry-progress')

test('入口进度分别累计成功失败并显示当前题号', () => {
  let state = initializeEntryProgress({
    entries: [{ id: 'xiaohe-app', label: '小荷AI医生APP' }, { id: 'douyin-xiaohe-miniapp', label: '抖音' }],
    question_count: 3,
  })
  state = applyEntryProgress(state, { type: 'question_started', entry_id: 'xiaohe-app', question_index: 1, question: '第一题' })
  assert.equal(state.entries[0].active_question_index, 1)
  state = applyEntryProgress(state, { type: 'question_completed', entry_id: 'xiaohe-app', question_index: 1 })
  state = applyEntryProgress(state, { type: 'question_failed', entry_id: 'xiaohe-app', question_index: 2 })
  assert.deepEqual([state.entries[0].succeeded, state.entries[0].failed], [1, 1])
  assert.equal(state.entries[0].status, 'running')
  assert.equal(state.entries[1].status, 'pending')
})

test('失败题重试成功会替换原失败结果而不是重复累计', () => {
  let state = initializeEntryProgress({
    entries: [{ id: 'xiaohe-app', label: '小荷AI医生APP' }],
    question_count: 2,
    results: [
      { entry_id: 'xiaohe-app', question_index: 1, status: 'completed' },
      { entry_id: 'xiaohe-app', question_index: 2, status: 'failed' },
    ],
  })
  state = applyEntryProgress(state, { type: 'question_started', entry_id: 'xiaohe-app', question_index: 2 })
  state = applyEntryProgress(state, { type: 'question_completed', entry_id: 'xiaohe-app', question_index: 2 })
  assert.deepEqual([state.entries[0].succeeded, state.entries[0].failed], [2, 0])
  assert.equal(state.entries[0].status, 'completed')
})
