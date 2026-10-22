// 验证 3：状态机与重试节奏。
// 覆盖跨天重置、失败计数、退避时刻、成功后的「当天不再跑」。
// 用临时目录里的状态文件，绝不触碰真实 state.json。
import fs from 'node:fs'
import { createChecker, load, makeTempHome } from './harness.mjs'

const check = createChecker('state')
const { CheckinState, beijingDay, RETRY_STEPS_MS, MAX_FAILURES } = await load('lib/state.mjs')

const home = makeTempHome()
const day = beijingDay()
const at = (hhmmss) => Date.parse(`${day}T${hhmmss}Z`)

// ---- 北京时间日界 ----
check.eq('UTC 15:59:59 → 北京 2026-10-21', beijingDay(Date.parse('2026-10-21T15:59:59Z')), '2026-10-21')
check.eq('UTC 16:00:00 → 北京 2026-10-22', beijingDay(Date.parse('2026-10-21T16:00:00Z')), '2026-10-22')
check.eq('UTC 00:00:00 → 北京当天', beijingDay(Date.parse('2026-10-21T00:00:00Z')), '2026-10-21')

// ---- 初始状态 ----
{
  const st = new CheckinState(home.stateFile)
  check.eq('新状态 lastSuccessDay 为空', st.data.lastSuccessDay, null)
  check.eq('新状态 failureCount 为 0', st.data.failureCount, 0)
  check.ok('新状态今天未尝试', !st.triedToday())
  check.ok('新状态还有重试次数', st.hasRetriesLeft())
  check.ok('新状态 nextAttemptAt 为 0', st.dueAt() === 0)
  check.ok('新状态尚未收工', !st.settledToday())
}

// ---- 只读接口的形状 ----
{
  const st = new CheckinState(home.stateFile)
  const s = st.summary()
  for (const key of ['lastSuccessDay', 'lastResult', 'streakDays', 'failureCount', 'nextAttemptAt', 'recent']) {
    check.ok(`summary 含 ${key}`, Object.prototype.hasOwnProperty.call(s, key))
  }
}

// ---- 连续 5 次失败的退避时刻，逐档核对 ----
// 语义：第 N 次失败后等待 RETRY_STEPS_MS[N]（首元素 0 是进程启动那一刻，不参与失败退避），
// 所以 5 次失败对应 1 / 1 / 2 / 2 / 3 分钟，与 README 的行为表一致。
{
  const st = new CheckinState(home.stateFile)
  const expected = [60_000, 60_000, 120_000, 120_000, 180_000]
  let now = at('02:00:00')
  for (let i = 0; i < 5; i++) {
    st.recordFailure({ day, error: `e${i}`, now })
    const wait = st.dueAt() - now
    check.eq(`第 ${i + 1} 次失败后退避 ${expected[i] / 60_000} 分钟`, wait, expected[i])
    now += wait
  }
  const totalMinutes = (now - at('02:00:00')) / 60_000
  check.eq('5 次退避累计正好约 9 分钟', totalMinutes, 9)
  check.eq('连续 5 次失败后计数', st.data.failureCount, 5)
  check.ok('5 次仍算「还有重试余地」', st.hasRetriesLeft(), `failureCount=5, MAX=${MAX_FAILURES}`)

  // 第 6 次失败 = 用尽
  st.recordFailure({ day, error: 'last', now })
  check.eq('第 6 次失败后计数', st.data.failureCount, 6)
  check.ok('第 6 次失败 → 重试用尽', !st.hasRetriesLeft())
  check.ok('重试用尽 → 今天已收工', st.settledToday())
  check.ok('重试用尽 → 不该再动手', !st.shouldAttempt(now))

  const narr = st.narration(day)
  check.eq('用尽后的播报口径是 failed', narr.outcome, 'failed')
  check.ok('用尽后的播报说明重试已用尽', /重试已用尽/.test(narr.humanReadable), narr.humanReadable)
}

// ---- 失败中的「正在重试」口径 ----
{
  const fresh = makeTempHome()
  const st = new CheckinState(fresh.stateFile)
  st.recordFailure({ day, error: 'HTTP 502', now: at('03:00:00') })
  const narr = st.narration(day)
  check.eq('首次失败后播报口径是 retrying', narr.outcome, 'retrying')
  check.ok('播报含「正在自动重试」', /正在自动重试/.test(narr.humanReadable), narr.humanReadable)

  // 跨天：昨天的失败不该继续污染今天的播报
  st.data.lastAttemptDay = beijingDay(at('03:00:00') - 86_400_000)
  st.rollover(at('03:00:00'))
  check.eq('跨天后失败计数清零', st.data.failureCount, 0)
  check.eq('跨天后 nextAttemptAt 清零', st.dueAt(), 0)
  check.ok('跨天后重新可尝试', st.hasRetriesLeft())
  fresh.cleanup()
}

// ---- 成功路径 ----
{
  const fresh = makeTempHome()
  const st = new CheckinState(fresh.stateFile)
  // 先放一个旧余额，模拟「上一次的余额还留在顶层」
  st.data.totalCredits = 200
  st.save()
  st.recordSuccess({ day, credit: 100, streakDays: 3, totalCredits: 300 })
  check.eq('成功后 lastSuccessDay = 今天', st.data.lastSuccessDay, day)
  check.eq('成功后 lastAttemptDay = 今天', st.data.lastAttemptDay, day)
  check.eq('成功后连续天数记录', st.data.streakDays, 3)
  check.eq('成功后顶层余额被更新（不再停留在旧值）', st.data.totalCredits, 300)
  check.eq('成功后失败计数归零', st.data.failureCount, 0)
  check.eq('成功后 nextAttemptAt 归零', st.dueAt(), 0)
  check.ok('成功后今天已收工', st.settledToday())
  check.ok('成功后不该再动手', !st.shouldAttempt())
  check.ok('成功后 triedToday 为真', st.triedToday())

  const narr = st.narration(day)
  check.eq('成功后播报口径是 claimed', narr.outcome, 'claimed')
  check.ok('播报含积分数字', /100/.test(narr.humanReadable), narr.humanReadable)
  check.ok('播报含连续天数', /连续第 3 天/.test(narr.humanReadable), narr.humanReadable)
  check.ok('播报含的是最新余额 300 而不是旧值 200', /余额 300/.test(narr.humanReadable), narr.humanReadable)
  check.ok('播报不含 null', !/null/.test(narr.humanReadable), narr.humanReadable)
  check.eq('summary 的余额同步为最新值', st.summary().totalCredits, 300)
  fresh.cleanup()
}

// ---- 「今天已签过」路径 ----
{
  const fresh = makeTempHome()
  const st = new CheckinState(fresh.stateFile)
  st.data.totalCredits = 150
  st.save()
  st.recordSkipped({ day, reason: 'already-checked', streakDays: 2, totalCredits: 200 })
  check.eq('已签过也置 lastSuccessDay', st.data.lastSuccessDay, day)
  check.eq('已签过也更新顶层余额', st.data.totalCredits, 200)
  check.ok('已签过 → 不该再动手', !st.shouldAttempt())
  const narr = st.narration(day)
  check.eq('已签过播报口径是 no-op', narr.outcome, 'no-op')
  check.ok('已签过播报含连续天数', /连续 2 天/.test(narr.humanReadable), narr.humanReadable)
  check.ok('已签过播报用的是最新余额', /余额 200/.test(narr.humanReadable), narr.humanReadable)
  fresh.cleanup()
}

// ---- 旧版本遗留的根顶层余额为 null 时，summary 要能回退到历史 ----
{
  const fresh = makeTempHome()
  const st = new CheckinState(fresh.stateFile)
  st.recordSuccess({ day, credit: 100, streakDays: 3, totalCredits: 300 })
  // 模拟旧版写下的数据：顶层被抹成 null
  st.data.totalCredits = null
  st.save()
  const reread = new CheckinState(fresh.stateFile)
  check.eq('顶层为 null 时 summary 回退到历史里的余额', reread.summary().totalCredits, 300)
  fresh.cleanup()
}

// ---- 旧版本遗留的顶层是「过时数字」而不是 null ----
//
// 这是真实踩到的场景：旧版 recordSuccess 只把 totalCredits 写进 history，
// 顶层停留在上一次的值（200），今天明明已经变成 300。
// 只判 null 的回退逻辑在这种情况下没救——顶层是合法的数字，看着完全正常。
{
  const fresh = makeTempHome()
  const st = new CheckinState(fresh.stateFile)
  // 模拟旧数据：顶层是昨天的 200
  st.data.totalCredits = 200
  st.data.history = [
    { day: '2026-10-21', result: 'already-checked', totalCredits: 200, at: '2026-10-21T11:54:05.720Z' },
  ]
  st.save()

  const reread = new CheckinState(fresh.stateFile)
  // 今天新签到成功，余额 300
  reread.recordSuccess({ day, credit: 100, streakDays: 3, totalCredits: 300 })
  check.eq('成功后顶层被写成 300', reread.data.totalCredits, 300)
  check.eq('summary 拿到 300', reread.summary().totalCredits, 300)

  // 关键回归：把顶层故意退回旧值 200，模拟「旧版写下的、没被本次更新覆盖」的文件
  reread.data.totalCredits = 200
  reread.save()
  const legacy = new CheckinState(fresh.stateFile)
  check.eq('顶层是过时旧值 200 时，summary 仍取历史最新的 300', legacy.summary().totalCredits, 300)
  check.ok(
    '顶层是过时旧值 200 时，播报也说 300',
    /余额 300/.test(legacy.narration(day).humanReadable),
    legacy.narration(day).humanReadable,
  )
  check.eq('latestCredits() 以历史为准', legacy.latestCredits(), 300)
  fresh.cleanup()
}

// ---- 没有 history 时 latestCredits 退回顶层字段 ----
{
  const fresh = makeTempHome()
  const st = new CheckinState(fresh.stateFile)
  st.data.totalCredits = 500
  st.data.history = []
  check.eq('无历史时用顶层字段', st.latestCredits(), 500)
  st.data.totalCredits = null
  check.eq('无历史且顶层为 null 时返回 null', st.latestCredits(), null)
  fresh.cleanup()
}

// ---- 原子写：写完不留临时文件，且内容可被重新读回 ----
{
  const fresh = makeTempHome()
  const st = new CheckinState(fresh.stateFile)
  st.recordSuccess({ day, credit: 50, streakDays: 1, totalCredits: 50 })
  const dir = `${fresh.dir}/.workbuddy-checkin`
  const leftovers = fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'))
  check.eq('没有残留 .tmp 文件', leftovers, [])
  const reread = new CheckinState(fresh.stateFile)
  check.eq('重新载入后数据一致', reread.data.lastSuccessDay, day)
  fresh.cleanup()
}

// ---- 历史长度上限 ----
{
  const fresh = makeTempHome()
  const st = new CheckinState(fresh.stateFile)
  for (let i = 0; i < 100; i++) st.recordFailure({ day, error: `e${i}`, now: at('02:00:00') + i })
  check.ok('历史记录被截断到 60 条以内', st.data.history.length <= 60, `${st.data.history.length} 条`)
  check.ok('summary.recent 最多 7 条', st.summary().recent.length <= 7, `${st.summary().recent.length} 条`)
  fresh.cleanup()
}

// ---- 坏状态文件不抛异常 ----
{
  const fresh = makeTempHome()
  fs.mkdirSync(`${fresh.dir}/.workbuddy-checkin`, { recursive: true })
  fs.writeFileSync(fresh.stateFile, '{ broken', 'utf8')
  let threw = false
  let st = null
  try {
    st = new CheckinState(fresh.stateFile)
  } catch {
    threw = true
  }
  check.ok('坏状态文件不抛异常', !threw)
  check.eq('坏状态文件 → 回到默认值', st && st.data.failureCount, 0)
  fresh.cleanup()
}

home.cleanup()
process.exit(check.report() ? 0 : 1)
