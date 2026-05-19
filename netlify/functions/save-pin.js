// netlify/functions/save-pin.js
//
// One endpoint, several operations (dispatched by body shape):
//   { password, probe:true }                           validate password only
//   { password, pin, newPhotos? }                      add / update a loose pin
//   { password, deletePinId }                          delete a loose pin
//   { password, walk, newPhotos? }                     add / update a walk
//   { password, deleteWalkId }                         delete a walk
//
// Data file: data/pins.json
//   {
//     "walks": [ { id, name, description, difficulty, distance_km, duration_min,
//                  terrain, toilets, mud, parking:{lat,lon,postcode,what3words},
//                  photos:[], pois:[ {id,title,note,lat,lon,tags,photos} ],
//                  url, created, updated } ],
//     "pins":  [ { id, title, note, lat, lon, tags, url, photos, created, updated } ]
//   }
//
// Photos: each photo is a JPEG, committed to /photos/<name> in the same
// atomic commit as the data update.
//
// Required env vars: GITHUB_TOKEN, GITHUB_REPO, GITHUB_BRANCH (default "main"),
// ADMIN_PASSWORD.

const DATA_PATH = 'data/pins.json';
const PHOTOS_DIR = 'photos';
const MAX_NEW_PHOTOS_PER_REQUEST = 8;
const MAX_PHOTO_BASE64 = 2_300_000;
const PHOTO_NAME_RE = /^[A-Za-z0-9_-]{1,80}\.jpg$/;
const VALID_TAGS = new Set([
  'cave','waterfall','swimming','woodland','spring-well',
  'viewpoint','historic','farmshops','holloway'
]);
const DIFFICULTIES = new Set(['easy','moderate','hard','strenuous']);

export const config = { path: '/api/save-pin' };

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const env = {
    token:    process.env.GITHUB_TOKEN,
    repo:     process.env.GITHUB_REPO,
    branch:   process.env.GITHUB_BRANCH || 'main',
    password: process.env.ADMIN_PASSWORD,
  };
  for (const [k, v] of Object.entries(env)) {
    if (!v && k !== 'branch') return json({ error: `Server not configured: ${k} missing` }, 500);
  }

  let body;
  try { body = await req.json(); }
  catch { return json({ error: 'Bad JSON' }, 400); }

  if (!body || typeof body.password !== 'string' || !ctEq(body.password, env.password)) {
    return json({ error: 'Bad password' }, 401);
  }

  if (body.probe === true) return json({ ok: true });

  try {
    // Read current store
    const fileRes = await gh(env, `/contents/${DATA_PATH}?ref=${encodeURIComponent(env.branch)}`);
    let store = { walks: [], pins: [] };
    if (fileRes.status === 200) {
      const j = await fileRes.json();
      try {
        const parsed = JSON.parse(Buffer.from(j.content, 'base64').toString('utf-8'));
        if (Array.isArray(parsed)) store = { walks: [], pins: parsed };
        else if (parsed && typeof parsed === 'object') {
          store.walks = Array.isArray(parsed.walks) ? parsed.walks : [];
          store.pins  = Array.isArray(parsed.pins)  ? parsed.pins  : [];
        }
      } catch { /* keep empty */ }
    } else if (fileRes.status !== 404) {
      return json({ error: 'GitHub read failed: ' + fileRes.status }, 502);
    }

    // Validate any newPhotos and build extra file list for commit
    const acceptedPhotos = new Set();
    const newFiles = [];
    if (Array.isArray(body.newPhotos)) {
      if (body.newPhotos.length > MAX_NEW_PHOTOS_PER_REQUEST) {
        return json({ error: `Too many photos (max ${MAX_NEW_PHOTOS_PER_REQUEST})` }, 400);
      }
      for (const ph of body.newPhotos) {
        if (!ph || typeof ph.name !== 'string' || typeof ph.data !== 'string') continue;
        if (!PHOTO_NAME_RE.test(ph.name)) continue;
        if (ph.data.length > MAX_PHOTO_BASE64) continue;
        let raw;
        try { raw = Buffer.from(ph.data, 'base64'); }
        catch { continue; }
        if (raw.length < 4) continue;
        if (raw[0] !== 0xFF || raw[1] !== 0xD8 || raw[2] !== 0xFF) continue;
        acceptedPhotos.add(ph.name);
        newFiles.push({ path: `${PHOTOS_DIR}/${ph.name}`, base64: ph.data });
      }
    }

    let changedId = null;
    let commitMsg = '';

    // --- WALK OPERATIONS ---
    if (body.walk && typeof body.walk === 'object') {
      const incoming = sanitiseWalk(body.walk);
      if (!incoming.name) return json({ error: 'Walk name required' }, 400);

      const now = new Date().toISOString();
      const idx = incoming.id ? store.walks.findIndex(w => w.id === incoming.id) : -1;
      if (idx >= 0) {
        const prev = store.walks[idx];
        const prevPhotos = new Set(prev.photos || []);
        const keptPhotos = incoming.photos.filter(n => prevPhotos.has(n) || acceptedPhotos.has(n));
        store.walks[idx] = {
          ...prev,
          ...incoming,
          photos: keptPhotos,
          created: prev.created || now,
          updated: now,
        };
        changedId = incoming.id;
        commitMsg = `Update walk: ${truncate(incoming.name, 60)}`;
      } else {
        const id = incoming.id || newId(store.walks.map(w => w.id), 'w_');
        const photos = incoming.photos.filter(n => acceptedPhotos.has(n));
        store.walks.push({
          ...incoming,
          id,
          photos,
          created: now,
          updated: now,
        });
        changedId = id;
        commitMsg = `Add walk: ${truncate(incoming.name, 60)}`;
      }
      sortWalks(store.walks);
    }
    else if (body.deleteWalkId) {
      const before = store.walks.length;
      store.walks = store.walks.filter(w => w.id !== body.deleteWalkId);
      if (store.walks.length === before) return json({ error: 'Walk not found' }, 404);
      changedId = body.deleteWalkId;
      commitMsg = `Remove walk ${body.deleteWalkId}`;
    }
    // --- LOOSE PIN OPERATIONS ---
    else if (body.pin && typeof body.pin === 'object') {
      const incoming = sanitisePin(body.pin);
      if (!incoming.title) return json({ error: 'Title required' }, 400);

      const now = new Date().toISOString();
      const idx = incoming.id ? store.pins.findIndex(p => p.id === incoming.id) : -1;
      if (idx >= 0) {
        const prev = store.pins[idx];
        const prevPhotos = new Set(prev.photos || []);
        const kept = incoming.photos.filter(n => prevPhotos.has(n) || acceptedPhotos.has(n));
        store.pins[idx] = { ...prev, ...incoming, photos: kept, created: prev.created || now, updated: now };
        changedId = incoming.id;
        commitMsg = `Update pin: ${truncate(incoming.title, 60)}`;
      } else {
        const id = incoming.id || newId(store.pins.map(p => p.id), 'p_');
        const photos = incoming.photos.filter(n => acceptedPhotos.has(n));
        store.pins.push({ ...incoming, id, photos, created: now, updated: now });
        changedId = id;
        commitMsg = `Add pin: ${truncate(incoming.title, 60)}`;
      }
      sortPins(store.pins);
    }
    else if (body.deletePinId) {
      const before = store.pins.length;
      store.pins = store.pins.filter(p => p.id !== body.deletePinId);
      if (store.pins.length === before) return json({ error: 'Pin not found' }, 404);
      changedId = body.deletePinId;
      commitMsg = `Remove pin ${body.deletePinId}`;
    }
    else {
      return json({ error: 'Nothing to do' }, 400);
    }

    // Commit atomically
    const allFiles = [
      { path: DATA_PATH, content: JSON.stringify(store, null, 2) + '\n' },
      ...newFiles,
    ];
    await gitCommit(env, allFiles, commitMsg);

    return json({ ok: true, store, id: changedId });
  } catch (e) {
    console.error(e);
    return json({ error: e.message || 'Server error' }, 500);
  }
};

/* ── walk / pin sanitisation ─────────────────────────────────── */

function sanitiseWalk(w) {
  const parking = (w.parking && typeof w.parking === 'object') ? w.parking : {};
  const pLat = isFiniteNum(parking.lat) ? clamp(+parking.lat, -90, 90) : null;
  const pLon = isFiniteNum(parking.lon) ? clamp(+parking.lon, -180, 180) : null;

  const pois = Array.isArray(w.pois) ? w.pois.map(sanitisePoi).filter(Boolean) : [];

  const difficulty = DIFFICULTIES.has(w.difficulty) ? w.difficulty : '';
  const distance_km = isFiniteNum(w.distance_km) ? clamp(+w.distance_km, 0, 200) : null;
  const duration_min = isFiniteNum(w.duration_min) ? clamp(+w.duration_min, 0, 24*60) : null;

  return {
    id: w.id || null,
    name: str(w.name, 200),
    description: str(w.description, 6000),
    difficulty,
    distance_km,
    duration_min,
    terrain: str(w.terrain, 400),
    toilets: str(w.toilets, 400),
    mud: str(w.mud, 400),
    parking: {
      lat: pLat, lon: pLon,
      postcode: str(parking.postcode, 16).toUpperCase(),
      what3words: str(parking.what3words, 80).toLowerCase(),
    },
    pois,
    photos: photosArr(w.photos, 12),
    url: str(w.url, 1000),
  };
}

function sanitisePoi(p) {
  if (!p || typeof p !== 'object') return null;
  const title = str(p.title, 200);
  if (!title) return null;
  return {
    id: p.id || ('poi_' + Math.random().toString(36).slice(2, 10)),
    title,
    note: str(p.note, 2000),
    lat: isFiniteNum(p.lat) ? clamp(+p.lat, -90, 90) : null,
    lon: isFiniteNum(p.lon) ? clamp(+p.lon, -180, 180) : null,
    tags: tagsArr(p.tags),
  };
}

function sanitisePin(p) {
  return {
    id: p.id || null,
    title: str(p.title, 200),
    note: str(p.note, 4000),
    lat: isFiniteNum(p.lat) ? clamp(+p.lat, -90, 90) : null,
    lon: isFiniteNum(p.lon) ? clamp(+p.lon, -180, 180) : null,
    tags: tagsArr(p.tags),
    url: str(p.url, 1000),
    photos: photosArr(p.photos, 8),
  };
}

function tagsArr(t) {
  if (!Array.isArray(t)) return [];
  const out = [];
  for (const x of t) {
    const norm = String(x || '').toLowerCase().trim().replace(/[^a-z0-9_-]/g, '');
    if (VALID_TAGS.has(norm) && !out.includes(norm)) out.push(norm);
  }
  return out;
}

function photosArr(a, max) {
  if (!Array.isArray(a)) return [];
  return a.filter(n => typeof n === 'string' && PHOTO_NAME_RE.test(n)).slice(0, max);
}

function str(s, max) { return String(s || '').slice(0, max).trim(); }
function isFiniteNum(x) { return typeof x === 'number' ? Number.isFinite(x) : Number.isFinite(parseFloat(x)); }
function clamp(x, a, b) { return Math.min(b, Math.max(a, x)); }
function truncate(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

function newId(existing, prefix) {
  const taken = new Set(existing);
  for (let i = 0; i < 50; i++) {
    const id = prefix + Math.random().toString(36).slice(2, 10);
    if (!taken.has(id)) return id;
  }
  return prefix + Date.now().toString(36);
}

function sortWalks(walks) {
  walks.sort((a, b) => (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase()));
}
function sortPins(pins) {
  pins.sort((a, b) => {
    const aLoc = a.lat != null, bLoc = b.lat != null;
    if (aLoc !== bLoc) return aLoc ? -1 : 1;
    return (a.title || '').toLowerCase().localeCompare((b.title || '').toLowerCase());
  });
}

function ctEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}

async function gh(env, path, init = {}) {
  return fetch(`https://api.github.com/repos/${env.repo}${path}`, {
    ...init,
    headers: {
      'Authorization': `Bearer ${env.token}`,
      'Accept':        'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent':    'hiddenfinds-netlify-fn',
      ...(init.headers || {}),
    },
  });
}

/* Atomically commits the given files. Each file is either:
     { path, content }   utf-8 text
     { path, base64  }   already base64-encoded binary
*/
async function gitCommit(env, files, message) {
  const refRes = await gh(env, `/git/ref/heads/${encodeURIComponent(env.branch)}`);
  if (!refRes.ok) throw new Error('GitHub ref read failed: ' + refRes.status);
  const ref = await refRes.json();
  const parentCommitSha = ref.object.sha;

  const commitRes = await gh(env, `/git/commits/${parentCommitSha}`);
  if (!commitRes.ok) throw new Error('GitHub commit read failed: ' + commitRes.status);
  const parentCommit = await commitRes.json();
  const baseTreeSha = parentCommit.tree.sha;

  const tree = await Promise.all(files.map(async (f) => {
    const content = f.base64
      ? f.base64
      : Buffer.from(f.content, 'utf-8').toString('base64');
    const blobRes = await gh(env, '/git/blobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, encoding: 'base64' }),
    });
    if (!blobRes.ok) throw new Error('GitHub blob create failed: ' + blobRes.status);
    const blob = await blobRes.json();
    return { path: f.path, mode: '100644', type: 'blob', sha: blob.sha };
  }));

  const treeRes = await gh(env, '/git/trees', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ base_tree: baseTreeSha, tree }),
  });
  if (!treeRes.ok) throw new Error('GitHub tree create failed: ' + treeRes.status);
  const newTree = await treeRes.json();

  const newCommitRes = await gh(env, '/git/commits', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, tree: newTree.sha, parents: [parentCommitSha] }),
  });
  if (!newCommitRes.ok) throw new Error('GitHub commit create failed: ' + newCommitRes.status);
  const newCommit = await newCommitRes.json();

  const patchRes = await gh(env, `/git/refs/heads/${encodeURIComponent(env.branch)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sha: newCommit.sha, force: false }),
  });
  if (!patchRes.ok) throw new Error('GitHub ref update failed: ' + patchRes.status);
}
