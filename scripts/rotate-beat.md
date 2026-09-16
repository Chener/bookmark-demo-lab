# rotate-beat

**主调度：Cloudflare Workers Cron Triggers**（`workers/ballot-api`，UTC `*/1 * * * *` 每分钟，以赶上 10 分钟投票窗的 `closesAt`）。

旧 8h 表达式 `0 0,8,16 * * *`（上海 08:00 / 16:00 / 00:00）**已降级，不再是主叙事**。

本脚本是 **人工 / 管理员回退**（KV 已转窗后把 JSON 同步进 git，或 Cron 故障时补跑；以及 `--ingest-only` 把 Firstmate slim 合并进当前窗）。**不要**用本机 crontab，**不要**用 Grok Bot routines，**不要**用 GitHub Issue / 评论当票箱。

Worker Cron 只做：KV 读计票 → 结算上一窗 → 打开下一窗写入 KV（时长来自 `voteWindowMinutes`，默认须由 `tracking/rotate-config.json` 提供；冷启动无配置时仍用遗留 `periodHours`）。不跑 git、不抓 X、不跑 agy / 演示构建。需要 X ingest 或 git push 时看 `GET /api/rotate-status` 的 `needsGitPush` / `needsXIngest`。这些标志只在成功 `rotated` / `bootstrapped` 时置 true；**skip / lock / 失败会读-合并-写，沿用旧值**。Harness 完成后 `POST /api/rotate-status/ack` 显式清掉。

空候选时 Worker **仍开窗**。隐藏投票 UI **不在本 Worker 分支**：见 Hub UI 分支 `hub/v2-ui-realtime`（合并 `main` 后才出现在 `index.html`）。

## 前置

- 本仓库 clone，`git` 已登录（仅回退路径需要 `git push`）
- `python3` 3.9+（`zoneinfo`）
- 投票 API 已部署：`VOTE_API_BASE` 或 `tracking/rotate-config.json` 的 `voteApiBase`，管理员操作另需 `BALLOT_ADMIN_TOKEN`
- X 增量主线（仅本脚本，Worker 不抓）：Firstmate 侧 X MCP slim JSON。路径优先环境变量 `X_BOOKMARKS_SLIM_PATH`，否则 `tracking/inbox/x-bookmarks-slim-latest.json`，再否则 `tracking/inbox/x-bookmarks-slim.json`。文件缺失则 `candidates=[]`，**绝不伪造书签**。
- 官方自建 X App / `X_BEARER_TOKEN` / `X_BOOKMARKS_USER_ID` **非主线**（船长 2026-09-16 令），本脚本不再走 Bearer 拉书签。公开调研仍走 grok build。

## Worker Cron（主路径）

部署 `ballot-api` 后，Wrangler `[triggers] crons = ["*/1 * * * *"]` 每分钟触发 `scheduled`：

1. `fetch` Pages `ORIGIN` 或 GitHub raw 的 `tracking/rotate-config.json`（失败则用 KV 缓存）读取 `voteWindowMinutes`（主）/ 遗留 `periodHours`
2. 读 KV `current-window`（没有则 fetch `ballot-window.json`）
3. 窗未关则跳过
4. 读 KV `tally:{windowId}` 结算 `winningStack`（真实零票 → `autoPick=true`；缺 tally 当零票）
5. 打开下一上海窗（`closesAt = opensAt + voteWindowMinutes`；10 分钟窗 `windowId` 为 `YYYY-MM-DD-HHMM`），写入 KV `current-window` / `window-meta:` / `vote-ledger`
6. 置 `rotate-status.needsGitPush=true`、`needsXIngest=true` 给后续 harness（后续 skip 不会清掉）

**部署顺序：** Pages 先（或同时）提供 `voteWindowMinutes: 10` 的 rotate-config，再 redeploy Worker。冷启动拉不到配置时不偷偷按 10 分钟 bootstrap。

## 本脚本回退步骤

1. 读 `tracking/rotate-config.json`、`tracking/arsenal.json`、`tracking/ballot-window.json`
2. 若当前窗仍未关闭则退出 0（`--force` 除外）
3. 若 Worker `GET /api/window` **严格超前** git JSON（先比 `opensAt`，再比可排序 `windowId`；10 分钟窗为 `YYYY-MM-DD-HHMM`）→ **同步 KV→git**（写入 `tracking/ballot-window.json` + `vote-ledger.json`，不伪造 X 书签）。**仅在 git commit 且 `git push` 成功后** 才 `POST /api/rotate-status/ack` 清 `needsGitPush`。`--no-git` / `--no-push` / push 失败 **不清** 标志。然后退出 0，不 settle。
   - 若 **git 超前** Worker：不覆盖 tracking JSON，不 ack。可选且默认：`PUT /api/window` 把 git 快照写回 Worker 以修复分脑（需 `BALLOT_ADMIN_TOKEN`）。然后继续用 git JSON 走后面步骤。
4. `GET {voteApiBase}/api/vote?windowId={prev}` 计票，写入 `tracking/vote-ledger.json`
   - **真实零票**（接口 `ok` 且 `voteCount=0`）→ `winningStack.autoPick = true`
   - **接口失败 / `voteApiBase` 为空 / 传输错误** → **中止 settle**（非 0 退出）
   - 燃料 / harness / 7×24 按票数取胜；平票按军火库 active 顺序
5. **X ingest（Firstmate X MCP slim）**：刚结束窗 `[opensAt, closesAt)` 的书签增量。优先 `bookmarked_at` / `bookmarkedAt`，否则 `created_at`。跳过 `tracking/seen-bookmarks.json` 已有 id。无 slim 文件则 `candidates=[]`，绝不伪造。默认 **按 id 合并**（不因本页缺失而删既有 open 候选）。`has_more=true` 时拒绝 `--replace-candidates` 整表替换。seen 文件损坏或 slim 解析失败则 **中止**（非 0）。
6. 按 `voteWindowMinutes` 打开下一窗，重写 `ballot-window.json`
7. `PUT {voteApiBase}/api/window` 把新窗快照写入 KV（需 `BALLOT_ADMIN_TOKEN`）
8. `git add tracking/ballot-window.json tracking/vote-ledger.json && git commit && git push`

## X 书签 ingest（Firstmate X MCP）

主线是 Firstmate 用自有 X MCP `get_users_bookmarks` 写成 slim JSON（见 `tracking/inbox/README.md`），**不是**官方自建 X App。Worker Cron **不**抓 X。

Firstmate 建议每 **5–15 分钟** 轮询 MCP 书签（按页计费）。不要为了填窗伪造条目。

约定：

- 文件：`X_BOOKMARKS_SLIM_PATH` → `tracking/inbox/x-bookmarks-slim-latest.json` → `tracking/inbox/x-bookmarks-slim.json`
- 周期：`[period_start, period_end)`，时间戳优先 `bookmarked_at` / `bookmarkedAt`，否则 `created_at`
- 跳过 seen id；`titleZh` / `planZh` / `suggestedSlug` 从条目真实 `text` 自动起草（中文原文可直接用）
- 没有 id/url 的条目丢弃，不编造推文 id 或 URL
- **默认 merge-by-id**：把本页通过过滤的 id 加入/更新候选；slim 里没出现的既有 open 候选一律保留。`has_more=true` 的残页不得整表替换
- `--replace-candidates`：故意全量替换；若 slim `has_more=true` 则拒绝并保持原候选
- `tracking/seen-bookmarks.json` 读失败 / 结构损坏 → 中止 ingest（不当成「谁都没见过」）
- slim 文件存在但 JSON 解析失败 → 中止；`ingestNoteZh` 写「读取/解析失败」，不写「无未见 id」
- `--ingest-only` 的 `ingestNoteZh` 按 **本页 incoming** 计数，不是合并后总数

窗未关时只刷新当前 `tracking/ballot-window.json` 的候选（不 settle）。若 rotate-config 含 `voteWindowMinutes`，会盖到 JSON 上并 `PUT /api/window`（**不改**当前 `opensAt`/`closesAt`；10 分钟跨度在下次 Cron/settle 开窗时生效）：

```bash
python3 scripts/rotate-beat.py --ingest-only
python3 scripts/rotate-beat.py --ingest-only --dry-run
# 或显式路径
X_BOOKMARKS_SLIM_PATH=tracking/inbox/x-bookmarks-slim-latest.json python3 scripts/rotate-beat.py --ingest-only
# 故意全量替换（slim 不得 has_more=true）
python3 scripts/rotate-beat.py --ingest-only --replace-candidates
```

`--ingest-only` 默认按当前窗 `[opensAt, closesAt)` **合并** `candidates` 并更新 `ingestNoteZh`。slim 文件缺失时保持原候选不动。

## 运行

```bash
cd /path/to/bookmark-demo-lab
python3 scripts/rotate-beat.py --self-test
python3 scripts/rotate-beat.py --ingest-only --dry-run
python3 scripts/rotate-beat.py --ingest-only   # 按 id 合并当前窗候选，不 settle
python3 scripts/rotate-beat.py --ingest-only --replace-candidates  # 故意全量替换
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
