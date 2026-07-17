class DouyinSearchResultNotFoundError extends Error {
  constructor(message, { cause, scanScrolls = 0 } = {}) {
    super(message, { cause })
    this.name = 'DouyinSearchResultNotFoundError'
    this.scanScrolls = scanScrolls
  }
}

class ToutiaoAnswerCardNotFoundError extends Error {
  constructor(message, { cause } = {}) {
    super(message, { cause })
    this.name = 'ToutiaoAnswerCardNotFoundError'
  }
}

class ToutiaoFullAnswerNotOpenedError extends Error {
  constructor(message, { cause } = {}) {
    super(message, { cause })
    this.name = 'ToutiaoFullAnswerNotOpenedError'
  }
}

async function runDouyinSearchResultAttempts({ waitForResult, refreshResults }) {
  try {
    return { ...(await waitForResult(1)), attempt: 1, refreshed: false }
  } catch (error) {
    if (!(error instanceof DouyinSearchResultNotFoundError)) throw error
    await refreshResults(error)
  }
  try {
    return { ...(await waitForResult(2)), attempt: 2, refreshed: true }
  } catch (error) {
    if (!(error instanceof DouyinSearchResultNotFoundError)) throw error
    throw new DouyinSearchResultNotFoundError(
      '抖音当前搜索结果刷新后再次扫描，仍未出现小荷AI医生智能总结或可验证的小程序入口卡片。',
      { cause: error, scanScrolls: error.scanScrolls },
    )
  }
}

async function runToutiaoAnswerCardAttempts({ waitForResult, repeatExactSearch }) {
  try {
    return { ...(await waitForResult(1)), attempt: 1, repeated: false }
  } catch (error) {
    if (!(error instanceof ToutiaoAnswerCardNotFoundError)) throw error
    await repeatExactSearch(error)
  }
  try {
    return { ...(await waitForResult(2)), attempt: 2, repeated: true }
  } catch (error) {
    if (!(error instanceof ToutiaoAnswerCardNotFoundError)) throw error
    throw new ToutiaoAnswerCardNotFoundError(
      '头条使用相同问题受控重试后，搜索结果仍未出现小荷AI医生“查看更多”卡片。',
      { cause: error },
    )
  }
}

async function runToutiaoFullAnswerAttempts({ initialTarget, openFullAnswer, repeatExactSearch, canRepeat = true }) {
  try {
    return { full: await openFullAnswer(initialTarget), target: initialTarget, attempt: 1, repeated: false }
  } catch (error) {
    if (!(error instanceof ToutiaoFullAnswerNotOpenedError) || !canRepeat) throw error
    const repeatedTarget = await repeatExactSearch(error)
    try {
      return { full: await openFullAnswer(repeatedTarget), target: repeatedTarget, attempt: 2, repeated: true }
    } catch (retryError) {
      if (!(retryError instanceof ToutiaoFullAnswerNotOpenedError)) throw retryError
      throw new ToutiaoFullAnswerNotOpenedError(
        `头条使用相同问题重新搜索后，“查看更多”仍未进入可验证的本题全文页；最后一次原因：${retryError.message}`,
        { cause: retryError },
      )
    }
  }
}

module.exports = {
  DouyinSearchResultNotFoundError,
  ToutiaoAnswerCardNotFoundError,
  ToutiaoFullAnswerNotOpenedError,
  runDouyinSearchResultAttempts,
  runToutiaoAnswerCardAttempts,
  runToutiaoFullAnswerAttempts,
}
