// Tests ohne Fremdpakete:  npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../server/public/shared/rules.js';
import { toVtt } from '../server/subtitles.js';

const R = globalThis.KoiSignageRules;
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// ───────── Regeln ─────────

test('Regel: leer gilt immer', () => {
  assert.equal(R.matches({}, { date: '2027-01-01', day: 5, minutes: 0 }), true);
  assert.equal(R.matches(null, { date: '2027-01-01', day: 5, minutes: 0 }), true);
});

test('Regel: Datum, Wochentag und Uhrzeit sind UND-verknüpft', () => {
  const rule = { from: '2027-06-01', to: '2027-08-31', days: [1, 3, 5], start: '08:00', end: '12:00' };
  assert.equal(R.matches(rule, { date: '2027-06-02', day: 3, minutes: 9 * 60 }), true);
  assert.equal(R.matches(rule, { date: '2027-06-02', day: 3, minutes: 12 * 60 }), false, 'Bis-Uhrzeit ist ausgeschlossen');
  assert.equal(R.matches(rule, { date: '2027-06-03', day: 4, minutes: 9 * 60 }), false, 'Donnerstag');
  assert.equal(R.matches(rule, { date: '2027-05-31', day: 1, minutes: 9 * 60 }), false, 'vor dem Zeitraum');
  assert.equal(R.matches(rule, { date: '2027-08-31', day: 1, minutes: 8 * 60 }), true, 'letzter Tag zählt mit');
});

test('Regel: Fenster über Mitternacht zählt zum Starttag', () => {
  const rule = { days: [5], start: '22:00', end: '02:00' };
  assert.equal(R.matches(rule, { date: '2027-06-04', day: 5, minutes: 23 * 60 }), true, 'Freitag 23 Uhr');
  assert.equal(R.matches(rule, { date: '2027-06-05', day: 6, minutes: 60 }), true, 'Samstag 1 Uhr gehört zum Freitag');
  assert.equal(R.matches(rule, { date: '2027-06-05', day: 6, minutes: 23 * 60 }), false, 'Samstag 23 Uhr');
  assert.equal(R.matches(rule, { date: '2027-06-04', day: 5, minutes: 60 }), false, 'Freitag 1 Uhr gehört zum Donnerstag');
});

test('Wanduhr: Zeitzone und Sommerzeit', () => {
  const winter = R.wallClock(Date.UTC(2027, 0, 4, 11, 30), 'Europe/Vienna'); // Montag
  assert.deepEqual(winter, { date: '2027-01-04', day: 1, minutes: 12 * 60 + 30 });
  const summer = R.wallClock(Date.UTC(2027, 6, 4, 22, 30), 'Europe/Vienna'); // Sonntag 22:30 UTC = Montag 00:30
  assert.deepEqual(summer, { date: '2027-07-05', day: 1, minutes: 30 });
});

test('Bereiche: Teilungslinie als Ausschnitt', () => {
  assert.equal(R.splitClip(null, 0), '');
  assert.equal(R.splitClip({ pos: 0.5, angle: 0 }, 0, 16 / 9), 'polygon(0% 0%, 50% 0%, 50% 100%, 0% 100%)');
  assert.equal(R.splitClip({ pos: 0.3, angle: 90 }, 1, 16 / 9), 'polygon(100% 30%, 100% 100%, 0% 100%, 0% 30%)');
  // 45 Grad in echten Seitenverhältnissen: auf 16:9 schneidet die Linie oben und unten
  assert.deepEqual(R.splitPolygon({ pos: 0.5, angle: 45 }, 0, 16 / 9), [[0, 0], [78.13, 0], [21.87, 100], [0, 100]]);
  assert.deepEqual(R.cleanSplit({ pos: -1, angle: 400 }), { pos: 0.05, angle: 90 });
});

test('Transformation: Position, Größe und Drehung', () => {
  assert.equal(R.cleanTransform(null), null);
  assert.equal(R.cleanTransform({ x: 50, y: 50, scale: 100, rotate: 0 }), null, 'unverändert heisst null');
  assert.deepEqual(R.cleanTransform({ x: 25, scale: 1000, rotate: -180, y: 'x' }), { x: 25, y: 50, scale: 400, rotate: 180 });
  assert.equal(R.transformCss(null), '');
  assert.equal(R.transformCss({ x: 75, y: 25, scale: 50, rotate: 30 }), 'translate(25%, -25%) rotate(30deg) scale(0.5)');
});

test('Beschreibung einer Regel', () => {
  assert.equal(R.describe({}), '');
  assert.equal(R.describe({ days: [1, 2, 3, 4, 5], start: '08:00', end: '12:00', to: '2027-08-31' }), 'Mo–Fr, 08:00–12:00, bis 31.08.2027');
});

test('Länge auf der Zeitleiste: Dauer, abgeschnittener Anfang, Geschwindigkeit', () => {
  const video = { type: 'video', duration: 20, speed: 1 };
  assert.equal(R.clipLength(video), 20);
  assert.equal(R.clipLength(video, 5), 5);
  assert.equal(R.clipLength(video, 50), 20, 'nicht länger als der Film');
  assert.equal(R.clipLength(video, null, 4), 16, 'Anfang abgeschnitten');
  assert.equal(R.clipLength(video, null, 4, 2), 8, 'doppelte Geschwindigkeit halbiert die Laufzeit');
  assert.equal(R.clipLength({ ...video, speed: 0.5 }), 40, 'Vorgabe des Clips');
  assert.equal(R.clipLength({ ...video, speed: 0.5 }, null, 0, 1), 20, 'der Eintrag übersteuert den Clip');
  assert.equal(R.clipLength({ type: 'image', duration: 10 }, 7), 7);
  assert.equal(R.clipLength({ type: 'image', duration: 10, speed: 2 }, null, 0, 2), 10, 'Bilder kennen keine Geschwindigkeit');
  assert.equal(R.clipLength(undefined), 0, 'gelöschter Clip');
});

// ───────── Untertitel ─────────

test('Untertitel: SubRip mit Formatierung wird zu WebVTT', () => {
  const srt = '1\r\n00:00:01,000 --> 00:00:03,500\r\n<i>Hallo</i> <font color="#ffffff">Welt</font>\r\nzweite Zeile & mehr\r\n\r\n2\r\n00:00:04,000 --> 00:00:05,000 X1:10 X2:20\r\n{\\an8}Oben\r\n';
  const out = toVtt(Buffer.from(srt), '.srt');
  assert.equal(out.cues, 2);
  assert.equal(out.vtt, 'WEBVTT\n\n00:00:01.000 --> 00:00:03.500\n<i>Hallo</i> Welt\nzweite Zeile &amp; mehr\n\n00:00:04.000 --> 00:00:05.000\nOben\n');
});

test('Untertitel: WebVTT behält Lage-Angaben, verliert Kopf, Notizen und Sprecher-Tags', () => {
  const vtt = 'WEBVTT - Titel\n\nNOTE Kommentar\n\nSTYLE\n::cue { color: red }\n\nintro\n00:01.000 --> 00:02.500 line:10% align:start\n<v Anna>Guten Tag &amp; willkommen\n\n01:00:00.000 --> 01:00:01.000\nspät\n';
  const out = toVtt(Buffer.from(vtt), '.vtt');
  assert.equal(out.vtt, 'WEBVTT\n\n00:00:01.000 --> 00:00:02.500 line:10% align:start\nGuten Tag &amp; willkommen\n\n01:00:00.000 --> 01:00:01.000\nspät\n');
});

test('Untertitel: SubStation Alpha und SubViewer', () => {
  const ass = ['[Script Info]', 'Title: Probe', '', '[V4+ Styles]', 'Format: Name, Fontname', 'Style: Default,Arial', '', '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Dialogue: 0,0:00:05.00,0:00:07.50,Default,,0,0,0,,{\\i1}Später{\\i0}, mit Komma\\Nneue Zeile',
    'Comment: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,nicht zeigen',
    'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\pos(10,10)}Zuerst'].join('\n');
  const expected = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nZuerst\n\n00:00:05.000 --> 00:00:07.500\n<i>Später</i>, mit Komma\nneue Zeile\n';
  assert.equal(toVtt(Buffer.from(ass), '.ass').vtt, expected, 'nach Zeit sortiert, Kommentar ausgelassen');
  assert.equal(toVtt(Buffer.from(ass), '.srt').vtt, expected, 'falsche Endung: am Inhalt erkannt');

  const sbv = '0:00:01.000,0:00:03.000\nHallo SBV\n\n0:00:03.500,0:00:05.000\nZweite\n';
  assert.equal(toVtt(Buffer.from(sbv), '.sbv').vtt, 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHallo SBV\n\n00:00:03.500 --> 00:00:05.000\nZweite\n');
});

test('Untertitel: Zeichensätze und unbrauchbare Dateien', () => {
  const text = '1\n00:00:01,000 --> 00:00:02,000\nGrüße aus Köln\n';
  const expected = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nGrüße aus Köln\n';
  assert.equal(toVtt(Buffer.from(text, 'latin1'), '.srt').vtt, expected, 'Windows-1252');
  assert.equal(toVtt(Buffer.from('\ufeff' + text, 'utf8'), '.srt').vtt, expected, 'UTF-8 mit Kennung am Anfang');
  assert.equal(toVtt(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]), '.srt').vtt, expected, 'UTF-16');
  assert.equal(toVtt(Buffer.from('nur irgendein Text'), '.srt').cues, 0);
  assert.equal(toVtt(Buffer.from('1\n00:00:05,000 --> 00:00:02,000\nEnde vor Anfang\n'), '.srt').cues, 0);
});

// ───────── Server ─────────

/** Startet einen eigenen Server mit leerem Datenordner. Liefert die Adresse und eine Abruf-Hilfe mit Sitzungs-Cookie. */
async function startServer(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koisignage-test-'));
  const port = 18000 + Math.floor(Math.random() * 2000);
  const base = 'http://127.0.0.1:' + port;
  const child = spawn(process.execPath, ['--no-warnings', path.join(root, 'server/server.js')], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir, ADMIN_PASSWORD: '' }, stdio: 'pipe' });
  t.after(() => { child.kill(); fs.rmSync(dir, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => { if (String(d).includes('läuft auf')) resolve(); });
    child.on('exit', () => reject(new Error('Server beendet')));
  });
  const session = { base, cookie: '' };
  session.call = async (method, url, body, headers = {}) => {
    const opts = { method, headers: { ...headers } };
    if (session.cookie) opts.headers.Cookie = session.cookie;
    if (body instanceof Uint8Array) opts.body = body;
    else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const res = await fetch(base + url, opts);
    const setCookie = res.headers.get('set-cookie');
    if (setCookie && setCookie.startsWith('koisignage_session=')) session.cookie = setCookie.split(';')[0];
    return { status: res.status, data: await res.json().catch(() => null), res };
  };
  return session;
}

test('Server: Zeitleiste mit Ebenen, Kürzen, Übergängen und Geschwindigkeit', async (t) => {
  const { call, base } = await startServer(t);
  await call('POST', '/api/auth/setup', { password: 'geheim-1234' });
  const bytes = new Uint8Array(3000).map((_, i) => i % 251);
  const film = (await call('POST', '/api/resources/upload?name=Film.mp4&duration=20', bytes)).data;
  const kurz = (await call('POST', '/api/resources/upload?name=Kurz.mp4&duration=10', bytes)).data;
  const logo = (await call('POST', '/api/resources/upload?name=Logo.png', bytes)).data;

  // Vorgabe der Geschwindigkeit am Clip
  assert.equal(film.speed, 1);
  assert.equal((await call('PUT', '/api/resources/' + kurz.id, { speed: 2 })).data.speed, 2);
  assert.equal((await call('PUT', '/api/resources/' + kurz.id, { speed: 3 })).data.speed, 2, 'unbekannte Stufe wird verworfen');
  assert.equal((await call('PUT', '/api/resources/' + logo.id, { speed: 2 })).data.speed, 1, 'Bilder haben keine Geschwindigkeit');

  const seq = (await call('POST', '/api/sequences', { name: 'Schnitt', items: [
    { type: 'clip', ref: film.id, offset: 4, duration: 6, fadeIn: 0, fadeOut: 1 },
    { type: 'clip', ref: kurz.id },
    { type: 'clip', ref: film.id, enabled: false },
    { type: 'clip', ref: kurz.id, speed: 0.5, duration: 4 },
    { type: 'clip', ref: logo.id, track: 2, start: 3, duration: 8, fadeIn: 1, fadeOut: 1 },
    { type: 'clip', ref: logo.id, track: 9, start: -5, speed: 7 },
    { type: 'tag', ref: 'gibt-es-nicht', track: 2, offset: 3 }
  ] })).data;
  const [a, b, , d, over, top, tag] = seq.items;
  assert.deepEqual([a.track, a.start, a.offset, a.speed, a.fadeIn, a.fadeOut], [0, 0, 4, null, 0, 1]);
  assert.deepEqual([b.fadeIn, b.fadeOut, b.offset], [0.5, 0, 0], 'Vorgaben: halbe Sekunde überblenden, kein Ausblenden');
  assert.equal(d.speed, 0.5);
  assert.deepEqual([over.track, over.start], [2, 3]);
  assert.deepEqual([top.track, top.start, top.speed], [3, 0, null], 'Ebene begrenzt, ungültige Werte verworfen');
  assert.deepEqual([tag.track, tag.offset], [0, 0], 'Tag-Einträge liegen immer auf der Hauptspur');

  const list = (await call('GET', '/api/preview/playlist?kind=sequence&id=' + seq.id)).data;
  // Hauptspur: lückenlos hintereinander; der ausgesetzte Eintrag behält seinen Platz, läuft aber nicht
  assert.deepEqual(list.entries.map((e) => [e.name, e.at, e.len]), [['Film', 0, 6], ['Kurz', 6, 5], ['Kurz', 31, 4]]);
  assert.deepEqual(list.entries.map((e) => e.scene), [0, 0, 0]);
  assert.deepEqual(list.entries.map((e) => [e.offset, e.speed, e.duration]), [[4, 1, 6], [0, 2, null], [0, 0.5, 4]]);
  assert.deepEqual([list.entries[0].fadeIn, list.entries[0].fadeOut], [0, 1]);
  // Überlagerungen mit fester Zeit
  assert.equal(list.scenes.length, 1);
  assert.equal(list.scenes[0].length, 35);
  assert.deepEqual(list.scenes[0].overlays.map((o) => [o.name, o.track, o.start, o.end, o.fadeIn, o.fadeOut]), [['Logo', 2, 3, 11, 1, 1], ['Logo', 3, 0, 10, 0.5, 0]]);

  // Ragt eine Überlagerung über die Hauptspur hinaus, dauert die Sequenz bis zu ihrem Ende; ein leerer Eintrag füllt die Zeit
  const longer = (await call('POST', '/api/sequences', { name: 'Mit Abspann', items: [
    { type: 'clip', ref: kurz.id, duration: 5 }, { type: 'clip', ref: logo.id, track: 2, start: 3, duration: 8 }
  ] })).data;
  const tail = (await call('GET', '/api/preview/playlist?kind=sequence&id=' + longer.id)).data;
  assert.equal(tail.scenes[0].length, 11);
  assert.deepEqual(tail.entries.map((e) => [e.type, e.at, e.len, e.duration]), [['video', 0, 5, 5], ['gap', 5, 6, 6]]);
  assert.equal((await call('GET', '/api/preview/playlist?kind=sequence&id=' + seq.id)).data.entries.some((e) => e.type === 'gap'), false, 'ohne Überhang kein leerer Eintrag');
  await call('DELETE', '/api/sequences/' + longer.id);

  // Transformation je Eintrag: kommt bei Hauptspur und Überlagerung in der Abspielliste an
  const moved = (await call('POST', '/api/sequences', { name: 'Verschoben', items: [
    { type: 'clip', ref: kurz.id, tf: { x: 30, y: 60, scale: 50, rotate: 15 } },
    { type: 'clip', ref: logo.id, track: 1, tf: { x: 50, y: 50, scale: 100, rotate: 0 } }
  ] })).data;
  assert.deepEqual(moved.items.map((i) => i.tf), [{ x: 30, y: 60, scale: 50, rotate: 15 }, null]);
  const ml = (await call('GET', '/api/preview/playlist?kind=sequence&id=' + moved.id)).data;
  assert.deepEqual([ml.entries[0].tf, ml.scenes[0].overlays[0].tf], [{ x: 30, y: 60, scale: 50, rotate: 15 }, null]);
  await call('DELETE', '/api/sequences/' + moved.id);

  // Bereiche: Bereich B hat eine eigene lückenlose Hauptspur und eigene Ebenen; ohne Teilung zählt B nicht
  const parted = (await call('POST', '/api/sequences', { name: 'Geteilt', split: { pos: 2, angle: 30 }, items: [
    { type: 'clip', ref: kurz.id, duration: 4 },
    { type: 'clip', ref: logo.id, area: 1, duration: 3 }, { type: 'clip', ref: logo.id, area: 1, duration: 5 },
    { type: 'clip', ref: logo.id, area: 1, track: 1, start: 2, duration: 2 }
  ] })).data;
  assert.deepEqual(parted.split, { pos: 0.95, angle: 30 }, 'Teilung begrenzt');
  assert.deepEqual(parted.items.map((i) => i.area), [0, 1, 1, 1]);
  const pl = (await call('GET', '/api/preview/playlist?kind=sequence&id=' + parted.id)).data;
  assert.deepEqual(pl.scenes[0].split, { pos: 0.95, angle: 30 });
  assert.equal(pl.scenes[0].length, 8, 'so lang wie der längste Bereich');
  assert.deepEqual(pl.scenes[0].overlays.map((o) => [o.area, o.track, o.start, o.end]), [[1, 0, 0, 3], [1, 0, 3, 8], [1, 1, 2, 4]]);
  assert.deepEqual(pl.entries.map((e) => [e.type, e.at, e.len]), [['video', 0, 4], ['gap', 4, 4]]);
  await call('PUT', '/api/sequences/' + parted.id, { split: null });
  const whole = (await call('GET', '/api/preview/playlist?kind=sequence&id=' + parted.id)).data;
  assert.deepEqual([whole.scenes[0].split, whole.scenes[0].overlays.length, whole.scenes[0].length], [null, 0, 4], 'ohne Teilung bleibt B stumm');
  const copy = (await call('POST', '/api/sequences/' + parted.id + '/duplicate')).data;
  assert.equal(copy.split, null);
  await call('DELETE', '/api/sequences/' + parted.id);
  await call('DELETE', '/api/sequences/' + copy.id);

  // Ein einzelner Clip am Bildschirm läuft mit der Vorgabe seiner Geschwindigkeit
  const single = (await call('GET', '/api/preview/playlist?kind=resource&id=' + kurz.id)).data;
  assert.deepEqual([single.entries[0].speed, single.entries[0].scene, single.scenes.length], [2, undefined, 0]);

  // Mastersequenz: Die Ausstrahlung der Sequenz ist die Vorgabe. Ein Eintrag übernimmt sie, schränkt zusätzlich ein oder übersteuert sie.
  const weekend = { days: [6, 7] }, morning = { start: '08:00', end: '12:00' };
  await call('PUT', '/api/sequences/' + seq.id, { rule: weekend });
  const prog = (await call('POST', '/api/sequences', { kind: 'master', name: 'Programm', items: [
    { ref: seq.id }, { ref: seq.id, rule: morning }, { ref: seq.id, rule: morning, override: true }, { ref: seq.id, override: true }
  ] })).data;
  assert.deepEqual(prog.items.map((i) => i.override), [false, false, true, true]);
  const slots = (await call('GET', '/api/preview/playlist?kind=master&id=' + prog.id)).data.entries.filter((e) => e.name === 'Film');
  assert.deepEqual(slots.map((e) => e.rules), [[weekend], [morning, weekend], [morning], []], 'übernommen, zusätzlich eingeschränkt, übersteuert, übersteuert auf immer');
  await call('PUT', '/api/sequences/' + seq.id, { rule: {} });
  await call('DELETE', '/api/sequences/' + prog.id);

  // Tags überall umbenennen und entfernen, auch in Tag-Einträgen; gleicher Name zusammengeführt
  await call('PUT', '/api/resources/' + kurz.id, { tags: ['Aktion', 'Sommer'] });
  await call('PUT', '/api/resources/' + logo.id, { tags: ['aktion'] });
  const tagged = (await call('POST', '/api/sequences', { name: 'Getaggt', tags: ['AKTION', 'Sommer'], items: [{ type: 'tag', ref: 'aktion' }] })).data;
  assert.equal((await call('POST', '/api/tags/rename', { from: 'aktion', to: 'Sommer' })).data.changed, 3);
  const clipsNow = (await call('GET', '/api/resources')).data;
  assert.deepEqual(clipsNow.find((c) => c.id === kurz.id).tags, ['Sommer'], 'zusammengeführt statt doppelt');
  assert.deepEqual(clipsNow.find((c) => c.id === logo.id).tags, ['Sommer']);
  const seqNow = (await call('GET', '/api/sequences')).data.find((s) => s.id === tagged.id);
  assert.deepEqual([seqNow.tags, seqNow.items[0].ref], [['Sommer'], 'Sommer']);
  assert.equal((await call('POST', '/api/tags/delete', { name: 'sommer' })).data.changed, 3);
  assert.deepEqual((await call('GET', '/api/resources')).data.find((c) => c.id === logo.id).tags, []);
  assert.equal((await call('POST', '/api/tags/rename', { from: '', to: 'x' })).status, 400);
  await call('DELETE', '/api/sequences/' + tagged.id);

  // Untertitel: am Video gespeichert, als WebVTT ausgeliefert, in der Abspielliste genannt
  const srt = new TextEncoder().encode('1\n00:00:01,000 --> 00:00:02,000\nHallo\n');
  assert.equal((await call('PUT', '/api/resources/' + logo.id + '/subtitles?name=a.srt', srt)).status, 400, 'nur für Videos');
  assert.equal((await call('PUT', '/api/resources/' + film.id + '/subtitles?name=a.txt', srt)).status, 415, 'unbekanntes Format');
  assert.equal((await call('PUT', '/api/resources/' + film.id + '/subtitles?name=leer.srt', new TextEncoder().encode('kein Untertitel'))).status, 400);
  const first = (await call('PUT', '/api/resources/' + film.id + '/subtitles?name=Film.de.srt', srt)).data;
  assert.equal(first.cues, 1);
  assert.equal(first.subtitles.name, 'Film.de.srt');
  const served = await fetch(base + first.subtitles.src);
  assert.match(served.headers.get('content-type'), /^text\/vtt/);
  assert.equal(await served.text(), 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHallo\n');
  const subbed = (await call('GET', '/api/preview/playlist?kind=sequence&id=' + seq.id)).data;
  assert.deepEqual(subbed.entries.map((e) => e.subs), [first.subtitles.src, null, null], 'nur der Film hat Untertitel');
  const second = (await call('PUT', '/api/resources/' + film.id + '/subtitles?name=neu.vtt', new TextEncoder().encode('WEBVTT\n\n00:01.000 --> 00:02.000\nNeu\n'))).data;
  assert.equal((await fetch(base + first.subtitles.src)).status, 404, 'alte Datei beim Ersetzen entfernt');
  assert.equal((await call('DELETE', '/api/resources/' + film.id + '/subtitles')).data.subtitles, null);
  assert.equal((await fetch(base + second.subtitles.src)).status, 404, 'Datei beim Entfernen gelöscht');
});

test('Server: vom Hochladen bis zur Live-Meldung', async (t) => {
  const session = await startServer(t);
  const { base } = session;
  const call = session.call;

  // Anmeldung
  assert.equal((await call('GET', '/api/resources')).status, 401, 'ohne Anmeldung gesperrt');
  assert.equal((await call('POST', '/api/auth/setup', { password: 'kurz' })).status, 400);
  assert.equal((await call('POST', '/api/auth/setup', { password: 'geheim-1234' })).status, 200);
  assert.equal((await call('POST', '/api/auth/setup', { password: 'nochmal-1234' })).status, 403, 'zweites Setup verboten');
  assert.equal((await call('GET', '/api/auth/state')).data.loggedIn, true);

  // Clips
  const bytes = new Uint8Array(5000).map((_, i) => i % 251);
  assert.equal((await call('POST', '/api/resources/upload?name=boese.svg', bytes)).status, 415);
  const video = (await call('POST', '/api/resources/upload?name=Sommeraktion.mp4&duration=12.5&width=1920&height=1080', bytes)).data;
  assert.equal(video.type, 'video'); assert.equal(video.name, 'Sommeraktion'); assert.equal(video.duration, 12.5);
  const image = (await call('POST', '/api/resources/upload?name=Kursplan.png', bytes)).data;
  assert.equal(image.type, 'image'); assert.equal(image.duration, 10);
  await call('PUT', '/api/resources/' + video.id, { tags: ['Sommer', 'sommer', 'Aktion'], rule: { to: '2099-08-31', start: 'quatsch' } });
  await call('PUT', '/api/resources/' + image.id, { tags: ['Kurse'], duration: 7 });
  const clips = (await call('GET', '/api/resources')).data;
  assert.deepEqual(clips.find((c) => c.id === video.id).tags, ['Sommer', 'Aktion'], 'doppelte Tags entfernt');
  assert.deepEqual(clips.find((c) => c.id === video.id).rule, { to: '2099-08-31' }, 'ungültige Felder verworfen');

  // Teilabruf einer Mediendatei
  const part = await fetch(base + video.src, { headers: { Range: 'bytes=10-19' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), 'bytes 10-19/5000');
  assert.deepEqual([...new Uint8Array(await part.arrayBuffer())], [...bytes.slice(10, 20)]);
  assert.equal((await fetch(base + '/media/../koisignage.db')).status, 404, 'kein Ausbruch aus dem Medienordner');

  // Sequenz mit Clip-Eintrag (mit Regel) und Tag-Eintrag
  const seq = (await call('POST', '/api/sequences', { name: 'Aktionen', items: [
    { type: 'clip', ref: video.id, rule: { days: [1, 2, 3, 4, 5] } },
    { type: 'tag', ref: 'kurse', duration: 15 },
    { type: 'clip', ref: 'gibt-es-nicht' }
  ] })).data;
  assert.equal(seq.items.length, 2, 'Eintrag mit unbekanntem Clip verworfen');
  const master = (await call('POST', '/api/sequences', { kind: 'master', name: 'Empfang', items: [{ ref: seq.id, rule: { start: '08:00', end: '20:00' } }, { ref: seq.id }] })).data;
  assert.equal(master.items.length, 2);

  // Player meldet sich an und wird gekoppelt
  const reg = (await call('POST', '/api/player/register', { ua: 'test', res: '1920x1080' })).data;
  assert.match(reg.code, /^[A-Z2-9]{6}$/);
  const player = { Authorization: 'Bearer ' + reg.key };
  session.cookie = ''; // der Player hat kein Sitzungs-Cookie
  const adminCookie = (await call('POST', '/api/auth/login', { password: 'geheim-1234' })).res.headers.get('set-cookie').split(';')[0];
  session.cookie = '';
  assert.equal((await call('GET', '/api/player/playlist', undefined, player)).data.status, 'pending');
  assert.equal((await call('GET', '/api/player/playlist', undefined, { Authorization: 'Bearer falsch' })).status, 401);
  session.cookie = adminCookie;
  assert.equal((await call('POST', '/api/screens/pair', { code: 'ZZZZZZ', name: 'x' })).status, 404);
  const screen = (await call('POST', '/api/screens/pair', { code: reg.code.toLowerCase(), name: 'Empfang' })).data;
  await call('PUT', '/api/screens/' + screen.id, { content: { kind: 'master', id: master.id }, hours: { start: '07:00', end: '21:00' } });

  // Abspielliste: flach, mit Regelkette und Herkunft
  session.cookie = '';
  const list = (await call('GET', '/api/player/playlist', undefined, player)).data;
  assert.equal(list.status, 'ok');
  assert.equal(list.tz, 'Europe/Vienna');
  assert.deepEqual(list.screen.hours, { start: '07:00', end: '21:00' });
  assert.deepEqual(list.entries.map((e) => e.name), ['Sommeraktion', 'Kursplan', 'Sommeraktion', 'Kursplan']);
  const first = list.entries[0];
  assert.deepEqual(first.rules, [{ start: '08:00', end: '20:00' }, { days: [1, 2, 3, 4, 5] }, { to: '2099-08-31' }]);
  assert.equal(first.path, 'Empfang › Aktionen');
  assert.equal(first.seqId, seq.id); assert.equal(first.masterId, master.id);
  assert.equal(first.duration, null, 'Video spielt bis zum Ende');
  assert.equal(list.entries[1].duration, 15, 'Dauer des Tag-Eintrags gilt für Bilder');
  assert.equal(list.entries[2].rules.length, 2, 'zweiter Master-Eintrag ohne eigene Regel');

  // Live-Meldung kommt in der Verwaltung an
  const hb = await call('POST', '/api/player/heartbeat', { now: { key: first.key, clipId: first.clipId, name: first.name, path: first.path, seqId: first.seqId, itemId: first.itemId, masterId: first.masterId, masterItemId: first.masterItemId, startedAt: Date.now(), index: 1, total: 4 }, cache: { done: 2, total: 2 }, offlineReady: true }, player);
  assert.equal(hb.status, 200);
  session.cookie = adminCookie;
  const screens = (await call('GET', '/api/screens')).data;
  assert.equal(screens.pending, 0);
  assert.equal(screens.screens[0].online, true);
  assert.equal(screens.screens[0].now.name, 'Sommeraktion');
  assert.equal(screens.screens[0].now.seqId, seq.id);

  // HDMI-Schaltung: Betriebszeiten entscheiden, ob der Fernseher an sein soll
  assert.equal(screens.screens[0].power, null, 'ohne Meldung keine HDMI-Schaltung');
  await call('PUT', '/api/screens/' + screen.id, { hours: { from: '2000-01-01', to: '2000-01-02' } });
  session.cookie = '';
  const off = await call('POST', '/api/player/power', { state: 'on', via: 'cec', tv: 'on' }, player);
  assert.equal(off.status, 200);
  assert.equal(off.data.on, false, 'ausserhalb der Betriebszeiten aus');
  assert.equal((await call('POST', '/api/player/power', { state: 'off', via: 'cec', tv: 'standby' }, { Authorization: 'Bearer falsch' })).status, 401);
  session.cookie = adminCookie;
  await call('PUT', '/api/screens/' + screen.id, { hours: {} });
  session.cookie = '';
  assert.equal((await call('POST', '/api/player/power', { state: 'off', via: 'cec', tv: 'standby' }, player)).data.on, true, 'durchgehend an');
  session.cookie = adminCookie;
  const powered = (await call('GET', '/api/screens')).data.screens[0];
  assert.deepEqual([powered.power.state, powered.power.via, powered.power.tv, powered.power.wanted], ['off', 'cec', 'standby', true]);
  assert.ok(powered.ip, 'IP wird mitgeführt');
  assert.equal(screens.screens[0].content.name, 'Empfang');

  // Live-Kanal der Verwaltung liefert den Stand sofort
  const stream = await fetch(base + '/api/events', { headers: { Cookie: adminCookie } });
  const chunk = new TextDecoder().decode((await stream.body.getReader().read()).value);
  assert.match(chunk, /retry: 5000/);
  await stream.body.cancel().catch(() => {});

  // Löschen: erst Hinweis auf Verwendung, dann mit Bestätigung überall entfernt
  const blocked = await call('DELETE', '/api/resources/' + video.id);
  assert.equal(blocked.status, 409);
  assert.deepEqual(blocked.data.usage.sequences, ['Aktionen']);
  assert.equal((await call('DELETE', '/api/resources/' + video.id + '?force=1')).status, 200);
  assert.equal((await fetch(base + video.src)).status, 404, 'Datei entfernt');
  assert.equal((await call('GET', '/api/sequences')).data.find((s) => s.id === seq.id).items.length, 1);

  // Deaktivierte Sequenz liefert nichts mehr
  await call('PUT', '/api/sequences/' + seq.id, { enabled: false });
  session.cookie = '';
  assert.equal((await call('GET', '/api/player/playlist', undefined, player)).data.entries.length, 0);

  // Entfernter Bildschirm: Schlüssel ist wertlos
  session.cookie = adminCookie;
  await call('DELETE', '/api/screens/' + screen.id);
  session.cookie = '';
  assert.equal((await call('GET', '/api/player/playlist', undefined, player)).status, 401);
});
