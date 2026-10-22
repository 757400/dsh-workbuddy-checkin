// 结果回报：通过 DSH 官方 schedule 服务向指定会话投递一条「唤醒指令」，
// 让那个会话里的 agent 读取签到状态文件，再用自然语言把结果讲给用户听。
//
// 为什么不用 appendPluginRecord：
//   源码明文写着 "never enters the model-visible surface"，
//   plugin: 记录按设计不可见，用户和模型都看不到，没法用来通知。
//
// 为什么用 schedule：
//   schedule 投递走 agent.followup(message)，即 send(input, "next-turn", true) → wakeDriver，
//   会真的唤醒目标会话的 agent 跑一轮并产出回复。
//
// 关于那层 "[SCHEDULE REMINDER]" 框架：
//   它由 renderReminderFraming() 固定生成，改不掉。
//   但它只是「唤醒信息」，真正的回答由 agent 这一轮自己生成。
//   所以投递内容写成「给 agent 的指令」：读状态文件 → 只回一句话。
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

/** 回报标题：作为可读的呈现标签。 */
export const REPORT_TITLE = '积分领取结果回报'

/** 默认状态文件路径：与插件主模块的 DSH_HOME 推导方式保持一致。 */
export const DEFAULT_STATE_FILE = path.join(
  process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
  '.workbuddy-checkin',
  'state.json',
)

/** 同一会话同一结果只报一次，避免重启或重试造成刷屏。 */
const SEEN_KEY_PREFIX = 'workbuddy-checkin/reported/'

function seenKey(sessionId, day, status) {
  return `${SEEN_KEY_PREFIX}${day}/${status}/${sessionId}`
}

/**
 * 构造投递给 agent 的指令正文。
 *
 * 关键点：这段文字会出现在 reminder_prompt_json 字段里，agent 读到后应当
 * 立刻读状态文件，然后只输出一句自然的话——不要再复述这层框架。
 *
 * @param {object} params
 * @param {string} params.stateFile 状态文件绝对路径
 * @param {string} params.day 北京日期 YYYY-MM-DD
 * @param {string} params.status claimed | failed | already-checked | ...
 * @returns {string}
 */
export function buildAgentPrompt({ stateFile, day, status }) {
  const statusLine =
    status === 'claimed'
      ? '本轮结果是「领取成功」，说清今天领到多少积分、连续第几天。'
      : status === 'retrying'
        ? '本轮结果是「领取失败、正在自动重试」，说清这次没成功、大致原因，并告诉用户几分钟内会自动再试，不用他动手。'
        : status === 'failed'
          ? '本轮结果是「领取失败且重试已用尽」，说清没领成、大致原因，并明确提醒用户需要处理。'
          : '本轮没有新领取（今天此前已处理过），说清连续天数与余额即可。'

  return [
    '【系统自动任务：签到结果播报】',
    '这不是用户提问，是一次自动唤醒。你被唤醒的唯一目的，是把下面这件事用一句人话讲给用户。',
    '',
    '必须执行的动作（按顺序，不得跳过）：',
    `1. 调用读文件工具，读取 ${stateFile}`,
    '2. 从读到的 JSON 里取出 narration.humanReadable 字段的值',
    '3. 在你的回复里，把这个值原样讲出来',
    '',
    '硬性要求：',
    '- 你的回复正文里必须出现一句自然语言结论，不能只有工具调用、不能空回复。',
    '- 不要复述这条消息的格式、不要提"提醒""调度""系统唤醒"这类词、不要贴 JSON、不要提文件名。',
    '- 说一句话就够，口语化，像人在汇报。',
    `- 如果 narration.day 不是 ${day}，说明状态还没刷新，就按文件里实际写的内容说。`,
    '',
    statusLine,
  ].join('\n')
}

/**
 * 向指定会话投递一条结果回报。
 *
 * @param {object} params
 * @param {object} params.scheduleCtx 声明了 schedule 依赖的 ctx（来自 ctx.inject(['schedule'], cb)）
 * @param {string} params.sessionId 目标会话 ID
 * @param {string} params.message 要回报的正文
 * @param {number} params.afterSeconds 延迟秒数
 * @param {string} params.title schedule 标题
 * @returns {Promise<{ok:boolean, id?:string, reason?:string}>}
 */
export async function deliverReport({ scheduleCtx, sessionId, message, afterSeconds = 30, title = REPORT_TITLE }) {
  try {
    if (!scheduleCtx || !scheduleCtx.schedule || typeof scheduleCtx.schedule.create !== 'function') {
      return { ok: false, reason: 'schedule service unavailable' }
    }
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return { ok: false, reason: 'no target session id configured' }
    }

    // 这里不要自己去查 sessions 判断会话在不在。
    // DSH 的 ctx 是依赖注入代理：没在 inject() 里声明的服务，读一下就抛
    // `cannot get property "sessions" without inject`——上一版就栽在这里，
    // 投递还没发出去就先报了错。
    // 目标会话是否有效由 schedule 自己在投递时刻判定：create() 内部只拒绝子代理会话，
    // 真正解析会话发生在倒计时结束后的 ctx.sessionController.resolveAgent(task.sessionId)。
    const record = await scheduleCtx.schedule.create(
      sessionId,
      {
        title: typeof title === 'string' ? title.slice(0, 120) : REPORT_TITLE,
        prompt: String(message || '').trim() || '签到结果',
        after_seconds: Math.max(1, Math.trunc(afterSeconds)),
      },
      undefined,
    )

    return { ok: true, id: record && record.id ? String(record.id) : undefined }
  } catch (err) {
    return { ok: false, reason: String((err && err.message) || err) }
  }
}

/** 构造去重用的稳定键（不含敏感信息）。 */
export function dedupeFingerprint(day, status, sessionId) {
  return createHash('sha1').update(`${day}|${status}|${sessionId}`).digest('hex').slice(0, 16)
}
