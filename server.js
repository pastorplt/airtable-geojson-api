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

/**
 * Flatten anything Airtable might return for a lookup/attachment field into an array of clean URL strings.
 * Handles: attachment arrays, nested arrays, objects, JSON-encoded strings, and comma-joined strings.
 */
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

/** Normalize "Network Leaders Names" into a single comma-separated string (no brackets/quotes/IDs). */
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

/** Main endpoint Felt points at */
app.get('/networks.geojson', async (_req, res) => {
  try {
    const networkRecords = await fetchAllRecords(NETWORKS_TABLE_NAME);

    const features = networkRecords.map((r) => {
      const f = r.fields || {};
      const geometry = parseGeometry(f['Polygon']);
      if (!geometry) return null;

      const leaders = normalizeLeaders(f['Network Leaders Names']) || '';

      // Collect, normalize, de-dup, and cap to 6 photos
      const urls = collectPhotoUrls(f['Photo']).map(normalizeUrl);
      const unique = [...new Set(urls)].slice(0, 6);

      const [photo1 = '', photo2 = '', photo3 = '', photo4 = '', photo5 = '', photo6 = ''] = unique;
      const photo_count = unique.filter(Boolean).length;

      return {
        type: 'Feature',
        geometry,
        properties: {
          id: r.id,
          name: f['Network Name'] ?? '',
          leaders,        // single comma-separated string
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
