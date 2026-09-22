class DouyinSearchResultNotFoundError extends Error {
  constructor(message, { cause, scanScrolls = 0, inspection = null } = {}) {
    super(message, { cause })
    this.name = 'DouyinSearchResultNotFoundError'
    this.scanScrolls = scanScrolls
    this.inspection = inspection
  }
}

class ToutiaoAnswerCardNotFoundError extends Error {
  constructor(message, { cause, inspection = null } = {}) {
    super(message, { cause })
    this.name = 'ToutiaoAnswerCardNotFoundError'
    this.inspection = inspection
  }
}

class ToutiaoFullAnswerNotOpenedError extends Error {
  constructor(message, { cause } = {}) {
    super(message, { cause })
    this.name = 'ToutiaoFullAnswerNotOpenedError'
  }
}

async function runDouyinSearchResultAttempts({ waitForResult }) {
  return { ...(await waitForResult(1)), attempt: 1, refreshed: false }
}

module.exports = {
  DouyinSearchResultNotFoundError,
  ToutiaoAnswerCardNotFoundError,
  ToutiaoFullAnswerNotOpenedError,
  runDouyinSearchResultAttempts,
}
