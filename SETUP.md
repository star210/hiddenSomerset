# Hidden Finds — setup

A personal atlas of walks and secret places, hosted on Netlify with data committed live to GitHub.

## How it works

- The static site is published from the repo root by Netlify.
- All data — walks, loose pins, photos — lives in the same repo:
  - `data/pins.json` : the walks + pins store
  - `photos/*.jpg`   : uploaded photos
- The single Netlify Function at `/api/save-pin` writes new commits to the GitHub repo on your behalf using a fine-grained PAT. Every save = one atomic GitHub commit. Netlify then auto-rebuilds and the change is live in ~30s.

## Data model

```
{
  "walks": [
    {
      "id": "w_xxxx",
      "name": "Cheddar Gorge North Rim",
      "description": "Moderate walk through limestone scenery…",
      "difficulty": "moderate",        // easy | moderate | hard | strenuous
      "distance_km": 6.2,
      "duration_min": 150,
      "terrain": "rocky, stiles",
      "toilets": "at car park",
      "mud": "boggy after rain",
      "parking": { "lat": 51.28, "lon": -2.76, "postcode": "BS27 3QF", "what3words": "trial.lake.boats" },
      "pois": [ { "id": "poi_xx", "title": "Lower viewpoint", "note": "…", "lat": …, "lon": …, "tags": ["viewpoint"] } ],
      "photos": [ "photo_…jpg" ],
      "url": ""
    }
  ],
  "pins": [
    { "id": "p_xxxx", "title": "…", "lat": …, "lon": …, "tags": […], "photos": […], … }
  ]
}
```

`walks` are the primary unit. `pins` is a flat list of loose pins (the 100 imported from your Google Maps CSV). You can leave them as loose pins or gradually pull them into walks.

### Tag set

`cave · waterfall · swimming · woodland · spring-well · viewpoint · historic · farmshops · holloway`

Each gets a colour on the map:
- well → blue · historic → brown · woodland → green · waterfall → light blue · cave → dark brown · swimming → teal · viewpoint → gold · farmshops → orange · holloway → sage

## Deploy

### 1. Push the repo to GitHub
```
git init
git add -A
git commit -m "Initial"
git remote add origin git@github.com:<you>/hiddenfinds.git
git push -u origin main
```

### 2. Create a fine-grained Personal Access Token
- github.com → Settings → Developer settings → Personal access tokens → Fine-grained tokens
- Resource owner: your account
- Repository access: only the `hiddenfinds` repo
- Permissions → Repository → **Contents: Read and Write**
- Copy the token (starts with `github_pat_…`). Treat it like a password.

### 3. Import to Netlify
- New site → Import from Git → pick `hiddenfinds`
- Build command: leave blank
- Publish directory: `/`
- Functions directory: `netlify/functions` (auto-detected from `netlify.toml`)
- Deploy

### 4. Set environment variables (Netlify → site → Settings → Environment variables)

| Key | Value |
|---|---|
| `GITHUB_TOKEN`     | the fine-grained PAT |
| `GITHUB_REPO`      | `<you>/hiddenfinds` |
| `GITHUB_BRANCH`    | `main` (optional, defaults to `main`) |
| `ADMIN_PASSWORD`   | a strong password you'll type into the sign-in box |

Redeploy after setting them so the function picks them up.

### 5. Use it
- Open the site
- Set your base location ("My location" or "Pick on map")
- Drag the "Explore within: X km" slider
- Switch tabs between **Walks** (primary) and **Loose pins** (the 100 imported)
- Click **+ New walk** → fill in name, description, terrain/toilets/mud, parking (postcode + what3words), add photos, add POIs
- The first save will prompt for your `ADMIN_PASSWORD`. It's stored in localStorage so you only sign in once per device.

## Photos

- Uploaded photos are resized to 1600px longest edge, JPEG quality 0.82, in the browser before upload.
- Max 8 per walk or pin per save.
- Each save commits the JSON change + new photo blobs together in one atomic GitHub commit.
- Removing a photo just drops the filename from the JSON; the blob stays in the repo (cheap, no garbage-collect needed).

## Build minute budget

A typical save = 1 GitHub commit = 1 Netlify build, which takes ~5-15 build minutes. Free tier gives you 300 build minutes/month, so you have headroom for ~20-60 saves per month at the upper estimate. If you hit the cap, either upgrade or batch edits into a single save.

## Importing more pins from a Google Maps CSV

```
python3 scripts/import-csv.py path/to/export.csv data/pins.json
```

The script merges new rows into the existing `pins` array, keyed by a stable ID, so re-running is idempotent.

## Troubleshooting

- **"Bad password"** → your `ADMIN_PASSWORD` env var doesn't match what you typed. Update it in Netlify and redeploy.
- **"GitHub … failed: 403"** → PAT lacks `Contents: Read and Write` on the right repo, or PAT expired.
- **Photos don't show after save** → wait ~30s for Netlify to rebuild from the new commit. Hard refresh.
- **Function returns 500** → check Netlify function logs for the real error.
