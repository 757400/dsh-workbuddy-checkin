# 发布流程

这个包通过 GitHub Actions 发布到 npm，打 tag 即发版。日常改代码只推 main，不会动 npm 上的版本。

## 一次性准备（只做一次）

1. 到 npm 建一个 Granular Access Token：
   权限选 Read and write，范围限定到 `dsh-workbuddy-checkin` 这一个包，
   类型选 Automation（CI 环境不走 2FA）。
2. 打开仓库 Settings → Secrets and variables → Actions → New repository secret，
   名字填 `NPM_TOKEN`，值粘贴上面的 token。

## 每次发版

```bash
# 1) 改版本号（记得同步 CHANGELOG.md）
npm version patch     # 或 minor / major

# 2) 推 commit 和 tag
git push origin main --follow-tags
```

tag 形如 `v1.0.2`，workflow 会先跑 `npm run verify`，通过后才发布。
tag 名和 `package.json` 的 version 对不上会直接失败，不会错发版本。

## 为什么必须发 npm

DSH 插件市场只对「有 npm 包信息」的条目生成一键安装和更新命令。
没发 npm 时，目录里能搜到插件，但点安装是空操作，用户只能手动 clone 后改 profile。

## 出问题怎么退

- 发错了版本：`npm unpublish dsh-workbuddy-checkin@<version>`（72 小时内有效），
  或者直接发一个更高的修订版覆盖。
- workflow 失败：看 Actions 日志。`verify` 失败说明插件自检没过，别绕过它发版。
- 只想先验证不发布：手动触发不了这个 workflow（它只认 tag），
  本地跑 `npm run verify` 即可。
