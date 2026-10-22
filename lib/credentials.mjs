// 凭据读取：只从 WorkBuddy 桌面端自己维护的登录文件里取 token。
// 只读，不写回，不刷新，不打印任何 token 内容。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** WorkBuddy 桌面端写登录态的固定相对路径（相对当前用户的 LOCALAPPDATA）。 */
export const DESKTOP_AUTH_RELATIVE = ['CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info']

/** 各平台 LOCALAPPDATA 的取值方式。 */
function localAppData() {
  if (process.env.LOCALAPPDATA) return process.env.LOCALAPPDATA
  const home = os.homedir()
  return process.platform === 'win32'
    ? path.join(home, 'AppData', 'Local')
    : path.join(home, '.local', 'share')
}

/**
 * 默认登录文件绝对路径。
 *
 * 这里必须用 os.homedir() 拼，不能写死某个用户名：
 * 写死以后装到别人机器上必然读不到文件，是所有 Windows 插件的常见坑。
 */
export const DEFAULT_DESKTOP_AUTH_FILE = path.join(localAppData(), ...DESKTOP_AUTH_RELATIVE)

export class CredentialError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'CredentialError'
    this.code = code
  }
}

/**
 * 读取桌面端登录态。
 * @returns {{accessToken:string, domain:string, expiresAt:number|null, refreshExpiresAt:number|null, uid:string|null}}
 */
export function readDesktopCredential(authFile) {
  const file = authFile || process.env.WORKBUDDY_AUTH_FILE || DEFAULT_DESKTOP_AUTH_FILE
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (err) {
    throw new CredentialError('AUTH_FILE_UNREADABLE', `读不到 WorkBuddy 登录文件（${err.code || 'unknown'}）`)
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new CredentialError('AUTH_FILE_MALFORMED', 'WorkBuddy 登录文件不是合法 JSON')
  }

  const auth = parsed && parsed.auth
  if (!auth || typeof auth.accessToken !== 'string' || auth.accessToken.length === 0) {
    throw new CredentialError('AUTH_NO_TOKEN', 'WorkBuddy 登录文件里没有 accessToken（可能未登录或已退出）')
  }

  const account = parsed.account || {}
  return {
    accessToken: auth.accessToken,
    domain: typeof auth.domain === 'string' && auth.domain ? auth.domain : 'www.workbuddy.cn',
    expiresAt: typeof auth.expiresAt === 'number' ? auth.expiresAt : null,
    refreshExpiresAt: typeof auth.refreshExpiresAt === 'number' ? auth.refreshExpiresAt : null,
    uid: typeof account.uid === 'string' ? account.uid : null,
  }
}

/** token 剩余有效时间（毫秒）；未知时返回 null。 */
export function tokenRemainingMs(cred, now = Date.now()) {
  if (!cred || typeof cred.expiresAt !== 'number') return null
  return cred.expiresAt - now
}
