# dsh-workbuddy-checkin

[English](./README.en.md) | 中文

DSH 插件：DSH 启动后自动完成 WorkBuddy「Buddy 加油站」每日签到，并领取当日积分。

**不需要运行 WorkBuddy 桌面客户端。**

- 安装后约 20 秒自动跑第一次，不用点任何按钮
- 今天已经领过就什么都不做，不会重复调接口
- 失败按 1、1、2、2、3 分钟退避重试，约 9 分钟内出结论
- 结果写在本机状态文件里，可通过只读路由查询
- 默认**不**往任何会话发消息、不消耗你的 token

---

## 为什么能不用客户端

WorkBuddy 桌面端登录后，会把登录态写在自己的数据目录：

```
%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info
```

签到接口本身只认一个请求头：

```
Authorization: Bearer <accessToken>
```

所以只要这份文件在、token 没过期，就能直接走公开 HTTPS 接口完成「查状态 → 领取 → 复核」，
不需要 WorkBuddy 进程活着，也不需要任何私有 IPC 模块。

本插件做的全部事情就是：**只读**这份文件 → 发两个 POST → 把结果记下来。

---

## 安装

### 从 DSH 插件市场

在 DSH 插件市场搜索 `dsh-workbuddy-checkin`，点安装，重启 DSH。

### 从 GitHub 手动安装

```bash
# 1) 拿到源码
git clone https://github.com/WangFugui-cmd/dsh-workbuddy-checkin.git
```

然后把它加进 DSH profile 的依赖：

```jsonc
// ~/.dsh/profiles/<profile>/package.json
{
  "dependencies": {
    "dsh-workbuddy-checkin": "file:/绝对路径/dsh-workbuddy-checkin"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // ……其他插件……
        "dsh-workbuddy-checkin"
      ]
    }
  }
}
```

重启 DSH。日志里能看到：

```
[dsh-workbuddy-checkin] 已装载：启动 20 秒后自动签到
[dsh-workbuddy-checkin] 状态路由已注册：GET /dsh-workbuddy-checkin/status
```

---

## 行为

| 时机 | 动作 |
| --- | --- |
| DSH 启动后 20 秒 | 跑第一次 |
| 今天已领过 / 已尝试过 | 不发任何请求 |
| 领取成功 | 记状态，当天不再跑 |
| 凭据缺失、文件损坏、没登录 | 当轮直接收工，不重试（重试也不会变好） |
| token 过期 | 记一条警告，等你在客户端重新登录 |
| 网络抖动、接口 5xx、业务码异常 | 按 **1 / 1 / 2 / 2 / 3 分钟**重试，共 5 轮，约 9 分钟 |
| 重试用尽 | 记下最终失败原因，等第二天 |

重试窗口压到 9 分钟是刻意的：DSH 单次使用时长通常不到一小时，
把退避拉到小时级别，等于「失败了但用户永远看不到」。

---

## 状态查询

插件注册了一个**只读**路由：

```
GET /dsh-workbuddy-checkin/status
```

返回：

```jsonc
{
  "plugin": "dsh-workbuddy-checkin",
  "lastRunAt": "2026-10-22T06:00:21.000Z",
  "lastResult": { "status": "claimed", "day": "2026-10-22", "credit": 100 },
  "reportConfig": { "enabled": false, "reason": "config.json 不存在", "source": "default" },
  "state": {
    "lastSuccessDay": "2026-10-22",
    "streakDays": 3,
    "totalCredits": 300,
    "failureCount": 0,
    "history": [ /* 最近 7 天 */ ]
  }
}
```

> DSH Desktop 默认不允许普通浏览器直接访问本机 HTTP 端口，
> 用 `curl` 之类的外部工具打这个路由会得到 403。
> 这是宿主的访问控制，不是插件的问题；日常看结果读状态文件即可。

状态文件位置：

```
$DSH_HOME/.workbuddy-checkin/state.json      # 默认 ~/.dsh/.workbuddy-checkin/state.json
```

它是原子写入的普通 JSON，可以直接打开看，也可以直接删（删了等于清空本地记录，不影响账号侧签到）。

---

## 结果回报（默认关闭）

插件可以选择在签到出结果后，往你指定的某个 DSH 会话里投递一条消息并唤醒那个会话的 agent，
让它用自然语言把结果讲给你听。

**这个功能默认关闭**，原因很直接：它会唤醒 agent 跑一轮，**消耗的是你自己的 token 额度**。
不打招呼就替用户花额度不合适，所以默认不开，而且**没有任何内置的目标会话**——
必须由你自己指定投给哪个会话。

### 开启

编辑 `$DSH_HOME/.workbuddy-checkin/config.json`：

```json
{
  "report": {
    "enabled": true,
    "targetSessionId": "session-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "afterSeconds": 30,
    "acknowledgeTokenCost": true
  }
}
```

| 字段 | 说明 |
| --- | --- |
| `enabled` | 置 `true` 才启用 |
| `targetSessionId` | 必填，格式 `session-<uuid>` |
| `afterSeconds` | 延迟秒数，允许 5~600，默认 30 |
| `acknowledgeTokenCost` | 置 `true` 表示你已知悉这会消耗 token |

也可以用环境变量覆盖：

```
DSH_WBCHECKIN_REPORT=1
DSH_WBCHECKIN_REPORT_SESSION=<会话 ID>
DSH_WBCHECKIN_REPORT_DELAY=30
```

未启用、或开了但没给 `targetSessionId`，插件会**完全跳过**这条路径：
不写播报文案、不调用 schedule 服务、不投递。签到本身照常进行。

### 什么情况下会播报

- 领取成功 → 播一条
- 第一次失败 → 立刻播一条「正在自动重试」，不必等到重试用尽
- 重试用尽仍失败 → 播一条最终失败

「今天已经领过」不打扰。

### 为什么没收到播报

查状态路由的 `reportConfig.reason`，它会直接说明原因：
配置不存在、缺会话 ID、显式关闭、配置文件损坏等。

---

## 其它环境变量

| 变量 | 用途 |
| --- | --- |
| `WORKBUDDY_AUTH_FILE` | 覆盖登录文件路径（默认按 `%LOCALAPPDATA%` 推导） |
| `DSH_HOME` | 覆盖 DSH 数据目录（默认 `~/.dsh`） |

---

## 安全边界

这是本插件刻意守住的红线：

- **只读**登录文件。不刷新 token、不回写、不打印 token 内容、不上传
- 只注册**一个** `exact` 只读路由，不抢占其它路径
- 不注入客户端脚本、不改 DSH 配置、不碰 WorkBuddy 客户端进程
- 结果回报默认关闭，没有内置会话 ID，不替你决定往哪投
- 所有异常都在插件内部吸收，**不会让 DSH 启动失败**
- 状态文件原子写，格式是人类可读的 JSON

数据流向：

```
本机登录文件 ──(读)──> 插件 ──(HTTPS POST)──> www.workbuddy.cn
                          └──(写)──> $DSH_HOME/.workbuddy-checkin/state.json
```

除 WorkBuddy 自己的接口外，不向任何第三方发请求。

---

## 卸载

1. 从 `~/.dsh/profiles/<profile>/package.json` 的 `dependencies` 和 `dsh.profile.bundles` 里移除 `dsh-workbuddy-checkin`
2. 重启 DSH
3. 可选：删掉 `$DSH_HOME/.workbuddy-checkin/`（放着也不影响任何东西）

---

## 兼容性

| 项 | 要求 |
| --- | --- |
| DSH | 提供 `dsh.bundle.patch` 与 `ctx.inject/Schedule/webServer` 的版本 |
| Node.js | `^22.19.0 \|\| >=24.0.0` |
| 操作系统 | Windows（登录文件由 WorkBuddy 桌面端写入） |

---

## 开发

```bash
node verify/run-all.mjs     # 全部离线验证（不联网、不签到）
```

验证脚本全部离线：只做模块加载、配置解析、状态机、路径推导、脱敏检查等，
不会发起签到请求，也不会写你的状态文件。

## License

[MIT](./LICENSE)
