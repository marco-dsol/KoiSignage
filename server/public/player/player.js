/* KoiSignage – Player. Klassisches Skript ohne Build, damit es auch in älteren TV-Browsern läuft. */
(function () {
  'use strict';

  var VERSION = '1.2';
  var R = window.KoiSignageRules;
  var params = new URLSearchParams(location.search);
  var preview = params.get('preview');          // z. B. "sequence:ID" (aus der Verwaltung)
  var simulateAt = params.get('at');            // z. B. "2027-12-24T10:00" (nur Vorschau)
  var debug = params.get('debug') === '1';
  var embed = Boolean(preview) && params.get('embed') === '1';   // Vorschau-Monitor im Sequenz-Editor
  var startAt = embed ? parseFloat(params.get('t')) || 0 : 0;    // dort: Abspielposition beim Start
  var paused = embed && params.get('paused') === '1';            // dort: angehalten, zeigt nur das Bild an der Abspielmarke
  var bootTime = Date.now();
  var PRELOAD = 3;          // Sekunden, die eine Überlagerung vor ihrem Einsatz geladen wird

  var stage = document.getElementById('stage');
  var layers = [document.getElementById('layerA'), document.getElementById('layerB')];
  var overBox = document.getElementById('over');
  var noteBox = document.getElementById('note');
  var pairBox = document.getElementById('pair');
  var debugBox = document.getElementById('debug');

  var key = null;
  var playlist = null;      // aktive Abspielliste
  var waiting = null;       // neue Liste, wird beim nächsten Clipwechsel übernommen
  var entries = [];
  var scenes = [];          // je Sequenz: Länge und Überlagerungen
  var index = -1;
  var active = 0;           // sichtbare Ebene der Hauptspur
  var shown = null;         // was die Hauptspur gerade zeigt: { entry, at, from, video }
  var overlays = {};        // laufende Überlagerungen, nach Schlüssel
  var ruleClockAt = 0, ruleClockValue = null;
  var playToken = 0;        // macht veraltete Rückrufe wirkungslos
  var timers = [];
  var current = null;       // Meldung an den Server: was läuft gerade
  var idleReason = 'start';
  var failures = 0;
  var timeOffset = 0;       // Serverzeit minus Gerätezeit
  var cacheState = null;
  var offlineReady = false;
  var lastError = '';
  var connected = false;
  var pairTimer = null;
  var events = null;

  function load(name) {
    try {
      var value = localStorage.getItem('koisignage.' + name);
      if (value === null) {
        // Vor der Umbenennung der App hiessen die Einträge "sinage.…". Übernehmen, damit gekoppelte Bildschirme gekoppelt bleiben.
        value = localStorage.getItem('sinage.' + name);
        if (value !== null) { localStorage.setItem('koisignage.' + name, value); localStorage.removeItem('sinage.' + name); }
      }
      return value;
    } catch (e) { return null; }
  }
  function save(name, value) {
    try { if (value === null) localStorage.removeItem('koisignage.' + name); else localStorage.setItem('koisignage.' + name, value); } catch (e) { /* kein Speicher */ }
  }

  function serverNow() { return Date.now() + timeOffset; }
  function clock() {
    if (preview && simulateAt) {
      var start = new Date(simulateAt).getTime();
      if (!isNaN(start)) return R.wallClock(start + (Date.now() - bootTime), null);
    }
    return R.wallClock(serverNow(), playlist && playlist.tz);
  }

  function api(method, path, body) {
    var headers = {};
    if (key) headers.Authorization = 'Bearer ' + key;
    if (body) headers['Content-Type'] = 'application/json';
    return fetch(path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin', cache: 'no-store' })
      .then(function (res) {
        return res.json().then(function (data) { return { status: res.status, data: data }; });
      });
  }

  // ───────── Wiedergabe ─────────

  function clearTimers() {
    for (var i = 0; i < timers.length; i++) clearTimeout(timers[i]);
    timers = [];
  }
  function later(fn, ms) { var t = setTimeout(fn, ms); timers.push(t); return t; }

  function emptyLayer(layer) {
    var v = layer.querySelector('video');
    if (v) { try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) { /* egal */ } }
    layer.innerHTML = '';
  }

  /** Blendet ein Element in der angegebenen Zeit auf die Deckkraft "to". 0 Sekunden ist ein harter Schnitt. */
  function fade(el, to, seconds) {
    el.style.transition = seconds > 0 ? 'opacity ' + seconds + 's linear' : 'none';
    void el.offsetWidth; // Ausgangswert festschreiben, sonst startet der Übergang nicht
    el.style.opacity = to;
  }
  function secs(v, fallback) { return typeof v === 'number' && v >= 0 ? v : fallback; }
  function seek(v, pos) { try { v.currentTime = pos; } catch (e) { /* noch nicht bereit */ } }

  /** Untertitel an ein Video hängen. Der Browser zeigt sie selbst an, passend zur Stelle im Film. */
  function addSubtitles(v, src) {
    if (!src) return;
    var track = document.createElement('track');
    track.kind = 'captions';
    track.label = 'Untertitel';
    track.default = true;
    track.src = src;
    v.appendChild(track);
    v.addEventListener('loadedmetadata', function () { if (v.textTracks && v.textTracks[0]) v.textTracks[0].mode = 'showing'; });
  }
  function hideSubtitles(v) {
    var tracks = v.textTracks || [];
    for (var i = 0; i < tracks.length; i++) tracks[i].mode = 'disabled';
  }
  function note(text) {
    if (!preview) return;
    noteBox.textContent = text;
    noteBox.style.display = text ? 'block' : 'none';
  }

  function applyPlaylist(data) {
    playlist = data;
    entries = data.entries || [];
    scenes = data.scenes || [];
    var rot = data.screen && data.screen.rotation;
    stage.className = rot ? 'r' + rot : '';
    if (index >= entries.length) index = -1;
    failures = 0;
  }

  function next() {
    clearTimers();
    if (waiting) { applyPlaylist(waiting); waiting = null; }
    if (!playlist) return idle('keine Abspielliste');
    var wc = clock();
    if (!R.matches(playlist.screen && playlist.screen.hours, wc)) return idle('ausserhalb der Betriebszeiten');
    if (!entries.length) return idle('kein Inhalt zugewiesen');
    for (var step = 1; step <= entries.length; step++) {
      var i = (index + step) % entries.length;
      if (R.allMatch(entries[i].rules, wc)) return play(entries[i], i, 0);
    }
    idle('zurzeit ist nichts eingeplant');
  }

  /** Derselbe Eintrag in einer neuen Abspielliste: gleiche Datei, gleiche Stelle, gleiches Tempo. */
  function sameEntry(a, b) {
    return a.src === b.src && a.type === b.type && (a.itemId || '') === (b.itemId || '') && a.at === b.at && a.len === b.len &&
      (a.offset || 0) === (b.offset || 0) && (a.speed || 1) === (b.speed || 1) && a.subs === b.subs && a.fit === b.fit &&
      a.duration === b.duration && a.fadeIn === b.fadeIn && a.fadeOut === b.fadeOut;   // sonst stimmen die Zeitgeber des laufenden Eintrags nicht mehr
  }

  /** Vorschau-Monitor: an eine Stelle der Zeitleiste springen (Sekunden ab Beginn der Sequenz). */
  function jumpTo(t) {
    clearTimers();
    if (waiting) { applyPlaylist(waiting); waiting = null; }
    if (!playlist || !entries.length) return next();
    var wc = clock();
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (e.at == null || !R.allMatch(e.rules, wc)) continue;
      if (t >= e.at + (e.len || 0) - 0.05) continue;
      var from = Math.max(0, t - e.at);
      // Läuft genau dieser Eintrag schon, genügt der Sprung im Clip: So folgt die Vorschau der gezogenen Abspielmarke flüssig.
      // Nach dem Speichern im Editor kommt eine neue Abspielliste; ist der laufende Eintrag darin gleich geblieben, wird das Video nicht neu geladen.
      if (shown && shown.token === playToken && (shown.entry === e || sameEntry(shown.entry, e))) { shown.entry = e; return shown.retime(from); }
      return play(e, i, from);
    }
    index = -1;
    next();
  }

  /** Vorschau-Monitor: anhalten und das aktuelle Bild stehen lassen. */
  function pause() {
    if (paused) return;
    var t = sceneTime();
    paused = true;
    clearTimers();
    if (shown) {
      if (t !== null) { shown.from = t - (shown.entry.at || 0); shown.at = Date.now(); }
      if (shown.video) shown.video.pause();
    }
    // Laufende Übergänge an der erreichten Deckkraft festhalten.
    for (var i = 0; i < layers.length; i++) {
      var o = getComputedStyle(layers[i]).opacity;
      layers[i].style.transition = 'none';
      layers[i].style.opacity = o;
    }
    for (var key in overlays) if (overlays[key].video) overlays[key].video.pause();
    tick();
    // Der Verwaltung die genaue Stelle melden, an der das Bild steht.
    if (window.parent !== window) window.parent.postMessage({ koi: 'paused', t: sceneTime() }, location.origin);
  }

  /** Vorschau-Monitor: an der Abspielmarke weiterspielen. */
  function resume() {
    if (!paused) return;
    paused = false;
    var t = sceneTime();
    if (t === null) return next();
    jumpTo(t);
  }

  function idle(reason) {
    playToken++;
    fade(layers[0], 0, 0.5);
    fade(layers[1], 0, 0.5);
    var changed = current !== null || idleReason !== reason;
    current = null;
    shown = null;
    idleReason = reason;
    later(function () { if (!current) { emptyLayer(layers[0]); emptyLayer(layers[1]); } }, 700);
    later(next, 5000);
    if (changed) report();
    note(reason);
    tick();
    renderDebug();
  }

  /** Spielt einen Eintrag der Hauptspur. from: so viele Sekunden des Eintrags überspringen (nur Vorschau-Monitor). */
  function play(entry, i, from) {
    var token = ++playToken;
    var back = layers[1 - active];
    var isShown = false;
    var speed = entry.speed > 0 ? entry.speed : 1;
    var video = null;
    back.style.transition = 'none';
    back.style.opacity = 0;
    emptyLayer(back);
    setClip(back, clipFor(entry.scene, 0));   // geteilte Sequenz: die Hauptspur füllt nur Bereich A
    index = i;

    function alive() { return token === playToken; }

    /** Zeitgeber für den Rest des Eintrags stellen: Ausblenden, Wechsel zum nächsten, Überwachung.
        fin: Sekunden, die das Einblenden gerade noch braucht. */
    function arm(fin) {
      // Feste Dauer am Bildschirm. Ohne sie läuft ein Video bis zu seinem Ende und meldet das selbst.
      var total = video ? entry.duration : (entry.duration || (entry.type === 'image' ? 10 : 30));
      var left = video && isFinite(video.duration) ? (video.duration - video.currentTime) / speed : null;
      var rest = total ? Math.max(0.2, total - from) : left;
      // Ausblenden nur, wenn nach dem Einblenden noch Zeit dafür bleibt.
      var fout = rest ? Math.min(secs(entry.fadeOut, 0), Math.max(0, rest - fin)) : 0;
      if (total) later(function () { if (alive()) next(); }, rest * 1000);
      if (fout > 0) later(function () { if (alive()) fade(back, 0, fout); }, (rest - fout) * 1000);
      // Überwachung: hängt das Video, geht es trotzdem weiter.
      if (video) later(function () { if (alive()) { lastError = entry.name + ': Zeit überschritten'; next(); } }, ((rest || entry.length || 600) + 20) * 1000);
    }

    /** Vorschau-Monitor: im laufenden Eintrag an eine andere Stelle springen, ohne ihn neu zu laden. */
    function retime(to) {
      clearTimers();
      from = to;
      if (video) {
        // Steht das Video schon fast an der Stelle, nicht springen: sonst ruckelt es bei jedem Speichern im Editor.
        var target = (entry.offset || 0) + from * speed;
        if (paused || Math.abs(video.currentTime - target) > 0.3) seek(video, target);
        if (paused) video.pause();
        else if (video.paused) { var again = video.play(); if (again && again.catch) again.catch(function () { /* bleibt als Standbild */ }); }
      }
      fade(back, 1, 0);
      shown.at = Date.now();
      shown.from = from;
      if (!paused) arm(0);
      tick();
    }

    function show() {
      if (!alive() || isShown) return;
      isShown = true;
      failures = 0;
      var front = layers[active];
      var fin = paused ? 0 : secs(entry.fadeIn, 0.5);
      if (shown && shown.video) { shown.video.muted = true; hideSubtitles(shown.video); }   // während der Überblendung weder doppelter Ton noch doppelte Untertitel
      back.style.zIndex = 2;
      front.style.zIndex = 1;
      fade(back, 1, fin);
      active = 1 - active;
      // Der alte Clip bleibt darunter stehen, bis der neue ganz eingeblendet ist: kein schwarzes Flackern.
      setTimeout(function () {
        if (!alive()) return;
        front.style.transition = 'none';
        front.style.opacity = 0;
        emptyLayer(front);
      }, fin * 1000 + 200);
      if (!paused) arm(fin);
      shown = { entry: entry, token: token, at: Date.now(), from: from, video: video, retime: retime };
      current = {
        key: entry.key, clipId: entry.clipId, name: entry.name, path: entry.path || '', type: entry.type,
        seqId: entry.seqId || '', itemId: entry.itemId || '', masterId: entry.masterId || '', masterItemId: entry.masterItemId || '',
        startedAt: serverNow(), duration: entry.duration || entry.len || (entry.length ? entry.length / speed : null),
        offset: entry.offset || 0, speed: speed, index: i + 1, total: entries.length
      };
      idleReason = '';
      note('');
      report();
      tick();
      renderDebug();
    }

    function failed(message) {
      if (!alive()) return;
      lastError = entry.name + ': ' + message;
      failures++;
      clearTimers();
      // Wenn gar nichts mehr abspielbar ist, nicht im Kreis rasen.
      later(next, failures >= entries.length ? 5000 : 300);
      renderDebug();
    }

    var fit = entry.fit === 'cover' ? 'cover' : 'contain';

    if (entry.type === 'gap') {
      // Nur Überlagerungen: Die Hauptspur ist hier zu Ende, darunter bleibt es schwarz.
      show();
    } else if (entry.type === 'video') {
      var v = video = document.createElement('video');
      var begin = (entry.offset || 0) + from * speed;   // Stelle im Film, an der es losgeht
      v.muted = !(playlist.screen && playlist.screen.muted === false);
      v.playsInline = true;
      v.setAttribute('playsinline', '');
      v.preload = 'auto';
      v.defaultPlaybackRate = speed;
      v.style.objectFit = fit;
      v.addEventListener('playing', function () {
        if (!alive() || isShown) return;
        if (v.playbackRate !== speed) v.playbackRate = speed;
        show();
      });
      v.addEventListener('ended', function () { if (alive()) next(); });
      v.addEventListener('error', function () { failed('Video nicht abspielbar'); });
      v.src = entry.src;
      addSubtitles(v, entry.subs);
      setTransform(v, entry.tf);
      back.appendChild(v);
      var start = function () {
        if (paused) {
          // Angehalten: nur das Bild an der Stelle zeigen, nicht abspielen.
          if (v.readyState >= 2) show();
          else v.addEventListener('loadeddata', function () { if (alive()) show(); });
          return;
        }
        var started = v.play();
        if (!started || !started.catch) return;
        started.catch(function (err) {
          if (!alive() || isShown) return;
          // Abgebrochen (z. B. Tab im Hintergrund) ist keine Verweigerung; die Start-Überwachung greift.
          if (err && err.name === 'AbortError') return;
          if (!v.muted) {
            // Browser erlaubt keinen Ton ohne Klick: stumm abspielen statt stehenbleiben.
            v.muted = true;
            var again = v.play();
            if (again && again.catch) again.catch(function () { failed('Wiedergabe verweigert'); });
          } else failed('Wiedergabe verweigert');
        });
      };
      // Mit abgeschnittenem Anfang erst an die Stelle springen, dann starten: so blitzt das erste Bild nicht auf.
      if (begin > 0) v.addEventListener('loadedmetadata', function () { seek(v, begin); start(); });
      else start();
      later(function () { if (alive() && !isShown) failed('startet nicht'); }, 20000);
    } else if (entry.type === 'image') {
      var img = document.createElement('img');
      img.style.objectFit = fit;
      img.onload = show;
      img.onerror = function () { failed('Bild nicht ladbar'); };
      img.src = entry.src;
      setTransform(img, entry.tf);
      back.appendChild(img);
    } else {
      var frame = document.createElement('iframe');
      frame.setAttribute('scrolling', 'no');
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
      frame.onload = show;
      frame.src = entry.src;
      setTransform(frame, entry.tf);
      back.appendChild(frame);
      later(show, 4000);
    }
  }

  // ───────── Überlagerungen (Ebenen über der Hauptspur) ─────────

  /** Stelle auf der Zeitleiste der laufenden Sequenz in Sekunden, null ohne Sequenz.
      Übersprungene Einträge der Hauptspur fallen aus der Zeit heraus; Überlagerungen bleiben so am richtigen Clip. */
  function sceneTime() {
    if (!shown || shown.entry.scene == null) return null;
    var e = shown.entry, v = shown.video, run;
    if (v && v.readyState > 0 && !v.seeking) run = (v.currentTime - (e.offset || 0)) / (e.speed > 0 ? e.speed : 1); // bildgenau am Hauptvideo
    else run = shown.from + (paused ? 0 : (Date.now() - shown.at) / 1000);
    if (run < 0) run = 0;
    if (e.len && run > e.len) run = e.len;
    return (e.at || 0) + run;
  }

  function ruleClock() {
    var n = Date.now();
    if (!ruleClockValue || n - ruleClockAt > 1000) { ruleClockValue = clock(); ruleClockAt = n; }
    return ruleClockValue;
  }

  /** Ausschnitt eines Bereichs (0: A, 1: B) der Szene; leer, wenn die Sequenz nicht geteilt ist. */
  function clipFor(sceneIndex, area) {
    var sc = sceneIndex != null && scenes[sceneIndex];
    if (!sc || !sc.split) return '';
    var w = stage.clientWidth, h = stage.clientHeight;
    return R.splitClip(sc.split, area, w > 0 && h > 0 ? w / h : 16 / 9);
  }
  function setClip(el, value) { if ((el.style.clipPath || '') !== value) { el.style.clipPath = value; el.style.webkitClipPath = value; } }
  /** Position, Größe und Drehung des Clips (aus der Sequenz) auf sein Bild, Video oder seine Webseite legen. */
  function setTransform(el, tf) {
    if (!el) return;
    var value = R.transformCss(tf);
    if (el.koiTf === value) return;
    el.koiTf = value;
    el.style.transform = value;
    el.style.webkitTransform = value;
  }

  function signature(o) { return [o.src, o.start, o.end, o.offset, o.speed, o.track, o.fit].join('|'); }

  function startOverlay(o, scene) {
    var box = document.createElement('div');
    var run = { o: o, scene: scene, box: box, sig: signature(o), ready: false, on: false, leaving: false, failed: false, video: null };
    var fit = o.fit === 'cover' ? 'cover' : 'contain';
    var ready = function () { run.ready = true; };
    var failed = function () {
      run.failed = true;
      lastError = o.name + ': Überlagerung nicht ladbar';
      if (box.parentNode) box.parentNode.removeChild(box);
      renderDebug();
    };
    box.className = 'ov';
    box.style.zIndex = String((o.track || 0) + 1);   // in Bereich B liegt dessen Hauptspur (Ebene 0) unter seinen Überlagerungen
    setClip(box, clipFor(scene, o.area || 0));
    if (o.type === 'video') {
      var v = document.createElement('video');
      v.muted = true;   // Ton kommt nur von der Hauptspur
      v.playsInline = true;
      v.setAttribute('playsinline', '');
      v.preload = 'auto';
      v.defaultPlaybackRate = o.speed > 0 ? o.speed : 1;
      v.style.objectFit = fit;
      v.addEventListener('loadedmetadata', function () { if (o.offset > 0) seek(v, o.offset); });
      v.addEventListener('canplay', ready);
      v.addEventListener('error', failed);
      v.src = o.src;
      addSubtitles(v, o.subs);
      run.video = v;
      setTransform(v, o.tf);
      box.appendChild(v);
    } else if (o.type === 'image') {
      var img = document.createElement('img');
      img.style.objectFit = fit;
      img.onload = ready;
      img.onerror = failed;
      img.src = o.src;
      setTransform(img, o.tf);
      box.appendChild(img);
    } else {
      var frame = document.createElement('iframe');
      frame.setAttribute('scrolling', 'no');
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
      frame.onload = ready;
      frame.src = o.src;
      setTransform(frame, o.tf);
      box.appendChild(frame);
      setTimeout(ready, 4000);
    }
    overBox.appendChild(box);
    return run;
  }

  function stepOverlay(run, t) {
    var o = run.o, v = run.video;
    var speed = o.speed > 0 ? o.speed : 1;
    var pos = (o.offset || 0) + (t - o.start) * speed;   // Stelle im Film
    var fout = secs(o.fadeOut, 0);
    if (!run.on) {
      run.on = true;
      if (v) {
        seek(v, pos);
        v.playbackRate = speed;
        if (!paused) {
          var started = v.play();
          if (started && started.catch) started.catch(function () { /* bleibt als Standbild stehen */ });
        }
      }
      // Am Anfang mit dem eingestellten Übergang, mitten hinein (nach einem Sprung) nur kurz.
      fade(run.box, 1, t - o.start < 0.4 ? secs(o.fadeIn, 0.5) : 0.3);
      return;
    }
    if (v && paused) {
      // Angehalten: genau das Bild an der Abspielmarke zeigen.
      if (!v.paused) v.pause();
      if (!v.seeking && Math.abs(v.currentTime - pos) > 0.01 && !(v.duration > 0 && pos >= v.duration)) seek(v, pos);
      return;
    }
    if (v && v.paused && !v.ended && !v.seeking) { var resumed = v.play(); if (resumed && resumed.catch) resumed.catch(function () { /* Standbild */ }); }
    // Läuft das Video der Zeitleiste davon (Sprung, neue Runde), wird es nachgeführt.
    if (v && !v.ended && !v.seeking && Math.abs(v.currentTime - pos) > speed && !(v.duration > 0 && pos >= v.duration)) seek(v, pos);
    if (fout > 0 && !run.leaving && t >= o.end - fout) { run.leaving = true; fade(run.box, 0, Math.max(0.05, o.end - t)); }
    else if (run.leaving && t < o.end - fout) { run.leaving = false; fade(run.box, 1, 0.3); }
  }

  /** soft: weich ausblenden (Regel gilt nicht mehr, andere Sequenz); sonst sofort weg (das Ende ist erreicht). */
  function endOverlay(key, soft) {
    var run = overlays[key], box = run.box;
    delete overlays[key];
    var remove = function () {
      if (run.video) { try { run.video.pause(); run.video.removeAttribute('src'); run.video.load(); } catch (e) { /* egal */ } }
      if (box.parentNode) box.parentNode.removeChild(box);
    };
    if (!soft || !run.on) return remove();
    fade(box, 0, 0.3);
    setTimeout(remove, 350);
  }

  /** Läuft fünfmal pro Sekunde: startet, führt und beendet die Überlagerungen passend zur Zeitleiste. */
  function tick() {
    var t = sceneTime();
    var sceneIndex = t === null ? -1 : shown.entry.scene;
    var list = (sceneIndex >= 0 && scenes[sceneIndex] && scenes[sceneIndex].overlays) || [];
    var keep = {}, key, run;
    for (var i = 0; i < list.length; i++) {
      var o = list[i];
      if (t < o.start - PRELOAD || t >= o.end) continue;
      if (!R.allMatch(o.rules, ruleClock())) continue;
      run = overlays[o.key];
      if (run && run.sig !== signature(o)) { endOverlay(o.key, true); run = null; }   // neue Abspielliste, anderer Inhalt
      if (!run) run = overlays[o.key] = startOverlay(o, sceneIndex);
      run.o = o;   // neue Abspielliste mit gleichem Inhalt: Transformation daraus übernehmen
      keep[o.key] = 1;
      setTransform(run.box.firstElementChild, o.tf);
      if (run.ready && !run.failed && t >= o.start) stepOverlay(run, t);
      setClip(run.box, clipFor(sceneIndex, o.area || 0));   // Teilung geändert (Vorschau im Editor): sofort nachziehen
    }
    if (shown) {
      setClip(layers[active], clipFor(shown.entry.scene, 0));
      setTransform(layers[active].firstElementChild, shown.entry.tf);
    }
    for (key in overlays) {
      if (keep[key]) continue;
      run = overlays[key];
      endOverlay(key, !(run.scene === sceneIndex && t >= run.o.end - 0.05));
    }
    if (embed && window.parent !== window) window.parent.postMessage({ koi: 'time', t: t }, location.origin);
  }

  // ───────── Verbindung zum Server ─────────

  function report() {
    if (preview || !key || !playlist) return;
    api('POST', '/api/player/heartbeat', {
      now: current, idle: current ? '' : idleReason, cache: cacheState, offlineReady: offlineReady,
      res: screen.width + 'x' + screen.height, error: lastError, version: VERSION
    }).then(function (r) {
      connected = r.status === 200;
      if (r.status === 401) fetchPlaylist();
    }).catch(function () { connected = false; renderDebug(); });
  }

  function showPairing(code) {
    playToken++;
    clearTimers();
    playlist = null; waiting = null; current = null; shown = null;
    emptyLayer(layers[0]); emptyLayer(layers[1]);
    fade(layers[0], 0, 0); fade(layers[1], 0, 0);
    tick();
    document.getElementById('code').textContent = code;
    document.getElementById('addr').textContent = location.host;
    pairBox.style.display = 'block';
    if (!pairTimer) pairTimer = setInterval(fetchPlaylist, 5000);
  }
  function hidePairing() {
    pairBox.style.display = 'none';
    if (pairTimer) { clearInterval(pairTimer); pairTimer = null; }
  }

  function register() {
    key = null;
    save('key', null);
    save('playlist', null);
    return api('POST', '/api/player/register', { ua: navigator.userAgent, res: screen.width + 'x' + screen.height })
      .then(function (r) {
        if (r.status !== 201) throw new Error(r.data.error || 'Anmeldung fehlgeschlagen');
        key = r.data.key;
        save('key', key);
        showPairing(r.data.code);
        connectEvents();
      })
      .catch(function (e) { lastError = String(e.message || e); renderDebug(); setTimeout(register, 10000); });
  }

  function receive(data) {
    timeOffset = data.serverTime - Date.now();
    hidePairing();
    if (!preview) save('playlist', JSON.stringify(data));
    syncCache(data);
    var runningVersion = waiting ? waiting.version : playlist && playlist.version;
    if (data.version === runningVersion) return;
    if (embed) {
      // Vorschau-Monitor: Änderungen sofort zeigen und an derselben Stelle weiterspielen.
      var t = playlist ? sceneTime() : startAt;
      waiting = data;
      return jumpTo(t || 0);
    }
    if (current) {
      // laufenden Clip nicht abbrechen; ausser Ton oder Drehung haben sich geändert
      var a = playlist.screen || {}, b = data.screen || {};
      waiting = data;
      if (a.muted !== b.muted || a.rotation !== b.rotation) next();
    } else {
      waiting = data;
      next();
    }
  }

  function fetchPlaylist() {
    var path = preview
      ? '/api/preview/playlist?kind=' + encodeURIComponent(preview.split(':')[0]) + '&id=' + encodeURIComponent(preview.split(':')[1] || '')
      : '/api/player/playlist';
    return api('GET', path).then(function (r) {
      connected = true;
      if (r.status === 401) {
        if (preview) { lastError = 'Vorschau: nicht angemeldet'; return renderDebug(); }
        return register();
      }
      if (r.status !== 200) throw new Error(r.data.error || 'Fehler ' + r.status);
      if (r.data.status === 'pending') return showPairing(r.data.code);
      receive(r.data);
      renderDebug();
    }).catch(function (e) {
      connected = false;
      lastError = 'Server nicht erreichbar';
      renderDebug();
    });
  }

  function connectEvents() {
    if (preview || !key || !window.EventSource) return;
    if (events) events.close();
    events = new EventSource('/api/player/events?key=' + encodeURIComponent(key));
    events.addEventListener('update', function () { fetchPlaylist(); });
    events.addEventListener('reload', function () { location.reload(); });
    events.onopen = function () { connected = true; fetchPlaylist(); };
    events.onerror = function () { connected = false; renderDebug(); };
  }

  // ───────── Offline-Cache ─────────

  function syncCache(data) {
    if (preview || !navigator.serviceWorker || !navigator.serviceWorker.controller) return;
    var urls = [], seen = {};
    var want = function (e) {
      if (e.src && e.type !== 'web' && e.type !== 'gap' && !seen[e.src]) { seen[e.src] = 1; urls.push(e.src); }
      if (e.subs && !seen[e.subs]) { seen[e.subs] = 1; urls.push(e.subs); }
    };
    var i, j, sc = data.scenes || [];
    for (i = 0; i < data.entries.length; i++) want(data.entries[i]);
    for (i = 0; i < sc.length; i++) for (j = 0; j < (sc[i].overlays || []).length; j++) want(sc[i].overlays[j]);
    navigator.serviceWorker.controller.postMessage({ type: 'sync', urls: urls });
  }

  function startServiceWorker() {
    if (preview || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('sw.js').then(function () {
      return navigator.serviceWorker.ready;
    }).then(function () {
      if (playlist) syncCache(waiting || playlist);
    }).catch(function () { /* kein sicherer Kontext: ohne Offline-Cache weiter */ });
    navigator.serviceWorker.addEventListener('message', function (ev) {
      var m = ev.data || {};
      if (m.type === 'progress') {
        var before = cacheState ? cacheState.done : -1;
        cacheState = { done: m.done, total: m.total };
        offlineReady = m.done === m.total;
        if (m.done !== before) report();
        renderDebug();
      }
    });
    navigator.serviceWorker.addEventListener('controllerchange', function () { if (playlist) syncCache(waiting || playlist); });
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});
  }

  // ───────── Anzeige für die Fehlersuche ─────────

  function renderDebug() {
    if (!debug) return;
    debugBox.style.display = 'block';
    var wc = clock();
    var lines = [
      'KoiSignage Player ' + VERSION + (preview ? ' (Vorschau)' : '') + ' | Server: ' + (connected ? 'verbunden' : 'nicht erreichbar') +
        ' | Uhr: ' + wc.date + ' ' + Math.floor(wc.minutes / 60) + ':' + ('0' + (wc.minutes % 60)).slice(-2),
      current ? 'Läuft: ' + current.name + ' (' + current.index + ' von ' + current.total + ')' + (current.path ? ' | ' + current.path : '') : 'Leerlauf: ' + idleReason,
      'Offline-Cache: ' + (cacheState ? cacheState.done + ' von ' + cacheState.total + ' Dateien' : (navigator.serviceWorker ? 'wird vorbereitet' : 'nicht verfügbar (HTTPS nötig)')),
      lastError ? 'Letzter Fehler: ' + lastError : ''
    ];
    debugBox.textContent = lines.join('\n').replace(/\n+$/, '');
  }

  // ───────── Start ─────────

  function boot() {
    setInterval(tick, 200);
    if (embed) {
      document.documentElement.className = 'embed';
      window.addEventListener('message', function (ev) {
        if (ev.origin !== location.origin || ev.source !== window.parent) return;
        var m = ev.data || {};
        if (m.koi === 'seek') jumpTo(Number(m.t) || 0);
        else if (m.koi === 'reload') fetchPlaylist();
        else if (m.koi === 'pause') pause();
        else if (m.koi === 'split') {
          // Teilung wird im Editor gezogen: sofort übernehmen, die gespeicherte Fassung kommt danach mit der Abspielliste.
          for (var s = 0; s < scenes.length; s++) scenes[s].split = m.split || null;
          tick();
        }
        else if (m.koi === 'transform') {
          // Clip wird im Editor verschoben, skaliert oder gedreht: sofort zeigen, ohne neu zu laden.
          var tf = R.cleanTransform(m.tf);
          for (var e = 0; e < entries.length; e++) if (entries[e].itemId === m.itemId) entries[e].tf = tf;
          for (var c = 0; c < scenes.length; c++) {
            var ovs = scenes[c].overlays || [];
            for (var k = 0; k < ovs.length; k++) if (ovs[k].itemId === m.itemId) ovs[k].tf = tf;
          }
          tick();
        }
        else if (m.koi === 'play') resume();
      });
      // Tasten an die Verwaltung weitergeben (Escape schliesst, Leertaste und Pfeile steuern), auch wenn der Fokus im Player liegt.
      document.addEventListener('keydown', function (e) {
        if (window.parent === window) return;
        if (e.key === 'Escape') window.parent.postMessage({ koi: 'escape' }, location.origin);
        else if (e.key === ' ' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); window.parent.postMessage({ koi: 'key', key: e.key }, location.origin); }
      });
    }
    if (preview) { fetchPlaylist(); return; }

    var fromUrl = params.get('key');
    key = fromUrl || load('key');
    if (fromUrl) save('key', fromUrl);

    startServiceWorker();

    // Sofort mit der zuletzt bekannten Liste beginnen, auch ohne Netz.
    var cached = load('playlist');
    if (key && cached) {
      try { waiting = JSON.parse(cached); timeOffset = 0; next(); } catch (e) { /* unbrauchbar */ }
    }

    if (key) { fetchPlaylist(); connectEvents(); } else register();

    setInterval(fetchPlaylist, 60000);
    setInterval(report, 30000);
    // Einmal pro Nacht neu laden, um den Browser frisch zu halten.
    setInterval(function () {
      var m = clock().minutes;
      if (m >= 180 && m < 240 && Date.now() - bootTime > 6 * 3600000) location.reload();
    }, 60000);

    if (navigator.wakeLock && navigator.wakeLock.request) {
      var lock = function () { navigator.wakeLock.request('screen').catch(function () {}); };
      lock();
      document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') lock(); });
    }
  }

  window.addEventListener('error', function (e) { lastError = String(e.message || 'Skriptfehler'); renderDebug(); });
  boot();
})();
