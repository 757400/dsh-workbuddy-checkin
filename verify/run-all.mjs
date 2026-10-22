// 一次跑完全部离线验证。
//
// 纪律：任何一条失败都必须让整体以非零码退出，不能「跑完了就算过」。
// 全部验证离线运行，不联网、不签到、不写真实状态文件。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const files = fs
  .readdirSync(HERE)
  .filter((n) => /^\d{2}-.*\.mjs$/.test(n))
  .sort()

if (files.length === 0) {
  console.error('没有找到验证脚本')
  process.exit(1)
}

const results = []
for (const f of files) {
  const full = path.join(HERE, f)
  process.stdout.write(`\n=== ${f} ===\n`)
  // stdio 继承：让子脚本直接往终端打，不走管道
  const r = spawnSync(process.execPath, [full], { stdio: 'inherit' })
  results.push({ f, ok: r.status === 0, status: r.status })
}

const failed = results.filter((r) => !r.ok)
console.log('\n================ 汇总 ================')
for (const r of results) {
  console.log(`  ${r.ok ? 'OK  ' : 'FAIL'}  ${r.f}`)
}
console.log(`\n${results.length - failed.length}/${results.length} 个验证脚本通过`)

if (failed.length > 0) {
  console.log('\n失败项：')
  for (const r of failed) console.log(`  - ${r.f} (exit ${r.status})`)
  process.exit(1)
}
process.exit(0)
