# bookmark-demo-lab

从 X 书签出发的日常技术演示：切分支 → 获得 **Cloudflare Pages 预览地址**。

一个仓库、多套独立应用。根目录 `index.html` 是轻量枢纽；每个演示放在 `apps/<slug>/`，可单独打开。

## 布局

```
apps/<slug>/                 # 每个选题一个自包含演示
tracking/seen-bookmarks.json # 已做成应用的 id / url / 技术栈；枢纽运行时读取
tracking/arsenal.json        # 军火库配置：当前在用与规划中的燃料、Harness 与环境
index.html                   # 枢纽：卡片网格 + 军火库 + 原帖链接
```

静态优先，交给 Cloudflare Pages（Framework preset: None，构建命令留空，输出目录 `/`）。不要加 Workers、`wrangler.toml`、自定义域名或 CNAME，也不要另开 Cloudflare 项目。

## 中文界面约定

- **枢纽页与各应用的用户可见文案一律中文**（导航、标题、按钮、占位符、aria-label、页脚等）。
- URL、slug、HTML `id`、`data-*`、文件路径保持英文，以便预览路径稳定。
- 枢纽卡片按 **`processedAt` 倒序**（最新在上）。根页运行时读取 `tracking/seen-bookmarks.json` 渲染；新增演示追加 tracking 即可，不必再改枢纽卡片或页脚链接。
- 每张卡片带「原帖」次要按钮，指向该条的 `url`（X 书签），主点击仍进入 `/apps/<slug>/`。
- 可选展示字段：`hubTitle`（枢纽短标题）、`blurbZh`（一行简介）。缺省时用 `titleZh`。
- **技术栈与溯源标签（可选字段）**：
  - `subscriptionZh`（或英文别名 `subscription`）：订阅级别，如 `Cursor Ultra`。
  - `modelZh`（或英文别名 `model`）：驱动模型，如 `grok-4.6`、`composer-2.5`；若历史记录不确定填 `模型未记录`。
  - `harnessZh`（或英文别名 `harness`）：云端 harness / 运行环境，如 `Cursor Cloud Agent`。
  - 枢纽卡片会自动为订阅、模型、云端 harness 渲染小胶囊标签（chips/tags）；空缺项自动隐藏；标签文本及 `hubTitle` 均纳入即时搜索匹配。
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
| `subscriptionZh` / `subscription` | string | 可选 | 订阅级别（如 `Cursor Ultra`），卡片展示为独立小胶囊 |
| `modelZh` / `model` | string | 可选 | 驱动模型（如 `grok-4.6`、`composer-2.5`；若不确定填 `模型未记录`） |
| `harnessZh` / `harness` | string | 可选 | 云端 harness / 运行环境（如 `Cursor Cloud Agent`） |

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

预览时检查：`/`（枢纽）、`/apps/gsap-canvas/`、`/apps/clapper/`、`/apps/llm-arch-3d/`、`/apps/remotion-tear/` 和 `/apps/obsidian-ui/`。

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
