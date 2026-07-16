(function exposeEntryProgress(root, factory) {
  const api = factory()
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.entryProgress = api
})(typeof globalThis !== 'undefined' ? globalThis : window, function createEntryProgressModule() {
  function statusFor(entry) {
    const finished = Object.keys(entry.outcomes).length
    const failed = Object.values(entry.outcomes).filter(value => value === 'failed').length
    if (finished >= entry.total && entry.total > 0) return failed ? 'completed_with_failures' : 'completed'
    if (entry.active_question_index || finished > 0 || entry.started) return 'running'
    return 'pending'
  }

  function summarize(entry) {
    const outcomes = Object.values(entry.outcomes)
    return {
      ...entry,
      succeeded: outcomes.filter(value => value === 'completed').length,
      failed: outcomes.filter(value => value === 'failed').length,
      finished: outcomes.length,
      status: statusFor(entry),
    }
  }

  function initializeEntryProgress({ entries = [], question_count: questionCount = 0, results = [] } = {}) {
    const state = {
      question_count: Number(questionCount) || 0,
      entries: entries.map(entry => ({
        id: entry.id,
        label: entry.label,
        total: Number(questionCount) || 0,
        outcomes: {},
        active_question_index: null,
        active_question: null,
        started: false,
      })),
    }
    for (const result of results) {
      const entry = state.entries.find(candidate => candidate.id === result.entry_id)
      if (!entry || !Number.isInteger(result.question_index)) continue
      if (result.status === 'completed' || result.status === 'failed') entry.outcomes[result.question_index] = result.status
    }
    return { ...state, entries: state.entries.map(summarize) }
  }

  function applyEntryProgress(state, event = {}) {
    if (event.type === 'initialized') return initializeEntryProgress(event)
    const entries = state.entries.map(previous => {
      if (previous.id !== event.entry_id) return previous
      const entry = { ...previous, outcomes: { ...previous.outcomes } }
      if (event.type === 'entry_started') entry.started = true
      if (event.type === 'question_started') {
        entry.started = true
        entry.active_question_index = event.question_index
        entry.active_question = event.question || null
      }
      if (event.type === 'question_completed' || event.type === 'question_failed') {
        entry.started = true
        entry.outcomes[event.question_index] = event.type === 'question_completed' ? 'completed' : 'failed'
        entry.active_question_index = null
        entry.active_question = null
      }
      return summarize(entry)
    })
    return { ...state, entries }
  }

  return { initializeEntryProgress, applyEntryProgress }
})
