# bookmark-demo-lab

Daily tech demos from X bookmarks → branch → **Cloudflare Pages preview URL**.

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

## Agent workflow

1. Cloud Agent cuts branch `demo/<slug>-YYYYMMDD`
2. Pushes static (or built) demo
3. Firstmate reads the Pages preview URL and messages the captain

## Local

Open `index.html` or serve the folder with any static server.
