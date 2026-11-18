// KoiSignage – Untertitel. Liest die gängigen Formate und schreibt WebVTT, das einzige Format, das Browser am Video anzeigen.
// Unterstützt: SubRip (.srt), WebVTT (.vtt), SubStation Alpha (.ass, .ssa), YouTube SubViewer (.sbv).

export const SUBTITLE_EXT = ['.srt', '.vtt', '.ass', '.ssa', '.sbv'];
const MAX_CUES = 20000;

/** Bytes einer Untertiteldatei zu Text. Viele Dateien sind nicht UTF-8, sondern UTF-16 oder Windows-1252. */
export function decode(input) {
  const buf = Buffer.from(input);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const body = Buffer.from(buf.subarray(2, buf.length - (buf.length % 2)));
    return body.swap16().toString('utf16le');
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { /* kein UTF-8 */ }
  try { return new TextDecoder('windows-1252').decode(buf); } catch { return buf.toString('latin1'); }
}

/** "1:02:03,450", "02:03.45" oder "0:00:01.50" in Sekunden; null, wenn es keine Zeitangabe ist. */
function seconds(text) {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(String(text).trim());
  if (!m) return null;
  return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + (m[4] ? Number(m[4].padEnd(3, '0')) / 1000 : 0);
}

/** SubRip und WebVTT: Blöcke mit einer Zeile "Anfang --> Ende", darunter der Text. */
function parseArrow(text) {
  const cues = [];
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split('\n');
    const i = lines.findIndex((l) => l.includes('-->'));
    const m = i >= 0 && /^\s*(\S+)\s+-->\s+(\S+)(.*)$/.exec(lines[i]);
    if (!m) continue;
    const start = seconds(m[1]), end = seconds(m[2]);
    if (start === null || end === null) continue;
    // Angaben zur Lage kennt nur WebVTT ("line:10% align:start"). Die Koordinaten mancher SRT-Dateien verstehen Browser nicht.
    const settings = /^(\s+(vertical|line|position|size|align):\S+)+\s*$/.test(m[3]) ? m[3].trim() : '';
    cues.push({ start, end, settings, text: lines.slice(i + 1).join('\n') });
  }
  return cues;
}

/** YouTube SubViewer: Zeile "0:00:01.000,0:00:04.000", darunter der Text. */
function parseSbv(text) {
  const cues = [];
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split('\n');
    const m = /^\s*(\d+:\d{1,2}:\d{1,2}\.\d{1,3})\s*,\s*(\d+:\d{1,2}:\d{1,2}\.\d{1,3})\s*$/.exec(lines[0]);
    if (m) cues.push({ start: seconds(m[1]), end: seconds(m[2]), settings: '', text: lines.slice(1).join('\n') });
  }
  return cues;
}

/** SubStation Alpha: Abschnitt [Events] mit Zeilen "Dialogue: …". Die Zeile "Format:" nennt die Reihenfolge der Felder. */
function parseAss(text) {
  const cues = [];
  let fields = ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
  let inEvents = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (/^\[.*\]$/.test(line)) { inEvents = /^\[events\]$/i.test(line); continue; }
    const m = inEvents && /^(\w+):\s*(.*)$/.exec(line);
    if (!m) continue;
    if (/^format$/i.test(m[1])) { fields = m[2].split(',').map((f) => f.trim().toLowerCase()); continue; }
    if (!/^dialogue$/i.test(m[1])) continue;
    const parts = m[2].split(',');
    // Der Text ist das letzte Feld und darf selbst Kommas enthalten.
    const values = [...parts.slice(0, fields.length - 1), parts.slice(fields.length - 1).join(',')];
    const get = (name) => values[fields.indexOf(name)] ?? '';
    const start = seconds(get('start')), end = seconds(get('end'));
    if (start === null || end === null) continue;
    const body = get('text')
      .replace(/\{[^}]*\\p[1-9][^}]*\}.*?(\{[^}]*\\p0[^}]*\}|$)/g, '')   // Zeichnungen sind kein Text
      .replace(/\{([^}]*)\}/g, (_, tags) => (tags.match(/\\[ibu][01](?![0-9])/g) || []).map((t) => (t[2] === '1' ? '<' : '</') + t[1] + '>').join(''))
      .replace(/\\N/g, '\n').replace(/\\n/g, ' ').replace(/\\h/g, ' ');
    cues.push({ start, end, settings: '', text: body });
  }
  return cues;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', nbsp: ' ', lrm: '', rlm: '' };

/** Text eines Untertitels für WebVTT: kursiv, fett und unterstrichen bleiben, alles andere an Formatierung fällt weg. */
function clean(text) {
  return text
    .replace(/\{\\[^}]*\}/g, '')                                                       // Befehle wie {\an8}
    .replace(/<(\/?)([ibu])>/gi, (_, close, tag) => '\u0001' + close + tag.toLowerCase() + '\u0002')
    .replace(/<[^>\n]*>/g, '')                                                         // <font>, <v Name>, <c.klasse>, Zeitmarken
    .replace(/&(amp|lt|gt|nbsp|lrm|rlm);/g, (_, name) => ENTITIES[name])
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\u0001(\/?[ibu])\u0002/g, '<$1>')
    .split('\n').map((line) => line.trim()).filter(Boolean).join('\n');
}

function stamp(sec) {
  const ms = Math.round(sec * 1000);
  const two = (n) => String(n).padStart(2, '0');
  return two(Math.floor(ms / 3600000)) + ':' + two(Math.floor((ms % 3600000) / 60000)) + ':' + two(Math.floor((ms % 60000) / 1000)) + '.' + String(ms % 1000).padStart(3, '0');
}

/** Wandelt eine Untertiteldatei in WebVTT um. ext ist die Dateiendung mit Punkt. Liefert { vtt, cues }; cues ist die Zahl der Untertitel. */
export function toVtt(input, ext) {
  const text = decode(input).replace(/\r\n?/g, '\n').replace(/^[ \t]+$/gm, '');
  // Zuerst das Format der Endung versuchen, dann die anderen: Falsch benannte Dateien kommen vor.
  const order = ext === '.ass' || ext === '.ssa' ? [parseAss, parseArrow, parseSbv] : ext === '.sbv' ? [parseSbv, parseArrow, parseAss] : [parseArrow, parseAss, parseSbv];
  let cues = [];
  for (const parse of order) {
    cues = parse(text).map((c) => ({ ...c, text: clean(c.text) })).filter((c) => c.text && c.end > c.start);
    if (cues.length) break;
  }
  cues = cues.sort((a, b) => a.start - b.start).slice(0, MAX_CUES);
  const body = cues.map((c) => stamp(c.start) + ' --> ' + stamp(c.end) + (c.settings ? ' ' + c.settings : '') + '\n' + c.text).join('\n\n');
  return { vtt: 'WEBVTT\n\n' + body + '\n', cues: cues.length };
}
