// 验证 1：模块能加载、导出的形状对、重试节奏与文档一致。
// 纯内存操作，不联网、不落盘。
import { createChecker, load } from './harness.mjs'

const check = createChecker('modules')
const mods = {}
const files = [
  'lib/index.mjs',
  'lib/api.mjs',
  'lib/config.mjs',
  'lib/credentials.mjs',
  'lib/report.mjs',
  'lib/state.mjs',
]

for (const f of files) {
  check(`${f} 可加载`, async () => (mods[f] = true))
}

const results = await Promise.all(
  files.map(async (f) => {
    try {
      const m = await load(f)
      return { f, m, ok: true }
    } catch (err) {
      return { f, err, ok: false }
    }
  }),
)

for (const r of results) {
  check.ok(`${r.f} 加载成功`, r.ok, r.ok ? '' : String(r.err && r.err.message))
}
const byFile = Object.fromEntries(results.filter((r) => r.ok).map((r) => [r.f, r.m]))

if (Object.keys(byFile).length === files.length) {
  const idx = byFile['lib/index.mjs'].default
  check.eq('入口默认导出 name', idx.name, 'dsh-workbuddy-checkin')
  check.ok('入口默认导出含 apply(ctx)', typeof idx.apply === 'function')

  const state = byFile['lib/state.mjs']
  check.eq(
    'RETRY_STEPS_MS 与 README 一致（0/1/1/2/2/3 分钟）',
    state.RETRY_STEPS_MS,
    [0, 60_000, 60_000, 2 * 60_000, 2 * 60_000, 3 * 60_000],
  )
  check.eq('MAX_FAILURES = 步数 - 1', state.MAX_FAILURES, 5)

  const totalMin = state.RETRY_STEPS_MS.reduce((a, b) => a + b, 0) / 60_000
  check.ok('重试总时长在 10 分钟以内', totalMin <= 10, `${totalMin} 分钟`)

  const cred = byFile['lib/credentials.mjs']
  check.ok('导出 readDesktopCredential', typeof cred.readDesktopCredential === 'function')
  check.ok('导出 CredentialError', typeof cred.CredentialError === 'function')
  check.ok('默认登录文件名正确', cred.DEFAULT_DESKTOP_AUTH_FILE.endsWith('workbuddy-desktop.info'), cred.DEFAULT_DESKTOP_AUTH_FILE)
  check.ok(
    '登录文件路径落在本地数据目录下',
    // 目录名跟随平台：Windows 是 AppData/Local，类 Unix 是 .local/share。
    // 写死 Windows 形态会让这条断言在 Linux/macOS 上（含 CI 的 ubuntu-latest）恒为 false。
    (process.platform === 'win32'
      ? /AppData[\\/]Local[\\/]CodeBuddyExtension/i
      : /[\\/]\.local[\\/]share[\\/]CodeBuddyExtension/i
    ).test(cred.DEFAULT_DESKTOP_AUTH_FILE),
    cred.DEFAULT_DESKTOP_AUTH_FILE,
  )

  const report = byFile['lib/report.mjs']
  check.ok('导出 deliverReport', typeof report.deliverReport === 'function')
  check.ok('导出 buildAgentPrompt', typeof report.buildAgentPrompt === 'function')
  check.ok('默认状态文件名正确', report.DEFAULT_STATE_FILE.endsWith('state.json'), report.DEFAULT_STATE_FILE)
  check.ok(
    '状态文件落在 .dsh 数据目录下',
    /[\\/]\.dsh[\\/]\.workbuddy-checkin[\\/]/i.test(report.DEFAULT_STATE_FILE),
    report.DEFAULT_STATE_FILE,
  )

  const cfg = byFile['lib/config.mjs']
  check.ok('导出 resolveReportConfig', typeof cfg.resolveReportConfig === 'function')

  const api = byFile['lib/api.mjs']
  check.ok('导出 fetchStatus', typeof api.fetchStatus === 'function')
  check.ok('导出 claimDaily', typeof api.claimDaily === 'function')
  check.ok('导出 UpstreamError', typeof api.UpstreamError === 'function')
}

process.exit(check.report() ? 0 : 1)
