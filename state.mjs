// 签到状态与调度：持久化到 $DSH_HOME/.workbuddy-checkin/state.json。
// 原则：任何异常都不外抛到宿主，最坏情况只是本插件这一轮没签上。
import fs from 'node:fs'
import path from 'node:path'

// 重试节奏：启动先跑一轮（首元素 0 表示立即），失败后按 1、1、2、2、3 分钟重排。
//
// 为什么不再是 15 分钟 / 1 小时 / 3 / 6 / 18 小时：
//   退避只有在进程一直活着时才有意义。DSH 单次使用时长通常不到一小时，
//   一旦失败，下一轮往往排在用户已经关掉程序之后，等于「失败永远看不见」。
//   压到 9 分钟跑完，用户开着 DSH 就能等到最终结论。
//   前两次密集是为了自愈瞬时网络抖动，后三次拉开避免在很短时间内连打五次。
export const RETRY_STEPS_MS = [0, 60_000, 60_000, 2 * 60_000, 2 * 60_000, 3 * 60_000]
export const MAX_FAILURES = RETRY_STEPS_MS.length - 1

/** 北京时间的日期串 YYYY-MM-DD（签到按北京时间自然日）。 */
export function beijingDay(now = Date.now()) {
  const t = new Date(now + 8 * 3600_000)
  return t.toISOString().slice(0, 10)
}

export class CheckinState {
  constructor(file) {
    this.file = file
    this.data = this.load()
  }

  defaults() {
    return {
      version: 1,
      lastAttemptDay: null,
      lastSuccessDay: null,
      lastResult: null,
      lastCredit: null,
      streakDays: null,
      // 顶层余额：summary() 与 narration() 都读它，
      // 所以每次成功都必须在这里更新，否则播报出来的余额会停在旧值上。
      totalCredits: null,
      failureCount: 0,
      nextAttemptAt: 0,
      history: [],
    }
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (parsed && typeof parsed === 'object') return { ...this.defaults(), ...parsed }
    } catch {
      // 文件不存在或损坏都从空状态开始，不抛
    }
    return this.defaults()
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
      fs.renameSync(tmp, this.file)
      return true
    } catch {
      return false
    }
  }

  /** 跨天重置：新的一天到了，把昨天的失败计数与重试时间清掉，其余保留。 */
  rollover(now = Date.now()) {
    const day = beijingDay(now)
    if (this.data.lastAttemptDay === day) return false
    if ((this.data.failureCount || 0) === 0 && (this.data.nextAttemptAt || 0) === 0) return false
    this.data.failureCount = 0
    this.data.nextAttemptAt = 0
    this.save()
    return true
  }

  /**
   * 今天是否已经动过手（不论成败）。
   * 「当天第一次启动才领」的唯一判据：今天只要试过，本次启动就不再领。
   * 重启不清零，只有跨天由 rollover() 清掉。
   */
  triedToday(now = Date.now()) {
    return this.data.lastAttemptDay === beijingDay(now)
  }

  /** 今天是否已经处理完（成功，或失败次数用尽）。 */
  settledToday(now = Date.now()) {
    const day = beijingDay(now)
    return this.data.lastSuccessDay === day || this.data.failureCount > MAX_FAILURES
  }

  /** 还有没有重试余地（不关心现在到没到点）。 */
  hasRetriesLeft() {
    return (this.data.failureCount || 0) <= MAX_FAILURES
  }

  /** 到点了没有。这是唯一的「现在能不能动手」判据，调度用它排计时器。 */
  dueAt() {
    return this.data.nextAttemptAt || 0
  }

  /** 现在还该不该动手。 */
  shouldAttempt(now = Date.now()) {
    if (this.data.lastSuccessDay === beijingDay(now)) return false
    if (!this.hasRetriesLeft()) return false
    return now >= this.dueAt()
  }

  recordSuccess({ day, credit, streakDays, totalCredits }) {
    this.data.lastAttemptDay = day
    this.data.lastSuccessDay = day
    this.data.lastResult = 'ok'
    this.data.lastCredit = credit
    this.data.streakDays = streakDays
    // 余额必须同步写到顶层：只写进 history 的话，summary/narration 读到的
    // 还是上一次的余额，播报就会说错数字（曾经真的这样错过一次）。
    if (typeof totalCredits === 'number') this.data.totalCredits = totalCredits
    this.data.failureCount = 0
    this.data.nextAttemptAt = 0
    this.pushHistory({ day, result: 'ok', credit, streakDays, totalCredits })
    this.save()
  }

  recordSkipped({ day, reason, streakDays, totalCredits }) {
    this.data.lastAttemptDay = day
    this.data.lastSuccessDay = day // 已经签过 = 今天不用再试
    this.data.lastResult = reason
    this.data.streakDays = typeof streakDays === 'number' ? streakDays : this.data.streakDays
    // 同理：跳过路线也拿到了最新余额，一并同步到顶层
    if (typeof totalCredits === 'number') this.data.totalCredits = totalCredits
    this.data.failureCount = 0
    this.data.nextAttemptAt = 0
    this.pushHistory({ day, result: reason, totalCredits })
    this.save()
  }

  recordFailure({ day, error, now = Date.now() }) {
    this.data.lastAttemptDay = day
    this.data.lastResult = 'failed'
    this.data.failureCount = (this.data.failureCount || 0) + 1
    const idx = Math.min(this.data.failureCount, RETRY_STEPS_MS.length - 1)
    this.data.nextAttemptAt = now + RETRY_STEPS_MS[idx]
    this.pushHistory({ day, result: 'failed', error })
    this.save()
  }

  pushHistory(entry) {
    const list = Array.isArray(this.data.history) ? this.data.history : []
    list.push({ ...entry, at: new Date().toISOString() })
    this.data.history = list.slice(-60)
  }

  /**
   * 当前余额的权威取值。
   *
   * 为什么不能只信顶层字段：旧版本把 totalCredits 只写进 history、没写顶层，
   * 于是磁盘上会同时存在「顶层是上一次的旧值」和「最新一条历史里的新值」。
   * 顶层那种情况不是 null，看着完全正常，只读它就会播报过期余额。
   * 所以顺序是：最新一条带余额的历史 → 顶层字段 → null。
   *
   * history 是追加写的，最后一条就是最近一次签到结果，它的余额最新。
   */
  latestCredits() {
    const history = Array.isArray(this.data.history) ? this.data.history : []
    const latest = [...history].reverse().find((h) => typeof h.totalCredits === 'number')
    if (latest) return latest.totalCredits
    return typeof this.data.totalCredits === 'number' ? this.data.totalCredits : null
  }

  summary() {
    const history = Array.isArray(this.data.history) ? this.data.history : []
    return {
      lastSuccessDay: this.data.lastSuccessDay,
      lastResult: this.data.lastResult,
      lastCredit: this.data.lastCredit,
      streakDays: this.data.streakDays,
      totalCredits: this.latestCredits(),
      failureCount: this.data.failureCount,
      nextAttemptAt: this.data.nextAttemptAt,
      recent: history.slice(-7),
    }
  }

  /**
   * 给 agent 读的「人话」摘要。
   *
   * 为什么单独做：agent 被唤醒后要一句话讲清结果，但原始字段里有 null、
   * 有时间戳、有英文状态码，直接念会说出「领到 null 积分」这种话。
   * 这里先把判断和数字整理好，agent 照着说就行，不需要它自己推理。
   */
  narration(day = beijingDay()) {
    const today = (this.data.history || []).find((h) => h.day === day) || null
    const todayResult = today ? today.result : this.data.lastResult
    const credit = today && typeof today.credit === 'number' ? today.credit : null
    const streak = this.data.streakDays
    // 余额优先取今天这条历史里的数字（那是本次签到刚拿到的真实余额）；
    // 今天没有带回余额时，退回 latestCredits()，它会挑最新一条历史记录，
    // 而不是盲目信顶层字段——顶层可能停在上一次的旧值上。
    const todayCredits = today && typeof today.totalCredits === 'number' ? today.totalCredits : null
    const balance = todayCredits !== null ? todayCredits : this.latestCredits()

    const parts = []
    let outcome = 'unknown'
    // 今天是失败过、但还留有重试机会 —— 说成「正在重试」而不是「没领成」。
    // 否则用户会以为今天就到此为止了，而实际上几分钟后还会再试。
    const failedToday = todayResult === 'failed'
    const retrying = failedToday && (this.data.failureCount || 0) > 0 && this.hasRetriesLeft()
    if (todayResult === 'ok') {
      outcome = 'claimed'
      parts.push(`今天领到 ${credit ?? '?'} 积分`)
      if (typeof streak === 'number') parts.push(`连续第 ${streak} 天`)
      if (typeof balance === 'number') parts.push(`当前余额 ${balance}`)
    } else if (retrying) {
      outcome = 'retrying'
      parts.push('今天这次领取失败了，正在自动重试')
      if (today && today.error) parts.push(`原因是 ${today.error}`)
      parts.push(`已经失败 ${this.data.failureCount} 次，几分钟内还有机会`)
    } else if (todayResult === 'failed') {
      outcome = 'failed'
      parts.push('今天这次没领成')
      if (today && today.error) parts.push(`原因是 ${today.error}`)
      if ((this.data.failureCount || 0) > 0) parts.push(`已经失败 ${this.data.failureCount} 次，重试已用尽`)
    } else if (todayResult === 'already-checked' || todayResult === 'inactive') {
      outcome = 'no-op'
      parts.push('今天没有新的领取')
      if (typeof streak === 'number') parts.push(`当前连续 ${streak} 天`)
      if (typeof balance === 'number') parts.push(`余额 ${balance}`)
      if (todayResult === 'inactive') parts.push('签到活动当前没开放')
    } else {
      parts.push('今天还没有签到记录')
    }

    return {
      outcome,
      day,
      credit,
      streakDays: streak ?? null,
      totalCredits: balance,
      humanReadable: parts.join('，'),
    }
  }
}
