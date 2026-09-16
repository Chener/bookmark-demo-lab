# X 书签增量 inbox（Firstmate X MCP）

## 接法
- **主线**：Firstmate 用自有 X MCP `get_users_bookmarks` 拉书签，写成 slim JSON 放到本目录或通过环境变量 `X_BOOKMARKS_SLIM_PATH` 交给 `scripts/rotate-beat.py`。默认 `--ingest-only` **按 id 合并**（不因本页缺失删既有 open 候选）；`has_more=true` 时拒绝 `--replace-candidates`。
- **不要**再配官方自建 App 的 `X_BEARER_TOKEN`（船长 2026-09-16 令）。
- 公开调研仍走 grok build，不走书签 MCP。

## 节拍与成本
- Firstmate 建议每 **5–15 分钟** 轮询一次 MCP 书签（按页计费，如 slim 里的 `approx_cost_usd`）。不要为了填满投票窗而伪造条目。
- Worker Cron 每分钟只做 settle/open，**不**拉 X。空候选时 Worker 仍开窗；**隐藏投票 UI 在 Hub UI 分支 `hub/v2-ui-realtime`**（合并 `main` 后才出现在枢纽页），不在本 Worker 分支的 `index.html`。
- 投票窗时长以 `tracking/rotate-config.json` 的 `voteWindowMinutes: 10` 为准（须先上 Pages，再/同时 redeploy Worker）。

## slim 约定
```json
{
  "source": "user-X MCP get_users_bookmarks",
  "account": "PixelMaLiang",
  "user_id": "…",
  "fetched_at": "…",
  "page": 1,
  "has_more": true,
  "next_token": "…",
  "items": [
    {"id":"…","url":"…","created_at":"…","author":"…","text":"…"}
  ]
}
```
- 周期过滤：优先 `bookmarked_at`，否则 `created_at`（推文创建时间，可能低估「本窗新收藏」）。
- 跳过 `tracking/seen-bookmarks.json` 已有 id；绝不伪造条目。seen 损坏或 slim 解析失败则 **中止**（fail closed）。

## 回调
每 5–15 分钟（或窗关闭后 / 开窗前）：Firstmate 交本窗 slim（可多页合并为一个文件）。书签Demo 跑 `python3 scripts/rotate-beat.py --ingest-only`（merge-by-id）后，admin `PUT /api/window` 同步 KV。`--ingest-only` 的 ingest 说明按 **incoming** 计数。
