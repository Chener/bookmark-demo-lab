# X 书签增量 inbox（Firstmate X MCP）

## 接法
- **主线**：Firstmate 用自有 X MCP `get_users_bookmarks` 拉书签，写成 slim JSON 放到本目录或通过环境变量 `X_BOOKMARKS_SLIM_PATH` 交给 `scripts/rotate-beat.py`。
- **不要**再配官方自建 App 的 `X_BEARER_TOKEN`（船长 2026-09-16 令）。
- 公开调研仍走 grok build，不走书签 MCP。

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
- 跳过 `tracking/seen-bookmarks.json` 已有 id；绝不伪造条目。

## 回调
每窗关闭后 / 开窗前：Firstmate 交本窗 slim（可多页合并为一个文件）。书签Demo 跑 rotate-beat ingest 或直接合并进 `ballot-window.json` 后推 main，并用 admin `PUT /api/window` 同步 KV。
