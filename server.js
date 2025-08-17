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
        if (Array.isArray(parsed)) parsed.forEach(pushClean); else pushClean(par
