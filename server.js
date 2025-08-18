// server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';

const {
  AIRTABLE_TOKEN,
  AIRTABLE_BASE_ID,
  NETWORKS_TABLE_NAME,
  AIRTABLE_VIEW_NAME,
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

/** Prefer Airtable thumbnail if present, else original URL. */
function pickAttachmentUrl(att) {
  if (!att) return null;
  if (typeof att === 'string') return /^https?:\/\//i.test(att) ? att : null;
  return att?.thumbnails?.large?.url || att?.thumbnails?.full?.url || att?.url || null;
}

/** Normalize weird slashes and leading encodings in a URL string. */
function normalizeUrl(u) {
  let s = String(u || '').trim();
  s = s.replace(/^%20+/i, '').replace(/^\s+/, '');
  s = s.replace(/^(https?:)\/{2,}/i, (_, p1) => `${p1}//`);
  s = s.replace(/([^:])\/{2,}/g, '$1/');
  return s;
}

/** Flatten attachment/lookup field into array of URLs. */
function collectPhotoUrls(value) {
  const urls = new Set();
  const pushAny = (v) => {
    if (v == null) return;
    if (Array.isArray(v)) { v.forEach(pushAny); return; }
    if (typeof v === 'string') {
      const s = v.trim();
      if ((s.startsWith('[') && s.endsWith(']')) || (s.startsWith('{') && s.endsWith('}'))) {
        try { pushAny(JSON.parse(s)); return; } catch {}
      }
      (s.includes(',') ? s.split(',') : [s]).forEach((part) => {
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

/** Normalize leaders list */
function normalizeLeaders(value) {
  const parts = [];
  const pushClean = (s) => {
    if (s == null) return;
    let t = String(s).trim();
    t = t.replace(/^(\[|\]+|"+|'+)|(\[|\]+|"+|'+)$/g, '');
    t = t.replace(/\s+/g, ' ').trim();
    if (/^rec[a-zA-Z0-9]{14}$/.test(t)) return;
    if (t) parts.push(t);
  };
  if (Array.isArray(value)) {
    value.forEach((v) => {
      if (typeof v === 'object' && v && 'name' in v) pushClean(v.name);
      else if (typeof v === 'string' && v.includes('","')) {
        v.split('","').forEach((x) => pushClean(x.replace(/^"+|"+$/g, '')));
      } else pushClean(v);
    });
  } else if (typeof value === 'string') {
    const text = value.trim();
    try {
      if (text.startsWith('[') && text.endsWith(']')) {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) parsed.forEach(pushClean); else pushClean(parsed);
      } else text.split(/[;,]/).forEach(s => pushClean(s));
    } catch { text.split(/[;,]/).forEach(s => pushClean(s)); }
  } else if (value != null) pushClean(value);
  return [...new Set(parts)].join(', ');
}

/** Normalize text/lookup fields */
function normalizeTextField(value) {
  if (value == null) return '';
  const out = [];
  const pushAny = (v) => {
    if (v == null) return;
    if (Array.isArray(v)) { v.forEach(pushAny); return; }
    if (typeof v === 'object') {
      const cand = v.email ?? v.text ?? v.name ?? v.value ?? null;
      if (cand != null) {
        const t = String(cand).trim();
        if (t) out.push(t);
      } else Object.values(v).forEach(pushAny);
      return;
    }
    const t = String(v).trim();
    if (t) out.push(t);
  };
  pushAny(value);
  return [...new Set(out)].join(', ');
}

function getBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}`;
}

/* ---------------- Image proxies ---------------- */
const urlCache = new Map();
const CACHE_TTL_MS = 8 * 60 * 1000;
function getCached(key) {
  const v = urlCache.get(key);
  if (!v) return null;
  if (Date.now() > v.expiresAt) { urlCache.delete(key); return null; }
  return v.url;
}
function setCached(key, url) {
  urlCache.set(key, { url, expiresAt: Date.now() + CACHE_TTL_MS });
}

app.get('/img/:recordId/:index', async (req, res) => {
  try {
    const { recordId, index } = req.params;
    const idx = Number(index);
    if (!Number.isInteger(idx) || idx < 0) return res.status(400).send('Bad index');
    const cacheKey = `Photo:${recordId}:${idx}`;
    const cached = getCached(cacheKey);
    if (cached) { res.set('Cache-Control', 'public, max-age=300'); return res.redirect(302, cached); }
    const rec = await fetchRecordById(NETWORKS_TABLE_NAME, recordId);
    const attachments = Array.isArray(rec.fields?.Photo) ? rec.fields.Photo : [];
    const att = attachments[idx]; if (!att) return res.status(404).send('Photo not found');
    const freshUrl = pickAttachmentUrl(att); if (!freshUrl) return res.status(404).send('Photo URL missing');
    setCached(cacheKey, freshUrl);
    res.set('Cache-Control', 'public, max-age=300'); return res.redirect(302, freshUrl);
  } catch (err) { console.error(err); return res.status(500).send('Image proxy error'); }
});

app.get('/image/:recordId/:index', async (req, res) => {
  try {
    const { recordId, index } = req.params;
    const idx = Number(index);
    if (!Number.isInteger(idx) || idx < 0) return res.status(400).send('Bad index');
    const cacheKey = `Image:${recordId}:${idx}`;
    const cached = getCached(cacheKey);
    if (cached) { res.set('Cache-Control', 'public, max-age=300'); return res.redirect(302, cached); }
    const rec = await fetchRecordById(NETWORKS_TABLE_NAME, recordId);
    const attachments = Array.isArray(rec.fields?.Image) ? rec.fields.Image : [];
    const att = attachments[idx]; if (!att) return res.status(404).send('Image not found');
    const freshUrl = pickAttachmentUrl(att); if (!freshUrl) return res.status(404).send('Image URL missing');
    setCached(cacheKey, freshUrl);
    res.set('Cache-Control', 'public, max-age=300'); return res.redirect(302, freshUrl);
  } catch (err) { console.error(err); return res.status(500).send('Image proxy error'); }
});

/** Main endpoint */
app.get('/networks.geojson', async (req, res) => {
  try {
    const baseUrl = getBaseUrl(req);
    const networkRecords = await fetchAllRecords(NETWORKS_TABLE_NAME);

    const features = networkRecords.map((r) => {
      const f = r.fields || {};
      const geometry = parseGeometry(f['Polygon']);
      if (!geometry) return null;

      const leaders = normalizeLeaders(f['Network Leaders Names']) || '';

      /* ----- Photos ----- */
      let photoUrls = [];
      const photoField = f['Photo'];
      const isPhotoAttachmentArray =
        Array.isArray(photoField) && photoField.length > 0 &&
        typeof photoField[0] === 'object' && (photoField[0]?.url || photoField[0]?.thumbnails);
      if (isPhotoAttachmentArray) {
        photoUrls = photoField.slice(0, 6).map((_, idx) => `${baseUrl}/img/${r.id}/${idx}`);
      } else {
        photoUrls = [...new Set(collectPhotoUrls(photoField).map(normalizeUrl))].slice(0, 6);
      }

      /* ----- Images ----- */
      let imageUrls = [];
      const imageField = f['Image'];
      const isImageAttachmentArray =
        Array.isArray(imageField) && imageField.length > 0 &&
        typeof imageField[0] === 'object' && (imageField[0]?.url || imageField[0]?.thumbnails);
      if (isImageAttachmentArray) {
        imageUrls = imageField.slice(0, 6).map((_, idx) => `${baseUrl}/image/${r.id}/${idx}`);
      } else {
        imageUrls = [...new Set(collectPhotoUrls(imageField).map(normalizeUrl))].slice(0, 6);
      }

      const [photo1 = '', photo2 = '', photo3 = '', photo4 = '', photo5 = '', photo6 = ''] = photoUrls;
      const [image1 = '', image2 = '', image3 = '', image4 = '', image5 = '', image6 = ''] = imageUrls;
      const photo_count = photoUrls.filter(Boolean).length;
      const image_count = imageUrls.filter(Boolean).length;

      return {
        type: 'Feature',
        geometry,
        properties: {
          id: r.id,
          name: f['Network Name'] ?? '',
          leaders,
          contact_email: normalizeTextField(f['contact email'] ?? f['Contact Email'] ?? f['Contact email']),
          status: normalizeTextField(f['Status']),
          county: normalizeTextField(f['County']),
          tags: normalizeTextField(f['Tags']),
          number_of_churches: f['Number of Churches'] ?? '',
          unity_lead: normalizeTextField(f['Unity Lead']),
          photo1, photo2, photo3, photo4, photo5, photo6,
          photo_count,
          image1, image2, image3, image4, image5, image6,
          image_count,
        },
      };
    }).filter(Boolean);

    res.set('Cache-Control', 'public, max-age=300');
    res.json({ type: 'FeatureCollection', features });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err?.message || err) });
  }
});

app.get('/', (_req, res) => res.send('OK'));
app.listen(PORT, () => { console.log(`Server running on http://localhost:${PORT}`); });
