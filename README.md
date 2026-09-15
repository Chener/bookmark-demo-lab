# bookmark-demo-lab

Daily tech demos from X bookmarks → branch → **Cloudflare Pages preview URL**.

One repo, many standalone apps. The root page is a light hub; each demo lives under `apps/<slug>/` and can be opened on its own.

## Layout

```
apps/<slug>/                 # one self-contained demo per pick
tracking/seen-bookmarks.json # ids/urls already turned into apps
index.html                   # hub that links to /apps/<slug>/
```

Static-first for Cloudflare Pages (framework None, empty build, output `/`). Do not add Workers, wrangler.toml, custom domains, or extra CF projects.

## Current demos

| Path | Source |
| --- | --- |
| [`/apps/obsidian-ui/`](apps/obsidian-ui/) | [ObsidianUI component library vibe](https://x.com/dhruvtwt_/status/2099548790470640118) |

## Cloudflare Pages setup (one-time)

1. Open [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**
2. Authorize GitHub, select repo **`Chener/bookmark-demo-lab`**
3. Build settings:
   - **Framework preset:** None / Vite if using Vite later
   - **Build command:** (leave empty for plain static) or `npm run build`
   - **Build output directory:** `/` for static root, or `dist` for Vite
4. Under **Settings → Builds & deployments → Branch deployments**:
   - Production branch: `main`
   - **Preview deployments:** enable for all non-production branches (default on most accounts)
5. Save. Every push to a new branch gets a URL like:
   `https://<branch-name>.bookmark-demo-lab-<hash>.pages.dev`

Preview paths to check: `/` (hub) and `/apps/obsidian-ui/`.

## Agent workflow

1. Cloud Agent cuts a branch (keep one repo — never one repo per demo)
2. Adds `apps/<slug>/`, updates the hub, appends `tracking/seen-bookmarks.json`
3. Pushes static (or built-to-static) files under `apps/<slug>/`
4. Firstmate reads the Pages preview URL and messages the captain

## Local

Serve the repo root with any static server so `/apps/<slug>/` resolves:

```bash
python3 -m http.server 4173
```

Then open `/` and `/apps/obsidian-ui/`.
