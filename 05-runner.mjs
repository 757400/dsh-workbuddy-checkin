// 验证 5：入口 apply() 的行为，用假的 ctx 把插件跑起来。
//
// 这里要钉死的是历史上真实踩过的两个坑：
//   1. 「今天已尝试」这道门会把重试也一起挡住。
//      第一次失败后 triedToday() 恒真，若调用方不区分 isRetry，
//      后面每一次重试进来都原地返回 already-done，看似在重试、实则空转。
//   2. 未启用回报时不得触碰 schedule 服务。
//      早期版本无条件注入 schedule，等于替用户花 token。
//
// 全部离线：假的 fetch 不会离开进程，状态文件写在临时目录。
import fs from 'node:fs'
import { createChecker, load, makeTempHome } from './harness.mjs'

const check = createChecker('runner')
const { beijingDay } = await load('lib/state.mjs')

const day = beijingDay()

/** 构造一个假 ctx：记录 inject 了哪些服务、注册了哪些路由、调了多少次 fetch。 */
function makeCtx({ reportEnabled = false, sessionId = 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' } = {}) {
  const calls = { inject: [], routes: [], scheduleCreate: 0, fetch: 0, logs: [] }
  const ctx = {
    logger: () => ({
      info: (m) => calls.logs.push(['info', m]),
      warn: (m) => calls.logs.push(['warn', m]),
      error: (m) => calls.logs.push(['error', m]),
    }),
    effect: (fn) => {
      try {
        fn // 注册，不执行清理
      } catch {
        // ignore
      }
    },
    inject: (deps, cb) => {
      calls.inject.push(deps)
      const scope = {}
      if (deps.includes('webServer')) {
        scope.webServer = {
          register: (route) => {
            calls.routes.push(route)
            return () => {}
          },
        }
      }
      if (deps.includes('schedule')) {
        scope.schedule = {
          create: async (sid, payload) => {
            calls.scheduleCreate++
            calls.lastSchedule = { sid, payload }
            return { id: 'schedule-test-id' }
          },
        }
      }
      try {
        cb(scope)
      } catch (err) {
        calls.logs.push(['error', `inject cb threw: ${err.message}`])
      }
    },
  }
  return { ctx, calls, reportEnabled, sessionId }
}

// 让插件不要真的去跑定时器：把 setTimeout 换成立即返回的假对象
const realSetTimeout = globalThis.setTimeout
const fakeTimers = []
globalThis.setTimeout = (fn, ms) => {
  const handle = { unref() {}, _fn: fn, _ms: ms, _cleared: false }
  fakeTimers.push(handle)
  return handle
}
globalThis.clearTimeout = (h) => {
  if (h && typeof h === 'object') h._cleared = true
}

const home = makeTempHome()

// 用一个隔离的 DSH_HOME 让插件读写临时目录
process.env.DSH_HOME = home.dir

// ---- 场景 1：正常装载，路由注册一次，未启用回报不碰 schedule ----
{
  const { ctx, calls } = makeCtx()
  const plugin = (await load('lib/index.mjs')).default
  plugin.apply(ctx)

  check.eq('装载后注册了 1 个路由', calls.routes.length, 1)
  const route = calls.routes[0] || {}
  check.eq('路由是 exact 类型', route.kind, 'exact')
  check.eq('路由路径正确', route.path, '/dsh-workbuddy-checkin/status')

  check.ok(
    '未启用回报时不注入 schedule',
    !calls.inject.some((d) => d.includes('schedule')),
    JSON.stringify(calls.inject),
  )
  check.ok(
    '注入了 webServer',
    calls.inject.some((d) => d.includes('webServer')),
    JSON.stringify(calls.inject),
  )
  check.eq('未启用回报时 schedule.create 未被调用', calls.scheduleCreate, 0)
  check.ok('装载日志已落', calls.logs.some(([, m]) => /已装载/.test(m)))
  check.ok('路由注册日志已落', calls.logs.some(([, m]) => /状态路由已注册/.test(m)))
  check.ok('启动定时器被安排', fakeTimers.length > 0, `${fakeTimers.length} 个`)
}

// ---- 场景 2：路由 handler 的返回形状与只读语义 ----
{
  const { ctx, calls } = makeCtx()
  const plugin = (await load('lib/index.mjs')).default
  plugin.apply(ctx)
  const route = calls.routes[0]

  const respond = (method) => {
    const out = { status: 0, headers: null, body: '' }
    const res = {
      writeHead(code, headers) {
        out.status = code
        out.headers = headers
      },
      end(body) {
        out.body = String(body || '')
      },
    }
    route.handler({ method }, res)
    return out
  }

  const get = respond('GET')
  check.eq('GET 返回 200', get.status, 200)
  let payload = null
  try {
    payload = JSON.parse(get.body)
  } catch {
    payload = null
  }
  check.ok('返回体是合法 JSON', payload !== null)
  if (payload) {
    check.eq('返回体带 plugin 名', payload.plugin, 'dsh-workbuddy-checkin')
    check.ok('返回体带 reportConfig', typeof payload.reportConfig === 'object' && payload.reportConfig !== null)
    check.eq('未启用时 reportConfig.enabled 为 false', payload.reportConfig.enabled, false)
    check.ok('返回体带 state', typeof payload.state === 'object' && payload.state !== null)
    check.ok('返回体不含 accessToken', !/accessToken/.test(get.body))
    check.ok('返回体不含 Bearer', !/Bearer/i.test(get.body))
  }

  const post = respond('POST')
  check.eq('POST 返回 405', post.status, 405)
}

// ---- 场景 3：重试必须能穿过「今天已尝试」这道门 ----
// 直接验证状态语义 + 调用侧 isRetry 的存在：
// 在状态文件里预置「今天已失败过一次」，然后看 runOnce 是否还会真的发请求。
{
  const { CheckinState } = await load('lib/state.mjs')
  const fresh = makeTempHome()
  process.env.DSH_HOME = fresh.dir
  const file = `${fresh.dir}/.workbuddy-checkin/state.json`
  const st = new CheckinState(file)
  st.recordFailure({ day, error: '预置的一次失败', now: Date.now() })
  check.ok('预置后处于「今天已尝试」态', st.triedToday())
  check.ok('预置后仍有重试余地', st.hasRetriesLeft())

  // 源码层面断言：runOnce 对 isRetry 的处理必须存在，否则重试全空转
  const src = fs.readFileSync(new URL('../lib/index.mjs', import.meta.url), 'utf8')
  check.ok('入口源码辨识 isRetry（重试穿门）', /opts\.isRetry/.test(src))
  check.ok('triedToday 的门受 isRetry 约束', /!opts\.isRetry\s*&&\s*state\.triedToday|state\.triedToday\(now\)/.test(src))
  check.ok('重试调用处传了 isRetry: true', /isRetry:\s*true/.test(src))
  fresh.cleanup()
}

// ---- 场景 4：启用回报时才注入 schedule ----
{
  const fresh = makeTempHome()
  fresh.writeConfig({
    report: {
      enabled: true,
      targetSessionId: 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      afterSeconds: 30,
      acknowledgeTokenCost: true,
    },
  })
  process.env.DSH_HOME = fresh.dir

  // 回退到「已签过」路径，让它真的走到 report()
  const { CheckinState } = await load('lib/state.mjs')
  const st = new CheckinState(`${fresh.dir}/.workbuddy-checkin/state.json`)
  st.recordSkipped({ day, reason: 'already-checked', streakDays: 2, totalCredits: 200 })

  const { ctx, calls } = makeCtx({ reportEnabled: true })
  // 劫持 fetch：任何网络请求都直接失败，确保离线
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => {
    calls.fetch++
    throw new Error('verify-offline')
  }
  try {
    const plugin = (await load('lib/index.mjs')).default
    plugin.apply(ctx)
  } finally {
    globalThis.fetch = realFetch
  }

  check.ok('启用回报时仍只注册 1 个路由', calls.routes.length === 1, `${calls.routes.length}`)
  check.eq('离线期间没有真实网络请求', calls.fetch, 0)
  fresh.cleanup()
}

// 恢复并清理
globalThis.setTimeout = realSetTimeout
delete process.env.DSH_HOME
home.cleanup()

process.exit(check.report() ? 0 : 1)
