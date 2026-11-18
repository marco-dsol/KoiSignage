// KoiSignage – Server. Kommt ohne Fremdpakete aus (Node.js >= 22.13).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import './public/shared/rules.js';
import { toVtt, SUBTITLE_EXT } from './subtitles.js';

const Rules = globalThis.KoiSignageRules;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const PUBLIC_DIR = path.join(__dirname, 'public');
const ENV_PASSWORD = process.env.ADMIN_PASSWORD || '';
const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_MB || 4096) * 1024 * 1024;
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const SESSION_DAYS = 30;
const ONLINE_MS = 75000;
const POWER_MS = 300000; // so lange gilt die letzte Meldung der HDMI-Schaltung als aktuell

fs.mkdirSync(MEDIA_DIR, { recursive: true });

// ───────────────────────── Datenbank ─────────────────────────

const DB_FILE = path.join(DATA_DIR, 'koisignage.db');
// Vor der Umbenennung der App hiess die Datenbank sinage.db. Sie wird beim ersten Start unter dem neuen Namen weitergeführt.
if (!fs.existsSync(DB_FILE) && fs.existsSync(path.join(DATA_DIR, 'sinage.db'))) {
  for (const suffix of ['', '-wal', '-shm']) {
    const old = path.join(DATA_DIR, 'sinage.db' + suffix);
    if (fs.existsSync(old)) fs.renameSync(old, DB_FILE + suffix);
  }
}
const db = new DatabaseSync(DB_FILE);
// Clips heissen jetzt Ressourcen: alte Tabelle und Zuweisungen übernehmen.
if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='clips'").get() && !db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='resources'").get()) db.exec('ALTER TABLE clips RENAME TO resources');
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS resources (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, file TEXT, url TEXT,
    mime TEXT, size INTEGER DEFAULT 0, duration REAL, width INTEGER, height INTEGER, thumb TEXT,
    tags TEXT DEFAULT '[]', rule TEXT DEFAULT '{}', fit TEXT DEFAULT 'contain', speed REAL DEFAULT 1,
    subs TEXT, subs_name TEXT, enabled INTEGER DEFAULT 1, created INTEGER, updated INTEGER
  );
  CREATE TABLE IF NOT EXISTS sequences (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL,
    tags TEXT DEFAULT '[]', items TEXT DEFAULT '[]', rule TEXT DEFAULT '{}',
    enabled INTEGER DEFAULT 1, created INTEGER, updated INTEGER
  );
  CREATE TABLE IF NOT EXISTS screens (
    id TEXT PRIMARY KEY, name TEXT DEFAULT '', code TEXT, token TEXT UNIQUE, paired INTEGER DEFAULT 0,
    content_kind TEXT, content_id TEXT, tags TEXT DEFAULT '[]', muted INTEGER DEFAULT 1,
    rotation INTEGER DEFAULT 0, hours TEXT DEFAULT '{}', info TEXT DEFAULT '{}', status TEXT DEFAULT '{}',
    last_seen INTEGER DEFAULT 0, created INTEGER
  );
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, expires INTEGER);
`);

const q = (sql) => db.prepare(sql);
q("UPDATE screens SET content_kind='resource' WHERE content_kind='clip'").run();
// Bestehende Datenbanken bekommen neue Spalten nachgetragen.
const resourceColumns = q('PRAGMA table_info(resources)').all().map((c) => c.name);
if (!resourceColumns.includes('speed')) db.exec('ALTER TABLE resources ADD COLUMN speed REAL DEFAULT 1');
if (!resourceColumns.includes('subs')) db.exec('ALTER TABLE resources ADD COLUMN subs TEXT; ALTER TABLE resources ADD COLUMN subs_name TEXT');
const seqColumns = q('PRAGMA table_info(sequences)').all().map((c) => c.name);
if (!seqColumns.includes('split')) db.exec("ALTER TABLE sequences ADD COLUMN split TEXT DEFAULT ''");   // Teilung in Bereich A und B
const screenColumns = q('PRAGMA table_info(screens)').all().map((c) => c.name);
if (!screenColumns.includes('ip')) db.exec("ALTER TABLE screens ADD COLUMN ip TEXT DEFAULT ''");
if (!screenColumns.includes('power')) db.exec("ALTER TABLE screens ADD COLUMN power TEXT DEFAULT '{}'");
const parse = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };
const newId = (bytes = 8) => crypto.randomBytes(bytes).toString('base64url');
const now = () => Date.now();

function getSetting(key, fallback = null) {
  const row = q('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
function setSetting(key, value) {
  q('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}
const timezone = () => getSetting('tz', 'Europe/Vienna');

// ───────────────────────── Hilfen ─────────────────────────

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
const fail = (status, message, extra) => { throw new HttpError(status, message, extra); };

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

async function readBody(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) fail(413, 'Anfrage zu gross');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  const body = parse(buf.toString('utf8'), null);
  if (!body || typeof body !== 'object') fail(400, 'Ungültiges JSON');
  return body;
}

function clientIp(req) {
  if (TRUST_PROXY && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  const ip = req.socket.remoteAddress || '';
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}
function isHttps(req) {
  return TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https';
}
function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };

function cleanTags(tags) {
  if (!Array.isArray(tags)) return [];
  const seen = new Set(), out = [];
  for (const t of tags) {
    const tag = str(t, 30);
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(tag);
  }
  return out.slice(0, 30);
}

function cleanRule(rule) {
  const out = {};
  if (!rule || typeof rule !== 'object') return out;
  const date = /^\d{4}-\d{2}-\d{2}$/, time = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (date.test(rule.from)) out.from = rule.from;
  if (date.test(rule.to)) out.to = rule.to;
  if (time.test(rule.start)) out.start = rule.start;
  if (time.test(rule.end)) out.end = rule.end;
  if (Array.isArray(rule.days)) {
    const days = [...new Set(rule.days.map(Number).filter((d) => d >= 1 && d <= 7))].sort();
    if (days.length && days.length < 7) out.days = days;
  }
  return out;
}

// ───────────────────────── Anmeldung ─────────────────────────

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  return salt.toString('hex') + ':' + crypto.scryptSync(password, salt, 32).toString('hex');
}
function checkPassword(password) {
  if (ENV_PASSWORD) {
    const a = crypto.createHash('sha256').update(password).digest();
    const b = crypto.createHash('sha256').update(ENV_PASSWORD).digest();
    return crypto.timingSafeEqual(a, b);
  }
  const stored = getSetting('password');
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(password, Buffer.from(salt, 'hex'), 32);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}
const hasPassword = () => Boolean(ENV_PASSWORD || getSetting('password'));

function isAdmin(req) {
  const id = cookies(req).koisignage_session;
  if (!id) return false;
  const row = q('SELECT expires FROM sessions WHERE id = ?').get(id);
  return Boolean(row && row.expires > now());
}
function startSession(req, res) {
  const id = crypto.randomBytes(24).toString('base64url');
  q('INSERT INTO sessions (id, expires) VALUES (?, ?)').run(id, now() + SESSION_DAYS * 86400000);
  res.setHeader('Set-Cookie', `koisignage_session=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}${isHttps(req) ? '; Secure' : ''}`);
}

// einfache Bremsen im Arbeitsspeicher
const loginFails = new Map();   // ip -> { count, until }
const registrations = new Map(); // ip -> [zeitpunkte]

// ───────────────────────── Ressourcen (Videos, Bilder, Webseiten) ─────────────────────────

const EXT = {
  '.mp4': ['video', 'video/mp4'], '.m4v': ['video', 'video/mp4'], '.webm': ['video', 'video/webm'], '.mov': ['video', 'video/quicktime'],
  '.jpg': ['image', 'image/jpeg'], '.jpeg': ['image', 'image/jpeg'], '.png': ['image', 'image/png'],
  '.webp': ['image', 'image/webp'], '.gif': ['image', 'image/gif']
};

function resourceOut(row) {
  return {
    id: row.id, name: row.name, type: row.type,
    src: row.type === 'web' ? row.url : '/media/' + row.file,
    url: row.url || '', mime: row.mime, size: row.size, duration: row.duration,
    width: row.width, height: row.height, thumb: row.thumb ? '/media/' + row.thumb : null,
    tags: parse(row.tags, []), rule: parse(row.rule, {}), fit: row.fit || 'contain',
    speed: row.type === 'video' ? row.speed || 1 : 1,
    subtitles: row.type === 'video' && row.subs ? { src: '/media/' + row.subs, name: row.subs_name || 'Untertitel' } : null,
    enabled: Boolean(row.enabled), created: row.created, updated: row.updated
  };
}
const allResources = () => q('SELECT * FROM resources ORDER BY name COLLATE NOCASE').all().map(resourceOut);
const getResourceRow = (id) => q('SELECT * FROM resources WHERE id = ?').get(id) || fail(404, 'Ressource nicht gefunden');

/** Löscht eine Mediendatei sofort: Wenn die Antwort beim Aufrufer ankommt, ist die Datei nicht mehr abrufbar. */
function removeFile(name) {
  if (!name) return;
  try { fs.rmSync(path.join(MEDIA_DIR, path.basename(name)), { force: true }); } catch { /* bleibt liegen, stört aber nicht */ }
}

async function receiveFile(req, name) {
  const ext = path.extname(name || '').toLowerCase();
  if (!EXT[ext]) fail(415, 'Dateityp nicht unterstützt. Erlaubt: MP4, WebM, MOV, M4V, JPG, PNG, WebP, GIF');
  if (Number(req.headers['content-length'] || 0) > MAX_UPLOAD) fail(413, 'Datei ist grösser als erlaubt');
  const file = crypto.randomBytes(16).toString('hex') + ext;
  const tmp = path.join(MEDIA_DIR, file + '.part');
  let size = 0;
  try {
    await pipeline(req, async function* (source) {
      for await (const chunk of source) {
        size += chunk.length;
        if (size > MAX_UPLOAD) throw new HttpError(413, 'Datei ist grösser als erlaubt');
        yield chunk;
      }
    }, fs.createWriteStream(tmp));
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e instanceof HttpError ? e : new HttpError(400, 'Hochladen abgebrochen');
  }
  if (!size) { fs.rmSync(tmp, { force: true }); fail(400, 'Leere Datei'); }
  fs.renameSync(tmp, path.join(MEDIA_DIR, file));
  return { file, size, type: EXT[ext][0], mime: EXT[ext][1] };
}

function resourceUsage(id) {
  const sequences = allSequences().filter((s) => s.items.some((i) => i.type === 'clip' && i.ref === id)).map((s) => s.name);
  const screens = q("SELECT name FROM screens WHERE content_kind = 'resource' AND content_id = ?").all(id).map((s) => s.name);
  return { sequences, screens };
}

// ───────────────────────── Sequenzen ─────────────────────────

const MAX_TRACK = 3; // Ebene 1 ist die Hauptspur (track 0), darüber bis zu drei Überlagerungen
const round2 = (n) => Math.round(n * 100) / 100;
const sec = (v, max, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? round2(Math.min(v, max)) : fallback);

/** Lage eines Eintrags auf der Zeitleiste. Fehlende Angaben (ältere Sequenzen) bekommen die Vorgaben. */
function timing(it, type) {
  const track = type === 'tag' ? 0 : Math.min(MAX_TRACK, Math.max(0, Math.trunc(Number(it.track)) || 0));
  return {
    area: it.area === 1 ? 1 : 0,   // 0: Bereich A, 1: Bereich B (nur wenn die Sequenz geteilt ist)
    track, start: track ? sec(it.start, 86400) : 0, offset: type === 'tag' ? 0 : sec(it.offset, 86400),
    speed: type !== 'tag' && Rules.SPEEDS.includes(it.speed) ? it.speed : null, // null: Vorgabe des Clips
    fadeIn: sec(it.fadeIn, 10, 0.5), fadeOut: sec(it.fadeOut, 10),
    tf: Rules.cleanTransform(it.tf)   // Position, Größe, Drehung; null: füllt den Bildschirm wie bisher
  };
}

function seqOut(row) {
  const items = parse(row.items, []);
  return {
    id: row.id, kind: row.kind, name: row.name, tags: parse(row.tags, []),
    items: row.kind === 'sequence' ? items.map((i) => ({ ...i, ...timing(i, i.type) })) : items,
    rule: parse(row.rule, {}), enabled: Boolean(row.enabled), created: row.created, updated: row.updated,
    split: row.kind === 'sequence' ? Rules.cleanSplit(parse(row.split, null)) : null
  };
}
const allSequences = () => q('SELECT * FROM sequences ORDER BY name COLLATE NOCASE').all().map(seqOut);
const getSeqRow = (id) => q('SELECT * FROM sequences WHERE id = ?').get(id) || fail(404, 'Sequenz nicht gefunden');

function cleanItems(kind, items) {
  if (!Array.isArray(items)) return [];
  const out = [];
  for (const it of items.slice(0, 500)) {
    if (!it || typeof it !== 'object') continue;
    const ref = str(it.ref, 64);
    if (!ref) continue;
    let type;
    if (kind === 'master') {
      const target = q('SELECT kind FROM sequences WHERE id = ?').get(ref);
      if (!target || target.kind !== 'sequence') continue;
      type = 'sequence';
    } else if (it.type === 'tag') {
      type = 'tag';
    } else {
      if (!q('SELECT id FROM resources WHERE id = ?').get(ref)) continue;
      type = 'clip';
    }
    const item = { id: str(it.id, 24) || newId(5), type, ref, duration: num(it.duration), rule: cleanRule(it.rule), enabled: it.enabled !== false };
    // Mastersequenz: "override" heisst, die Regel dieses Eintrags ersetzt an dieser Stelle die Ausstrahlung der Sequenz.
    out.push(kind === 'master' ? { ...item, override: it.override === true } : { ...item, ...timing(it, type) });
  }
  return out;
}

function seqUsage(id) {
  const masters = allSequences().filter((s) => s.kind === 'master' && s.items.some((i) => i.ref === id)).map((s) => s.name);
  const screens = q("SELECT name FROM screens WHERE content_kind IN ('sequence','master') AND content_id = ?").all(id).map((s) => s.name);
  return { sequences: masters, screens };
}

// ───────────────────────── Abspielliste auflösen ─────────────────────────

function resolvePlaylist(kind, id) {
  const clips = new Map(allResources().map((c) => [c.id, c]));
  const seqs = new Map(allSequences().map((s) => [s.id, s]));
  const entries = [], scenes = [];
  const nonEmpty = (rules) => rules.filter((r) => !Rules.isEmpty(r));

  // opt: { duration, offset, speed, fadeIn, fadeOut, tf, place: { scene, at, len } }
  function addClip(clip, rules, trail, opt = {}) {
    if (!clip || !clip.enabled) return;
    const isVideo = clip.type === 'video';
    entries.push({
      key: String(entries.length), clipId: clip.id, name: clip.name, type: clip.type, src: clip.src, thumb: clip.thumb,
      duration: isVideo ? (opt.duration || null) : Rules.clipLength(clip, opt.duration),
      length: isVideo ? clip.duration || null : null,
      offset: isVideo ? opt.offset || 0 : 0, speed: Rules.clipSpeed(clip, opt.speed), subs: clip.subtitles ? clip.subtitles.src : null,
      fadeIn: opt.fadeIn ?? 0.5, fadeOut: opt.fadeOut || 0, tf: opt.tf || null,
      fit: clip.fit, rules: nonEmpty([...rules, clip.rule]), ...trail, ...opt.place
    });
  }

  /* Eine Sequenz ist eine Szene: Die Hauptspur (track 0) wird zu Einträgen, die nacheinander laufen.
     Jeder Eintrag kennt seine Stelle "at" auf der Zeitleiste. Überlagerungen liegen mit fester Zeit darüber.
     Auch was gerade nicht läuft (ausgesetzt, Clip inaktiv) behält seinen Platz, damit die Zeiten zum Editor passen. */
  function addSequence(seq, rules, trail, override) {
    if (!seq || !seq.enabled || seq.kind !== 'sequence') return;
    // Übersteuert: Die eigene Ausstrahlung der Sequenz gilt an dieser Stelle nicht, es zählt die Regel des Eintrags in der Mastersequenz.
    const base = override ? [...rules] : [...rules, seq.rule];
    const t = { ...trail, seqId: seq.id, path: trail.path ? trail.path + ' › ' + seq.name : seq.name };
    const scene = scenes.length, overlays = [];
    // Geteilte Sequenz: Bereich B läuft mit eigener Hauptspur und eigenen Ebenen. Ohne Teilung zählt nur Bereich A.
    const split = seq.split || null;
    const areaOf = (item) => (split && item.area === 1 ? 1 : 0);
    const inUse = (item) => !(item.area === 1 && !split);
    let at = 0, atB = 0;
    const overlay = (clip, item, start, duration, area, track) => {
      if (!item.enabled || !clip.enabled) return;
      overlays.push({
        key: 'o' + scene + '.' + overlays.length, clipId: clip.id, name: clip.name, type: clip.type, src: clip.src, fit: clip.fit,
        track, area, start: round2(start), end: round2(start + Rules.clipLength(clip, duration, item.offset, item.speed)),
        offset: clip.type === 'video' ? item.offset : 0, speed: Rules.clipSpeed(clip, item.speed), subs: clip.subtitles ? clip.subtitles.src : null,
        fadeIn: item.fadeIn, fadeOut: item.fadeOut, tf: item.tf || null,
        rules: nonEmpty([...base, item.rule, clip.rule]), itemId: item.id
      });
    };
    const place = (clip, item, duration) => {
      const len = Rules.clipLength(clip, duration, item.offset, item.speed);
      if (areaOf(item) === 1) {
        // Hauptspur von Bereich B: lückenlos wie in A, gespielt als Ebene mit fester Zeit unter den Überlagerungen von B.
        if (clip.enabled) overlay(clip, item, atB, duration, 1, 0);
        atB += len;
        return;
      }
      if (item.enabled) {
        addClip(clip, [...base, item.rule], { ...t, itemId: item.id }, {
          duration, offset: item.offset, speed: item.speed, fadeIn: item.fadeIn, fadeOut: item.fadeOut, tf: item.tf,
          place: { scene, at: round2(at), len: round2(len) }
        });
      }
      at += len;
    };
    for (const item of seq.items) {
      if (!inUse(item)) continue;
      if (item.type === 'tag') {
        const tag = item.ref.toLowerCase();
        for (const clip of clips.values()) {
          if (clip.enabled && clip.tags.some((x) => x.toLowerCase() === tag)) place(clip, item, clip.type === 'video' ? null : item.duration);
        }
        continue;
      }
      const clip = clips.get(item.ref);
      if (item.type !== 'clip' || !clip) continue;
      if (!item.track) { place(clip, item, item.duration); continue; }
      overlay(clip, item, item.start, item.duration, areaOf(item), item.track);
    }
    // Die Sequenz dauert bis zum Ende des letzten Inhalts. Ragen Überlagerungen über die Hauptspur hinaus,
    // füllt ein leerer Eintrag die Zeit, damit sie zu Ende laufen.
    const end = Math.max(at, atB, ...overlays.map((o) => o.end));
    if (end > at + 0.05) {
      entries.push({
        key: String(entries.length), clipId: '', name: 'Überlagerungen', type: 'gap', src: '', thumb: '', duration: round2(end - at), length: null,
        offset: 0, speed: 1, subs: null, fadeIn: 0, fadeOut: 0, fit: 'contain', rules: nonEmpty(base), ...t, itemId: '', scene, at: round2(at), len: round2(end - at)
      });
    }
    scenes.push({ length: round2(end), overlays, split });
  }

  if (kind === 'resource') addClip(clips.get(id), [], { path: '' });
  else if (kind === 'sequence') addSequence(seqs.get(id), [], { path: '' });
  else if (kind === 'master') {
    const master = seqs.get(id);
    if (master && master.enabled && master.kind === 'master') {
      for (const item of master.items) {
        if (!item.enabled) continue;
        addSequence(seqs.get(item.ref), [master.rule, item.rule], { masterId: master.id, masterItemId: item.id, path: master.name }, item.override);
      }
    }
  }
  return { entries, scenes };
}

function playlistResponse(screen, { entries, scenes }) {
  const tz = timezone();
  const version = crypto.createHash('sha1').update(JSON.stringify([screen, entries, scenes, tz])).digest('hex').slice(0, 16);
  return { status: 'ok', screen, entries, scenes, version, serverTime: now(), tz };
}

// ───────────────────────── Bildschirme ─────────────────────────

const playerStreams = new Map(); // screenId -> Set(res)
const adminStreams = new Set();
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newCode() {
  for (;;) {
    let code = '';
    for (const b of crypto.randomBytes(6)) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
    if (!q('SELECT id FROM screens WHERE code = ?').get(code)) return code;
  }
}

function isOnline(row) {
  const set = playerStreams.get(row.id);
  return Boolean(set && set.size) || now() - row.last_seen < ONLINE_MS;
}

/** Soll der Fernseher laut Betriebszeiten an sein? Ungekoppelt immer, damit der Code sichtbar ist. */
function powerWanted(row) {
  return !row.paired || Rules.matches(parse(row.hours, {}), Rules.wallClock(now(), timezone()));
}
function powerOut(row) {
  const p = parse(row.power, {});
  return p.at && now() - p.at < POWER_MS ? { ...p, wanted: powerWanted(row) } : null;
}

function contentName(kind, id) {
  if (!kind || !id) return null;
  const row = kind === 'resource' ? q('SELECT name FROM resources WHERE id = ?').get(id) : q('SELECT name FROM sequences WHERE id = ?').get(id);
  return row ? row.name : null;
}

function screenOut(row) {
  const status = parse(row.status, {});
  const online = isOnline(row);
  return {
    id: row.id, name: row.name, key: row.token, tags: parse(row.tags, []),
    content: row.content_kind && row.content_id ? { kind: row.content_kind, id: row.content_id, name: contentName(row.content_kind, row.content_id) } : null,
    muted: Boolean(row.muted), rotation: row.rotation || 0, hours: parse(row.hours, {}),
    info: parse(row.info, {}), status, now: status.now || null,
    online, lastSeen: row.last_seen, created: row.created, ip: row.ip || parse(row.info, {}).ip || '',
    power: powerOut(row)
  };
}
function screensPayload() {
  return {
    screens: q('SELECT * FROM screens WHERE paired = 1 ORDER BY name COLLATE NOCASE').all().map(screenOut),
    pending: q('SELECT COUNT(*) AS n FROM screens WHERE paired = 0').get().n,
    serverTime: now()
  };
}
const getScreenRow = (id) => q('SELECT * FROM screens WHERE id = ? AND paired = 1').get(id) || fail(404, 'Bildschirm nicht gefunden');

function sse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive', 'X-Accel-Buffering': 'no'
  });
  res.write('retry: 5000\n\n');
}
function emit(res, event, data = '') {
  try { res.write(`event: ${event}\ndata: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`); } catch { /* Verbindung weg */ }
}

/** Signal an Player: einen bestimmten oder alle. */
function notifyPlayers(event = 'update', screenId = null) {
  for (const [id, set] of playerStreams) {
    if (screenId && id !== screenId) continue;
    for (const res of set) emit(res, event);
  }
}
/** Aktuellen Stand der Bildschirme an alle offenen Admin-Oberflächen. */
let adminTimer = null;
function notifyAdmins() {
  if (!adminStreams.size || adminTimer) return;
  adminTimer = setTimeout(() => {
    adminTimer = null;
    const payload = screensPayload();
    for (const res of adminStreams) emit(res, 'screens', payload);
  }, 80);
}
/** Inhalte haben sich geändert: Player holen neu, Admins sehen den neuen Stand. */
function changed() { notifyPlayers('update'); notifyAdmins(); }

function playerScreen(req, url) {
  const auth = String(req.headers.authorization || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : url.searchParams.get('key');
  if (!token) fail(401, 'Schlüssel fehlt');
  const row = q('SELECT * FROM screens WHERE token = ?').get(token) || fail(401, 'Unbekannter Bildschirm');
  // Letzte bekannte IP merken, damit sie auch offline noch sichtbar ist
  const ip = clientIp(req);
  if (ip && ip !== row.ip) {
    q('UPDATE screens SET ip=? WHERE id=?').run(ip, row.id);
    row.ip = ip;
    if (row.paired) notifyAdmins();
  }
  return row;
}

// ───────────────────────── Routen ─────────────────────────

const routes = [];
function route(method, pattern, access, handler) {
  const keys = [];
  const regex = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, regex, keys, access, handler });
}
const PUBLIC = 'public', ADMIN = 'admin';

// Anmeldung
route('GET', '/api/auth/state', PUBLIC, ({ req, res }) => {
  sendJson(res, 200, { setup: hasPassword(), loggedIn: isAdmin(req), fixedPassword: Boolean(ENV_PASSWORD) });
});
route('POST', '/api/auth/setup', PUBLIC, async ({ req, res }) => {
  if (hasPassword()) fail(403, 'Es ist bereits ein Passwort gesetzt');
  const { password } = await readJson(req);
  if (typeof password !== 'string' || password.length < 8) fail(400, 'Das Passwort braucht mindestens 8 Zeichen');
  setSetting('password', hashPassword(password));
  startSession(req, res);
  sendJson(res, 200, { ok: true });
});
route('POST', '/api/auth/login', PUBLIC, async ({ req, res }) => {
  const ip = clientIp(req);
  const entry = loginFails.get(ip);
  if (entry && entry.until > now()) fail(429, 'Zu viele Fehlversuche. Bitte eine Minute warten.');
  const { password } = await readJson(req);
  if (typeof password !== 'string' || !checkPassword(password)) {
    const count = (entry && entry.last > now() - 600000 ? entry.count : 0) + 1;
    loginFails.set(ip, { count: count >= 5 ? 0 : count, last: now(), until: count >= 5 ? now() + 60000 : 0 });
    fail(401, 'Falsches Passwort');
  }
  loginFails.delete(ip);
  startSession(req, res);
  sendJson(res, 200, { ok: true });
});
route('POST', '/api/auth/logout', PUBLIC, ({ req, res }) => {
  const id = cookies(req).koisignage_session;
  if (id) q('DELETE FROM sessions WHERE id = ?').run(id);
  res.setHeader('Set-Cookie', 'koisignage_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
  sendJson(res, 200, { ok: true });
});
route('POST', '/api/auth/password', ADMIN, async ({ req, res }) => {
  if (ENV_PASSWORD) fail(403, 'Das Passwort ist über ADMIN_PASSWORD fest vorgegeben');
  const { current, password } = await readJson(req);
  if (typeof current !== 'string' || !checkPassword(current)) fail(401, 'Das aktuelle Passwort stimmt nicht');
  if (typeof password !== 'string' || password.length < 8) fail(400, 'Das neue Passwort braucht mindestens 8 Zeichen');
  setSetting('password', hashPassword(password));
  q('DELETE FROM sessions WHERE id != ?').run(cookies(req).koisignage_session || '');
  sendJson(res, 200, { ok: true });
});

// Einstellungen
route('GET', '/api/settings', ADMIN, ({ res }) => sendJson(res, 200, { tz: timezone(), maxUploadMb: MAX_UPLOAD / 1048576 }));
route('PUT', '/api/settings', ADMIN, async ({ req, res }) => {
  const { tz } = await readJson(req);
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { fail(400, 'Unbekannte Zeitzone'); }
  setSetting('tz', tz);
  changed();
  sendJson(res, 200, { tz });
});

// Ressourcen
route('GET', '/api/resources', ADMIN, ({ res }) => sendJson(res, 200, allResources()));
route('POST', '/api/resources/upload', ADMIN, async ({ req, res, url }) => {
  const original = str(url.searchParams.get('name'), 200) || 'Datei';
  const f = await receiveFile(req, original);
  const id = newId();
  const duration = f.type === 'video' ? num(url.searchParams.get('duration')) : 10;
  q(`INSERT INTO resources (id, name, type, file, mime, size, duration, width, height, created, updated) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, original.replace(/\.[^.]+$/, ''), f.type, f.file, f.mime, f.size, duration, num(url.searchParams.get('width')), num(url.searchParams.get('height')), now(), now());
  changed();
  sendJson(res, 201, resourceOut(getResourceRow(id)));
});
route('POST', '/api/resources', ADMIN, async ({ req, res }) => {
  const body = await readJson(req);
  const link = str(body.url, 1000);
  if (!/^https?:\/\//i.test(link)) fail(400, 'Die Adresse muss mit http:// oder https:// beginnen');
  const id = newId();
  q(`INSERT INTO resources (id, name, type, url, duration, tags, created, updated) VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, str(body.name) || link, 'web', link, num(body.duration) || 30, JSON.stringify(cleanTags(body.tags)), now(), now());
  changed();
  sendJson(res, 201, resourceOut(getResourceRow(id)));
});
route('PUT', '/api/resources/:id', ADMIN, async ({ req, res, params }) => {
  const row = getResourceRow(params.id);
  const body = await readJson(req);
  const name = 'name' in body ? str(body.name) || row.name : row.name;
  const tags = 'tags' in body ? JSON.stringify(cleanTags(body.tags)) : row.tags;
  const rule = 'rule' in body ? JSON.stringify(cleanRule(body.rule)) : row.rule;
  const fit = body.fit === 'cover' || body.fit === 'contain' ? body.fit : row.fit;
  const enabled = 'enabled' in body ? (body.enabled ? 1 : 0) : row.enabled;
  const speed = row.type === 'video' && Rules.SPEEDS.includes(body.speed) ? body.speed : row.speed || 1;
  let duration = row.duration, link = row.url;
  if (row.type !== 'video' && 'duration' in body) duration = num(body.duration) || row.duration;
  if (row.type === 'web' && 'url' in body && /^https?:\/\//i.test(str(body.url, 1000))) link = str(body.url, 1000);
  q('UPDATE resources SET name=?, tags=?, rule=?, fit=?, speed=?, enabled=?, duration=?, url=?, updated=? WHERE id=?')
    .run(name, tags, rule, fit, speed, enabled, duration, link, now(), row.id);
  changed();
  sendJson(res, 200, resourceOut(getResourceRow(row.id)));
});
route('POST', '/api/resources/:id/file', ADMIN, async ({ req, res, url, params }) => {
  const row = getResourceRow(params.id);
  if (row.type === 'web') fail(400, 'Eine Webseite hat keine Datei');
  const f = await receiveFile(req, str(url.searchParams.get('name'), 200));
  const duration = f.type === 'video' ? num(url.searchParams.get('duration')) : (row.type === 'video' ? 10 : row.duration);
  q('UPDATE resources SET type=?, file=?, mime=?, size=?, duration=?, width=?, height=?, thumb=NULL, updated=? WHERE id=?')
    .run(f.type, f.file, f.mime, f.size, duration, num(url.searchParams.get('width')), num(url.searchParams.get('height')), now(), row.id);
  removeFile(row.file); removeFile(row.thumb);
  changed();
  sendJson(res, 200, resourceOut(getResourceRow(row.id)));
});
route('PUT', '/api/resources/:id/thumb', ADMIN, async ({ req, res, params }) => {
  const row = getResourceRow(params.id);
  const buf = await readBody(req, 2 * 1024 * 1024);
  if (buf.length < 100 || buf[0] !== 0xff || buf[1] !== 0xd8) fail(400, 'Das Vorschaubild muss ein JPEG sein');
  const file = crypto.randomBytes(16).toString('hex') + '.thumb.jpg';
  fs.writeFileSync(path.join(MEDIA_DIR, file), buf);
  q('UPDATE resources SET thumb=?, updated=? WHERE id=?').run(file, now(), row.id);
  removeFile(row.thumb);
  changed();
  sendJson(res, 200, resourceOut(getResourceRow(row.id)));
});
// Untertitel eines Videos: Die Datei kommt roh im Rumpf, gespeichert wird sie als WebVTT.
route('PUT', '/api/resources/:id/subtitles', ADMIN, async ({ req, res, url, params }) => {
  const row = getResourceRow(params.id);
  if (row.type !== 'video') fail(400, 'Untertitel gibt es nur für Videos');
  const name = str(url.searchParams.get('name'), 200);
  const ext = path.extname(name).toLowerCase();
  if (!SUBTITLE_EXT.includes(ext)) fail(415, 'Untertitelformat nicht unterstützt. Erlaubt: SRT, VTT, ASS, SSA, SBV');
  const { vtt, cues } = toVtt(await readBody(req, 2 * 1024 * 1024), ext);
  if (!cues) fail(400, 'In der Datei wurden keine Untertitel gefunden');
  const file = crypto.randomBytes(16).toString('hex') + '.vtt';
  fs.writeFileSync(path.join(MEDIA_DIR, file), vtt);
  q('UPDATE resources SET subs=?, subs_name=?, updated=? WHERE id=?').run(file, name, now(), row.id);
  removeFile(row.subs);
  changed();
  sendJson(res, 200, { ...resourceOut(getResourceRow(row.id)), cues });
});
route('DELETE', '/api/resources/:id/subtitles', ADMIN, ({ res, params }) => {
  const row = getResourceRow(params.id);
  q('UPDATE resources SET subs=NULL, subs_name=NULL, updated=? WHERE id=?').run(now(), row.id);
  removeFile(row.subs);
  changed();
  sendJson(res, 200, resourceOut(getResourceRow(row.id)));
});
route('DELETE', '/api/resources/:id', ADMIN, ({ res, url, params }) => {
  const row = getResourceRow(params.id);
  const usage = resourceUsage(row.id);
  if ((usage.sequences.length || usage.screens.length) && url.searchParams.get('force') !== '1') {
    fail(409, 'Die Ressource wird noch verwendet', { usage });
  }
  for (const seq of allSequences()) {
    const items = seq.items.filter((i) => !(i.type === 'clip' && i.ref === row.id));
    if (items.length !== seq.items.length) q('UPDATE sequences SET items=?, updated=? WHERE id=?').run(JSON.stringify(items), now(), seq.id);
  }
  q("UPDATE screens SET content_kind=NULL, content_id=NULL WHERE content_kind='resource' AND content_id=?").run(row.id);
  q('DELETE FROM resources WHERE id=?').run(row.id);
  removeFile(row.file); removeFile(row.thumb); removeFile(row.subs);
  changed();
  sendJson(res, 200, { ok: true });
});

// Tags: über alle Ressourcen, Sequenzen, Mastersequenzen und Bildschirme umbenennen oder entfernen
/** Ändert einen Tag überall. to: neuer Name, null entfernt ihn. Gross- und Kleinschreibung zählen nicht. */
function retag(from, to) {
  const low = from.toLowerCase();
  let count = 0;
  for (const table of ['resources', 'sequences', 'screens']) {
    for (const row of q(`SELECT id, tags FROM ${table}`).all()) {
      const tags = parse(row.tags, []);
      if (!tags.some((t) => t.toLowerCase() === low)) continue;
      const next = to ? tags.map((t) => (t.toLowerCase() === low ? to : t)) : tags.filter((t) => t.toLowerCase() !== low);
      q(`UPDATE ${table} SET tags = ? WHERE id = ?`).run(JSON.stringify(cleanTags(next)), row.id);
      count++;
    }
  }
  // Tag-Einträge in Sequenzen folgen dem neuen Namen; beim Entfernen bleiben sie stehen und zeigen nichts mehr.
  if (to) {
    for (const row of q("SELECT id, items FROM sequences WHERE kind = 'sequence'").all()) {
      const items = parse(row.items, []);
      let hit = false;
      for (const it of items) if (it.type === 'tag' && String(it.ref).toLowerCase() === low) { it.ref = to; hit = true; }
      if (hit) q('UPDATE sequences SET items = ? WHERE id = ?').run(JSON.stringify(items), row.id);
    }
  }
  changed();
  return count;
}
route('POST', '/api/tags/rename', ADMIN, async ({ req, res }) => {
  const body = await readJson(req);
  const from = str(body.from, 30), to = str(body.to, 30);
  if (!from || !to) fail(400, 'Alter und neuer Name des Tags fehlen');
  sendJson(res, 200, { changed: retag(from, to) });
});
route('POST', '/api/tags/delete', ADMIN, async ({ req, res }) => {
  const name = str((await readJson(req)).name, 30);
  if (!name) fail(400, 'Name des Tags fehlt');
  sendJson(res, 200, { changed: retag(name, null) });
});

// Sequenzen und Mastersequenzen
route('GET', '/api/sequences', ADMIN, ({ res }) => sendJson(res, 200, allSequences()));
route('POST', '/api/sequences', ADMIN, async ({ req, res }) => {
  const body = await readJson(req);
  const kind = body.kind === 'master' ? 'master' : 'sequence';
  const id = newId();
  q('INSERT INTO sequences (id, kind, name, tags, items, rule, split, created, updated) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, kind, str(body.name) || (kind === 'master' ? 'Neue Mastersequenz' : 'Neue Sequenz'), JSON.stringify(cleanTags(body.tags)),
      JSON.stringify(cleanItems(kind, body.items)), JSON.stringify(cleanRule(body.rule)), kind === 'sequence' ? JSON.stringify(Rules.cleanSplit(body.split)) : '', now(), now());
  changed();
  sendJson(res, 201, seqOut(getSeqRow(id)));
});
route('PUT', '/api/sequences/:id', ADMIN, async ({ req, res, params }) => {
  const row = getSeqRow(params.id);
  const body = await readJson(req);
  q('UPDATE sequences SET split=? WHERE id=?').run('split' in body && row.kind === 'sequence' ? JSON.stringify(Rules.cleanSplit(body.split)) : row.split, row.id);
  q('UPDATE sequences SET name=?, tags=?, items=?, rule=?, enabled=?, updated=? WHERE id=?').run(
    'name' in body ? str(body.name) || row.name : row.name,
    'tags' in body ? JSON.stringify(cleanTags(body.tags)) : row.tags,
    'items' in body ? JSON.stringify(cleanItems(row.kind, body.items)) : row.items,
    'rule' in body ? JSON.stringify(cleanRule(body.rule)) : row.rule,
    'enabled' in body ? (body.enabled ? 1 : 0) : row.enabled, now(), row.id);
  changed();
  sendJson(res, 200, seqOut(getSeqRow(row.id)));
});
route('POST', '/api/sequences/:id/duplicate', ADMIN, ({ res, params }) => {
  const row = getSeqRow(params.id);
  const id = newId();
  const items = parse(row.items, []).map((i) => ({ ...i, id: newId(5) }));
  q('INSERT INTO sequences (id, kind, name, tags, items, rule, split, enabled, created, updated) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(id, row.kind, row.name + ' (Kopie)', row.tags, JSON.stringify(items), row.rule, row.split || '', row.enabled, now(), now());
  sendJson(res, 201, seqOut(getSeqRow(id)));
});
route('DELETE', '/api/sequences/:id', ADMIN, ({ res, url, params }) => {
  const row = getSeqRow(params.id);
  const usage = seqUsage(row.id);
  if ((usage.sequences.length || usage.screens.length) && url.searchParams.get('force') !== '1') {
    fail(409, 'Die Sequenz wird noch verwendet', { usage });
  }
  for (const seq of allSequences()) {
    if (seq.kind !== 'master') continue;
    const items = seq.items.filter((i) => i.ref !== row.id);
    if (items.length !== seq.items.length) q('UPDATE sequences SET items=?, updated=? WHERE id=?').run(JSON.stringify(items), now(), seq.id);
  }
  q("UPDATE screens SET content_kind=NULL, content_id=NULL WHERE content_kind IN ('sequence','master') AND content_id=?").run(row.id);
  q('DELETE FROM sequences WHERE id=?').run(row.id);
  changed();
  sendJson(res, 200, { ok: true });
});

// Bildschirme
route('GET', '/api/screens', ADMIN, ({ res }) => sendJson(res, 200, screensPayload()));
route('POST', '/api/screens/pair', ADMIN, async ({ req, res }) => {
  const body = await readJson(req);
  const code = str(body.code, 12).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const row = code && q('SELECT * FROM screens WHERE code = ? AND paired = 0').get(code);
  if (!row) fail(404, 'Kein wartendes Gerät mit diesem Code. Steht der Code noch am Bildschirm?');
  q('UPDATE screens SET paired=1, name=?, code=NULL WHERE id=?').run(str(body.name) || 'Bildschirm', row.id);
  notifyPlayers('update', row.id);
  notifyAdmins();
  sendJson(res, 200, screenOut(getScreenRow(row.id)));
});
route('PUT', '/api/screens/:id', ADMIN, async ({ req, res, params }) => {
  const row = getScreenRow(params.id);
  const body = await readJson(req);
  let kind = row.content_kind, cid = row.content_id;
  if ('content' in body) {
    const c = body.content;
    if (c && ['resource', 'sequence', 'master'].includes(c.kind) && contentName(c.kind, str(c.id, 64)) !== null) { kind = c.kind; cid = str(c.id, 64); }
    else { kind = null; cid = null; }
  }
  const rotation = [0, 90, 180, 270].includes(Number(body.rotation)) ? Number(body.rotation) : row.rotation;
  q('UPDATE screens SET name=?, tags=?, content_kind=?, content_id=?, muted=?, rotation=?, hours=? WHERE id=?').run(
    'name' in body ? str(body.name) || row.name : row.name,
    'tags' in body ? JSON.stringify(cleanTags(body.tags)) : row.tags,
    kind, cid, 'muted' in body ? (body.muted ? 1 : 0) : row.muted, rotation,
    'hours' in body ? JSON.stringify(cleanRule(body.hours)) : row.hours, row.id);
  notifyPlayers('update', row.id);
  notifyAdmins();
  sendJson(res, 200, screenOut(getScreenRow(row.id)));
});
route('POST', '/api/screens/:id/reload', ADMIN, ({ res, params }) => {
  const row = getScreenRow(params.id);
  notifyPlayers('reload', row.id);
  sendJson(res, 200, { ok: true, delivered: Boolean(playerStreams.get(row.id)?.size) });
});
route('DELETE', '/api/screens/:id', ADMIN, ({ res, params }) => {
  const row = getScreenRow(params.id);
  q('DELETE FROM screens WHERE id=?').run(row.id);
  notifyPlayers('update', row.id);
  notifyAdmins();
  sendJson(res, 200, { ok: true });
});

// Vorschau und Live-Kanal der Admin-Oberfläche
route('GET', '/api/preview/playlist', ADMIN, ({ res, url }) => {
  const resolved = resolvePlaylist(url.searchParams.get('kind'), url.searchParams.get('id'));
  sendJson(res, 200, playlistResponse({ name: 'Vorschau', muted: true, rotation: 0, hours: {} }, resolved));
});
route('GET', '/api/events', ADMIN, ({ req, res }) => {
  sse(res);
  adminStreams.add(res);
  emit(res, 'screens', screensPayload());
  req.on('close', () => adminStreams.delete(res));
});

// Player
route('POST', '/api/player/register', PUBLIC, async ({ req, res }) => {
  const ip = clientIp(req);
  const recent = (registrations.get(ip) || []).filter((t) => t > now() - 3600000);
  if (recent.length >= 20) fail(429, 'Zu viele Anmeldungen von dieser Adresse');
  recent.push(now());
  registrations.set(ip, recent);
  const body = await readJson(req);
  const id = newId(), token = crypto.randomBytes(24).toString('base64url'), code = newCode();
  const info = { ua: str(body.ua, 300), res: str(body.res, 20), ip };
  q('INSERT INTO screens (id, code, token, paired, info, ip, created, last_seen) VALUES (?,?,?,?,?,?,?,?)').run(id, code, token, 0, JSON.stringify(info), ip, now(), now());
  notifyAdmins();
  sendJson(res, 201, { key: token, code });
});
route('GET', '/api/player/playlist', PUBLIC, ({ req, res, url }) => {
  const row = playerScreen(req, url);
  q('UPDATE screens SET last_seen=? WHERE id=?').run(now(), row.id);
  if (!row.paired) return sendJson(res, 200, { status: 'pending', code: row.code });
  const screen = { name: row.name, muted: Boolean(row.muted), rotation: row.rotation || 0, hours: parse(row.hours, {}) };
  const resolved = row.content_kind ? resolvePlaylist(row.content_kind, row.content_id) : { entries: [], scenes: [] };
  sendJson(res, 200, playlistResponse(screen, resolved));
});
route('POST', '/api/player/heartbeat', PUBLIC, async ({ req, res, url }) => {
  const row = playerScreen(req, url);
  const body = await readJson(req);
  const n = body.now && typeof body.now === 'object' ? body.now : null;
  const status = {
    now: n ? {
      key: str(n.key, 12), clipId: str(n.clipId, 64), name: str(n.name), path: str(n.path, 400), type: str(n.type, 10),
      seqId: str(n.seqId, 64), itemId: str(n.itemId, 24), masterId: str(n.masterId, 64), masterItemId: str(n.masterItemId, 24),
      startedAt: Number(n.startedAt) || now(), duration: num(n.duration), offset: num(n.offset) || 0, speed: num(n.speed) || 1, index: Number(n.index) || 0, total: Number(n.total) || 0
    } : null,
    idle: str(body.idle, 40), cache: body.cache && typeof body.cache === 'object' ? { done: Number(body.cache.done) || 0, total: Number(body.cache.total) || 0 } : null,
    offlineReady: Boolean(body.offlineReady), res: str(body.res, 20), error: str(body.error, 300), version: str(body.version, 20)
  };
  const wasOnline = isOnline(row);
  const before = parse(row.status, {});
  q('UPDATE screens SET status=?, last_seen=? WHERE id=?').run(JSON.stringify(status), now(), row.id);
  const sameClip = before.now && status.now && before.now.key === status.now.key && before.now.startedAt === status.now.startedAt;
  if (!wasOnline || !sameClip || JSON.stringify(before.cache) !== JSON.stringify(status.cache) || before.idle !== status.idle) notifyAdmins();
  sendJson(res, 200, { ok: true, serverTime: now() });
});
// HDMI-Schaltung am Gerät (Raspberry Pi): meldet ihren Stand und erfährt, ob der Fernseher an sein soll.
route('POST', '/api/player/power', PUBLIC, async ({ req, res, url }) => {
  const row = playerScreen(req, url);
  const body = await readJson(req);
  const before = parse(row.power, {});
  const power = { at: now(), state: str(body.state, 10), via: str(body.via, 10), tv: str(body.tv, 20), error: str(body.error, 200) };
  q('UPDATE screens SET power=? WHERE id=?').run(JSON.stringify(power), row.id);
  const fresh = before.at && now() - before.at < POWER_MS;
  if (row.paired && (!fresh || ['state', 'via', 'tv', 'error'].some((k) => (before[k] || '') !== power[k]))) notifyAdmins();
  sendJson(res, 200, { on: powerWanted(row), serverTime: now() });
});
route('GET', '/api/player/events', PUBLIC, ({ req, res, url }) => {
  const row = playerScreen(req, url);
  sse(res);
  if (!playerStreams.has(row.id)) playerStreams.set(row.id, new Set());
  playerStreams.get(row.id).add(res);
  notifyAdmins();
  req.on('close', () => {
    const set = playerStreams.get(row.id);
    if (set) { set.delete(res); if (!set.size) playerStreams.delete(row.id); }
    notifyAdmins();
  });
});

// ───────────────────────── Dateien ausliefern ─────────────────────────

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json'
};

function sendFile(req, res, file, type, cacheControl) {
  let stat;
  try { stat = fs.statSync(file); } catch { stat = null; }
  if (!stat || !stat.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Nicht gefunden'); }
  const headers = { 'Content-Type': type, 'Cache-Control': cacheControl, 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff' };
  let start = 0, end = stat.size - 1, status = 200;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
  if (m && (m[1] || m[2])) {
    if (m[1]) { start = Number(m[1]); if (m[2]) end = Math.min(Number(m[2]), end); }
    else { start = Math.max(0, stat.size - Number(m[2])); }
    if (start > end || start >= stat.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      return res.end();
    }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
  }
  headers['Content-Length'] = end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(file, { start, end });
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

function serveStatic(req, res, pathname) {
  if (pathname === '/') { res.writeHead(302, { Location: '/admin/' }); return res.end(); }
  if (pathname === '/admin' || pathname === '/player') { res.writeHead(302, { Location: pathname + '/' }); return res.end(); }
  if (pathname.startsWith('/media/')) {
    const name = path.basename(pathname);
    const ext = path.extname(name).toLowerCase();
    const type = ext === '.vtt' ? 'text/vtt; charset=utf-8' : EXT[ext] ? EXT[ext][1] : 'application/octet-stream';
    return sendFile(req, res, path.join(MEDIA_DIR, name), type, 'public, max-age=31536000, immutable');
  }
  let rel = path.normalize(pathname).replace(/^([/\\])+/, '');
  if (pathname.endsWith('/')) rel = path.join(rel, 'index.html');
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  sendFile(req, res, file, STATIC_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'no-cache');
}

// ───────────────────────── Server ─────────────────────────

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400); return res.end(); }
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end(); }

  if (!pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    return serveStatic(req, res, pathname);
  }
  try {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.regex.exec(pathname);
      if (!m) continue;
      if (r.access === ADMIN && !isAdmin(req)) fail(401, 'Nicht angemeldet');
      const params = {};
      r.keys.forEach((k, i) => { params[k] = m[i + 1]; });
      return await r.handler({ req, res, url, params });
    }
    fail(404, 'Unbekannter Endpunkt');
  } catch (e) {
    if (res.headersSent) return res.destroy();
    if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message, ...(e.extra || {}) });
    console.error(e);
    sendJson(res, 500, { error: 'Interner Fehler' });
  }
});
server.requestTimeout = 0; // grosse Uploads und offene Live-Kanäle nicht abschneiden

// Lebenszeichen für offene Live-Kanäle, Online-Wechsel erkennen, aufräumen
let lastOnline = '';
setInterval(() => {
  for (const set of playerStreams.values()) for (const res of set) { try { res.write(': ping\n\n'); } catch { /* weg */ } }
  for (const res of adminStreams) { try { res.write(': ping\n\n'); } catch { /* weg */ } }
  const online = q('SELECT * FROM screens WHERE paired = 1').all().map((r) => r.id + ':' + isOnline(r) + ':' + Boolean(powerOut(r))).join(',');
  if (online !== lastOnline) { lastOnline = online; notifyAdmins(); }
}, 20000).unref();
setInterval(() => {
  q('DELETE FROM screens WHERE paired = 0 AND created < ?').run(now() - 86400000);
  q('DELETE FROM sessions WHERE expires < ?').run(now());
}, 3600000).unref();

server.listen(PORT, HOST, () => {
  console.log(`KoiSignage läuft auf http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`Verwaltung: /admin/   Player: /player/   Daten: ${DATA_DIR}`);
  if (!hasPassword()) console.log('Noch kein Admin-Passwort gesetzt. Beim ersten Aufruf der Verwaltung festlegen.');
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { try { db.close(); } catch { /* egal */ } process.exit(0); });
