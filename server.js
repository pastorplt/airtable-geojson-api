// server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';

const {
  AIRTABLE_TOKEN,
  AIRTABLE_BASE_ID,
  NETWORKS_TABLE_NAME, // e.g., "Networks"
  AIRTABLE_VIEW_NAME,  // optional, e.g., "Grid view"
  PORT = 3000,
} = process.env;

if (!AIRTABLE_TOKEN || !AIRTABLE_BASE_ID || !NETWORKS_TABLE_NAME) {
  console.error("Missing env vars: AIRTABLE_TOKEN, AIRTABLE_BASE_ID, NETWORKS_TABLE_NAME");
  process.exit(1);
}

const app = express();
app.use(cors());

/** Fetch all Airtable records for one table (handles pagination). */
async function fetchAllRecords(tableName) {
  const all = [];
  let offset;
  const baseUrl = new URL(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(tableName)}`);
  if (AIRTABLE_VIEW_NAME) baseUrl.searchParams.set('view', AIRTABLE_VIEW_NAME);
  baseUrl.searchParams.set('pageSize', '100');

  while (true) {
    const url = new URL(baseUrl);
    if (offset) url.searchParams.set('offset', offset);

    const res = await fetch(url, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
    if (!res.ok) throw new Error(`Airtable error ${res.status}: ${await res.text()}`);

    const data = await res.json();
    if (data.records?.length) all.push(...data.records);
    if (data.offset) offset = data.offset; else break;
  }
  return all;
}

/** Fetch a single record by ID. */
async function fetchRecordById(tableName, recordId) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(tableName)}/${recordId}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
  if (!res.ok) throw new Error(`Airtable error ${res.status}: ${await res.text()}`);
  return res.json();
}

/** Parse a GeoJSON string or object safely. */
function parseGeometry(raw) {
  if (!raw) return null;
  try {
    const g = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return g?.type ? g : null;
  } catch {
    return null;
  }
}

/** Prefer Airtable thumbnail if present, else original URL. Accepts strings too. */
function pickAttachmentUrl(att) {
  if (!att) return null;
  if (typeof att === 'string') return /^https?:\/\//i.test(att) ? att : null;
  return att?.thumbnails?.large?.url || att?.thumbnails?.full?.url || att?.url || null;
}

/** Normalize weird slashes and leading encodings in a URL string. */
function normalizeUrl(u) {
  let s = String(u || '').trim();
  s = s.replace(/^%20+/i, '').replace(/^\s+/, '');          // trim encoded/real spaces
  s = s.replace(/^(https?:)\/{2,}/i, (_, p1) => `${p1}//`); // https://// -> https://
  s = s.replace(/([^:])\/{2,}/g, '$1/');                    // collapse extra slashes in path
  return s;
}

/** Flatten anything Airtable might return for a lookup/attachment field into an array of clean URL strings. */
function collectPhotoUrls(value) {
  const urls = new Set();

  const pushAny = (v) => {
    if (v == null) return;

    if (Array.isArray(v)) {
      v.forEach(pushAny);
      return;
    }

    if (typeof v === 'string') {
      const s = v.trim();

      // JSON array/object encoded as string
      if ((s.startsWith('[') && s.endsWith(']')) || (s.startsWith('{') && s.endsWith('}'))) {
        try {
          const parsed = JSON.parse(s);
          pushAny(parsed);
          return;
        } catch { /* fall through */ }
      }

      // Comma-joined URLs in one string
      const parts = s.includes(',') ? s.split(',') : [s];
      parts.forEach((part) => {
        const maybe = pickAttachmentUrl(part);
        if (maybe) urls.add(normalizeUrl(maybe));
      });
      return;
    }

    if (typeof v === 'object') {
      if (v.url || v.thumbnails) {
        const maybe = pickAttachmentUrl(v);
        if (maybe) urls.add(normalizeUrl(maybe));
        return;
      }
      Object.values(v).forEach(pushAny);
    }
  };

  pushAny(value);
  return Array.from(urls);
}

/** Normalize "Network Leaders Names" into a single comma-separated string. */
function normalizeLeaders(value) {
  const parts = [];

  const pushClean = (s) => {
    if (s == null) return;
    let t = String(s).trim();
    t = t.replace(/^(\[|\]+|"+|'+)|(\[|\]+|"+|'+)$/g, ''); // strip quotes/brackets
    t = t.replace(/\s+/g, ' ').trim();                    // collapse whitespace
    if (/^rec[a-zA-Z0-9]{14}$/.test(t)) return;           // drop Airtable record IDs
    if (t) parts.push(t);
  };

  if (Array.isArray(value)) {
    value.forEach((v) => {
      if (typeof v === 'object' && v && 'name' in v) pushClean(v.name);
      else if (typeof v === 'string' && v.includes('","')) {
        v.split('","').forEach(x => pushClean(x.replace(/^"+|"+$/g, '')));
      } else pushClean(v);
    });
  } else if (typeof value === 'string') {
    const text = value.trim();
    try {
      if (text.startsWith('[') && text.endsWith(']')) {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) parsed.forEach(pushClean); else pushClean(parsed);
      } else {
        text.split(/[;,]/).forEach(s => pushClean(s));
      }
    } catch {
      text.split(/[;,]/).forEach(s => pushClean(s));
    }
  } else if (value != null) {
    pushClean(value);
  }

  return [...new Set(parts)].join(', ');
}

/** NEW: Normalize a general text/lookup field into a comma-separated string (e.g., contact email). */
function normalizeTextField(value) {
  if (value == null) return '';
  const out = [];

  const pushAny = (v) => {
    if (v == null) return;
    if (Array.isArray(v)) {
      v.forEach(pushAny);
      return;
    }
    if (typeof v === 'object') {
      // common shapes: { email: "x@y" } or { text: "..." } or linked { name: "..."}
      const cand = v.email ?? v.text ?? v.name ?? v.value ?? null;
      if (cand != null) {
        const t = String(cand).trim();
        if (t) out.push(t);
      } else {
        Object.values(v).forEach(pushAny);
      }
      return;
    }
    const t = String(v).trim();
    if (t) out.push(t);
  };

  pushAny(value);
  return [...new Set(out)].join(', ');
}

/** Figure out the absolute base URL for proxy links. */
function getBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}`;
}

/* ---------------- Image proxy (prevents expired Airtable links) ----------------
   - We proxy ONLY when the Photo field is an attachment array (objects with url/thumbnails).
   - For plain string URLs (e.g., S3/Cloudinary), we pass them through unchanged.
----------------------------------------------------------------------------- */

/** Very short-lived in-memory cache of fresh Airtable attachment URLs. */
const urlCache = new Map(); // key: `${recordId}:${index}` -> { url, expiresAt }
const CACHE_TTL_MS = 8 * 60 * 1000; // 8 minutes

function getCached(key) {
  const v = urlCache.get(key);
  if (!v) return null;
  if (Date.now() > v.expiresAt) {
    urlCache.delete(key);
    return null;
  }
  return v.url;
}
function setCached(key, url) {
  urlCache.set(key, { url, expiresAt: Date.now() + CACHE_TTL_MS });
}

/** Redirect to a fresh Airtable attachment URL for Photo[index]. */
app.get('/img/:recordId/:index', async (req, res) => {
  try {
    const { recordId, index } = req.params;
    const idx = Number(index);
    if (!Number.isInteger(idx) || idx < 0) return res.status(400).send('Bad index');

    const cacheKey = `${recordId}:${idx}`;
    const cached = getCached(cacheKey);
    if (cached) {
      res.set('Cache-Control', 'public, max-age=300');
      return res.redirect(302, cached);
    }

    const rec = await fetchRecordById(NETWORKS_TABLE_NAME, recordId);
    const attachments = Array.isArray(rec.fields?.Photo) ? rec.fields.Photo : [];
    const att = attachments[idx];
    if (!att) return res.status(404).send('Photo not found');

    const freshUrl = pickAttachmentUrl(att);
    if (!freshUrl) return res.status(404).send('Photo URL missing');

    setCached(cacheKey, freshUrl);
    res.set('Cache-Control', 'public, max-age=300');
    return res.redirect(302, freshUrl);
  } catch (err) {
    console.error(err);
    return res.status(500).send('Image proxy error');
  }
});

/** Main endpoint Felt points at */
app.get('/networks.geojson', async (req, res) => {
  try {
    const baseUrl = getBaseUrl(req);
    const networkRecords = await fetchAllRecords(NETWORKS_TABLE_NAME);

    const features = networkRecords.map((r) => {
      const f = r.fields || {};
      const geometry = parseGeometry(f['Polygon']);
      if (!geometry) return null;

      const leaders = normalizeLeaders(f['Network Leaders Names']) || '';

      // If Photo is an attachment array (objects), build proxied URLs by index.
      let photoUrls = [];
      const photoField = f['Photo'];
      const isAttachmentArray =
        Array.isArray(photoField) &&
        photoField.length > 0 &&
        typeof photoField[0] === 'object' &&
        (photoField[0]?.url || photoField[0]?.thumbnails);

      if (isAttachmentArray) {
        photoUrls = photoField
          .slice(0, 6)
          .map((_, idx) => `${baseUrl}/img/${r.id}/${idx}`);
      } else {
        // Fallback: collect plain URLs from whatever is in Photo (these may be permanent)
        const urls = collectPhotoUrls(photoField).map(normalizeUrl);
        photoUrls = [...new Set(urls)].slice(0, 6);
      }

      const [photo1 = '', photo2 = '', photo3 = '', photo4 = '', photo5 = '', photo6 = ''] = photoUrls;
      const photo_count = photoUrls.filter(Boolean).length;

      // NEW: contact email field (supports common name variants & lookups)
      const contact_email = normalizeTextField(
        f['contact email'] ?? f['Contact Email'] ?? f['Contact email']
      );

      return {
        type: 'Feature',
        geometry,
        properties: {
          id: r.id,
          name: f['Network Name'] ?? '',
          leaders,        // single comma-separated string
          contact_email,  // <-- added
          photo1,
          photo2,
          photo3,
          photo4,
          photo5,
          photo6,
          photo_count,    // integer 0..6
        },
      };
    }).filter(Boolean);

    res.set('Cache-Control', 'public, max-age=300'); // 5 minutes
    res.json({ type: 'FeatureCollection', features });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err?.message || err) });
  }
});

app.get('/', (_req, res) => res.send('OK'));

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
