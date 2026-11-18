/* KoiSignage – Regel-Logik. Wird von Server (Node), Admin und Player gemeinsam genutzt.
   Bewusst als klassisches Skript ohne moderne Syntax, damit es auch in alten TV-Browsern läuft. */
(function (root) {
  'use strict';

  var DAY_NAMES = ['', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
  var WEEKDAY_INDEX = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  var formatters = {};

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function localClock(d) {
    return {
      date: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()),
      day: d.getDay() === 0 ? 7 : d.getDay(),
      minutes: d.getHours() * 60 + d.getMinutes()
    };
  }

  /* Wanduhrzeit für einen Zeitpunkt (ms) in einer Zeitzone: { date:'YYYY-MM-DD', day:1..7, minutes } */
  function wallClock(ms, tz) {
    var d = new Date(ms);
    if (!tz) return localClock(d);
    try {
      var f = formatters[tz];
      if (!f) {
        f = formatters[tz] = new Intl.DateTimeFormat('en-US', {
          timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false
        });
      }
      var parts = f.formatToParts(d), p = {};
      for (var i = 0; i < parts.length; i++) p[parts[i].type] = parts[i].value;
      var hour = parseInt(p.hour, 10) % 24;
      return {
        date: p.year + '-' + p.month + '-' + p.day,
        day: WEEKDAY_INDEX[p.weekday] || 1,
        minutes: hour * 60 + parseInt(p.minute, 10)
      };
    } catch (e) {
      return localClock(d);
    }
  }

  function toMinutes(s) {
    if (!s || typeof s !== 'string') return null;
    var m = /^(\d{1,2}):(\d{2})$/.exec(s);
    if (!m) return null;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  }

  function previousDate(date) {
    var p = date.split('-');
    var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]) - 86400000);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  }

  function isEmpty(rule) {
    if (!rule) return true;
    return !rule.from && !rule.to && !rule.start && !rule.end && !(rule.days && rule.days.length);
  }

  /* Gilt die Regel zur Wanduhrzeit wc? */
  function matches(rule, wc) {
    if (isEmpty(rule)) return true;
    var start = toMinutes(rule.start), end = toMinutes(rule.end);
    var date = wc.date, day = wc.day;
    if (start !== null && end !== null && start === end) { start = null; end = null; }
    if (start !== null && end !== null && start > end) {
      // Fenster über Mitternacht: nach Mitternacht zählen Datum und Wochentag des Vortags.
      if (wc.minutes >= start) { /* heute */ }
      else if (wc.minutes < end) { date = previousDate(date); day = day === 1 ? 7 : day - 1; }
      else return false;
    } else {
      if (start !== null && wc.minutes < start) return false;
      if (end !== null && wc.minutes >= end) return false;
    }
    if (rule.from && date < rule.from) return false;
    if (rule.to && date > rule.to) return false;
    if (rule.days && rule.days.length && rule.days.indexOf(day) < 0) return false;
    return true;
  }

  function allMatch(rules, wc) {
    if (!rules) return true;
    for (var i = 0; i < rules.length; i++) if (!matches(rules[i], wc)) return false;
    return true;
  }

  function fmtDate(s) {
    var p = s.split('-');
    return p[2] + '.' + p[1] + '.' + p[0];
  }

  function describeDays(days) {
    var d = days.slice().sort(function (a, b) { return a - b; });
    if (d.length === 7) return '';
    var contiguous = d.length > 2;
    for (var i = 1; i < d.length; i++) if (d[i] !== d[i - 1] + 1) contiguous = false;
    if (contiguous) return DAY_NAMES[d[0]] + '–' + DAY_NAMES[d[d.length - 1]];
    var names = [];
    for (var j = 0; j < d.length; j++) names.push(DAY_NAMES[d[j]]);
    return names.join(', ');
  }

  /* Kurze deutsche Beschreibung, leer wenn die Regel immer gilt. */
  function describe(rule) {
    if (isEmpty(rule)) return '';
    var out = [];
    if (rule.days && rule.days.length) { var dd = describeDays(rule.days); if (dd) out.push(dd); }
    if (rule.start && rule.end) out.push(rule.start + '–' + rule.end);
    else if (rule.start) out.push('ab ' + rule.start);
    else if (rule.end) out.push('bis ' + rule.end);
    if (rule.from && rule.to) out.push(fmtDate(rule.from) + ' bis ' + fmtDate(rule.to));
    else if (rule.from) out.push('ab ' + fmtDate(rule.from));
    else if (rule.to) out.push('bis ' + fmtDate(rule.to));
    return out.join(', ');
  }

  var SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

  /* Abspielgeschwindigkeit eines Videos: die Angabe am Eintrag übersteuert die Vorgabe des Clips. */
  function clipSpeed(clip, speed) {
    if (!clip || clip.type !== 'video') return 1;
    return speed > 0 ? speed : (clip.speed > 0 ? clip.speed : 1);
  }

  /* Länge eines Clips auf der Zeitleiste in Sekunden. Server und Editor rechnen damit gleich.
     duration: eingestellte Dauer am Bildschirm (leer: natürliche Länge), offset: bei Videos vorne
     abgeschnittene Sekunden des Films, speed: Geschwindigkeit des Eintrags (leer: Vorgabe des Clips). */
  function clipLength(clip, duration, offset, speed) {
    if (!clip) return 0;
    var wanted = duration > 0 ? duration : 0;
    if (clip.type === 'video') {
      if (!(clip.duration > 0)) return wanted || 10;
      var rest = Math.max(0.5, (clip.duration - (offset > 0 ? offset : 0)) / clipSpeed(clip, speed));
      return wanted ? Math.min(wanted, rest) : rest;
    }
    return wanted || (clip.duration > 0 ? clip.duration : (clip.type === 'web' ? 30 : 10));
  }

  /* ── Bereiche: eine Sequenz kann den Bildschirm mit einer geraden Linie in A und B teilen ──
     split: { pos: 0..1, angle: -90..90 }. Drehung 0 heisst senkrechte Linie (A links, B rechts),
     90 heisst waagrecht (A oben, B unten). pos verschiebt die Linie quer zu ihrer Richtung über den ganzen Bildschirm.
     Gerechnet wird in echten Seitenverhältnissen, damit 45 Grad auch auf einem breiten Bild wie 45 Grad aussehen. */
  function cleanSplit(split) {
    if (!split || typeof split !== 'object') return null;
    var pos = Number(split.pos), angle = Number(split.angle);
    return {
      pos: isFinite(pos) ? Math.round(Math.min(0.95, Math.max(0.05, pos)) * 1000) / 1000 : 0.5,
      angle: isFinite(angle) ? Math.round(Math.min(90, Math.max(-90, angle)) * 10) / 10 : 0
    };
  }
  /* Teilungslinie in einem Rechteck w × h: Normale n, Abstand d (Punkte p mit p·n <= d gehören zu A) und die Spannweite. */
  function splitLine(split, w, h) {
    var a = split.angle * Math.PI / 180, nx = Math.cos(a), ny = Math.sin(a);
    var proj = [0, w * nx, h * ny, w * nx + h * ny];
    var lo = Math.min.apply(null, proj), hi = Math.max.apply(null, proj);
    return { nx: nx, ny: ny, lo: lo, hi: hi, d: lo + split.pos * (hi - lo) };
  }
  /* Das Rechteck auf der Seite von Bereich area (0: A, 1: B), als Eckpunkte in Prozent. */
  function splitPolygon(split, area, aspect) {
    var w = aspect > 0 ? aspect : 16 / 9, h = 1, L = splitLine(split, w, h);
    var sign = area === 1 ? -1 : 1;
    var inside = function (p) { return sign * (p[0] * L.nx + p[1] * L.ny - L.d) <= 1e-9; };
    var corners = [[0, 0], [w, 0], [w, h], [0, h]], out = [];
    for (var i = 0; i < 4; i++) {
      var p = corners[i], q = corners[(i + 1) % 4], pin = inside(p), qin = inside(q);
      if (pin) out.push(p);
      if (pin !== qin) {
        var fp = p[0] * L.nx + p[1] * L.ny - L.d, fq = q[0] * L.nx + q[1] * L.ny - L.d, t = fp / (fp - fq);
        out.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]);
      }
    }
    var pct = [];
    for (var j = 0; j < out.length; j++) pct.push([Math.round(out[j][0] / w * 10000) / 100, Math.round(out[j][1] / h * 10000) / 100]);
    return pct;
  }
  /* CSS-Ausschnitt für einen Bereich; leer, wenn die Sequenz nicht geteilt ist. */
  function splitClip(split, area, aspect) {
    if (!split) return '';
    var pts = splitPolygon(split, area, aspect), parts = [];
    for (var i = 0; i < pts.length; i++) parts.push(pts[i][0] + '% ' + pts[i][1] + '%');
    return parts.length ? 'polygon(' + parts.join(', ') + ')' : 'polygon(0 0, 0 0, 0 0)';
  }

  /* ── Transformation eines Clips in der Sequenz: Position, Größe und Drehung ──
     tf: { x, y, scale, rotate }. x und y sind die Mitte des Clips in Prozent des Bildschirms (50/50 ist mittig),
     scale ist die Größe in Prozent (100 füllt den Bildschirm wie bisher), rotate die Drehung in Grad im Uhrzeigersinn.
     Ohne Änderung (mittig, 100 %, 0°) ist tf null. */
  function cleanTransform(tf) {
    if (!tf || typeof tf !== 'object') return null;
    var n = function (v, lo, hi, def, step) {
      v = Number(v);
      if (!isFinite(v)) return def;
      return Math.round(Math.min(hi, Math.max(lo, v)) / step) * step;
    };
    var out = {
      x: Math.round(n(tf.x, -100, 200, 50, 0.1) * 10) / 10,
      y: Math.round(n(tf.y, -100, 200, 50, 0.1) * 10) / 10,
      scale: Math.round(n(tf.scale, 5, 400, 100, 0.1) * 10) / 10,
      rotate: Math.round(n(tf.rotate, -180, 180, 0, 0.1) * 10) / 10
    };
    if (out.rotate === -180) out.rotate = 180;
    if (out.x === 50 && out.y === 50 && out.scale === 100 && out.rotate === 0) return null;
    return out;
  }
  /* CSS-Transformation für ein Element, das den ganzen Bildschirm füllt; leer ohne Transformation. */
  function transformCss(tf) {
    if (!tf) return '';
    return 'translate(' + (tf.x - 50) + '%, ' + (tf.y - 50) + '%) rotate(' + tf.rotate + 'deg) scale(' + tf.scale / 100 + ')';
  }

  root.KoiSignageRules = {
    cleanTransform: cleanTransform, transformCss: transformCss,
    wallClock: wallClock, matches: matches, allMatch: allMatch,
    isEmpty: isEmpty, describe: describe, clipLength: clipLength, clipSpeed: clipSpeed,
    cleanSplit: cleanSplit, splitLine: splitLine, splitPolygon: splitPolygon, splitClip: splitClip,
    SPEEDS: SPEEDS, DAY_NAMES: DAY_NAMES
  };
})(typeof self !== 'undefined' ? self : globalThis);
