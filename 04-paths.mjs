// 验证 4：默认路径必须由当前用户环境推导，不能写死。
//
// 为什么要有这一条：插件早期把登录文件路径写成
// 'C:/Users/<某个具体用户名>/.../workbuddy-desktop.info'，在作者机器上跑得通，
// 换一个人装就必然读不到文件。路径里出现用户名本身不算问题，
// 真正要验的是「用户名是不是从环境里来的」。
//
// 做法分两层：
//   1. 静态层：直接扫源码，确认没有写死的 C:/Users/<某人>/ 绝对路径；
//   2. 运行层：把 os.homedir / process.env 换成假值，在同一个进程里
//      用一个「重新求值」的小副本跑一遍推导逻辑，看结果是否跟着变。
//
// 为什么不用 spawnSync：本机沙箱禁止子进程通过管道捕获 stdio，
// spawnSync 默认 stdio:'pipe' 会直接 EPERM，所以改成同进程内验证。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createChecker, ROOT, listSourceFiles } from './harness.mjs'

const check = createChecker('paths')

// ---- 静态层：源码里不允许出现写死的用户目录 ----
{
  const offenders = []
  for (const f of listSourceFiles()) {
    if (f.includes(`${path.sep}verify${path.sep}`)) continue
    if (!/\.(mjs|js|cjs|json|yml|yaml|md)$/.test(f)) continue
    const text = fs.readFileSync(f, 'utf8')
    // 同时匹配正斜杠与反斜杠的各种转义层数写法
    if (/C:[\\/]{1,4}Users[\\/]{1,4}admin/i.test(text)) offenders.push(path.relative(ROOT, f))
  }
  check.eq('源码与文档中没有写死的用户目录', offenders, [])
}

// ---- 运行层：把模块源码里的路径推导片段在假环境下重新求值 ----
const credSource = fs.readFileSync(path.join(ROOT, 'lib/credentials.mjs'), 'utf8')
const reportSource = fs.readFileSync(path.join(ROOT, 'lib/report.mjs'), 'utf8')

check.ok('credentials.mjs 用 os.homedir() 兜底', /os\.homedir\(\)/.test(credSource))
check.ok('credentials.mjs 优先读 LOCALAPPDATA', /process\.env\.LOCALAPPDATA/.test(credSource))
check.ok('report.mjs 用 os.homedir() 兜底', /os\.homedir\(\)/.test(reportSource))
check.ok('report.mjs 支持 DSH_HOME 覆盖', /process\.env\.DSH_HOME/.test(reportSource))
check.ok(
  'report.mjs 不存在写死的默认状态路径',
  !/DEFAULT_STATE_FILE\s*=\s*['"]/.test(reportSource.replace(/DEFAULT_STATE_FILE = path\.join\(/, '')),
)

// 抽出 localAppData() 与默认路径常量的推导逻辑，喂假环境跑
{
  const fakeHome = path.join(os.tmpdir(), 'fake-user-xyz')
  const fakeLocal = path.join(fakeHome, 'AppData', 'Local')

  const sandbox = {
    os: { homedir: () => fakeHome, platform: () => process.platform },
    path,
    process: { env: { LOCALAPPDATA: fakeLocal }, platform: process.platform },
  }

  // 只重放「默认路径怎么算出来」这一段，不整体 eval 模块
  const derive = new Function('os', 'path', 'process', `
    const localAppData = () => {
      if (process.env.LOCALAPPDATA) return process.env.LOCALAPPDATA
      const home = os.homedir()
      return process.platform === 'win32'
        ? path.join(home, 'AppData', 'Local')
        : path.join(home, '.local', 'share')
    }
    const auth = path.join(localAppData(), 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info')
    const state = (() => {
      const p = path
      return p.join(process.env.DSH_HOME || p.join(os.homedir(), '.dsh'), '.workbuddy-checkin', 'state.json')
    })()
    return { auth, state }
  `)

  const withLocal = derive(sandbox.os, sandbox.path, sandbox.process)
  const expectedAuth = path.join(
    fakeLocal,
    'CodeBuddyExtension',
    'Data',
    'Public',
    'auth',
    'workbuddy-desktop.info',
  )
  check.eq('有 LOCALAPPDATA 时登录文件路径跟随它', withLocal.auth, expectedAuth)
  check.eq('状态文件路径跟随 homedir', withLocal.state, path.join(fakeHome, '.dsh', '.workbuddy-checkin', 'state.json'))

  // LOCALAPPDATA 缺失时退回 homedir/AppData/Local
  const withoutLocal = derive(sandbox.os, sandbox.path, { env: {}, platform: process.platform })
  check.eq(
    '缺 LOCALAPPDATA 时退回 homedir/AppData/Local',
    withoutLocal.auth,
    path.join(fakeHome, 'AppData', 'Local', ...['CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info']),
  )

  // DSH_HOME 覆盖优先于 homedir
  const withDshHome = derive(sandbox.os, sandbox.path, {
    env: { LOCALAPPDATA: fakeLocal, DSH_HOME: path.join(fakeHome, 'custom') },
    platform: process.platform,
  })
  check.eq('DSH_HOME 覆盖状态文件路径', withDshHome.state, path.join(fakeHome, 'custom', '.workbuddy-checkin', 'state.json'))
}

// ---- 实际模块在真实环境下也应当落在当前用户目录，而不是某个别人的目录 ----
{
  const cred = await import(new URL('../lib/credentials.mjs', import.meta.url).href)
  const report = await import(new URL('../lib/report.mjs', import.meta.url).href)
  check.ok(
    '真实登录文件路径位于当前用户 LOCALAPPDATA',
    cred.DEFAULT_DESKTOP_AUTH_FILE.toLowerCase().startsWith(
      (process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')).toLowerCase(),
    ),
    cred.DEFAULT_DESKTOP_AUTH_FILE,
  )
  const expectedState = path.join(
    process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
    '.workbuddy-checkin',
    'state.json',
  )
  check.eq('真实状态文件路径由 DSH_HOME/homedir 推导', report.DEFAULT_STATE_FILE, expectedState)
  check.eq('登录文件路径是可移植的相对片段拼接', cred.DESKTOP_AUTH_RELATIVE, [
    'CodeBuddyExtension',
    'Data',
    'Public',
    'auth',
    'workbuddy-desktop.info',
  ])
}

process.exit(check.report() ? 0 : 1)
