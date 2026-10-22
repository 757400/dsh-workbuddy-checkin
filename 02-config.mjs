// 验证 2：回报配置解析。
// 覆盖默认关闭、显式关闭、缺会话、环境变量覆盖、延迟钳制、坏文件等分支。
// 全部在临时目录里跑，不碰真实 config.json。
import { createChecker, load, makeTempHome } from './harness.mjs'

const check = createChecker('config')
const { resolveReportConfig } = await load('lib/config.mjs')

const home = makeTempHome()

// 1) 没有配置文件 → 未启用
{
  const r = resolveReportConfig({ home: home.dir, env: {} })
  check.ok('无配置 → 未启用', r.enabled === false, r.reason)
  check.ok('无配置 → reason 说明到位', /不存在|未启用|默认关闭/.test(r.reason), r.reason)
  check.eq('无配置 → 无目标会话', r.targetSessionId, '')
}

// 2) 文件里 enabled:true 但没给会话 → 拒绝启用
{
  home.writeConfig({ report: { enabled: true } })
  const r = resolveReportConfig({ home: home.dir, env: {} })
  check.ok('缺 targetSessionId → 拒绝启用', r.enabled === false, r.reason)
  check.ok('缺会话的 reason 指向 targetSessionId', /targetSessionId/.test(r.reason), r.reason)
}

// 3) 完整配置 → 启用
{
  home.writeConfig({
    report: {
      enabled: true,
      targetSessionId: 'session-11111111-2222-3333-4444-555555555555',
      afterSeconds: 45,
      acknowledgeTokenCost: true,
    },
  })
  const r = resolveReportConfig({ home: home.dir, env: {} })
  check.ok('完整配置 → 启用', r.enabled === true, r.reason)
  check.eq('目标会话读到', r.targetSessionId, 'session-11111111-2222-3333-4444-555555555555')
  check.eq('延迟读到', r.afterSeconds, 45)
  check.eq('来源标记为 file', r.source, 'file')
  check.eq('额度确认读到', r.ackTokenCost, true)
}

// 4) 文件开着，环境变量显式关 → 关（防误留）
{
  const r = resolveReportConfig({ home: home.dir, env: { DSH_WBCHECKIN_REPORT: '0' } })
  check.ok('环境变量显式关 → 覆盖文件', r.enabled === false, r.reason)
}

// 5) 只有环境变量，没有配置文件
{
  const empty = makeTempHome()
  const r = resolveReportConfig({
    home: empty.dir,
    env: {
      DSH_WBCHECKIN_REPORT: '1',
      DSH_WBCHECKIN_REPORT_SESSION: 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      DSH_WBCHECKIN_REPORT_DELAY: '90',
    },
  })
  check.ok('环境变量可独立启用', r.enabled === true, r.reason)
  check.eq('环境变量会话生效', r.targetSessionId, 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
  check.eq('环境变量延迟生效', r.afterSeconds, 90)
  check.eq('来源标记为 env', r.source, 'env')
  empty.cleanup()
}

// 6) 延迟钳制：下限 5、上限 600
{
  for (const [input, expected] of [
    ['1', 5],
    ['9999', 600],
    ['30.9', 30],
  ]) {
    const r = resolveReportConfig({
      home: home.dir,
      env: {
        DSH_WBCHECKIN_REPORT: '1',
        DSH_WBCHECKIN_REPORT_SESSION: 'session-x',
        DSH_WBCHECKIN_REPORT_DELAY: input,
      },
    })
    check.eq(`延迟 ${input} → 钳制为 ${expected}`, r.afterSeconds, expected)
  }
}

// 7) 坏 JSON → 当作未启用，不崩
{
  const bad = makeTempHome()
  home.writeConfig({ report: {} })
  const fs = await import('node:fs')
  const path = await import('node:path')
  const file = path.join(bad.dir, '.workbuddy-checkin', 'config.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '{ this is not json', 'utf8')
  let threw = false
  let r = null
  try {
    r = resolveReportConfig({ home: bad.dir, env: {} })
  } catch {
    threw = true
  }
  check.ok('坏 JSON 不抛异常', !threw)
  check.ok('坏 JSON → 未启用', r && r.enabled === false, r && r.reason)
  bad.cleanup()
}

// 8) report 段不是对象 → 不崩
{
  const weird = makeTempHome()
  weird.writeConfig({ report: 'enabled' })
  let threw = false
  let r = null
  try {
    r = resolveReportConfig({ home: weird.dir, env: {} })
  } catch {
    threw = true
  }
  check.ok('report 非对象不抛异常', !threw)
  check.ok('report 非对象 → 未启用', r && r.enabled === false, r && r.reason)
  weird.cleanup()
}

// 9) 无内置会话 ID 的强断言：所有未配置路径都不该凭空冒出会话
{
  const empty = makeTempHome()
  const r = resolveReportConfig({ home: empty.dir, env: {} })
  check.eq('没有配置文件时目标会话必须为空', r.targetSessionId, '')
  empty.cleanup()
}

home.cleanup()
process.exit(check.report() ? 0 : 1)
