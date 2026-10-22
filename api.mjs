// 签到接口客户端：只做两件事——查今天签没签、领今天的。
// 全部走公开 HTTP，不依赖 WorkBuddy 客户端进程。

export const STATUS_PATH = '/v2/billing/meter/checkin-activity-status'
export const CLAIM_PATH = '/v2/billing/meter/daily-checkin'

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

/** 业务码 10001 = 今天已经签过。 */
export const ALREADY_CHECKED_IN = 10001

export class UpstreamError extends Error {
  constructor(code, message, detail) {
    super(message)
    this.name = 'UpstreamError'
    this.code = code
    this.detail = detail
  }
}

function buildHeaders(cred) {
  return {
    Authorization: `Bearer ${cred.accessToken}`,
    'Content-Type': 'application/json',
    'X-Domain': cred.domain,
    'X-Product': 'SaaS',
    'User-Agent': BROWSER_UA,
    Accept: 'application/json, text/plain, */*',
  }
}

async function post(path, cred, timeoutMs) {
  const url = `https://${cred.domain}${path}`
  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(cred),
      body: '{}',
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    const reason = err && err.name === 'TimeoutError' ? '请求超时' : '网络不可达'
    throw new UpstreamError('NETWORK', `${reason}（${path}）`, String((err && err.message) || err))
  }

  const text = await response.text()
  if (!response.ok) {
    throw new UpstreamError('HTTP_STATUS', `接口返回 HTTP ${response.status}（${path}）`, text.slice(0, 300))
  }

  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new UpstreamError('BAD_BODY', `接口返回不是合法 JSON（${path}）`, text.slice(0, 300))
  }

  if (typeof body.code === 'number' && body.code !== 0 && body.code !== ALREADY_CHECKED_IN) {
    throw new UpstreamError('BIZ_CODE', `接口业务码 ${body.code}：${String(body.msg || '未知原因')}`, text.slice(0, 300))
  }
  return body
}

/** 查询签到状态。 */
export async function fetchStatus(cred, timeoutMs = 20000) {
  const body = await post(STATUS_PATH, cred, timeoutMs)
  const data = body.data || {}
  return {
    active: data.active === true,
    todayCheckedIn: data.today_checked_in === true,
    streakDays: typeof data.streak_days === 'number' ? data.streak_days : null,
    dailyCredit: typeof data.daily_credit === 'number' ? data.daily_credit : null,
    totalCredits: typeof data.total_credits === 'number' ? data.total_credits : null,
    activityName: typeof data.activity_name === 'string' ? data.activity_name : null,
    endTime: typeof data.end_time === 'string' ? data.end_time : null,
  }
}

/**
 * 领取今天的签到。
 * @returns {{alreadyClaimed:boolean, credit:number|null, streakDays:number|null}}
 */
export async function claimDaily(cred, timeoutMs = 20000) {
  let body
  try {
    body = await post(CLAIM_PATH, cred, timeoutMs)
  } catch (err) {
    // code 10001 在 post() 里被放行，但保险起见也拦一次
    if (err instanceof UpstreamError && /业务码 10001/.test(err.message)) {
      return { alreadyClaimed: true, credit: null, streakDays: null }
    }
    throw err
  }
  const data = body.data || {}
  return {
    alreadyClaimed: body.code === ALREADY_CHECKED_IN,
    credit: typeof data.credit === 'number' ? data.credit : null,
    streakDays: typeof data.streak_days === 'number' ? data.streak_days : null,
  }
}
