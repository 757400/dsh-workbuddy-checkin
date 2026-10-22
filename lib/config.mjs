// 配置：决定「结果回报」这一子功能是否启用、投递到哪个会话。
//
// 设计原则（针对上架场景）：
//   1. 默认关闭。装完不做任何事，不往任何会话投递，不消耗用户 token。
//   2. 启用必须由用户显式打开，且必须自己指定目标会话。
//   3. 不存在任何内置的会话 ID 默认值——硬编码别人的会话 ID 是越权。
//   4. 读不到配置、配置写错，一律当作「未启用」，绝不猜测着投递。
//
// 配置来源（优先级从高到低）：
//   环境变量
//     DSH_WBCHECKIN_REPORT=1                 启用回报
//     DSH_WBCHECKIN_REPORT_SESSION=<会话 ID>  目标会话（启用时必填）
//     DSH_WBCHECKIN_REPORT_DELAY=<秒>         延迟秒数，默认 30
//   配置文件  $DSH_HOME/.workbuddy-checkin/config.json
//     {
//       "report": {
//         "enabled": true,
//         "targetSessionId": "session-xxxx",
//         "afterSeconds": 30,
//         "acknowledgeTokenCost": true   // 已知悉会消耗自己额度
//       }
//     }
import fs from 'node:fs'
import path from 'node:path'

/** 回报延迟的合法范围（秒）。太小会和启动高峰撞车，太大用户等不到。 */
const MIN_DELAY = 5
const MAX_DELAY = 600

/**
 * 解析回报配置。任何异常都退化为「未启用」。
 *
 * @param {object} opts
 * @param {string} opts.home DSH_HOME
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @returns {{
 *   enabled: boolean,
 *   targetSessionId: string,
 *   afterSeconds: number,
 *   reason: string,
 *   source: string,
 *   ackTokenCost: boolean
 * }}
 */
export function resolveReportConfig({ home, env = process.env } = {}) {
  const disabled = (reason, extra = {}) => ({
    enabled: false,
    targetSessionId: '',
    afterSeconds: 30,
    reason,
    source: 'default',
    ackTokenCost: false,
    ...extra,
  })

  // ---- 先读配置文件，作为基底 ----
  let fileCfg = null
  let fileReason = ''
  try {
    const cfgFile = path.join(home, '.workbuddy-checkin', 'config.json')
    if (fs.existsSync(cfgFile)) {
      const raw = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
      fileCfg = raw && typeof raw === 'object' && raw.report && typeof raw.report === 'object' ? raw.report : null
      if (!fileCfg) fileReason = 'config.json 里没有 report 段'
    } else {
      fileReason = 'config.json 不存在'
    }
  } catch (err) {
    fileReason = `config.json 读取失败：${String((err && err.message) || err)}`
    fileCfg = null
  }

  // ---- 环境变量覆盖文件 ----
  const envEnabledRaw = env.DSH_WBCHECKIN_REPORT
  const envSession = (env.DSH_WBCHECKIN_REPORT_SESSION || '').trim()
  const envDelay = env.DSH_WBCHECKIN_REPORT_DELAY

  const fromEnv = envEnabledRaw !== undefined && envEnabledRaw !== ''
  const fileEnabled = !!(fileCfg && fileCfg.enabled === true)

  // 只要有一边显式说关，就关（防止文件里开着、环境变量误留一个 0 还在投递）
  const explicitOff = (fromEnv && !isTruthy(envEnabledRaw)) || (fileCfg && fileCfg.enabled === false)
  if (explicitOff) return disabled('显式配置为关闭')

  if (!fromEnv && !fileEnabled) {
    return disabled(fileReason || '未启用回报（默认关闭）')
  }

  // ---- 目标会话：没有就拒绝启用 ----
  const targetSessionId = envSession || (fileCfg && typeof fileCfg.targetSessionId === 'string' ? fileCfg.targetSessionId.trim() : '')
  if (!targetSessionId) {
    return disabled('已启用回报但没有配置目标会话（targetSessionId）')
  }

  // ---- 延迟秒数 ----
  let afterSeconds = 30
  const rawDelay = envDelay !== undefined && envDelay !== '' ? envDelay : fileCfg ? fileCfg.afterSeconds : undefined
  if (rawDelay !== undefined && rawDelay !== null) {
    const n = Number(rawDelay)
    if (Number.isFinite(n)) afterSeconds = clamp(Math.trunc(n), MIN_DELAY, MAX_DELAY)
  }

  // ---- 额度确认：这份提示会消耗用户自己的 token，要求显式知悉 ----
  const ackTokenCost = !!(fileCfg && fileCfg.acknowledgeTokenCost === true)

  return {
    enabled: true,
    targetSessionId,
    afterSeconds,
    reason: '',
    source: fromEnv ? 'env' : 'file',
    ackTokenCost,
  }
}

function isTruthy(v) {
  const s = String(v).trim().toLowerCase()
  return s === '1' || s === 'true' || s === 'yes' || s === 'on'
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n))
}
