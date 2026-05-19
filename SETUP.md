# Hidden Finds — Deployment Guide

A personal atlas of secret places. Browse and pin walks/finds on a map, with every save committed as a git commit on GitHub. Same architecture as the cookbook: token lives in a Netlify Function, never in the browser; one password gates writes; reads are open to anyone with the URL.

## Repo structure

```
hiddenfinds/
├── index.html                       ← the whole app (single file)
├── netlify.toml                     ← Netlify build config
├── data/
│   └── pins.json                    ← the database (100 pins imported from CSV)
├── netlify/
│   └── functions/
│       └── save-pin.js              ← write proxy → commits to GitHub
├── scripts/
│   └── import-csv.py                ← optional: re-import from a fresh Google Maps CSV
└── SETUP.md                         ← this file
```

## Deployment, step by step

### 1. Put it on GitHub

```bash
cd hiddenfinds
git init
git add .
git commit -m "Initial commit"
gh repo create hiddenfinds --public --source=. --push   # or push to a repo you've created manually
```

The repo can be public or private — readers don't talk to GitHub directly, the function does.

### 2. Connect the repo to Netlify

Netlify dashboard → **Add new site → Import an existing project** → pick the repo.

- Build command: *(leave empty)*
- Publish directory: `.`
- Functions directory: `netlify/functions` *(auto-detected from `netlify.toml`)*

Let the first deploy run. The site will load and the map will appear, but adding pins won't work yet — the function needs env vars (next step).

### 3. Generate the GitHub token

GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.

- Resource owner: your account
- Repository access: **Only selected repositories** → pick the `hiddenfinds` repo
- Repository permissions: **Contents: Read and write**
- Expiry: as long as you're comfortable with (max 1 year on fine-grained)

Copy the token immediately — it's shown once.

### 4. Set Netlify env vars

Netlify site → **Site configuration → Environment variables** → add four:

| Variable          | Value                                     |
|-------------------|-------------------------------------------|
| `GITHUB_TOKEN`    | The fine-grained PAT from step 3          |
| `GITHUB_REPO`     | `owner/hiddenfinds` (your GitHub username + repo name) |
| `GITHUB_BRANCH`   | `main` *(optional — defaults to `main`)*  |
| `ADMIN_PASSWORD`  | Whatever you want to use to gate writes   |

Then **Deploys → Trigger deploy → Deploy site** so the function picks up the new env vars.

### 5. (Optional) Custom subdomain

Netlify **Domain management → Add custom domain** → e.g. `finds.yourdomain.com`. Add a CNAME at your DNS host pointing to `<site>.netlify.app`. HTTPS auto-provisions.

## Using it

- Visit the live URL — the map loads with all 54 located pins from your CSV, and a "To locate" section in the sidebar lists the 46 pins that only had Google place IDs.
- Tap **+** (bottom right) → tap on the map to drop a new pin → fill the form → Save.
- Tap an existing pin → **Edit** to change anything, including the coordinates.
- For unlocated pins: open the sidebar (☰), find the pin under **To locate**, tap → tap on the map to set its coordinates → save.
- First save of the session prompts for `ADMIN_PASSWORD`; it's cached in `localStorage` until you clear browser data.

## How a save becomes a commit

1. Browser POSTs `{ pin, password }` (or `{ deleteId, password }`) to `/api/save-pin`.
2. Function constant-time-compares the password against `ADMIN_PASSWORD`.
3. Function reads the current `data/pins.json` from the repo.
4. Function applies the add/update/delete in memory and re-sorts the array.
5. Function uses the GitHub **Git Data API** to:
   - Create a blob for the new `data/pins.json` content
   - Build a tree containing it, parented on the current tree
   - Create a commit (`"Add pin: Brown's Folly"` / `"Update pin: …"` / `"Remove pin: …"`)
   - Fast-forward `refs/heads/main` to the new commit
6. Function returns the updated array; the UI updates instantly.
7. Netlify rebuilds the static site ~30–60s later so other devices see the change.

## Reimporting a fresh CSV

If you export a newer "Saved places" CSV from Google Maps, drop it into the repo and run:

```bash
python scripts/import-csv.py path/to/new-export.csv
```

The script **merges** by stable ID — pins you've manually edited keep their edits, only genuinely new rows are appended. Commit the resulting `data/pins.json` change and push.

## Security notes

- The site is **publicly readable**. Anyone with the URL can browse pins.
- Writes require `ADMIN_PASSWORD`. The GitHub token never reaches the browser; it lives only in Netlify's env vars.
- 401 responses clear the cached password so a typo doesn't lock the device.
- Rotate `GITHUB_TOKEN` when it expires; update the env var; redeploy. No code change required.

## Troubleshooting

- **"Server not configured: GITHUB_TOKEN missing"** → one of the env vars is unset. Check all four, then redeploy.
- **"Bad password"** → `ADMIN_PASSWORD` doesn't match what you typed. Browser storage is cleared on a 401, so just try again.
- **GitHub 401/403 in function logs** → PAT is wrong, expired, or doesn't have Contents: Write on the right repo.
- **Saved but the map on another device still shows old pins** → wait for Netlify's rebuild (Deploys tab shows it in progress). Your own device sees the change immediately because the function returns the updated array.
- **Map tiles look slow or rate-limited** → the default Carto tiles allow generous personal use, but if you hit limits you can swap the URL in `index.html` (search for `cartocdn.com`) for another OSM-based provider.

## Growth notes

Each pin is ~250–500 bytes in `pins.json`. A few thousand pins is fine in a single file. If you ever cross ~10,000 pins, the front-end will still cope but you may want to switch to clustered markers (Leaflet.markercluster) — about 20 lines of JS to add.
