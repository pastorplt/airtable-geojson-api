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

/** Escape Markdown special characters in text. */
function escapeMarkdown(text) {
  return String(text).replace(/([\\`*_{}[\]()#+\-.!])/g, '\\$1');
}

/** Prefer Airtable thumbnail if present, else original URL. */
function pickAttachmentUrl(att) {
  return att?.thumbnails?.large?.url || att?.thumbnails?.full?.url || att?.url || null;
}

/** Build Felt-safe Markdown description. */
function buildMarkdownDescription(fields) {
  const name = fields['Network Name'] ?? '';
  const leadersField = fields['Network Leaders Names'];
  const leaderText = Array.isArray(leadersField) ? leadersField.join(', ') : (leadersField ?? '');

  const photos = Array.isArray(fields['Photo']) ? fields['Photo'] : [];
  const photoUrls = photos.map(pickAttachmentUrl).filter(Boolean);

  let md = `**${escapeMarkdown(name)}**`;
  if (leaderText) md += `\n\n${escapeMarkdown(leaderText)}`;
  photoUrls.forEach((url) => {
    md += `\n\n![Leader photo](${url})`;
  });

  return md;
}

/** Main endpoint Felt points at */
app.get('/networks.geojson', async (_req, res) => {
  try {
    const networkRecords = await fetchAllRecords(NETWORKS_TABLE_NAME);

    const features = networkRecords.map((r) => {
      const f = r.fields || {};
      const geometry = parseGeometry(f['Polygon']);
      if (!geometry) return null;

      const description = buildMarkdownDescription(f);

      return {
        type: 'Feature',
        geometry,
        properties: {
          id: r.id,
          name: f['Network Name'] ?? '',
          leaders: f['Network Leaders Names'] ?? [],
          description, // Markdown only — works in Felt popups
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
