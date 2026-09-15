# rotate-beat

**主调度：Cloudflare Workers Cron Triggers**（`workers/ballot-api`，UTC `0 0,8,16 * * *` ≡ 上海 08:00 / 16:00 / 00:00）。

本脚本是 **人工 / 管理员回退**（KV 已转窗后把 JSON 同步进 git，或 Cron 故障时补跑）。**不要**用本机 crontab，**不要**用 Grok Bot routines，**不要**用 GitHub Issue / 评论当票箱。

Worker Cron 只做：KV 读计票 → 结算上一窗 → 打开下一窗写入 KV。不跑 git、不抓 X、不跑 agy / 演示构建。需要 X ingest 或 git push 时看 `GET /api/rotate-status` 的 `needsGitPush` / `needsXIngest`。这些标志只在成功 `rotated` / `bootstrapped` 时置 true；**skip / lock / 失败会读-合并-写，沿用旧值**。Harness 完成后 `POST /api/rotate-status/ack` 显式清掉。

## 前置

- 本仓库 clone，`git` 已登录（仅回退路径需要 `git push`）
- `python3` 3.9+（`zoneinfo`）
- 投票 API 已部署：`VOTE_API_BASE` 或 `tracking/rotate-config.json` 的 `voteApiBase`，管理员操作另需 `BALLOT_ADMIN_TOKEN`
- X 增量（仅本脚本，Worker 不抓）：`X_BEARER_TOKEN` + `X_BOOKMARKS_USER_ID`（没有则 `candidates=[]`，绝不伪造书签）

## Worker Cron（主路径）

部署 `ballot-api` 后，Wrangler `[triggers] crons` 会在整点触发 `scheduled`：

1. `fetch` Pages `ORIGIN` 或 GitHub raw 的 `tracking/rotate-config.json`（失败则用 KV 缓存）读取 `periodHours` / `slotHours`
2. 读 KV `current-window`（没有则 fetch `ballot-window.json`）
3. 窗未关则跳过
4. 读 KV `tally:{windowId}` 结算 `winningStack`（真实零票 → `autoPick=true`；缺 tally 当零票）
5. 打开下一上海窗，写入 KV `current-window` / `window-meta:` / `vote-ledger`
6. 置 `rotate-status.needsGitPush=true`、`needsXIngest=true` 给后续 harness（后续 skip 不会清掉）

`periodHours` 改为 `2` 或 `1` 时，同步改 `slotHours` **以及** `wrangler.toml` 的 cron 表达式。

## 本脚本回退步骤

1. 读 `tracking/rotate-config.json`、`tracking/arsenal.json`、`tracking/ballot-window.json`
2. 若当前窗仍未关闭则退出 0（`--force` 除外）
3. 若 Worker `GET /api/window` 的 `windowId` 已超前 git JSON → **同步 KV→git**（`GET /api/window` + `GET /api/ledger` 写入 `tracking/ballot-window.json` 与 `tracking/vote-ledger.json`，不伪造 X 书签；成功写入后 `POST /api/rotate-status/ack` 只清 `needsGitPush`），然后退出 0，不 settle
4. `GET {voteApiBase}/api/vote?windowId={prev}` 计票，写入 `tracking/vote-ledger.json`
   - **真实零票**（接口 `ok` 且 `voteCount=0`）→ `winningStack.autoPick = true`
   - **接口失败 / `voteApiBase` 为空 / 传输错误** → **中止 settle**（非 0 退出）
   - 燃料 / harness / 7×24 按票数取胜；平票按军火库 active 顺序
5. **TODO X ingest**：刚结束窗 `[opensAt, closesAt)` 的书签增量。无凭证或未实现则 `candidates=[]`
6. 按上海 `slotHours` 打开下一窗，重写 `ballot-window.json`
7. `PUT {voteApiBase}/api/window` 把新窗快照写入 KV（需 `BALLOT_ADMIN_TOKEN`）
8. `git add tracking/ballot-window.json tracking/vote-ledger.json && git commit && git push`

## 运行

```bash
cd /path/to/bookmark-demo-lab
python3 scripts/rotate-beat.py --self-test
python3 scripts/rotate-beat.py --dry-run
python3 scripts/rotate-beat.py --no-push   # 只本地 commit
# 管理员强制（窗未关也结算；会覆盖 Worker 当前窗，慎用）
python3 scripts/rotate-beat.py --force
```

`./scripts/rotate-beat.sh` 只是上述 Python 的薄封装，**不是** crontab 入口。

## 投票 API URL

```
GET  {voteApiBase}/api/vote?windowId={windowId}
POST {voteApiBase}/api/vote
GET  {voteApiBase}/api/window
PUT  {voteApiBase}/api/window
GET  {voteApiBase}/api/ledger
GET  {voteApiBase}/api/rotate-status
POST {voteApiBase}/api/rotate-status/ack  # admin；body {"needsGitPush":false,"needsXIngest":false}
POST {voteApiBase}/api/rotate          # admin；与 Cron 同一套 slim settle/open
```

`voteApiBase` 例：`https://ballot-api.<account>.workers.dev`（不要尾斜杠）。同源路由绑在现有 Pages 主机时可为 `""`，枢纽走 `/api/vote`。
