// netlify/functions/save-pin.js
//
// One endpoint, two operations (decided by request body):
//   { pin, password }            → add (when pin.id is null/missing) or update
//   { deleteId, password }       → delete by id
//
// Auth: shared password compared in constant time against env var ADMIN_PASSWORD.
// Storage: data/pins.json — committed to the configured repo + branch via the
// GitHub Git Data API so each save is a single clean commit.
//
// Returns: { ok: true, pins: [...], id: <newOrUpdatedId> }
//
// Required env vars:
//   GITHUB_TOKEN      Fine-grained PAT with Contents: Read+Write on the target repo.
//   GITHUB_REPO       owner/name, e.g. starkit/hiddenfinds
//   GITHUB_BRANCH     Branch to write to. Defaults to "main".
//   ADMIN_PASSWORD    Shared write password.

const PATH = 'data/pins.json';

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

  try {
    // 1. Read current pins.json (or start with [] if 404)
    const fileRes = await gh(env, `/contents/${PATH}?ref=${encodeURIComponent(env.branch)}`);
    let pins = [];
    if (fileRes.status === 200) {
      const j = await fileRes.json();
      try { pins = JSON.parse(Buffer.from(j.content, 'base64').toString('utf-8')); }
      catch { pins = []; }
      if (!Array.isArray(pins)) pins = [];
    } else if (fileRes.status !== 404) {
      return json({ error: 'GitHub read failed: ' + fileRes.status }, 502);
    }

    // 2. Apply the mutation in memory
    let changedId = null;
    let commitMsg = '';

    if (body.deleteId) {
      const before = pins.length;
      pins = pins.filter(p => p.id !== body.deleteId);
      if (pins.length === before) return json({ error: 'Pin not found' }, 404);
      changedId = body.deleteId;
      commitMsg = `Remove pin ${body.deleteId}`;
    } else if (body.pin && typeof body.pin === 'object') {
      const incoming = sanitisePin(body.pin);
      if (!incoming.title) return json({ error: 'Title required' }, 400);

      const now = new Date().toISOString();
      const existingIdx = incoming.id ? pins.findIndex(p => p.id === incoming.id) : -1;
      if (existingIdx >= 0) {
        const prev = pins[existingIdx];
        pins[existingIdx] = { ...prev, ...incoming, created: prev.created || now, updated: now };
        changedId = incoming.id;
        commitMsg = `Update pin: ${truncate(incoming.title, 60)}`;
      } else {
        const id = incoming.id || newId(pins);
        pins.push({ ...incoming, id, created: now, updated: now });
        changedId = id;
        commitMsg = `Add pin: ${truncate(incoming.title, 60)}`;
      }
    } else {
      return json({ error: 'Nothing to do' }, 400);
    }

    // 3. Sort: located by title, then unlocated by title (for stable diffs)
    pins.sort((a, b) => {
      const aLoc = a.lat != null, bLoc = b.lat != null;
      if (aLoc !== bLoc) return aLoc ? -1 : 1;
      return (a.title || '').toLowerCase().localeCompare((b.title || '').toLowerCase());
    });

    // 4. Commit via Git Data API (single atomic commit)
    const newContent = JSON.stringify(pins, null, 2) + '\n';
    await gitCommit(env, [{ path: PATH, content: newContent }], commitMsg);

    return json({ ok: true, pins, id: changedId });
  } catch (e) {
    console.error(e);
    return json({ error: e.message || 'Server error' }, 500);
  }
};

/* ── helpers ──────────────────────────────────────────────────── */

function sanitisePin(p) {
  const tags = Array.isArray(p.tags)
    ? p.tags
        .map(t => String(t).toLowerCase().trim().replace(/[^a-z0-9_-]/g, ''))
        .filter(Boolean)
        .slice(0, 12)
    : [];
  const lat = isFiniteNum(p.lat) ? clamp(+p.lat, -90, 90) : null;
  const lon = isFiniteNum(p.lon) ? clamp(+p.lon, -180, 180) : null;
  return {
    id: p.id || null,
    title: String(p.title || '').slice(0, 200).trim(),
    note: String(p.note || '').slice(0, 4000).trim(),
    lat, lon,
    tags,
    url: String(p.url || '').slice(0, 1000).trim(),
  };
}
function isFiniteNum(x) { return typeof x === 'number' ? Number.isFinite(x) : Number.isFinite(parseFloat(x)); }
function clamp(x, a, b) { return Math.min(b, Math.max(a, x)); }
function truncate(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

function newId(pins) {
  const taken = new Set(pins.map(p => p.id));
  for (let i = 0; i < 50; i++) {
    const id = 'p_' + Math.random().toString(36).slice(2, 10);
    if (!taken.has(id)) return id;
  }
  return 'p_' + Date.now().toString(36);
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

/* Atomically commits the given files (path+content as utf-8 string).
   One commit, parented on the current branch tip, then fast-forwards the ref. */
async function gitCommit(env, files, message) {
  // Get current ref + commit + tree
  const refRes = await gh(env, `/git/ref/heads/${encodeURIComponent(env.branch)}`);
  if (!refRes.ok) throw new Error('GitHub ref read failed: ' + refRes.status);
  const ref = await refRes.json();
  const parentCommitSha = ref.object.sha;

  const commitRes = await gh(env, `/git/commits/${parentCommitSha}`);
  if (!commitRes.ok) throw new Error('GitHub commit read failed: ' + commitRes.status);
  const parentCommit = await commitRes.json();
  const baseTreeSha = parentCommit.tree.sha;

  // Create blobs for each file
  const tree = [];
  for (const f of files) {
    const blobRes = await gh(env, '/git/blobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: Buffer.from(f.content, 'utf-8').toString('base64'),
        encoding: 'base64',
      }),
    });
    if (!blobRes.ok) throw new Error('GitHub blob create failed: ' + blobRes.status);
    const blob = await blobRes.json();
    tree.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
  }

  // Build a new tree off the existing one
  const treeRes = await gh(env, '/git/trees', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ base_tree: baseTreeSha, tree }),
  });
  if (!treeRes.ok) throw new Error('GitHub tree create failed: ' + treeRes.status);
  const newTree = await treeRes.json();

  // Create the commit
  const newCommitRes = await gh(env, '/git/commits', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, tree: newTree.sha, parents: [parentCommitSha] }),
  });
  if (!newCommitRes.ok) throw new Error('GitHub commit create failed: ' + newCommitRes.status);
  const newCommit = await newCommitRes.json();

  // Fast-forward the ref
  const patchRes = await gh(env, `/git/refs/heads/${encodeURIComponent(env.branch)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sha: newCommit.sha, force: false }),
  });
  if (!patchRes.ok) throw new Error('GitHub ref update failed: ' + patchRes.status);
}
