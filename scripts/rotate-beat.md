# rotate-beat（云电脑 cron，不是 Grok Bot）

每个上海整点窗结束时跑一次：结算上一窗 →（可选）摄入刚结束时段的 X 书签增量 → 打开下一窗 → 把 JSON 提交进 git。

**不要用 GitHub Issue / 评论当票箱。** 计票只读 Vote Worker（KV）。

## 前置

- 本仓库 clone，`git` 已登录，能 `git push origin`
- `python3` 3.9+（`zoneinfo`）
- 投票 API 已部署时：环境变量 `VOTE_API_BASE`（或 `tracking/rotate-config.json` 的 `voteApiBase`）+ `BALLOT_ADMIN_TOKEN`
- X 增量：`X_BEARER_TOKEN` + `X_BOOKMARKS_USER_ID`（没有则 `candidates=[]`，绝不伪造书签）

## Beat 步骤

1. 读 `tracking/rotate-config.json`、`tracking/arsenal.json`、`tracking/ballot-window.json`
2. 若当前窗仍未关闭则退出 0（`--force` 除外）
3. `GET {voteApiBase}/api/vote?windowId={prev}` 计票，写入 `tracking/vote-ledger.json` 的 `tallies` + `winningStack`
   - **真实零票**（接口 `ok` 且 `voteCount=0`）→ `winningStack.autoPick = true`（编排器从军火库 **active** 项自选）
   - **接口失败 / `voteApiBase` 为空 / 传输错误** → **中止 settle**（非 0 退出）。不把失败当成零票，不改 `vote-ledger` / `ballot-window`，不 git push
   - 燃料 / harness / 7×24 按票数取胜；平票按军火库 active 顺序
   - 模型若写在燃料名里，由编排器从 `winningStack.fuel` 解析
4. **TODO X ingest**：把刚结束窗 `[opensAt, closesAt)` 的书签增量写成 `candidates[]`（形状见 `scripts/rotate-beat.py` 的 `SAMPLE_CANDIDATE`）。无凭证或未实现则 `candidates=[]`，并在 `ingestNoteZh` 说明
5. 按上海 `slotHours` 打开下一窗，重写 `ballot-window.json`（`options` 只从 `arsenal.json` **active** 派生）
6. `PUT {voteApiBase}/api/window` 把新窗快照写入 KV（需 `BALLOT_ADMIN_TOKEN`）
7. `git add tracking/ballot-window.json tracking/vote-ledger.json && git commit && git push`

## 运行

```bash
cd /path/to/bookmark-demo-lab
./scripts/rotate-beat.sh
# 或
python3 scripts/rotate-beat.py --dry-run   # 窗未关则退出 0；窗已关则仍须能 GET 计票，失败则中止（非零）
python3 scripts/rotate-beat.py --self-test
python3 scripts/rotate-beat.py --no-push   # 只本地 commit
```

## Cron

上海时区（机器 `TZ=Asia/Shanghai` 或 crontab 前 `TZ=Asia/Shanghai`）：

```cron
0 0,8,16 * * * cd /path/to/bookmark-demo-lab && git pull --ff-only origin main && ./scripts/rotate-beat.sh >> /var/log/rotate-beat.log 2>&1
```

UTC 等价（`00:00/08:00/16:00` UTC ≡ `08:00/16:00/00:00` 上海）：

```cron
0 0,8,16 * * * cd /path/to/bookmark-demo-lab && git pull --ff-only origin main && ./scripts/rotate-beat.sh >> /var/log/rotate-beat.log 2>&1
```

`periodHours` 改为 `2` 或 `1` 时，同步改 `slotHours` 与 cron 表达式。

## 投票 API URL

```
GET  {voteApiBase}/api/vote?windowId={windowId}
POST {voteApiBase}/api/vote
PUT  {voteApiBase}/api/window
```

`voteApiBase` 例：`https://ballot-api.<account>.workers.dev`（不要尾斜杠）。同源路由绑在现有 Pages 主机时可为 `""`，枢纽走 `/api/vote`。
