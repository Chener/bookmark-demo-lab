# bookmark-demo-lab

从 X 书签出发的日常技术演示：切分支 → 获得 **Cloudflare Pages 预览地址**。

一个仓库、多套独立应用。根目录 `index.html` 是轻量枢纽；每个演示放在 `apps/<slug>/`，可单独打开。

## 布局

```
apps/<slug>/                 # 每个选题一个自包含演示
tracking/seen-bookmarks.json # 已做成应用的 id / url
index.html                   # 枢纽，链到 /apps/<slug>/
```

静态优先，交给 Cloudflare Pages（Framework preset: None，构建命令留空，输出目录 `/`）。不要加 Workers、`wrangler.toml`、自定义域名或 CNAME，也不要另开 Cloudflare 项目。

## 中文界面约定

- **枢纽页与各应用的用户可见文案一律中文**（导航、标题、按钮、占位符、aria-label、页脚等）。
- URL、slug、HTML `id`、`data-*`、文件路径保持英文，以便预览路径稳定。
- 枢纽卡片按**倒序**（最新在上）。新演示插到 `index.html` 卡片列表最上方。
- 不要为预览绑定自定义域名。

## 当前演示

| 路径 | 来源 |
| --- | --- |
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

预览时检查：`/`（枢纽）、`/apps/clapper/`、`/apps/llm-arch-3d/`、`/apps/remotion-tear/` 和 `/apps/obsidian-ui/`。

## Agent 工作流

1. Cloud Agent 切分支（始终同一仓库，不要一演示一仓库）
2. 新增 `apps/<slug>/`，更新枢纽（新卡片置顶），追加 `tracking/seen-bookmarks.json`
3. 把静态文件（或构建产物）推到 `apps/<slug>/`
4. Firstmate 读取 Pages 预览地址并通知 captain

## 本地

在仓库根目录起任意静态服务，这样 `/apps/<slug>/` 才能解析：

```bash
python3 -m http.server 4173
```

然后打开 `/`、`/apps/clapper/`、`/apps/llm-arch-3d/`、`/apps/remotion-tear/` 和 `/apps/obsidian-ui/`。
