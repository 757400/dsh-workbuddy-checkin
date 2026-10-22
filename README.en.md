# dsh-workbuddy-checkin

[中文](./README.md) | English

A DSH plugin that automatically claims the WorkBuddy **daily check-in** credits every time DSH starts.

**The WorkBuddy desktop client does not need to be running.**

- Runs about 20 seconds after DSH starts — no buttons to click
- Does nothing if today is already claimed — no duplicate API calls
- Retries a failure at 1 / 1 / 2 / 2 / 3 minutes, settling within ~9 minutes
- Writes its result to a local state file, readable through a read-only route
- By default it sends **nothing** into your sessions and spends **none** of your tokens

---

## Why it works without the client

After you log in, the WorkBuddy desktop app stores its session in:

```
%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info
```

The check-in endpoint only asks for one header:

```
Authorization: Bearer <accessToken>
```

So as long as that file exists and the token is valid, the plugin can drive the
public HTTPS endpoints — status, claim, verify — without the client process,
without any private IPC module.

That is all it does: **read** that file, send two POSTs, record the outcome.

---

## Install

### From the DSH plugin marketplace

Search for `dsh-workbuddy-checkin`, install, restart DSH.

### From GitHub

```bash
git clone https://github.com/757400/dsh-workbuddy-checkin.git
```

Add it to your DSH profile:

```jsonc
// ~/.dsh/profiles/<profile>/package.json
{
  "dependencies": {
    "dsh-workbuddy-checkin": "file:/absolute/path/to/dsh-workbuddy-checkin"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // ...your other plugins...
        "dsh-workbuddy-checkin"
      ]
    }
  }
}
```

Restart DSH. The log will show:

```
[dsh-workbuddy-checkin] 已装载：启动 20 秒后自动签到
[dsh-workbuddy-checkin] 状态路由已注册：GET /dsh-workbuddy-checkin/status
```

---

## Behaviour

| When | What happens |
| --- | --- |
| 20 s after DSH starts | first run |
| Already claimed / already attempted today | no requests at all |
| Claim succeeded | state recorded, done for the day |
| Credentials missing, corrupt, or not logged in | gives up for this run — retrying cannot help |
| Token expired | logs a warning and waits for you to log in again |
| Network blip, 5xx, unexpected business code | retries at **1 / 1 / 2 / 2 / 3 min**, 5 rounds, ~9 minutes total |
| Retries exhausted | records the final reason, waits for tomorrow |

The 9-minute window is deliberate. A typical DSH session is under an hour,
so hour-scale backoff means a failure happens where nobody will ever see it.

---

## Status route

The plugin registers one **read-only** route:

```
GET /dsh-workbuddy-checkin/status
```

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
    "history": [ /* last 7 days */ ]
  }
}
```

> DSH Desktop refuses ordinary browser access to its local HTTP port,
> so hitting this route with an external tool like `curl` returns 403.
> That is the host's access control, not a plugin fault.
> To check results, read the state file.

State file:

```
$DSH_HOME/.workbuddy-checkin/state.json      # default ~/.dsh/.workbuddy-checkin/state.json
```

It is plain, atomically written JSON. You can open it, or delete it to reset local
bookkeeping — the account-side check-in is not affected.

---

## Result reporting (off by default)

The plugin can post a message into a DSH session of your choice after a run finishes,
waking that session's agent so it explains the outcome in plain language.

**This is off by default**, for a straightforward reason: it wakes an agent, which
**spends your own token quota**. Doing that without asking is not acceptable, so it is
opt-in, and there is **no built-in target session** — you must name one yourself.

### Enable it

Edit `$DSH_HOME/.workbuddy-checkin/config.json`:

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

| Field | Meaning |
| --- | --- |
| `enabled` | must be `true` |
| `targetSessionId` | required, `session-<uuid>` |
| `afterSeconds` | 5–600 seconds, default 30 |
| `acknowledgeTokenCost` | set `true` to confirm you accept the token cost |

Environment variables work too:

```
DSH_WBCHECKIN_REPORT=1
DSH_WBCHECKIN_REPORT_SESSION=<session id>
DSH_WBCHECKIN_REPORT_DELAY=30
```

When disabled — or enabled without a `targetSessionId` — the plugin skips this path
entirely: no message is composed, the schedule service is not touched, nothing is
delivered. The check-in itself is unaffected.

### When a report is sent

- Claim succeeded → one report
- First failure → one report saying it is retrying, so you do not wait for the end
- Retries exhausted → one final failure report

"Already claimed today" stays silent.

### Why no report arrived

Check `reportConfig.reason` on the status route. It states the actual cause:
no config file, missing session id, explicitly disabled, malformed config, and so on.

---

## Other environment variables

| Variable | Purpose |
| --- | --- |
| `WORKBUDDY_AUTH_FILE` | override the credential file path (default derived from `%LOCALAPPDATA%`) |
| `DSH_HOME` | override the DSH data directory (default `~/.dsh`) |

---

## Security boundary

Deliberate red lines:

- **Read-only** on the credential file. No token refresh, no write-back, no logging of
  token contents, no upload
- Exactly **one** `exact` read-only route; no other path is claimed
- No client-side script injection, no DSH config rewriting, no touching the WorkBuddy process
- Result reporting off by default, no built-in session id, no decision made on your behalf
- Every failure is absorbed inside the plugin — it can **never** break DSH startup
- State file written atomically, in human-readable JSON

Data flow:

```
local credential file ──(read)──> plugin ──(HTTPS POST)──> www.workbuddy.cn
                                    └──(write)──> $DSH_HOME/.workbuddy-checkin/state.json
```

No request goes anywhere except WorkBuddy's own endpoints.

---

## Uninstall

1. Remove `dsh-workbuddy-checkin` from `dependencies` and `dsh.profile.bundles` in
   `~/.dsh/profiles/<profile>/package.json`
2. Restart DSH
3. Optional: delete `$DSH_HOME/.workbuddy-checkin/`

---

## Compatibility

| Item | Requirement |
| --- | --- |
| DSH | a version exposing `dsh.bundle.patch` and `ctx.inject` / `schedule` / `webServer` |
| Node.js | `^22.19.0 \|\| >=24.0.0` |
| OS | Windows (the credential file is written by the WorkBuddy desktop client) |

---

## Development

```bash
node verify/run-all.mjs     # full offline verification (no network, no check-in)
```

All verification is offline: module loading, config parsing, the retry state machine,
path derivation, and a secret-leak scan. It never calls the check-in endpoint and never
writes your state file.

## License

[MIT](./LICENSE)
