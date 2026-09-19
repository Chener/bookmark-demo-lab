# bookmark-demo-lab

从 X 书签出发的日常技术演示：切分支 → 获得 **Cloudflare Pages 预览地址**。

一个仓库、多套独立应用。根目录 `index.html` + `hub.css` / `hub.js` 是轻量枢纽；每个演示放在 `apps/<slug>/`，可单独打开。

## 布局

```
apps/<slug>/                      # 每个选题一个自包含演示
tracking/seen-bookmarks.json      # 已做成应用的 id / url / 技术栈；枢纽运行时读取
tracking/arsenal.json             # 军火库：燃料 / harness / 7×24（仅 active 可投票）
tracking/rotate-config.json       # 轮转：时区、voteWindowMinutes（主）、periodHours 遗留、voteApiBase
tracking/ballot-window.json      # 当前投票窗 + 待投票候选 + 可选项
tracking/vote-ledger.json         # 上一窗结算账本（winningStack / autoPick）
workers/ballot-api/               # 唯一后端：投票 + KV + Workers Cron Triggers
scripts/rotate-beat.py            # 人工/管理员回退（Cron 才是主调度）
index.html                        # 枢纽：卡片 + 待投票 + 军火库 + 原帖
hub.css / hub.js                  # 枢纽样式与投票/军火库逻辑（静态，不进 Worker）
```

枢纽与演示是 **Cloudflare Pages** 项目 `bookmark-demo-lab`（Direct Upload，经 `wrangler pages deploy` / GitHub Actions 发布；纯静态，无构建）。生产域名 **https://xdemo.chenerpath.com**（DNSPod CNAME → `bookmark-demo-lab.pages.dev`）。**每个 demo 一个 PR，一个 PR 一个预览**：PR 自动部署到 `https://pr-<号>.bookmark-demo-lab.pages.dev` 并回帖链接。

唯一例外：静态 Pages **无法按 IP 做「每窗一票」**，因此本仓库附带 **一个** Worker + KV（`workers/ballot-api/`）：`GET/POST /api/vote`、窗快照、以及 **Cloudflare Workers Cron Triggers** 的 slim 转窗。不要再加第二个 Worker 或 Pages Function。仓库里是 `wrangler.toml.example`，避免 Pages 误走 Workers Builds。

## 10 分钟投票轮转（上海）

Captain 产品节拍默认 **Asia/Shanghai、`voteWindowMinutes=10`**（写在 `tracking/rotate-config.json`）：`closesAt = opensAt + 10 分钟`。窗在时区内按该时长 **向下取整对齐**（不再读 `slotHours`）。Worker Cron **每 10 分钟**（UTC `*/10 * * * *`）结算刚关闭的窗。旧的 **8 小时整点窗**（`periodHours=8`、cron `0 0,8,16 * * *`）只作为遗留字段保留，**不再是主叙事**。

每个 beat：

1. **结算刚结束的投票窗**（Worker Cron 读 KV 计票）→ 选出下一场演示的燃料 / harness / 7×24。零票则 `winningStack.autoPick=true`，编排器从军火库 **active** 项自选。
2. **打开下一 10 分钟窗** 写入 KV（即使 `candidates=[]`）。空候选时 **隐藏投票 UI 不在本 Worker 分支**：见 Hub UI 分支 `hub/v2-ui-realtime`（合并 `main` 后才出现在 `index.html`）。X 书签增量与 git 同步 **不在 Worker 内执行**；只置 `rotate-status.needsXIngest` / `needsGitPush` 给后续 harness。候选项主线是 Firstmate X MCP slim ingest（**不要** `X_BEARER_TOKEN`），**绝不伪造书签**。

### 配置旋钮（`tracking/rotate-config.json`）

| 字段 | 说明 |
| --- | --- |
| `timezone` | `Asia/Shanghai` |
| `voteWindowMinutes` | **主字段**（rotate-config 提供）；`closesAt` 以此为准。Worker 冷启动未拉到配置时**不用** 10 分钟，而用 `periodHours` |
| `periodHours` | 遗留；无有效 `voteWindowMinutes` 时 Worker/python 用 `periodHours * 60` 分钟 |
| `slotHours` | 遗留、**不再参与开窗**。窗按上海时钟对 `voteWindowMinutes`（或 `periodHours*60`）向下取整对齐 |
| `voteApiBase` | Vote Worker 根 URL，如 `https://ballot-api.<account>.workers.dev`。空字符串表示走同源 `/api/vote`（需在 **现有** Pages 主机绑路由） |

### 枢纽投票 UX

- 区块标题：**待投票 / 本窗方案**。候选项与计划预览来自 `ballot-window.json`；燃料 / harness / 7×24 **只列出军火库 active**（planned 不可投）。
- 访客 **无需登录**，在页面上直接选三项（可选「优先哪个候选」）后 POST 到 Vote Worker。
- 提交成功后写入 `localStorage` 回执。同一公网 IP 每个 `windowId` 只能成功一次（Worker + KV 强制）；另有每分钟请求上限与数秒冷却。轻量指纹只作辅助，不是登录。
- **禁止** GitHub Issue / 评论当票箱，也 **没有** 站外提交 X 链接的表单。
- 实时计票来自 `GET /api/vote`；接口未绑定时只读 `vote-ledger.json`。

### Vote Worker + KV

后端 = **1 个 Worker（`ballot-api`）+ 1 个 KV（`ballot-votes`）**：`GET/POST /api/vote`、窗快照、Workers Cron 转窗（`*/10 * * * *` UTC）。源码 `workers/ballot-api/src/index.js`。

部署走 GitHub Actions（`.github/workflows/deploy-worker.yml`）：`workers/ballot-api/**` 一变就 `wrangler deploy`；`wrangler.toml` 不进仓库（CI 内现场生成：KV `ballot-votes` id、`[vars] ORIGIN=https://xdemo.chenerpath.com`、`RAW_BASE` 指向 GitHub raw）。CORS 只放行生产域名 + localhost。

两个 Worker secrets（`VOTE_SALT`、`BALLOT_ADMIN_TOKEN`）只活在 Cloudflare 侧，**不要**写进仓库；`tracking/rotate-config.json` 的 `voteApiBase` 指向 `https://ballot-api.chenhuitf2.workers.dev`（无尾斜杠），枢纽跨域 POST 靠它。

| 资源 | 名称 | 数量 |
| --- | --- | --- |
| Worker | `ballot-api` | **1** |
| KV namespace | `ballot-votes`（binding `BALLOT_KV`） | **1** |
| Cron Trigger | UTC `*/1 * * * *`（每分钟；旧 8h `0 0,8,16 * * *` 已弃用为主路径） | 挂在上述 Worker 上 |
| 路由 | `https://ballot-api.<account>.workers.dev` | workers.dev，不要自定义域 |
| 可选同源 | 在 **已有** Pages 主机加 Worker 路由 `…pages.dev/api/*`，然后 `voteApiBase=""` | 仍是这一个 Worker |

**IP 去重：** `POST /api/vote` 读取 `CF-Connecting-IP`，与 `windowId` + `VOTE_SALT` 做 SHA-256，KV 键 `voted:{windowId}:{hash}` 命中则 `409 already_voted`。原始 IP 不入库。可选 `fingerprint`（浏览器 UUID）同样哈希后写入 `fp:{windowId}:…`。计票 JSON 在 `tally:{windowId}`。

Worker CORS **只允许** `ORIGIN`（wrangler `[vars]`）与 `localhost` / `127.0.0.1`，不含 `*.pages.dev` 通配。`VOTE_SALT` 未设置时 POST 直接 `503 misconfigured`。

### Cron（Cloudflare Workers Cron Triggers，主路径）

调度在 **Cloudflare Workers Cron Triggers** 上，表达式 UTC `*/1 * * * *`（每分钟），以便赶上 10 分钟窗的 `closesAt`。旧 8h 表达式 `0 0,8,16 * * *` 不再作为主路径。**不是**本机 crontab，**不是** Grok Bot。

`scheduled` 只做 CPU 很轻的事（Free 约 10ms）：KV 读写 + `fetch` Pages / GitHub raw 的 `rotate-config.json` / `arsenal.json` / `ballot-window.json`。`voteWindowMinutes` 以 rotate-config（拉取或 KV 缓存）为准，`closesAt = opensAt + voteWindowMinutes`。结算语义与 `scripts/rotate-beat.py` 相同，但：

- 计票直接读 KV `tally:{windowId}`（不 HTTP 自己、不 `gh issue`）
- 账本与下一窗快照写 KV（`vote-ledger`、`current-window`）
- **不**跑 agy、git、X 抓取、重演示构建
- 若还需要 X ingest / git push，只写 KV `rotate-status`（`needsGitPush` / `needsXIngest`）给后续 harness。**skip / lock / 失败不会清掉这些标志**；harness 完成后 `POST /api/rotate-status/ack`（Bearer `BALLOT_ADMIN_TOKEN`，body 里把对应字段设为 `false`）。

改 `voteWindowMinutes` 后确认 `wrangler.toml` 的 cron 仍足够密（10 分钟窗用 `*/1 * * * *`），然后在本机 `npx wrangler deploy` **同一个** `ballot-api`（不要新开 Worker 项目）。**部署顺序：** 先让 Pages / `main` 提供带 `voteWindowMinutes: 10` 的 `tracking/rotate-config.json`，再（或同时）redeploy Worker。Worker 冷启动 `defaultConfig` 在拉不到配置、KV 也没有缓存时仍用遗留 `periodHours=8`，**不会**在缺配置时偷偷按 10 分钟 bootstrap。

管理员可 `POST /api/rotate`（Bearer `BALLOT_ADMIN_TOKEN`）手动跑同一套 slim 转窗。`scripts/rotate-beat.py` 仅作回退：Worker **严格超前** git 时才 `GET /api/window` + `/api/ledger` 写入 tracking JSON 并在 **commit+push 成功后** ack `needsGitPush`；git 超前时不覆盖 JSON，可 PUT 回 Worker。Cron 故障时才自己 settle。详见 `scripts/rotate-beat.md`。

Harness 清标志：

```bash
curl -X POST "$VOTE_API_BASE/api/rotate-status/ack" \
  -H "Authorization: Bearer $BALLOT_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"needsGitPush":false,"needsXIngest":false}'
```

python 回退路径：Vote API 失败或 `voteApiBase` 为空则 **中止**（非零退出），不会写成零票 `autoPick` 并推进下一窗。

## 中文界面约定

- **枢纽页与各应用的用户可见文案一律中文**（导航、标题、按钮、占位符、aria-label、页脚等）。
- URL、slug、HTML `id`、`data-*`、文件路径保持英文，以便预览路径稳定。
- 枢纽卡片按 **`processedAt` 倒序**（最新在上）。根页运行时读取 `tracking/seen-bookmarks.json` 渲染；新增演示追加 tracking 即可，不必再改枢纽卡片或页脚链接。
- 每张卡片带「原帖」次要按钮，指向该条的 `url`（X 书签），主点击仍进入 `/apps/<slug>/`。
- 可选展示字段：`hubTitle`（枢纽短标题）、`blurbZh`（一行简介）。缺省时用 `titleZh`。
- **技术栈与溯源标签（可选字段，严格对齐军火库三层顺序：燃料 → harness → 7×24）**：
  - **第一层 · 燃料 (`tag-fuel`)**：`subscriptionZh` 与 `modelZh`（若两者皆有，合并为一个标签展示，如「`Cursor Ultra · grok-4.6`」；title/aria 标为「燃料」；不单独渲染独立的「模型」标签；亦支持直接配置 `fuelZh` / `fuel`）。
  - **第二层 · 运行载体 (`tag-harness`)**：`harnessZh`（或英文别名 `harness`），如 `Cursor Cloud Agent`。
  - **第三层 · 7×24 环境 (`tag-env`)**：`environmentZh`（或别名 `environment` / `cloudZh` / `cloud`），如 `Cursor Cloud Agent 托管机`。
  - 枢纽卡片严格按 **燃料 → harness → 7×24 环境** 顺序渲染小胶囊标签；空缺项自动隐藏；标签文本、独立字段及 `hubTitle` 均纳入即时搜索匹配。
- 不要为预览绑定自定义域名。

### 追踪记录字段规范 (`tracking/seen-bookmarks.json`)

| 字段 (Field) | 类型 (Type) | 必选/可选 | 说明与约定 (Description & Notes) |
| --- | --- | --- | --- |
| `id` | string | 推荐 | X / 原平台唯一推文或书签 ID |
| `url` | string | 必选 | 原帖完整 URL（卡片次要按钮「原帖」跳转地址） |
| `slug` | string | 必选 | 应用目录名，对应 `/apps/<slug>/` |
| `title` | string | 可选 | 原始英文或外文标题 |
| `titleZh` | string | 必选 | 中文完整标题 |
| `hubTitle` | string | 可选 | 枢纽卡片主标题；缺省时自动截取 `titleZh` 前缀 |
| `blurbZh` | string | 可选 | 枢纽卡片中文一行简介 |
| `author` | string | 可选 | 原帖作者用户名 / handle |
| `processedAt` | string | 必选 | ISO 8601 时间戳（如 `2026-09-15T02:56:00.000Z`），枢纽按此倒序排列 |
| `path` | string | 可选 | 自定义路径，缺省为 `/apps/<slug>/` |
| `subscriptionZh` / `subscription` | string | 可选 | 订阅级别（如 `Cursor Ultra`），与 `modelZh` 合并展示在第一层「燃料」胶囊（如「`Cursor Ultra · grok-4.6`」） |
| `modelZh` / `model` | string | 可选 | 驱动模型（如 `grok-4.6`、`composer-2.5`），合并于燃料标签展示，不单设独立中间模型标签 |
| `harnessZh` / `harness` | string | 可选 | 云端运行载体 / harness（如 `Cursor Cloud Agent`），展示为第二层「harness」胶囊 |
| `environmentZh` / `environment` | string | 可选 | 7×24 常驻环境（如 `Cursor Cloud Agent 托管机`，支持别名 `cloudZh`/`cloud`），展示为第三层「7×24」胶囊 |

### 军火库目录规范 (`tracking/arsenal.json`)

`tracking/arsenal.json` 驱动根枢纽下方的「军火库」总览。纯目录清单风格（不搞剩余百分比或倒计时等虚浮指标）；**额度明细由 CodexBar 负责，枢纽只做总览与标签**。三段式结构：

1. **燃料 (fuel)**：高性价比（≤~$20）或前沿免费选项，如 `Cursor Ultra`、`Google AI Pro · Antigravity / alphatradebot`、`OpenRouter 前沿免费`，以及规划中（planned）的备选工具。
2. **运行载体 (harness)**：官方优先的执行载体，如 `Cursor Cloud Agent`、`Cursor CLI`、`agy / Antigravity`，以及 OpenRouter 侧的 `pi` harness。
3. **7×24 环境 (environment)**：常驻云环境，如 `Cursor Cloud Agent 托管机`、`Grok Bot 云电脑`、`自购 VPS / 便宜 KVM`（如 Vultr 现作梯子，可按需随时另开独立 Agent 专用机）。

**不要在枢纽或本文件里编造单价 / 套餐报价。** `≤~$20` 与「前沿免费」是分层标签，不是商品标价。

**Schema 结构与字段说明**：

| 字段 | 类型 | 必选/可选 | 说明 |
| --- | --- | --- | --- |
| `version` | number | 必选 | 配置版本号（目前为 1） |
| `updatedAt` | string | 必选 | ISO 8601 更新时间戳 |
| `overviewZh` | string | 可选 | 三层总览一句 |
| `quotaBoardZh` | string | 可选 | 配额看板名称（如 `CodexBar`） |
| `quotaNoteZh` | string | 可选 | 提醒额度细节不在枢纽展示 |
| `sections` | array | 必选 | 分组列表（燃料、运行载体、7×24 环境） |
| `sections[].id` | string | 必选 | 分组唯一标识（`fuel` / `harness` / `environment`） |
| `sections[].titleZh` | string | 必选 | 分组中文标题 |
| `sections[].kickerZh` | string | 可选 | 分组短标签（如 `官方 / pi`） |
| `sections[].blurbZh` | string | 可选 | 分组简要副标题说明 |
| `sections[].items` | array | 必选 | 组内收录的技术项列表 |
| `items[].nameZh` | string | 必选 | 工具 / 方案中文名称（投票选项以此为准，勿改 active 名） |
| `items[].status` | string | 必选 | 状态：`active`（当前启用，高亮绿标）或 `planned`（规划中，弱化展示） |
| `items[].kind` | string | 可选 | 角色：`subscription` / `free-frontier` / `official` / `pi` / `cloud-agent` / `vps-kvm` / `planned` 等 |
| `items[].bandZh` | string | 可选 | 分层标签（高性价比 / 前沿免费 / 官方 / pi），**不是价格** |
| `items[].noteZh` | string | 可选 | 角色说明与使用方式备注 |
| `items[].tags` | string[] | 可选 | 枢纽胶囊标签 |

**容错约定**：
- 静态页面通过 `fetch("./tracking/arsenal.json")` 异步渲染；
- 若文件缺失或加载异常，模块保持隐藏（fail soft），不影响上方演示卡片正常浏览与检索。

## 当前演示

| 路径 | 来源 |
| --- | --- |
| [`/apps/gsap-canvas/`](apps/gsap-canvas/) | [审美三件套：Product Design × GSAP × Canvas UI](https://x.com/BTCqzy1/status/2099440427841597573) |
| [`/apps/clapper/`](apps/clapper/) | [Clapper 开场页氛围](https://x.com/kunchenguid/status/2099627078660624419) |
| [`/apps/llm-arch-3d/`](apps/llm-arch-3d/) | [大模型架构立体小卡](https://x.com/bbruceyuan/status/2098785251455877338) |
| [`/apps/remotion-tear/`](apps/remotion-tear/) | [Codex+Remotion 怀旧撕纸短片](https://x.com/xl_lottie/status/2099342984433324435) |
| [`/apps/obsidian-ui/`](apps/obsidian-ui/) | [ObsidianUI 组件库氛围](https://x.com/dhruvtwt_/status/2099548790470640118) |

## 部署现状（2026-09-19 起，全部自动化）

- **Pages 项目** `bookmark-demo-lab` 已存在（Direct Upload，**不走** Connect to Git / GitHub App 授权）。
- `.github/workflows/deploy-pages.yml`：push `main`（`tracking/**` 除外）→ 生产部署；PR → 预览部署 `https://pr-<号>.bookmark-demo-lab.pages.dev` 并自动回帖链接。
- `.github/workflows/deploy-worker.yml`：`workers/ballot-api/**` 变更 → `wrangler deploy`。
- `.github/workflows/sync-harness.yml`：每 15 分钟跑 `scripts/rotate-beat.py`，把 KV 窗快照同步进 `tracking/` 并 push（`tracking/**` 的提交不触发 Pages 重部署，避免部署刷屏）。
- 生产域名 **https://xdemo.chenerpath.com**（DNSPod CNAME → `bookmark-demo-lab.pages.dev`，Pages 侧已绑自定义域）。
- 仓库 Secrets：`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`（已配）。

预览时检查：`/`（枢纽，含「待投票」）、`/apps/gsap-canvas/`、`/apps/clapper/`、`/apps/llm-arch-3d/`、`/apps/remotion-tear/` 和 `/apps/obsidian-ui/`。
## Agent 工作流

1. Cloud Agent 切分支（始终同一仓库，不要一演示一仓库）
2. 新增 `apps/<slug>/`，追加 `tracking/seen-bookmarks.json`（`url`、`slug`、`titleZh`、`processedAt`，建议带 `hubTitle` / `blurbZh`）。枢纽会按时间倒序自动列出，并带上「原帖」链接。
3. 把静态文件（或构建产物）推到 `apps/<slug>/`
4. Firstmate 读取 Pages 预览地址并通知 captain

## 本地

在仓库根目录起任意静态服务，这样 `/apps/<slug>/` 才能解析：

```bash
python3 -m http.server 4173
```

然后打开 `/`、`/apps/gsap-canvas/`、`/apps/clapper/`、`/apps/llm-arch-3d/`、`/apps/remotion-tear/` 和 `/apps/obsidian-ui/`。
