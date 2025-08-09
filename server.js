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

/** Prefer Airtable thumbnail if present, else original URL. */
function pickAttachmentUrl(att) {
  return att?.thumbnails?.large?.url || att?.thumbnails?.full?.url || att?.url || null;
}

/** Normalize "Network Leaders Names" into a single comma-separated string (no brackets/quotes/IDs). */
function normalizeLeaders(value) {
  let parts = [];

  const pushClean = (s) => {
    if (s == null) return;
    let t = String(s).trim();
    // Strip surrounding quotes/brackets
    t = t.replace(/^(\[|\]+|"+|'+)|(\[|\]+|"+|'+)$/g, '');
    // Collapse whitespace
    t = t.replace(/\s+/g, ' ').trim();
    // Drop Airtable record IDs like recXXXXXXXXXXXXXX
    if (/^rec[a-zA-Z0-9]{14}$/.test(t)) return;
    if (t) parts.push(t);
  };

  if (Array.isArray(value)) {
    value.forEach((v) => {
      if (typeof v === 'object' && v && 'name' in v) {
        pushClean(v.name);
      } else if (typeof v === 'string' && v.includes('","')) {
        // Looks like a flattened JSON array: "A","B"
        v.split('","').forEach(x => pushClean(x.replace(/^"+|"+$/g, '')));
      } else {
        pushClean(v);
      }
    });
  } else if (typeof value === 'string') {
    const text = value.trim();
    try {
      if (text.startsWith('[') && text.endsWith(']')) {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) parsed.forEach(pushClean);
        else pushClean(parsed);
      } else {
        text.split(/[;,]/).forEach(s => pushClean(s));
      }
    } catch {
      text.split(/[;,]/).forEach(s => pushClean(s));
    }
  } else if (value != null) {
    pushClean(value);
  }

  // unique + join
  const unique = [...new Set(parts)];
  return unique.join(', ');
}

/** Main endpoint Felt points at */
app.get('/networks.geojson', async (_req, res) => {
  try {
    const networkRecords = await fetchAllRecords(NETWORKS_TABLE_NAME);

    const features = networkRecords.map((r) => {
      const f = r.fields || {};
      const geometry = parseGeometry(f['Polygon']);
      if (!geometry) return null;

      const leadersString = normalizeLeaders(f['Network Leaders Names']) || '';

      // Keep raw photo URLs as data (no Markdown)
      const photos = Array.isArray(f['Photo']) ? f['Photo'] : [];
      const photoUrls = photos.map(pickAttachmentUrl).filter(Boolean);

      return {
        type: 'Feature',
        geometry,
        properties: {
          id: r.id,
          name: f['Network Name'] ?? '',
          leaders: leadersString,   // always a single comma-separated string
          photos: photoUrls,        // plain URLs (array); not used as Markdown
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
