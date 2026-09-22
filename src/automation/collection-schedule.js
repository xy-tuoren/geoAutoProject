const { brandExecutionUnits } = require('../question-plan')

function normalizeCollectionOrder(value = 'platform_first') {
  if (!['platform_first', 'question_first'].includes(value)) {
    throw new Error('采集顺序必须是 platform_first（按平台）或 question_first（按问题）。')
  }
  return value
}

// Each segment stays on one platform and in one archive group. Result order is
// the durable execution plan: recovery filters it without reordering old batches.
function collectionSchedule(questionPlan, entries, order) {
  order = normalizeCollectionOrder(order)
  const units = brandExecutionUnits(questionPlan)
  const segments = []
  function append(unit, unitIndex, entry, entryIndex, tasks) {
    segments.push({ unit, unitIndex, entry, entryIndex, tasks })
  }
  if (order === 'platform_first') {
    entries.forEach((entry, entryIndex) => units.forEach((unit, unitIndex) => {
      append(unit, unitIndex, entry, entryIndex, unit.tasks)
    }))
  } else {
    units.forEach((unit, unitIndex) => {
      if (entries.length === 1) append(unit, unitIndex, entries[0], 0, unit.tasks)
      else unit.tasks.forEach(task => entries.forEach((entry, entryIndex) => {
        append(unit, unitIndex, entry, entryIndex, [task])
      }))
    })
  }
  return segments
}

module.exports = { normalizeCollectionOrder, collectionSchedule }
