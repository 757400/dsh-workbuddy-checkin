// 离线验证公共工具。
//
// 所有验证脚本都必须满足两条纪律：
//   1. 不联网——绝不调用签到接口；
//   2. 不写真实状态文件——所有落盘都指向临时目录。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 极简断言器：统计通过/失败，跑完由 run() 决定退出码。 */
export function createChecker(name) {
  const results = []
  const check = (label, fn) => {
    try {
      const detail = fn()
      results.push({ ok: true, label, detail })
      return true
    } catch (err) {
      results.push({ ok: false, label, detail: String((err && err.message) || err) })
      return false
    }
  }
  check.eq = (label, actual, expected) =>
    check(label, () => {
      const a = JSON.stringify(actual)
      const e = JSON.stringify(expected)
      if (a !== e) throw new Error(`期望 ${e}，实际 ${a}`)
      return a
    })
  check.ok = (label, cond, detail = '') =>
    check(label, () => {
      if (!cond) throw new Error(detail || '条件不成立')
      return detail
    })
  check.report = () => {
    const failed = results.filter((r) => !r.ok)
    for (const r of results) {
      if (r.ok) console.log(`  PASS ${r.label}${r.detail ? ` — ${r.detail}` : ''}`)
      else console.log(`  FAIL ${r.label} — ${r.detail}`)
    }
    console.log(`\n[${name}] ${results.length - failed.length}/${results.length} 通过`)
    return failed.length === 0
  }
  return check
}

/** 加载仓库内的模块。 */
export function load(relPath) {
  return import(pathToFileURL(path.join(ROOT, relPath)).href)
}

/** 造一个隔离的临时 home 目录，跑完自己清理。 */
export function makeTempHome(prefix = 'dsh-wbcheckin-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  return {
    dir,
    stateFile: path.join(dir, '.workbuddy-checkin', 'state.json'),
    configFile: path.join(dir, '.workbuddy-checkin', 'config.json'),
    writeConfig(obj) {
      fs.mkdirSync(path.dirname(this.configFile), { recursive: true })
      fs.writeFileSync(this.configFile, JSON.stringify(obj, null, 2), 'utf8')
    },
    cleanup() {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        // 临时目录清不掉不影响结论
      }
    },
  }
}

/** 递归列出仓库里所有源文件（跳过 node_modules / .git）。 */
export function listSourceFiles(dir = ROOT, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) listSourceFiles(full, acc)
    else if (entry.isFile()) acc.push(full)
  }
  return acc
}
