# bookmark-demo-lab

从 X 书签出发的日常技术演示：切分支 → 获得 **Cloudflare Pages 预览地址**。

一个仓库、多套独立应用。根目录 `index.html` 是轻量枢纽；每个演示放在 `apps/<slug>/`，可单独打开。

## 布局

```
apps/<slug>/                      # 每个选题一个自包含演示
tracking/seen-bookmarks.json      # 已做成应用的 id / url / 技术栈；枢纽运行时读取
tracking/arsenal.json             # 军火库：燃料 / harness / 7×24（仅 active 可投票）
tracking/rotate-config.json       # 轮转：时区、periodHours、slotHours、voteApiBase
tracking/ballot-window.json      # 当前投票窗 + 待投票候选 + 可选项
tracking/vote-ledger.json         # 上一窗结算账本（winningStack / autoPick）
workers/ballot-api/               # 唯一后端：投票 Worker + KV（源码；需单独 deploy）
scripts/rotate-beat.sh            # 云电脑 cron 入口
index.html                        # 枢纽：卡片 + 待投票 + 军火库 + 原帖
```

枢纽与演示仍是 **静态 Cloudflare Pages**（Framework preset: None，构建命令留空，输出目录 `/`）。不要自定义域名、CNAME、Workers Builds，也不要另开 Pages/Workers 项目。

唯一例外：静态 Pages **无法按 IP 做「每窗一票」**，因此本仓库附带 **一个** Worker + KV（`workers/ballot-api/`），只服务 `GET/POST /api/vote`（及 cron 用的 `PUT /api/window`）。不要再加第二个 Worker 或 Pages Function。仓库里是 `wrangler.toml.example`，避免 Pages 误走 Workers Builds。

## 8 小时投票轮转（上海）

Captain 产品节拍默认 **Asia/Shanghai、periodHours=8**，整点窗 **00:00 / 08:00 / 16:00**。`periodHours` 允许改为 **2** 或 **1**（同时改 `slotHours` 与 cron）。

每个 beat 同时：

1. **结算刚结束的投票窗** → 按 Worker 计票选出下一场演示的燃料 / harness / 7×24（燃料名里若带模型，由编排器解析）。零票则 `winningStack.autoPick=true`，编排器从军火库 **active** 项自选。
2. **摄入刚结束时段的 X 书签增量** 到枢纽「待投票」，并带自动起草的演示计划预览；该名单是下一窗的选票。无 X 凭证则 `candidates=[]`，**绝不伪造书签**。

### 配置旋钮（`tracking/rotate-config.json`）

| 字段 | 说明 |
| --- | --- |
| `timezone` | `Asia/Shanghai` |
| `periodHours` | 默认 `8`；允许 `2` 或 `1` |
| `slotHours` | 默认 `[0, 8, 16]`。2h 用偶数点，1h 用 `0..23` |
| `voteApiBase` | Vote Worker 根 URL，如 `https://ballot-api.<account>.workers.dev`。空字符串表示走同源 `/api/vote`（需在 **现有** Pages 主机绑路由） |

### 枢纽投票 UX

- 区块标题：**待投票 / 本窗方案**。候选项与计划预览来自 `ballot-window.json`；燃料 / harness / 7×24 **只列出军火库 active**（planned 不可投）。
- 访客 **无需登录**，在页面上直接选三项（可选「优先哪个候选」）后 POST 到 Vote Worker。
- 提交成功后写入 `localStorage` 回执。同一公网 IP 每个 `windowId` 只能成功一次（Worker + KV 强制）；另有每分钟请求上限与数秒冷却。轻量指纹只作辅助，不是登录。
- **禁止** GitHub Issue / 评论当票箱，也 **没有** 站外提交 X 链接的表单。
- 实时计票来自 `GET /api/vote`；接口未绑定时只读 `vote-ledger.json`。

### Vote Worker + KV（最小后端）

源码：`workers/ballot-api/src/index.js`。绑定与部署（在本机/云电脑，**不要**从 Pages 再开项目）：

```bash
cd workers/ballot-api
cp wrangler.toml.example wrangler.toml   # 已 gitignore，勿提交
npx wrangler kv namespace create ballot-votes
# 把返回的 id 写入 wrangler.toml 的 kv_namespaces.id
# wrangler.toml [vars] ORIGIN = 现有 Pages 生产 URL
npx wrangler secret put VOTE_SALT
npx wrangler secret put BALLOT_ADMIN_TOKEN
npx wrangler deploy
```

| 资源 | 名称 |
| --- | --- |
| Worker | `ballot-api` |
| KV namespace | `ballot-votes`（binding `BALLOT_KV`） |
| 路由 | `https://ballot-api.<account>.workers.dev/api/vote` |
| 可选同源 | 在 **已有** Pages 主机加 Worker 路由 `…pages.dev/api/*`，然后 `voteApiBase=""` |

**IP 去重：** `POST /api/vote` 读取 `CF-Connecting-IP`，与 `windowId` + `VOTE_SALT` 做 SHA-256，KV 键 `voted:{windowId}:{hash}` 命中则 `409 already_voted`。原始 IP 不入库。可选 `fingerprint`（浏览器 UUID）同样哈希后写入 `fp:{windowId}:…`。计票 JSON 在 `tally:{windowId}`。

把 Worker URL 写入 `tracking/rotate-config.json` 的 `voteApiBase`（不要尾斜杠），推 `main` 后枢纽即可跨域 POST。Worker CORS **只允许** `ORIGIN`（wrangler `[vars]`）与 `localhost` / `127.0.0.1`，不含 `*.pages.dev` 通配。`VOTE_SALT` 未设置时 POST 直接 `503 misconfigured`。

Cron 结算：Vote API 失败或 `voteApiBase` 为空则 **中止**（非零退出），不会写成零票 `autoPick` 并推进下一窗。

### Cron（云电脑，不是 Grok Bot）

详见 `scripts/rotate-beat.md`。机器 `TZ=Asia/Shanghai`：

```cron
0 0,8,16 * * * cd /path/to/bookmark-demo-lab && git pull --ff-only origin main && ./scripts/rotate-beat.sh >> /var/log/rotate-beat.log 2>&1
```

UTC 等价（`00:00/08:00/16:00` UTC ≡ `08:00/16:00/00:00` 上海）：

```cron
0 0,8,16 * * * cd /path/to/bookmark-demo-lab && git pull --ff-only origin main && ./scripts/rotate-beat.sh >> /var/log/rotate-beat.log 2>&1
```

结算走 `GET {voteApiBase}/api/vote`，**不**调用 `gh issue`。

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

`tracking/arsenal.json` 驱动根枢纽下方的「军火库 · 当前在用」目录模块。纯目录清单风格（不搞剩余百分比或倒计时等虚浮指标），采用三段式结构：

1. **燃料 (fuel)**：高性价比（≤~$20）或前沿免费选项，如 `Cursor Ultra`、`Google AI Pro · Antigravity / alphatradebot`、`OpenRouter 前沿免费`，以及规划中（planned）的备选工具。
2. **运行载体 (harness)**：官方优先的执行载体，如 `Cursor Cloud Agent`、`Cursor CLI`、`agy / Antigravity`，以及 OpenRouter 侧的 `pi`。
3. **7×24 环境 (environment)**：常驻云环境，如 `Cursor Cloud Agent 托管机`、`Grok Bot 云电脑`、`自购 VPS / 便宜 KVM`（如 Vultr 现作梯子，可按需随时另开独立 Agent 专用机）。

**Schema 结构与字段说明**：

| 字段 | 类型 | 必选/可选 | 说明 |
| --- | --- | --- | --- |
| `version` | number | 必选 | 配置版本号（目前为 1） |
| `updatedAt` | string | 必选 | ISO 8601 更新时间戳 |
| `sections` | array | 必选 | 分组列表（燃料、运行载体、7×24 环境） |
| `sections[].id` | string | 必选 | 分组唯一标识（`fuel` / `harness` / `environment`） |
| `sections[].titleZh` | string | 必选 | 分组中文标题 |
| `sections[].blurbZh` | string | 可选 | 分组简要副标题说明 |
| `sections[].items` | array | 必选 | 组内收录的技术项列表 |
| `items[].nameZh` | string | 必选 | 工具 / 方案中文名称 |
| `items[].status` | string | 必选 | 状态：`active`（当前启用，高亮绿标）或 `planned`（规划中，弱化展示） |
| `items[].noteZh` | string | 可选 | 角色说明与使用方式备注 |

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

## Cloudflare Pages 一次性配置

1. 打开 [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**
2. 授权 GitHub，选择仓库 **`Chener/bookmark-demo-lab`**
3. Build settings:
   - **Framework preset:** None / 以后若用 Vite 再选 Vite
   - **Build command:** 纯静态留空，或 `npm run build`
   - **Build output directory:** 静态根目录填 `/`，Vite 则填 `dist`
4. 在 **Settings → Builds & deployments → Branch deployments**：
   - Production branch: `main`
   - **Preview deployments:** 对所有非生产分支开启（多数账号默认已开）
5. 保存。之后每次推送新分支都会得到类似地址：
   `https://<branch-name>.bookmark-demo-lab-<hash>.pages.dev`

预览时检查：`/`（枢纽，含「待投票」）、`/apps/gsap-canvas/`、`/apps/clapper/`、`/apps/llm-arch-3d/`、`/apps/remotion-tear/` 和 `/apps/obsidian-ui/`。Vote Worker 是独立最小后端，不要从 Pages 再开第二个项目。

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
