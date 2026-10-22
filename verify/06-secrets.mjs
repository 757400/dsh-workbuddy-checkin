// 验证 6：密钥与个人信息泄露扫描。
//
// 上架前的硬闸门：仓库里只要出现一次真实 token、真实用户名、真实会话 ID，
// 就不该发出去。这条检查失败意味着「现在绝不能 push」。
import fs from 'node:fs'
import path from 'node:path'
import { createChecker, ROOT, listSourceFiles } from './harness.mjs'

const check = createChecker('secrets')

const files = listSourceFiles().filter((f) => {
  const rel = path.relative(ROOT, f)
  // 只看会进仓库的文本文件
  if (/[\\/](\.git|node_modules)[\\/]/.test(rel)) return false
  // verify/ 里本来就是在描述这些泄露模式，扫它自己必然自命中，排除
  if (rel.startsWith(`verify${path.sep}`)) return false
  return /\.(mjs|js|cjs|json|md|yml|yaml|txt|LICENSE)$/i.test(f) || path.basename(f) === 'LICENSE'
})

check.ok('扫描到待检查文件', files.length > 0, `${files.length} 个`)

// 已知的真实敏感串一旦出现在仓库里就是事故。
//
// 注意这里不写任何真值字面量：这份脚本本身也会公开，把 "某台机器上真实的
// 会话 ID" 抄进正则，等于换了种方式把它发出去。所以做法是
//   1) 通用模式（能匹配任意机器的用户名 / 路径 / token 形态）；
//   2) 本机专属的已知值走环境变量或 .secrets.local，不进仓库。
const GENERIC_SECRETS = [
  { name: '盘符绝对路径指向用户目录且带真实用户名', re: /[A-Z]:[\\/]{1,4}Users[\\/]{1,4}(?!<|\$\{|\*)[A-Za-z0-9._-]{2,}[\\/]{1,4}/i },
  { name: '登录文件名被硬编码为绝对路径', re: /[A-Z]:[\\/].*workbuddy-desktop\.info/i },
  { name: 'JWT 形态的 token', re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: 'Bearer 后跟长串', re: /Bearer\s+[A-Za-z0-9._-]{40,}/ },
  { name: '疑似 accessToken 赋值', re: /accessToken\s*[:=]\s*['"][A-Za-z0-9._-]{20,}['"]/ },
  { name: '疑似 refreshToken 赋值', re: /refreshToken\s*[:=]\s*['"][A-Za-z0-9._-]{20,}['"]/ },
]

// 本机专属的真值不落盘：用 DSH_PLUGIN_AUTHOR_DENYLIST 传（逗号分隔），
// 或者放在仓库外的 .secrets.local 里一行一个。CI 上不需要，本地发布前跑。
function localDenylist() {
  const out = []
  const env = process.env.DSH_PLUGIN_AUTHOR_DENYLIST
  if (env) out.push(...env.split(',').map((s) => s.trim()).filter(Boolean))
  const localFile = path.join(path.dirname(new URL(import.meta.url).pathname).replace(/^[\\/]/, ''), '..', '.secrets.local')
  try {
    if (fs.existsSync(localFile)) {
      out.push(...fs.readFileSync(localFile, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#')))
    }
  } catch {
    // 没有就没有，本地专用文件允许缺失
  }
  return out
}

const REAL_SECRETS = [
  ...GENERIC_SECRETS,
  ...localDenylist().map((v) => ({ name: '本机已知敏感串', re: new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') })),
]

const findings = []
for (const f of files) {
  const rel = path.relative(ROOT, f)
  const text = fs.readFileSync(f, 'utf8')
  for (const s of REAL_SECRETS) {
    if (s.re.test(text)) {
      // README 里说明「不会打印 token」这类正常叙述不算泄露，单独放过明显是描述的句子
      findings.push(`${rel} ← ${s.name}`)
    }
  }
}

check.eq('没有真实密钥 / 用户名 / 会话 ID 泄露', findings, [])

// 也扫一遍是否有别人机器上的绝对路径（作者路径）残留
{
  const suspicious = []
  for (const f of files) {
    const rel = path.relative(ROOT, f)
    const text = fs.readFileSync(f, 'utf8')
    // 典型的「某人的本机路径」：盘符 + Users + 用户名 + 插件目录
    if (/[A-Z]:[\\/]{1,4}Users[\\/]{1,4}[^\\/"'\s]+[\\/]{1,4}[^"'\s]*checkin/i.test(text)) {
      suspicious.push(rel)
    }
  }
  check.eq('没有残留的作者本机路径', suspicious, [])
}

// package.json 关键字段自检
{
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  check.eq('包名', pkg.name, 'dsh-workbuddy-checkin')
  check.ok('版本号形如 x.y.z', /^\d+\.\d+\.\d+$/.test(pkg.version), pkg.version)
  check.ok('不含 private 字段（可公开发布）', pkg.private === undefined, String(pkg.private))
  check.eq('license 为 MIT', pkg.license, 'MIT')
  check.eq('type 为 module', pkg.type, 'module')
  check.eq('入口文件正确', pkg.main, 'lib/index.mjs')
  check.ok('有 repository', typeof pkg.repository === 'object')
  check.ok('有 homepage', typeof pkg.homepage === 'string')
  check.ok('有 bugs 地址', typeof pkg.bugs === 'object')
  check.ok('engines.node 已声明', typeof pkg.engines?.node === 'string', pkg.engines?.node)
  check.ok('dsh.bundle.patch 已声明', pkg.dsh?.bundle?.patch === './cordis.patch.yml')
  check.ok('files 含 lib', Array.isArray(pkg.files) && pkg.files.includes('lib'))
  check.ok('files 含 README.md', pkg.files.includes('README.md'))
  check.ok('files 含 LICENSE', pkg.files.includes('LICENSE'))
  check.ok('keywords 提到 dsh-plugin', pkg.keywords.includes('dsh-plugin'))
}

// 字数纪律：简介太长会被市场截断
{
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  check.ok('description 不超过 200 字符', pkg.description.length <= 200, `${pkg.description.length} 字符`)
  check.ok('description 为英文（市场索引友好）', !/[\u4e00-\u9fa5]/.test(pkg.description))
}

// 必需文件存在
for (const f of ['README.md', 'README.en.md', 'LICENSE', 'CHANGELOG.md', '.gitignore', 'cordis.patch.yml']) {
  check.ok(`${f} 存在`, fs.existsSync(path.join(ROOT, f)))
}

process.exit(check.report() ? 0 : 1)
