// 插件入口：DSH 启动后自动签到 + 状态路由 + 结果回报。
//
// 安全边界（对应用户的指令）：
//  - 只注册一个 exact 路由，不抢占其他路径；
//  - 不注册客户端脚本注入、不改 DSH 配置、不碰 WorkBuddy 客户端；
//  - 所有失败都吞掉并落日志，绝不抛给宿主；
//  - 只读凭据文件，不刷新、不回写 token；
//  - 回报走 DSH 官方 schedule 服务，不往会话日志里注入事件。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { readDesktopCredential, tokenRemainingMs, CredentialError } from './credentials.mjs'
import { fetchStatus, claimDaily, UpstreamError } from './api.mjs'
import { CheckinState, beijingDay, MAX_FAILURES } from './state.mjs'
import { deliverReport, REPORT_TITLE, buildAgentPrompt } from './report.mjs'
import { resolveReportConfig } from './config.mjs'

const NAME = 'dsh-workbuddy-checkin'
const DISPLAY = 'WorkBuddy 自动签到'
const ROUTE_PATH = '/dsh-workbuddy-checkin/status'

/** 这些错误重试也不会变好，直接本轮收工。 */
const NON_RETRYABLE = new Set(['AUTH_FILE_UNREADABLE', 'AUTH_FILE_MALFORMED', 'AUTH_NO_TOKEN'])

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/**
 * 把绝对路径转成 POSIX 风格再交给 agent 读。
 *
 * 为什么要转：handle 里的 Windows 反斜杠在字符串模板里要写成 `\\\\`，
 * 一旦写漏一层就会变成无效转义，agent 拿到的是坏路径。
 * 统一用正斜杠后，两个平台的路径都能直接塞进模板。
 *
 * 注意：这里必须用 split/join，不能用正则字面量——
 * 在正则里写反斜杠本身又是另一层转义，正是上一版出错的根源。
 */
function toPosixPath(p) {
  return String(p || '').split(path.sep === '/' ? '/' : '\\').join('/')
}

function log(logger, level, message) {
  try {
    if (logger && typeof logger[level] === 'function') logger[level](message)
    else if (level === 'error' || level === 'warn') console.warn(`[${NAME}] ${message}`)
  } catch {
    // 日志失败也不能影响宿主
  }
}

/** 顺序执行一次签到判定。任何异常都在这里被吸收成 result 对象。 */
async function runOnce(ctx, state, opts = {}) {
  const now = Date.now()
  const day = beijingDay(now)
  const logger = opts.logger
  const timeoutMs = opts.timeoutMs || 20000

  // 1) 「当天第一次启动才领」：今天已经动过手就什么都不做。
  //    这与「已成功」是两回事——失败重试用尽也算动过手，重启不再重领。
  //
  //    但重试必须能穿过这道门，否则重试永远跑不起来：
  //    第一次失败已经把 lastAttemptDay 写成今天，triedToday() 从此恒为真，
  //    后面每一次重试进来都会在这里被 return already-done。
  //    所以用 opts.isRetry 区分「重启后的首次尝试」和「本次进程内的重试」：
  //    重试时保留当天只领一次的语义（账号侧今天已经签过就会被服务端拒绝），
  //    但允许真的发出请求。
  if (!opts.force && !opts.isRetry && state.triedToday(now)) {
    const why = state.data.lastSuccessDay === day ? '今天已成功领取' : '今天已尝试过（不再重复领取）'
    return { status: 'already-done', day, detail: why }
  }
  // 今天已经签成功，直接收工（重试也救不了，账号侧已签）
  if (state.data.lastSuccessDay === day) {
    return { status: 'already-done', day, detail: '今天已签到过，跳过' }
  }
  if (state.data.failureCount > MAX_FAILURES) {
    return { status: 'gave-up', day, detail: `今天已失败 ${state.data.failureCount} 次，停止重试` }
  }

  // 2) 读凭据
  let cred
  try {
    cred = readDesktopCredential(opts.authFile)
  } catch (err) {
    if (err instanceof CredentialError) {
      state.recordFailure({ day, error: err.message, now })
      log(logger, 'warn', `凭据不可用：${err.message}`)
      return { status: 'no-credential', day, detail: err.message, retryable: !NON_RETRYABLE.has(err.code) }
    }
    throw err
  }

  const remaining = tokenRemainingMs(cred, now)
  if (remaining !== null && remaining <= 0) {
    const msg = 'WorkBuddy accessToken 已过期，需要先在客户端重新登录'
    state.recordFailure({ day, error: msg, now })
    log(logger, 'warn', msg)
    return { status: 'token-expired', day, detail: msg, retryable: false }
  }

  // 3) 查状态：已签就跳过，避免无谓的领取请求
  try {
    const status = await fetchStatus(cred, timeoutMs)
    if (!status.active) {
      const msg = '签到活动当前未开放'
      state.recordSkipped({ day, reason: 'inactive', streakDays: status.streakDays, totalCredits: status.totalCredits })
      log(logger, 'info', msg)
      return { status: 'inactive', day, detail: msg }
    }
    if (status.todayCheckedIn) {
      state.recordSkipped({ day, reason: 'already-checked', streakDays: status.streakDays, totalCredits: status.totalCredits })
      log(logger, 'info', `今天已签到（连续 ${status.streakDays ?? '?'} 天，余额 ${status.totalCredits ?? '?'}）`)
      return { status: 'already-checked', day, streakDays: status.streakDays, totalCredits: status.totalCredits }
    }

    // 4) 领取
    const claim = await claimDaily(cred, timeoutMs)
    const after = await fetchStatus(cred, timeoutMs).catch(() => null)

    if (claim.alreadyClaimed) {
      state.recordSkipped({ day, reason: 'already-checked', streakDays: claim.streakDays, totalCredits: after?.totalCredits })
      return { status: 'already-checked', day, streakDays: claim.streakDays }
    }
    if (after && after.todayCheckedIn !== true) {
      throw new UpstreamError('NOT_CONFIRMED', '领取接口返回成功，但复核仍显示未签到')
    }

    const streak = claim.streakDays ?? after?.streakDays ?? null
    state.recordSuccess({ day, credit: claim.credit, streakDays: streak, totalCredits: after?.totalCredits ?? null })
    log(logger, 'info', `签到成功：+${claim.credit ?? '?'} 积分，连续 ${streak ?? '?'} 天，余额 ${after?.totalCredits ?? '?'}`)
    return {
      status: 'claimed',
      day,
      credit: claim.credit,
      streakDays: streak,
      totalCredits: after?.totalCredits ?? null,
      message: `今日积分已领取完毕，请查收喵！（+${claim.credit ?? '?'}，连续 ${streak ?? '?'} 天，余额 ${after?.totalCredits ?? '?'}）`,
    }
  } catch (err) {
    const code = err instanceof UpstreamError ? err.code : 'UNKNOWN'
    const msg = err && err.message ? err.message : String(err)
    state.recordFailure({ day, error: `${code}: ${msg}`, now })
    log(logger, 'warn', `签到失败（${code}）：${msg}`)
    return { status: 'failed', day, code, detail: msg, retryable: true, message: `积分领取失败了喵，请重试领取或修复（${code}：${msg}）` }
  }
}

export default {
  name: NAME,

  apply(ctx) {
    const home = dshHome()
    const stateFile = path.join(home, '.workbuddy-checkin', 'state.json')
    const state = new CheckinState(stateFile)

    // 回报配置：默认关闭，必须由用户显式启用并自选目标会话。
    // 这个子功能会往会话里投递消息并唤醒 agent（消耗用户自己的额度），
    // 所以不能默认开，也不能有内置的会话 ID。
    const reportCfg = resolveReportConfig({ home })
    const REPORT_SESSION_ID = reportCfg.targetSessionId
    const REPORT_DELAY_SECONDS = reportCfg.afterSeconds

    let logger = null
    try {
      logger = ctx.logger && typeof ctx.logger === 'function' ? ctx.logger(NAME) : null
    } catch {
      logger = null
    }

    const runtime = {
      lastRunAt: null,
      lastResult: null,
      startedAt: new Date().toISOString(),
      timer: null,
      reportedKeys: new Set(), // 本次进程内已回报过的「日期/结果」，避免重复投递
      lastReport: null, // 最近一次「投递到会话」的结果，写进状态文件后可查
    }

    /**
     * 记录投递结果并落盘。
     *
     * 为什么要落盘：投递走的是 ctx.inject(['schedule'], cb)，成功与否只体现为
     * 一个 Promise 的返回值，日志在宿主控制台里翻起来很费劲。写进状态文件后，
     * 打开 /dsh-workbuddy-checkin/status 就能看到「到底发没发出去、为什么没发出去」。
     */
    const noteReport = (info) => {
      runtime.lastReport = { at: new Date().toISOString(), ...info }
      try {
        state.data.lastReport = runtime.lastReport
        state.save()
      } catch {
        // 落盘失败不影响投递本身
      }
    }

    // 回报投递器：拿到 schedule 服务后向目标会话投递一条「唤醒指令」。
    // 投递的不是最终文案，而是让那个会话的 agent 去读状态文件、再用自然语言讲给用户。
    //
    // 未启用回报时这一整条路径都不走：不写 narration、不碰 schedule、不投递。
    // 签到本身照常进行，结果仍然写在状态文件里，随时可以通过状态路由查看。
    const report = async (result, reason) => {
      if (!result || !result.status) return
      if (!reportCfg.enabled) {
        log(logger, 'info', `跳过结果回报（未启用：${reportCfg.reason}）`)
        return
      }
      if (!REPORT_SESSION_ID) return
      const key = `${result.day}/${result.status}`
      if (runtime.reportedKeys.has(key)) {
        log(logger, 'info', `跳过重复回报（${key} 已投递过）`)
        return
      }
      // 先把「人话摘要」写进状态文件，agent 唤醒后照着念就行，不必自己推理字段
      try {
        state.data.narration = state.narration(result.day)
        state.save()
      } catch (err) {
        log(logger, 'warn', `写人话摘要失败（不影响投递）：${String((err && err.message) || err)}`)
      }

      const prompt = buildAgentPrompt({
        stateFile: toPosixPath(stateFile),
        day: result.day,
        status: result.status,
      })
      try {
        ctx.inject(['schedule'], (scope) => {
          deliverReport({
            scheduleCtx: scope,
            sessionId: REPORT_SESSION_ID,
            message: prompt,
            afterSeconds: REPORT_DELAY_SECONDS,
            title: REPORT_TITLE,
          })
            .then((r) => {
              noteReport({
                source: 'checkin',
                ok: r.ok,
                id: r.id || null,
                reason: r.reason || null,
                sessionId: REPORT_SESSION_ID,
                day: result.day,
                status: result.status,
              })
              if (r.ok) {
                runtime.reportedKeys.add(key)
                log(logger, 'info', `已投递回报（${reason}，${REPORT_DELAY_SECONDS} 秒后唤醒 ${REPORT_SESSION_ID}）`)
              } else {
                log(logger, 'warn', `回报投递失败：${r.reason}`)
              }
            })
            .catch((err) => {
              noteReport({
                source: 'checkin',
                ok: false,
                id: null,
                reason: String((err && err.message) || err),
                sessionId: REPORT_SESSION_ID,
                day: result.day,
                status: result.status,
              })
              log(logger, 'warn', `回报投递异常：${String((err && err.message) || err)}`)
            })
        })
      } catch (err) {
        noteReport({
          source: 'checkin',
          ok: false,
          id: null,
          reason: `无法请求 schedule 服务：${String((err && err.message) || err)}`,
          sessionId: REPORT_SESSION_ID,
          day: result.day,
          status: result.status,
        })
        log(logger, 'warn', `无法请求 schedule 服务：${String((err && err.message) || err)}`)
      }
    }

    // 实验开关：宿主启动时若读到该文件，投递一条「唤醒指令」并立刻删掉它。
    //
    // 这个通道只在「回报已启用」时才工作：它是验证回报链路的工具，
    // 不是绕过配置的后门。没启用回报时即使有人写了开关文件也不会投递。
    // 正式使用时不会有人创建这个文件。
    const experimentFlag = path.join(home, '.workbuddy-checkin', 'experiment-flag.json')
    const runExperiment = () => {
      if (!reportCfg.enabled) return
      let flag = null
      try {
        flag = JSON.parse(fs.readFileSync(experimentFlag, 'utf8'))
      } catch {
        return
      }
      // 默认视为启用：只有显式写 enabled:false 才跳过。
      // （上一版要求 enabled === true，手写开关少了这个字段就静默退出，白重启一次）
      if (!flag || flag.enabled === false) return
      try {
        fs.unlinkSync(experimentFlag) // 先删，保证只跑一次
      } catch {}

      const status = typeof flag.simulateStatus === 'string' ? flag.simulateStatus : 'claimed'
      const day = flag.simulateDay || beijingDay()
      // 会话 ID 三种写法都认，避免"代码读 A、文件写 B"的静默错位。
      // 不再回退到某个内置会话 ID——只能来自开关、配置或环境变量。
      const targetSession = flag.targetSessionId || flag.sessionId || REPORT_SESSION_ID
      if (!targetSession) {
        log(logger, 'warn', '[实验] 没有可用的目标会话，跳过')
        return
      }
      const prompt = buildAgentPrompt({
        stateFile: toPosixPath(stateFile),
        day,
        status,
      })

      log(logger, 'info', `[实验] 开始投递唤醒指令到 ${targetSession}，${flag.afterSeconds || 30} 秒后生效`)
      try {
        ctx.inject(['schedule'], (scope) => {
          deliverReport({
            scheduleCtx: scope,
            sessionId: targetSession,
            message: prompt,
            afterSeconds: flag.afterSeconds || 30,
            title: '积分领取结果回报',
          })
            .then((r) => {
              noteReport({
                source: 'experiment',
                ok: r.ok,
                id: r.id || null,
                reason: r.reason || null,
                sessionId: targetSession,
              })
              if (r.ok) log(logger, 'info', `[实验] 投递成功，schedule id = ${r.id}`)
              else log(logger, 'warn', `[实验] 投递失败：${r.reason}`)
            })
            .catch((err) => {
              noteReport({
                source: 'experiment',
                ok: false,
                id: null,
                reason: String((err && err.message) || err),
                sessionId: targetSession,
              })
              log(logger, 'warn', `[实验] 投递异常：${String((err && err.message) || err)}`)
            })
        })
      } catch (err) {
        noteReport({
          source: 'experiment',
          ok: false,
          id: null,
          reason: `无法请求 schedule 服务：${String((err && err.message) || err)}`,
          sessionId: targetSession,
        })
        log(logger, 'warn', `[实验] 无法请求 schedule 服务：${String((err && err.message) || err)}`)
      }
    }

    const run = async (reason, opts = {}) => {
      runtime.lastRunAt = new Date().toISOString()
      try {
        state.rollover() // 跨天先把昨天残留的失败计数清掉，否则第二天一上来就判定"用尽"
        const result = await runOnce(ctx, state, { logger, force: opts.force, isRetry: opts.isRetry })
        runtime.lastResult = result
        // 只有真正领到、或彻底失败（重试用尽）才回报；「今天已领过」不打扰
        if (result.status === 'claimed') void report(result, reason)
        if (result.status === 'failed') {
          if (!state.hasRetriesLeft()) {
            // 重试用尽：终局，必须报
            void report(result, reason)
          } else if ((state.data.failureCount || 0) === 1) {
            // 首次失败：立刻报一条「正在重试」。
            // 理由：重试窗口再短也是 9 分钟，用户未必一直开着 DSH；
            // 先把这个信号送出去，总比等他恰好开到最后一次却什么都没看到强。
            void report({ ...result, status: 'retrying' }, reason)
          }
        }
        return result
      } catch (err) {
        // 兜底：runOnce 理论上不会抛，真抛了也只记录
        runtime.lastResult = { status: 'error', detail: String((err && err.message) || err) }
        log(logger, 'error', `未预期异常：${runtime.lastResult.detail}`)
        return runtime.lastResult
      }
    }

    // ① 启动后延迟 20 秒跑第一次：避开宿主启动高峰
    const kickoff = setTimeout(() => {
      // 实验开关优先：它一旦存在就投递一条唤醒指令，验证 agent 会不会替我们把结果讲出来
      try {
        runExperiment()
      } catch (err) {
        log(logger, 'warn', `[实验] 启动失败：${String((err && err.message) || err)}`)
      }
      void run('startup').finally(scheduleNext)
    }, 20_000)
    if (typeof kickoff.unref === 'function') kickoff.unref()

    // ② 失败时按退避重排；成功后今天不再跑
    function scheduleNext() {
      try {
        if (runtime.timer) return
        // 只有「今天还没签成」且「还有重试次数」才排下一轮。
        // 不能直接问 shouldAttempt()：刚记完失败时 nextAttemptAt 在未来，它必然返回 false。
        if (state.data.lastSuccessDay === beijingDay()) return
        if (!state.hasRetriesLeft()) return
        const now = Date.now()
        // 下限只防「到点时间已过或异常」导致 0/负数延迟把定时器打成死循环，
        // 所以取 5 秒而不是 60 秒——否则 1 分钟档会被无谓地拉长。
        const delay = Math.max(5_000, state.dueAt() - now)
        runtime.timer = setTimeout(() => {
          runtime.timer = null
          // isRetry 让重试穿过「今天已尝试过」这道门，否则它每次都空转返回
          void run('retry', { isRetry: true }).finally(scheduleNext)
        }, delay)
        if (typeof runtime.timer.unref === 'function') runtime.timer.unref()
        log(logger, 'info', `下一轮重试：${Math.round(delay / 60_000)} 分钟后`)
      } catch {
        // 调度失败不影响宿主
      }
    }

    // ③ 只读状态路由
    // 必须放在 inject 回调里：未声明依赖就摸 ctx.webServer 会被 Cordis 拦下
    // （报 "cannot get property webServer without inject"）。
    // 路由不是签到主流程的必需品，所以 await 不到服务就只记一条日志，不影响签到。
    const disposers = []
    try {
      ctx.inject(['webServer'], (scope) => {
        try {
          disposers.push(
            scope.webServer.register({
              kind: 'exact',
              path: ROUTE_PATH,
              handler: (req, res) => {
                try {
                  if (String(req.method || 'GET').toUpperCase() !== 'GET') {
                    res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' })
                    res.end(JSON.stringify({ error: 'method not allowed' }))
                    return
                  }
                  const body = JSON.stringify(
                    {
                      plugin: NAME,
                      display: DISPLAY,
                      startedAt: runtime.startedAt,
                      lastRunAt: runtime.lastRunAt,
                      lastResult: runtime.lastResult,
                      lastReport: runtime.lastReport || (state.data && state.data.lastReport) || null,
                      // 回报子功能的配置与生效状态。用户查这里就能知道
                      // 「为什么没收到播报」——是没启用、没配会话，还是投递失败。
                      reportConfig: {
                        enabled: reportCfg.enabled,
                        reason: reportCfg.reason || null,
                        source: reportCfg.source,
                        targetSessionId: reportCfg.enabled ? reportCfg.targetSessionId : null,
                        afterSeconds: reportCfg.afterSeconds,
                        acknowledgeTokenCost: reportCfg.ackTokenCost,
                      },
                      state: state.summary(),
                    },
                    null,
                    2,
                  )
                  res.writeHead(200, {
                    'Content-Type': 'application/json; charset=utf-8',
                    'Cache-Control': 'no-store',
                    'Content-Length': String(Buffer.byteLength(body)),
                  })
                  res.end(body)
                } catch (err) {
                  try {
                    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
                    res.end(JSON.stringify({ error: String((err && err.message) || err) }))
                  } catch {
                    // 连接可能已断开
                  }
                }
              },
            }),
          )
          log(logger, 'info', `状态路由已注册：GET ${ROUTE_PATH}`)
        } catch (err) {
          log(logger, 'warn', `状态路由注册失败（不影响签到本身）：${String((err && err.message) || err)}`)
        }
      })
    } catch (err) {
      log(logger, 'warn', `无法请求 webServer 服务（不影响签到本身）：${String((err && err.message) || err)}`)
    }

    // ④ 卸载：清掉定时器与路由
    ctx.effect(() => () => {
      try {
        clearTimeout(kickoff)
        if (runtime.timer) clearTimeout(runtime.timer)
        runtime.timer = null
        for (const d of disposers) {
          try {
            d()
          } catch {
            // 忽略
          }
        }
      } catch {
        // 忽略
      }
    })

    log(logger, 'info', `已装载：启动 20 秒后自动签到，状态写 ${stateFile}`)
  },
}
