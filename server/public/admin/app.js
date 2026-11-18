/* KoiSignage – Verwaltung. Reines JavaScript ohne Build-Schritt. */
(() => {
  'use strict';

  const R = window.KoiSignageRules;
  const app = document.getElementById('app');
  const state = { clips: [], sequences: [], screens: [], pending: 0, tz: 'Europe/Vienna', offset: 0, fixedPassword: false };
  let liveListeners = [];   // werden bei jeder Live-Meldung aufgerufen
  let cleanup = [];         // beim Seitenwechsel aufzuräumen
  let events = null;

  // ───────── Hilfen ─────────

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k in el && k !== 'list') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    el.append(...kids.flat(3).filter((x) => x != null && x !== false));
    return el;
  }

  /** Text mit hervorgehobenen Fundstellen des Suchbegriffs (Gross- und Kleinschreibung egal). */
  function hl(text, query) {
    const q = (query || '').trim().toLowerCase();
    if (!q) return text;
    const out = [], low = text.toLowerCase();
    let at = 0, i;
    while ((i = low.indexOf(q, at)) >= 0) {
      if (i > at) out.push(text.slice(at, i));
      out.push(h('mark', { class: 'hit' }, text.slice(i, i + q.length)));
      at = i + q.length;
    }
    out.push(text.slice(at));
    return out;
  }

  /** Ersetzt den Inhalt eines Elements; leere Werte und verschachtelte Listen sind erlaubt. */
  function set(el, ...kids) {
    el.replaceChildren(...kids.flat(3).filter((x) => x != null && x !== false));
  }

  async function api(method, path, body) {
    const opts = { method, headers: {}, credentials: 'same-origin' };
    if (body instanceof Blob) opts.body = body;
    else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const res = await fetch(path, opts);
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && !path.startsWith('/api/auth/')) { location.reload(); throw new Error('Nicht angemeldet'); }
    if (!res.ok) { const e = new Error(data.error || 'Fehler ' + res.status); e.status = res.status; e.data = data; throw e; }
    return data;
  }

  /** Bildzeichen und Wortmarke: ein weisser Koi mit rotem Fleck, daneben der Name. */
  const brand = () => h('div', { class: 'brand' }, h('img', { src: '/shared/koi.svg', alt: '', width: 30, height: 30 }), h('span', {}, h('b', {}, 'Koi'), 'Signage'));

  function toast(text, bad) {
    const el = h('div', { class: 'toast' + (bad ? ' bad' : '') }, text);
    document.getElementById('toasts').append(el);
    setTimeout(() => el.remove(), bad ? 6000 : 2600);
  }
  const oops = (e) => toast(e.message || String(e), true);

  function fmtDuration(sec) {
    if (!sec && sec !== 0) return '';
    sec = Math.round(sec);
    const m = Math.floor(sec / 60), s = sec % 60;
    return m >= 60 ? Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0') + ':' + String(s).padStart(2, '0') : m + ':' + String(s).padStart(2, '0');
  }
  function fmtSize(bytes) {
    if (!bytes) return '';
    return bytes > 1048576 * 1024 ? (bytes / 1073741824).toFixed(1) + ' GB' : Math.max(1, Math.round(bytes / 1048576)) + ' MB';
  }
  /** Stand der HDMI-Schaltung (Raspberry Pi) in einem Satz. */
  function powerText(p) {
    if (!p) return 'Ein Raspberry Pi mit HDMI-Schaltung schaltet den Fernseher ausserhalb der Betriebszeiten zusätzlich aus.';
    const via = p.via === 'cec' ? 'HDMI-CEC' : p.via === 'signal' ? 'HDMI-Signal' : 'HDMI';
    const tv = { on: 'an', standby: 'im Standby', off: 'aus' }[p.tv] || '';
    return 'HDMI-Schaltung aktiv (' + via + '): Fernseher ' + (p.state === 'off' ? 'ausgeschaltet' : 'eingeschaltet')
      + (tv ? ', meldet sich ' + tv : '') + (p.error ? '. Fehler: ' + p.error : '') + '.';
  }

  function ago(ms) {
    if (!ms) return 'noch nie';
    const s = Math.max(0, Math.round((serverNow() - ms) / 1000));
    if (s < 90) return 'gerade eben';
    if (s < 5400) return 'vor ' + Math.round(s / 60) + ' Minuten';
    if (s < 129600) return 'vor ' + Math.round(s / 3600) + ' Stunden';
    return 'vor ' + Math.round(s / 86400) + ' Tagen';
  }
  const serverNow = () => Date.now() + state.offset;
  const clipById = (id) => state.resources.find((c) => c.id === id);
  /** Platzhalter für einen Clip, der gerade vom Rechner auf die Zeitleiste gezogen wurde und noch hochlädt. */
  const isUploading = (id) => typeof id === 'string' && id.startsWith('up:');
  const seqById = (id) => state.sequences.find((s) => s.id === id);
  /** Alle Tags, ohne Unterschied in Gross- und Kleinschreibung doppelt aufzuführen. */
  const allTags = () => {
    const seen = new Map();
    for (const t of [...state.resources, ...state.sequences, ...state.screens].flatMap((x) => x.tags || [])) if (!seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t);
    return [...seen.values()].sort((a, b) => a.localeCompare(b, 'de'));
  };
  const hasTag = (x, tag) => x.tags.some((t) => t.toLowerCase() === tag.toLowerCase());
  /** Filter mit mehreren Tags: passt, wenn der Inhalt mindestens einen der gewählten Tags trägt. Ohne Auswahl passt alles. */
  const hasAnyTag = (x, tags) => !tags.length || tags.some((t) => hasTag(x, t));

  /** Filter-Chips für Tags mit Mehrfachauswahl. Ein Klick schaltet den Tag ein oder aus, „Alle" hebt den Filter auf.
      Gewählte Tags, die es nicht mehr gibt, fallen aus der Auswahl. Gibt die Chips zurück. */
  function tagFilterChips(available, selected, redraw) {
    for (let i = selected.length - 1; i >= 0; i--) if (!available.includes(selected[i])) selected.splice(i, 1);
    const chips = available.map((t) => {
      const on = selected.includes(t);
      return h('button', { type: 'button', class: 'chip filter' + (on ? ' on' : ''), title: on ? 'Tag aus dem Filter nehmen' : 'Ressourcen mit diesem Tag zeigen', 'aria-pressed': String(on),
        onclick: () => { if (on) selected.splice(selected.indexOf(t), 1); else selected.push(t); redraw(); } }, t);
    });
    if (selected.length) chips.unshift(h('button', { type: 'button', class: 'chip filter', title: 'Tag-Filter aufheben', onclick: () => { selected.length = 0; redraw(); } }, 'Alle'));
    return chips;
  }
  const typeLabel = { video: 'Video', image: 'Bild', web: 'Webseite' };
  const bg = (url) => (url ? { backgroundImage: 'url("' + url + '")' } : {});

  /** Wanduhrzeit für Regeln: simulierter Zeitpunkt oder jetzt in der Server-Zeitzone. */
  function clockAt(sim) {
    if (sim) { const t = new Date(sim).getTime(); if (!isNaN(t)) return R.wallClock(t, null); }
    return R.wallClock(serverNow(), state.tz);
  }

  async function loadAll() {
    const [clips, sequences, screens, settings] = await Promise.all([
      api('GET', '/api/resources'), api('GET', '/api/sequences'), api('GET', '/api/screens'), api('GET', '/api/settings')
    ]);
    state.resources = clips; state.sequences = sequences; state.tz = settings.tz;
    takeScreens(screens);
  }
  function takeScreens(payload) {
    state.screens = payload.screens; state.pending = payload.pending;
    state.offset = payload.serverTime - Date.now();
  }

  /** Welche Bildschirme spielen gerade etwas aus dieser Sequenz oder Mastersequenz? */
  function playingOn(seq) {
    return state.screens.filter((s) => s.online && s.now && (seq.kind === 'master' ? s.now.masterId === seq.id : s.now.seqId === seq.id));
  }

  // ───────── Dialoge und Bausteine ─────────

  function dialog(title, body, buttons, wide) {
    const close = () => { back.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    const foot = h('div', { class: 'dialog-foot' }, buttons(close));
    const back = h('div', { class: 'backdrop', onmousedown: (e) => { if (e.target === back) close(); } },
      h('div', { class: 'dialog' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true' },
        h('div', { class: 'dialog-head' }, title), h('div', { class: 'dialog-body' }, body), foot));
    document.body.append(back);
    document.addEventListener('keydown', onKey);
    const first = back.querySelector('input, select, button');
    if (first) first.focus();
    return close;
  }

  /** Spielt eine Sequenz oder Mastersequenz im Player-Fenster über der Seite ab. Schliessen mit Escape, Kreuz oder Klick daneben. */
  function previewModal(seq) {
    const close = () => { back.remove(); document.removeEventListener('keydown', onKey); window.removeEventListener('message', onMessage); };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
    const onMessage = (e) => { if (e.origin === location.origin && e.source === frame.contentWindow && (e.data || {}).koi === 'escape') close(); };
    const frame = h('iframe', { title: 'Vorschau von ' + seq.name, src: previewUrl(seq) + '&embed=1', allow: 'autoplay' });
    const closeBtn = h('button', { class: 'preview-close', type: 'button', title: 'Schliessen (Esc)', 'aria-label': 'Vorschau schliessen', onclick: close }, '×');
    const back = h('div', { class: 'backdrop', onmousedown: (e) => { if (e.target === back) close(); } },
      h('div', { class: 'preview-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Vorschau von ' + seq.name },
        h('div', { class: 'preview-head' },
          h('strong', {}, 'Vorschau: ' + seq.name),
          h('a', { class: 'btn small', href: previewUrl(seq), target: '_blank', rel: 'noopener' }, 'Im neuen Tab'),
          closeBtn),
        h('div', { class: 'preview-screen' }, frame)));
    document.body.append(back);
    document.addEventListener('keydown', onKey);
    window.addEventListener('message', onMessage);
    closeBtn.focus();
  }

  function confirmDialog(title, text, actionLabel, action) {
    dialog(title, h('p', {}, text), (close) => [
      h('button', { class: 'btn', onclick: close }, 'Abbrechen'),
      h('button', { class: 'btn primary', onclick: async () => { try { await action(); close(); } catch (e) { oops(e); } } }, actionLabel)
    ]);
  }

  /** Löschen mit Rückfrage; zeigt bei Verwendung, wo etwas noch vorkommt. */
  function removeWithUsage(path, title, text, done) {
    confirmDialog(title, text, 'Löschen', async () => {
      try {
        await api('DELETE', path);
        await done();
      } catch (e) {
        if (e.status !== 409) throw e;
        const u = e.data.usage;
        const where = [...u.sequences.map((n) => '„' + n + '"'), ...u.screens.map((n) => 'Bildschirm „' + n + '"')].join(', ');
        confirmDialog('Wird noch verwendet', 'Verwendet in: ' + where + '. Beim Löschen wird der Eintrag dort entfernt.', 'Trotzdem löschen', async () => {
          await api('DELETE', path + '?force=1');
          await done();
        });
      }
    });
  }

  /** Tags bearbeiten: Chips mit ×, Eingabe mit eigener Vorschlagsliste. Passt nichts, steht als letzter Vorschlag „neu anlegen". */
  function tagInput(tags, onChange) {
    const box = h('div', { class: 'taginput' });
    const listId = 'tagsug-' + Math.random().toString(36).slice(2);
    const input = h('input', { type: 'text', placeholder: 'Tag hinzufügen', 'aria-label': 'Tag hinzufügen', autocomplete: 'off',
      role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': listId });
    const badge = h('span', { class: 'tag-new', hidden: true }, 'Neuer Tag');
    const pop = h('div', { class: 'tag-pop', id: listId, role: 'listbox', hidden: true });
    let options = [], active = -1;

    const has = (v) => tags.some((t) => t.toLowerCase() === v.toLowerCase());
    function add(value) {
      const v = (value == null ? input.value : value).replace(/,/g, '').trim();
      input.value = '';
      if (v && !has(v)) { tags.push(v); onChange(tags); }
      draw();
      input.focus();
    }
    /** Vorschläge passend zur Eingabe: vorhandene Tags, die den Text enthalten, Treffer am Anfang zuerst. */
    function suggest() {
      const q = input.value.replace(/,/g, '').trim(), low = q.toLowerCase();
      const known = allTags().filter((t) => !has(t));
      const exact = known.find((t) => t.toLowerCase() === low) || (q && has(q) ? q : null);
      const hits = known.filter((t) => !low || t.toLowerCase().includes(low))
        .sort((a, b) => (b.toLowerCase().startsWith(low) - a.toLowerCase().startsWith(low)) || a.localeCompare(b, 'de')).slice(0, 8);
      options = hits.map((t) => ({ value: t, label: hl(t, q) }));
      const isNew = Boolean(q) && !exact;
      if (isNew) options.push({ value: q, isNew: true });
      badge.hidden = !isNew;
      box.classList.toggle('creating', isNew);
      active = options.length ? 0 : -1;
      drawPop(document.activeElement === input);
    }
    function drawPop(open) {
      const show = open && options.length > 0;
      pop.hidden = !show;
      if (show) {
        // Fest am Fenster ausrichten, damit Karten und Dialoge mit verstecktem Überlauf die Liste nicht abschneiden.
        const r = box.getBoundingClientRect();
        pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 348)) + 'px';
        pop.style.top = r.bottom + 6 + 'px';
      }
      input.setAttribute('aria-expanded', String(show));
      set(pop, options.map((o, i) => h('div', { class: 'tag-opt' + (i === active ? ' active' : '') + (o.isNew ? ' new' : ''), role: 'option', id: listId + '-' + i, 'aria-selected': String(i === active),
        onmousedown: (e) => { e.preventDefault(); add(o.value); }, onmousemove: () => { if (active !== i) { active = i; drawPop(true); } } },
        o.isNew ? [h('span', { class: 'plus', 'aria-hidden': 'true' }, '+'), h('span', {}, 'Neuen Tag „', h('b', {}, o.value), '" anlegen')] : [h('span', { class: 'chip' }, h('span', {}, o.label))])));
      if (show && active >= 0) input.setAttribute('aria-activedescendant', listId + '-' + active); else input.removeAttribute('aria-activedescendant');
    }
    input.addEventListener('input', suggest);
    input.addEventListener('focus', suggest);
    input.addEventListener('blur', () => { drawPop(false); });
    // Beim Scrollen wandert das Feld weg: Liste schliessen statt in der Luft hängen lassen.
    const onScroll = (e) => {
      if (!box.isConnected) return window.removeEventListener('scroll', onScroll, true);   // Feld ist weg: aufräumen
      if (!pop.hidden && !pop.contains(e.target)) drawPop(false);
    };
    window.addEventListener('scroll', onScroll, true);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!options.length) return;
        e.preventDefault();
        active = (active + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
        drawPop(true);
      } else if (e.key === 'Enter' || e.key === ',' || (e.key === 'Tab' && input.value.trim())) {
        e.preventDefault();
        add(!pop.hidden && options[active] ? options[active].value : null);
      } else if (e.key === 'Escape' && !pop.hidden) {
        e.preventDefault(); e.stopPropagation(); drawPop(false);
      } else if (e.key === 'Backspace' && !input.value && tags.length) { tags.pop(); onChange(tags); draw(); input.focus(); }
    });
    function draw() {
      set(box,
        ...tags.map((t, i) => h('span', { class: 'chip' }, t, h('button', { type: 'button', 'aria-label': t + ' entfernen', onclick: () => { tags.splice(i, 1); onChange(tags); draw(); } }, '×'))),
        h('span', { class: 'tag-field' }, input, badge, pop));
      suggest();
    }
    draw();
    return box;
  }

  /** Felder für eine Regel. Liefert { el, get() }. */
  function ruleFields(rule) {
    const r = { ...rule, days: [...(rule.days || [])] };
    const days = h('div', { class: 'days' }, [1, 2, 3, 4, 5, 6, 7].map((d) => {
      const b = h('button', { type: 'button', class: r.days.includes(d) ? 'on' : '', 'aria-pressed': String(r.days.includes(d)), onclick: () => {
        r.days = r.days.includes(d) ? r.days.filter((x) => x !== d) : [...r.days, d];
        b.className = r.days.includes(d) ? 'on' : '';
        b.setAttribute('aria-pressed', String(r.days.includes(d)));
      } }, R.DAY_NAMES[d]);
      return b;
    }));
    const field = (label, type, key) => h('label', {}, h('span', {}, label), h('input', { type, value: r[key] || '', oninput: (e) => { r[key] = e.target.value; } }));
    const el = h('div', {},
      h('div', { class: 'rulegrid' }, field('Von Datum', 'date', 'from'), field('Bis Datum', 'date', 'to'), field('Von Uhrzeit', 'time', 'start'), field('Bis Uhrzeit', 'time', 'end')),
      h('div', { class: 'field-label' }, 'Wochentage'), days,
      h('p', { class: 'hint', style: { marginTop: '10px' } }, 'Leere Felder schränken nicht ein. Kein Wochentag gewählt heisst: jeden Tag.'));
    return { el, get: () => ({ from: r.from || undefined, to: r.to || undefined, start: r.start || undefined, end: r.end || undefined, days: r.days.length ? r.days.slice().sort() : undefined }) };
  }

  function ruleDialog(title, rule, onSave) {
    const f = ruleFields(rule || {});
    dialog(title, f.el, (close) => [
      h('button', { class: 'btn left', onclick: () => { onSave({}); close(); } }, 'Immer zeigen'),
      h('button', { class: 'btn', onclick: close }, 'Abbrechen'),
      h('button', { class: 'btn primary', onclick: () => { onSave(f.get()); close(); } }, 'Regel übernehmen')
    ]);
  }

  function ruleChip(rule, onclick, emptyText) {
    const text = R.describe(rule);
    return h('button', { type: 'button', class: 'chip' + (text ? ' rule' : ''), onclick, title: 'Regel bearbeiten' }, text || emptyText || 'immer');
  }

  // ───────── Anmeldung ─────────

  function gate(setup) {
    const pw = h('input', { type: 'password', autocomplete: setup ? 'new-password' : 'current-password', required: true });
    const err = h('p', { class: 'error' });
    set(app, h('div', { class: 'gate' }, h('form', { onsubmit: async (e) => {
      e.preventDefault();
      try { await api('POST', setup ? '/api/auth/setup' : '/api/auth/login', { password: pw.value }); start(); }
      catch (ex) { err.textContent = ex.message; }
    } },
      brand(),
      h('p', { class: 'hint' }, setup ? 'Erster Start: Passwort für die Verwaltung festlegen (mindestens 8 Zeichen).' : 'Verwaltung der Bildschirme und Inhalte.'),
      h('label', { class: 'field' }, h('span', {}, setup ? 'Neues Passwort' : 'Passwort'), pw),
      h('button', { class: 'btn primary' }, setup ? 'Passwort festlegen' : 'Anmelden'), err)));
    pw.focus();
  }

  // ───────── Rahmen und Navigation ─────────

  const NAV = [
    ['#/screens', 'Bildschirme', () => state.screens.length],
    ['#/resources', 'Ressourcen', () => state.resources.length],
    ['#/sequences', 'Sequenzen', () => state.sequences.filter((s) => s.kind === 'sequence').length],
    ['#/masters', 'Mastersequenzen', () => state.sequences.filter((s) => s.kind === 'master').length],
    ['#/tags', 'Tags', () => allTags().length]
  ];

  function buildNav() {
    const route = location.hash || '#/screens';
    const live = state.screens.filter((s) => s.online && s.now).length;
    return h('nav', { class: 'side' },
      brand(),
      NAV.map(([href, label, count]) => h('a', { href, class: route.startsWith(href) ? 'current' : '' }, label, h('span', { class: 'count' }, String(count())))),
      h('div', { class: 'spacer' }),
      live ? h('a', { href: '#/screens', title: 'Bildschirme, die gerade etwas zeigen' }, h('span', { class: 'chip live' }, live + ' live')) : null,
      h('a', { href: '#/settings', class: route.startsWith('#/settings') ? 'current' : '' }, 'Einstellungen'));
  }
  function frame(content) {
    set(app, h('div', { class: 'shell' }, buildNav(), h('main', { class: 'main' }, content)));
  }

  function render() {
    cleanup.forEach((fn) => fn());
    cleanup = []; liveListeners = [];
    const [, page, id] = (location.hash || '#/screens').split('/');
    if (page === 'resources') return frame(resourcesPage());
    if (page === 'sequences' || page === 'masters') {
      const kind = page === 'masters' ? 'master' : 'sequence';
      const seq = id && seqById(id);
      return frame(seq && seq.kind === kind ? (kind === 'master' ? masterPage(seq) : timelinePage(seq)) : listPage(kind));
    }
    if (page === 'settings') return frame(settingsPage());
    if (page === 'tags') return frame(tagsPage());
    frame(screensPage());
  }

  // ───────── Bildschirme mit Live-Bild ─────────

  /** Baut das mitlaufende Bild für einen Bildschirm: derselbe Clip an derselben Stelle. */
  function mirror(tv, screen) {
    const now = screen.now;
    const sig = (screen.online ? 'on' : 'off') + '|' + (now ? now.key + ':' + now.clipId + ':' + now.startedAt : 'idle:' + (screen.status.idle || ''));
    if (tv.dataset.sig === sig) return;
    tv.dataset.sig = sig;
    const old = tv.querySelector('video');
    if (old) { old.pause(); old.removeAttribute('src'); old.load(); }
    const bar = h('div', { class: 'bar' });
    set(tv, );
    tv.className = 'tv' + (screen.online ? '' : ' dim');
    const clip = now && clipById(now.clipId);
    if (!now) {
      const idle = screen.status.idle;
      tv.append(h('div', { class: 'note' }, !screen.online ? 'Keine Verbindung' : idle ? 'Schwarz: ' + idle : 'Wartet auf Inhalt'));
      return;
    }
    if (clip && clip.type === 'video' && screen.online) {
      const v = h('video', { muted: true, playsInline: true, preload: 'auto' });
      v.addEventListener('loadedmetadata', () => {
        const speed = now.speed || 1;
        const pos = (now.offset || 0) + (serverNow() - now.startedAt) / 1000 * speed;
        if (pos > 0 && pos < v.duration) v.currentTime = pos;
        v.playbackRate = speed;
        v.play().catch(() => {});
      });
      v.addEventListener('error', () => { if (clip.thumb) tv.prepend(h('img', { src: clip.thumb, alt: '' })); });
      v.src = clip.src;
      tv.append(v);
    } else if (clip && clip.type === 'image') tv.append(h('img', { src: clip.src, alt: '' }));
    else if (clip && clip.thumb) tv.append(h('img', { src: clip.thumb, alt: '' }));
    else tv.append(h('div', { class: 'note' }, clip && clip.type === 'web' ? 'Webseite: ' + clip.url : now.name));
    if (screen.online) tv.append(h('span', { class: 'chip live badge' }, 'live'), bar);
  }

  /** Inhalt für einen Bildschirm wählen: Knopf mit Vorschaubild und aufklappbare Liste mit Suche, nach Art gruppiert.
      Die Liste hängt im Knopf-Element, damit das Live-Update der Kachel sie nicht abreisst, solange sie offen ist. */
  function contentSelect(screen, onChange) {
    let value = screen.content ? screen.content.kind + ':' + screen.content.id : '';
    const listId = 'cp-' + Math.random().toString(36).slice(2, 9);
    const thumbOf = (s) => (s.kind === 'master' ? s.items.map((i) => seqById(i.ref)).filter(Boolean).map(firstThumb).find(Boolean) || '' : firstThumb(s));
    const count = (n, one, many) => n + ' ' + (n === 1 ? one : many);
    /** Alle wählbaren Inhalte, in der Reihenfolge der Liste. */
    const all = () => [
      { value: '', group: '', name: 'Kein Inhalt', meta: 'Der Bildschirm zeigt nichts', empty: true },
      ...state.sequences.filter((s) => s.kind === 'master').map((s) => ({ value: 'master:' + s.id, group: 'Mastersequenzen', kindLabel: 'Mastersequenz', name: s.name, tags: s.tags, off: !s.enabled,
        thumb: thumbOf(s), meta: count(s.items.length, 'Sequenz', 'Sequenzen') + ' · ' + fmtDuration(seqDuration(s)) + ' min' })),
      ...state.sequences.filter((s) => s.kind === 'sequence').map((s) => ({ value: 'sequence:' + s.id, group: 'Sequenzen', kindLabel: 'Sequenz', name: s.name, tags: s.tags, off: !s.enabled,
        thumb: thumbOf(s), meta: count(s.items.length, 'Eintrag', 'Einträge') + ' · ' + fmtDuration(seqDuration(s)) + ' min' })),
      ...state.resources.map((c) => ({ value: 'resource:' + c.id, group: 'Ressourcen', kindLabel: typeLabel[c.type], name: c.name, tags: c.tags, off: !c.enabled,
        thumb: c.thumb || (c.type === 'image' ? c.src : ''), label: typeLabel[c.type], meta: typeLabel[c.type] + (c.type === 'video' ? ' · ' + fmtDuration(R.clipLength(c)) + ' min' : '') }))
    ];
    const mini = (o) => h('span', { class: 'mini' + (o.empty ? ' none' : ''), style: o.thumb ? bg(o.thumb) : null }, o.thumb ? null : o.empty ? '–' : (o.label || o.kindLabel || '').slice(0, 3));

    const wrap = h('div', { class: 'picker' });
    const btn = h('button', { type: 'button', class: 'picker-btn', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', 'aria-controls': listId,
      onclick: () => (pop.hidden ? open() : close()),
      onkeydown: (e) => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); open(); } } });
    const search = h('input', { type: 'search', class: 'picker-search', placeholder: 'Suchen: Name, Art oder Tag', autocomplete: 'off', 'aria-label': 'Inhalt suchen',
      role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'true', 'aria-controls': listId });
    const list = h('div', { class: 'picker-list', id: listId, role: 'listbox', 'aria-label': 'Inhalt für ' + screen.name });
    const pop = h('div', { class: 'picker-pop', hidden: true }, search, list);
    let shown = [], active = 0;

    function drawBtn() {
      const o = all().find((x) => x.value === value) || { value, name: (screen.content && screen.content.name) || 'Gelöschter Inhalt', meta: 'nicht mehr vorhanden' };
      btn.setAttribute('aria-label', 'Inhalt für ' + screen.name + ': ' + o.name);
      set(btn, mini(o), h('span', { class: 'picker-text' }, h('span', { class: 'picker-name' + (o.empty ? ' muted' : '') }, o.name),
        h('span', { class: 'picker-meta' }, o.empty ? 'Inhalt wählen' : (o.kindLabel && o.group !== 'Ressourcen' ? o.kindLabel + ' · ' : '') + o.meta)), h('span', { class: 'picker-chev', 'aria-hidden': 'true' }));
    }
    function drawList() {
      const q = search.value.trim().toLowerCase();
      // Suche über Name, Art und Tags; „Kein Inhalt" nur ohne Suchtext
      shown = all().filter((o) => (q ? !o.empty && [o.name, o.kindLabel, ...(o.tags || [])].some((t) => (t || '').toLowerCase().includes(q)) : true));
      if (active >= shown.length) active = Math.max(0, shown.length - 1);
      const rows = [];
      let group = null;
      shown.forEach((o, i) => {
        if (o.group && o.group !== group) { group = o.group; rows.push(h('div', { class: 'picker-group', role: 'presentation' }, o.group, h('span', {}, String(shown.filter((x) => x.group === o.group).length)))); }
        const tagHit = q && !o.name.toLowerCase().includes(q) ? (o.tags || []).find((t) => t.toLowerCase().includes(q)) : null;
        rows.push(h('div', { class: 'picker-opt' + (i === active ? ' active' : '') + (o.value === value ? ' current' : '') + (o.off ? ' off' : ''), role: 'option', id: listId + '-' + i,
          'aria-selected': String(o.value === value),
          onmousedown: (e) => { e.preventDefault(); choose(o); }, onmousemove: () => { if (active !== i) { active = i; markActive(); } } },
          mini(o),
          h('span', { class: 'picker-text' }, h('span', { class: 'picker-name' }, hl(o.name, search.value.trim())),
            h('span', { class: 'picker-meta' }, o.meta, o.off ? h('span', { class: 'chip off' }, 'inaktiv') : null, tagHit ? h('span', { class: 'chip', title: 'Tag' }, h('span', {}, hl(tagHit, search.value.trim()))) : null)),
          h('span', { class: 'picker-check', 'aria-hidden': 'true' }, o.value === value ? '✓' : '')));
      });
      if (!shown.length) rows.push(h('div', { class: 'picker-none' }, 'Nichts gefunden für „' + search.value.trim() + '"'));
      set(list, ...rows);
      markActive();
    }
    function markActive() {
      list.querySelectorAll('.picker-opt').forEach((el, i) => el.classList.toggle('active', i === active));
      const el = document.getElementById(listId + '-' + active);
      if (el) { search.setAttribute('aria-activedescendant', el.id); el.scrollIntoView({ block: 'nearest' }); } else search.removeAttribute('aria-activedescendant');
    }
    function place() {
      // Fest am Fenster, damit die Kachel mit verstecktem Überlauf die Liste nicht abschneidet; passt sie unten nicht hin, nach oben.
      const r = btn.getBoundingClientRect(), w = Math.min(Math.max(r.width, 340), window.innerWidth - 16);
      pop.style.width = w + 'px';
      pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px';
      const below = window.innerHeight - r.bottom - 12, above = r.top - 12;
      const up = below < 260 && above > below;
      pop.style.maxHeight = Math.min(420, up ? above : below) + 'px';
      pop.style.top = up ? '' : r.bottom + 6 + 'px';
      pop.style.bottom = up ? window.innerHeight - r.top + 6 + 'px' : '';
    }
    function open() {
      if (!pop.hidden) return;
      search.value = '';
      active = Math.max(0, all().findIndex((o) => o.value === value));
      pop.hidden = false;
      wrap.classList.add('open');
      btn.setAttribute('aria-expanded', 'true');
      place();
      drawList();
      search.focus();
      document.addEventListener('pointerdown', away, true);
      window.addEventListener('scroll', onScroll, true);
      window.addEventListener('resize', close);
    }
    function close(refocus) {
      if (pop.hidden) return;
      pop.hidden = true;
      wrap.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
      document.removeEventListener('pointerdown', away, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', close);
      if (refocus === true) btn.focus();
    }
    const away = (e) => { if (!wrap.contains(e.target)) close(); };
    const onScroll = (e) => { if (!pop.contains(e.target)) close(); };
    function choose(o) {
      close(true);
      if (o.value === value) return;
      value = o.value;
      drawBtn();
      const [kind, id] = value.split(':');
      onChange(kind ? { kind, id } : null);
    }
    search.addEventListener('input', () => { active = 0; drawList(); });
    search.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (shown.length) { active = (active + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length; markActive(); }
      } else if (e.key === 'Home' && !search.value) { e.preventDefault(); active = 0; markActive(); }
      else if (e.key === 'End' && !search.value) { e.preventDefault(); active = shown.length - 1; markActive(); }
      else if (e.key === 'Enter') { e.preventDefault(); if (shown[active]) choose(shown[active]); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
      else if (e.key === 'Tab') close();
    });
    drawBtn();
    wrap.append(btn, pop);
    return wrap;
  }

  function screensPage() {
    const wrap = h('div', {});
    const tiles = new Map();

    function tile(screen) {
      const t = {
        tv: h('div', { class: 'tv' }), dot: h('span', { class: 'dot' }), name: h('span', { class: 'name' }),
        nowline: h('div', { class: 'nowline' }), pathline: h('div', { class: 'pathline' }), select: h('span', {}), state: h('span', { class: 'hint' })
      };
      t.el = h('article', { class: 'tile' }, t.tv, h('div', { class: 'tile-body' },
        h('div', { class: 'tile-title' }, t.dot, t.name, h('button', { class: 'btn small', onclick: () => screenDialog(state.screens.find((s) => s.id === screen.id)) }, 'Einstellungen')),
        t.nowline, t.pathline, t.select, h('div', { class: 'row' }, t.state)));
      return t;
    }

    function update(t, s) {
      mirror(t.tv, s);
      t.dot.className = 'dot ' + (s.online ? 'online' : 'offline');
      t.dot.title = s.online ? 'online' : 'offline';
      t.name.textContent = s.name;
      const n = s.now;
      t.nowline.textContent = n ? n.name : (s.online ? 'Zeigt gerade nichts' : 'Offline, zuletzt gesehen ' + ago(s.lastSeen));
      t.pathline.textContent = n ? [n.path, n.total > 1 ? 'Clip ' + n.index + ' von ' + n.total : ''].filter(Boolean).join(', ') + (s.online ? '' : ' (letzte Meldung ' + ago(s.lastSeen) + ')') : (s.content ? 'Zugewiesen: ' + (s.content.name || '') : 'Kein Inhalt zugewiesen');
      if (!t.select.contains(document.activeElement)) {
        set(t.select, contentSelect(s, async (content) => {
          try { await api('PUT', '/api/screens/' + s.id, { content }); toast('Inhalt zugewiesen'); } catch (e) { oops(e); }
        }));
      }
      const c = s.status.cache;
      const pw = s.power && s.power.state === 'off' ? 'Fernseher per HDMI ausgeschaltet' : '';
      t.state.textContent = !s.online ? (s.ip ? 'Letzte IP ' + s.ip : '') : pw ? pw : c && c.total ? (c.done >= c.total ? 'Offline bereit, ' + c.total + ' Dateien gespeichert' : 'Lädt Dateien: ' + c.done + ' von ' + c.total) : 'Ohne Offline-Speicher';
    }

    function draw() {
      const head = h('div', { class: 'head' }, h('h1', {}, 'Bildschirme'),
        h('button', { class: 'btn primary', onclick: pairDialog }, 'Bildschirm koppeln'));
      const parts = [head];
      if (state.pending) parts.push(h('div', { class: 'notice' }, state.pending === 1 ? 'Ein Gerät zeigt einen Code und wartet auf die Kopplung.' : state.pending + ' Geräte zeigen einen Code und warten auf die Kopplung.'));
      if (!state.screens.length) {
        parts.push(h('div', { class: 'empty' }, h('strong', {}, 'Noch kein Bildschirm gekoppelt'),
          'Am Fernseher oder Abspielgerät diese Adresse im Browser öffnen: ', h('b', {}, location.origin + '/player/'), h('br'),
          'Dort erscheint ein Code. Diesen hier eingeben.', h('br'),
          h('button', { class: 'btn primary', onclick: pairDialog }, 'Bildschirm koppeln')));
      } else {
        const grid = h('div', { class: 'screens' });
        for (const id of [...tiles.keys()]) if (!state.screens.some((s) => s.id === id)) tiles.delete(id);
        for (const s of state.screens) {
          if (!tiles.has(s.id)) tiles.set(s.id, tile(s));
          update(tiles.get(s.id), s);
          grid.append(tiles.get(s.id).el);
        }
        parts.push(grid);
      }
      set(wrap, ...parts);
    }

    // Fortschrittsbalken laufen lokal weiter
    const timer = setInterval(() => {
      for (const s of state.screens) {
        const t = tiles.get(s.id);
        const bar = t && t.tv.querySelector('.bar');
        if (!bar || !s.now) continue;
        const clip = clipById(s.now.clipId);
        const total = s.now.duration || (clip && clip.duration);
        bar.style.width = total ? Math.min(100, ((serverNow() - s.now.startedAt) / 10) / total) + '%' : '0';
      }
    }, 500);
    cleanup.push(() => clearInterval(timer));
    liveListeners.push(draw);
    draw();
    return wrap;
  }

  function pairDialog() {
    const code = h('input', { type: 'text', maxLength: 8, autocomplete: 'off', style: { textTransform: 'uppercase', letterSpacing: '.2em', fontSize: '1.4rem', fontWeight: '700' } });
    const name = h('input', { type: 'text', placeholder: 'z. B. Empfang' });
    dialog('Bildschirm koppeln', h('div', {},
      h('p', { class: 'hint' }, 'Am Gerät ' + location.origin + '/player/ öffnen. Der Bildschirm zeigt einen sechsstelligen Code.'),
      h('label', { class: 'field' }, h('span', {}, 'Code vom Bildschirm'), code),
      h('label', { class: 'field' }, h('span', {}, 'Name des Bildschirms'), name)), (close) => [
      h('button', { class: 'btn', onclick: close }, 'Abbrechen'),
      h('button', { class: 'btn primary', onclick: async () => {
        try { await api('POST', '/api/screens/pair', { code: code.value, name: name.value }); close(); toast('Bildschirm gekoppelt'); } catch (e) { oops(e); }
      } }, 'Koppeln')
    ]);
  }

  function screenDialog(s) {
    if (!s) return;
    const draft = { name: s.name, tags: [...s.tags], muted: s.muted, rotation: s.rotation, hours: s.hours };
    const link = location.origin + '/player/?key=' + s.key;
    const hoursChip = h('span', {});
    const drawHours = () => set(hoursChip, ruleChip(draft.hours, () => ruleDialog('Betriebszeiten von ' + s.name, draft.hours, (r) => { draft.hours = r; drawHours(); }), 'durchgehend'));
    drawHours();
    const linkInput = h('input', { type: 'text', readOnly: true, value: link, onfocus: (e) => e.target.select() });
    const body = h('div', {},
      h('label', { class: 'field' }, h('span', {}, 'Name'), h('input', { type: 'text', value: draft.name, oninput: (e) => { draft.name = e.target.value; } })),
      h('div', { class: 'field' }, h('div', { class: 'field-label' }, 'Tags'), tagInput(draft.tags, () => {})),
      h('label', { class: 'field' }, h('span', {}, 'Drehung (für hochkant montierte Bildschirme)'),
        h('select', { onchange: (e) => { draft.rotation = Number(e.target.value); } }, [0, 90, 180, 270].map((r) => h('option', { value: r, selected: r === draft.rotation }, r === 0 ? 'Keine' : r + ' Grad')))),
      h('div', { class: 'field' }, h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: !draft.muted, onchange: (e) => { draft.muted = !e.target.checked; } }), 'Ton abspielen'),
        h('div', { class: 'hint' }, 'Mit Ton braucht der Browser am Gerät die Erlaubnis für automatische Wiedergabe. Sonst spielt er stumm.')),
      h('div', { class: 'field' }, h('div', { class: 'field-label' }, 'Betriebszeiten (ausserhalb bleibt das Bild schwarz)'), hoursChip,
        h('div', { class: 'hint' }, powerText(s.power))),
      h('div', { class: 'field' }, h('div', { class: 'field-label' }, 'Direktlink als Startadresse für Kiosk-Geräte'),
        h('div', { class: 'copyline' }, linkInput, h('button', { class: 'btn', onclick: () => { linkInput.select(); navigator.clipboard ? navigator.clipboard.writeText(link).then(() => toast('Link kopiert')) : document.execCommand('copy'); } }, 'Kopieren')),
        h('div', { class: 'hint' }, 'Der Link enthält den Schlüssel dieses Bildschirms. Nicht öffentlich teilen.')),
      h('p', { class: 'hint' }, [s.ip ? (s.online ? 'IP ' : 'letzte IP ') + s.ip : '', s.status.res ? 'Auflösung ' + s.status.res : '', s.status.version ? 'Player ' + s.status.version : '', 'zuletzt gesehen ' + ago(s.lastSeen), s.status.error ? 'letzter Fehler: ' + s.status.error : ''].filter(Boolean).join(', ')));
    dialog('Bildschirm ' + s.name, body, (close) => [
      h('button', { class: 'btn danger left', onclick: () => { close(); confirmDialog('Bildschirm entfernen', '„' + s.name + '" wird entfernt. Das Gerät zeigt danach wieder einen Kopplungscode.', 'Entfernen', async () => { await api('DELETE', '/api/screens/' + s.id); toast('Bildschirm entfernt'); }); } }, 'Entfernen'),
      h('button', { class: 'btn', onclick: async () => { try { const r = await api('POST', '/api/screens/' + s.id + '/reload'); toast(r.delivered ? 'Player lädt neu' : 'Gerät ist nicht verbunden', !r.delivered); } catch (e) { oops(e); } } }, 'Neu laden'),
      h('button', { class: 'btn primary', onclick: async () => { try { await api('PUT', '/api/screens/' + s.id, draft); close(); toast('Gespeichert'); } catch (e) { oops(e); } } }, 'Speichern')
    ]);
  }

  // ───────── Clips ─────────

  const uploads = [];
  let uploadBox = null;

  function drawUploads() {
    if (!uploads.length) { if (uploadBox) { uploadBox.remove(); uploadBox = null; } return; }
    if (!uploadBox) { uploadBox = h('div', { class: 'uploads' }); document.body.append(uploadBox); }
    const busy = uploads.some((u) => !u.done);
    set(uploadBox, 
      h('div', { class: 'row' }, h('strong', { style: { flex: 1 } }, busy ? 'Lädt hoch' : 'Hochladen abgeschlossen'),
        !busy ? h('button', { class: 'btn small', onclick: () => { uploads.length = 0; drawUploads(); } }, 'Schliessen') : null),
      uploads.map((u) => h('div', { class: 'up' + (u.error ? ' err' : '') }, h('div', { class: 'n' }, u.name + (u.error ? ': ' + u.error : '')),
        h('div', { class: 'meter' }, h('i', { style: { width: Math.round(u.progress * 100) + '%' } })))));
  }

  /** Liest Länge, Grösse und ein Vorschaubild im Browser aus; am Server ist kein ffmpeg nötig. */
  function probe(file) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const done = (meta) => { URL.revokeObjectURL(url); resolve(meta); };
      const snap = (source, w, hgt) => new Promise((res) => {
        try {
          const scale = Math.min(1, 480 / w);
          const canvas = h('canvas', { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(hgt * scale)) });
          canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
          canvas.toBlob((b) => res(b), 'image/jpeg', 0.8);
        } catch (e) { res(null); }
      });
      const timeout = setTimeout(() => done({ unreadable: true }), 15000);
      if (!isVideoFile(file)) {
        const img = new Image();
        img.onload = async () => { clearTimeout(timeout); done({ width: img.naturalWidth, height: img.naturalHeight, thumb: await snap(img, img.naturalWidth, img.naturalHeight) }); };
        img.onerror = () => { clearTimeout(timeout); done({ unreadable: true }); };
        img.src = url;
      } else {
        const v = document.createElement('video');
        v.muted = true; v.preload = 'auto'; v.playsInline = true;
        v.onloadedmetadata = () => { v.currentTime = Math.min(1, (v.duration || 0) / 4); };
        v.onseeked = async () => { clearTimeout(timeout); done({ duration: v.duration, width: v.videoWidth, height: v.videoHeight, thumb: v.videoWidth ? await snap(v, v.videoWidth, v.videoHeight) : null }); };
        v.onerror = () => { clearTimeout(timeout); done({ unreadable: true }); };
        v.src = url;
      }
    });
  }

  function send(path, file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', path);
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
      xhr.onload = () => {
        let data = {};
        try { data = JSON.parse(xhr.responseText); } catch (e) { /* kein JSON */ }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data); else reject(new Error(data.error || 'Fehler ' + xhr.status));
      };
      xhr.onerror = () => reject(new Error('Verbindung abgebrochen'));
      xhr.send(file);
    });
  }

  const SUBTITLE_EXT = ['.srt', '.vtt', '.ass', '.ssa', '.sbv'];
  const SUBTITLE_ACCEPT = SUBTITLE_EXT.join(',');
  const isSubtitleFile = (file) => SUBTITLE_EXT.includes((/\.[^.]+$/.exec(file.name) || [''])[0].toLowerCase());
  const saveSubtitles = (clipId, file) => api('PUT', '/api/resources/' + clipId + '/subtitles?name=' + encodeURIComponent(file.name), file);

  /** Zu welchem Video gehört eine Untertiteldatei? Sie heisst wie das Video, auf Wunsch mit Sprachkürzel: film.srt oder film.de.srt.
      fresh: die eben hochgeladenen Clips, sie haben Vorrang vor älteren mit demselben Namen. */
  function subtitleTarget(fileName, fresh) {
    const base = fileName.replace(/\.[^.]+$/, '').toLowerCase();
    for (const name of [base, base.replace(/\.[a-z]{2,3}(-[a-z]{2,4})?$/, '')]) {
      const match = (c) => c.type === 'video' && c.name.toLowerCase() === name;
      const clip = fresh.find(match) || state.resources.find(match);
      if (clip) return clip;
    }
    return null;
  }

  /** Dateien, die der Server als Clip annimmt (wie EXT in server.js). */
  const MEDIA_EXT = ['.mp4', '.m4v', '.webm', '.mov', '.jpg', '.jpeg', '.png', '.webp', '.gif'];
  const isMediaFile = (file) => MEDIA_EXT.includes((/\.[^.]+$/.exec(file.name) || [''])[0].toLowerCase());
  const isVideoFile = (file) => file.type.startsWith('video/') || /\.(mp4|m4v|webm|mov)$/i.test(file.name);

  /** Eine Datei als neuen Clip hochladen (oder die Datei eines Clips ersetzen), samt Vorschaubild. meta kommt von probe(). */
  async function uploadClip(file, meta, onProgress, replaceId) {
    const query = new URLSearchParams({ name: file.name });
    for (const k of ['duration', 'width', 'height']) if (meta[k]) query.set(k, meta[k]);
    const path = (replaceId ? '/api/resources/' + replaceId + '/file' : '/api/resources/upload') + '?' + query;
    const clip = await send(path, file, onProgress);
    if (meta.thumb) await api('PUT', '/api/resources/' + clip.id + '/thumb', meta.thumb).catch(() => {});
    return clip;
  }
  const unreadableNote = 'hochgeladen, aber dieser Browser kann das Video nicht lesen. Format prüfen (H.264 in MP4).';

  /** Untertiteldateien dem passenden Video zuordnen; fresh: eben hochgeladene Clips. */
  async function uploadSubtitles(subs, fresh) {
    for (const file of subs) {
      const u = { name: file.name, progress: 0, done: false, error: '' };
      uploads.push(u); drawUploads();
      try {
        const clip = subtitleTarget(file.name, fresh);
        if (!clip) throw new Error('kein Video mit diesem Namen gefunden. Die Datei muss wie das Video heissen, oder in der Ressource unter „Untertitel" auswählen.');
        await saveSubtitles(clip.id, file);
        u.progress = 1;
      } catch (e) { u.error = e.message; }
      u.done = true; drawUploads();
    }
    if (subs.length) state.resources = await api('GET', '/api/resources');
  }

  async function uploadFiles(files, replaceId, done = () => render()) {
    const subs = replaceId ? [] : files.filter(isSubtitleFile);
    const fresh = [];
    for (const file of files) {
      if (subs.includes(file)) continue;
      const u = { name: file.name, progress: 0, done: false, error: '' };
      uploads.push(u); drawUploads();
      try {
        const meta = await probe(file);
        const clip = await uploadClip(file, meta, (p) => { u.progress = p; drawUploads(); }, replaceId);
        fresh.push(clip);
        if (meta.unreadable && isVideoFile(file)) u.error = unreadableNote;
        u.progress = 1;
      } catch (e) { u.error = e.message; }
      u.done = true; drawUploads();
    }
    state.resources = await api('GET', '/api/resources');
    // Untertiteldateien zuletzt: Dann gibt es das Video schon, zu dem sie gehören.
    await uploadSubtitles(subs, fresh);
    done();
  }

  let resourceFilter = { text: '', tags: [] };

  function resourcesPage() {
    const picker = h('input', { type: 'file', multiple: true, accept: 'video/*,image/*,' + SUBTITLE_ACCEPT, style: { display: 'none' }, onchange: (e) => { uploadFiles([...e.target.files]); e.target.value = ''; } });
    const grid = h('div', {});
    const tagRow = h('div', { class: 'chips' });

    function draw() {
      const text = resourceFilter.text.toLowerCase();
      set(tagRow, ...tagFilterChips([...new Set(state.resources.flatMap((c) => c.tags))].sort((a, b) => a.localeCompare(b, 'de')), resourceFilter.tags, draw));
      const list = state.resources.filter((c) => (!text || c.name.toLowerCase().includes(text)) && hasAnyTag(c, resourceFilter.tags));
      if (!state.resources.length) {
        grid.className = '';
        set(grid, h('div', { class: 'empty' }, h('strong', {}, 'Noch keine Ressourcen'), 'Videos und Bilder hierher ziehen oder auswählen. Empfohlen: MP4 mit H.264 in 1080p. Eine Untertiteldatei mit demselben Namen wie das Video wird gleich zugeordnet.', h('br'),
          h('button', { class: 'btn primary', onclick: () => picker.click() }, 'Dateien hochladen')));
        return;
      }
      grid.className = 'grid';
      const wc = clockAt();
      set(grid, ...list.map((c) => h('button', { class: 'card' + (c.enabled ? '' : ' inactive'), onclick: () => resourceDialog(c) },
        h('div', { class: 'thumb', style: bg(c.thumb || (c.type === 'image' ? c.src : '')) }, !c.thumb && c.type !== 'image' ? typeLabel[c.type] : null, h('span', { class: 'len' }, (c.type === 'video' ? '' : typeLabel[c.type] + ' ') + fmtDuration(R.clipLength(c)))),
        h('div', { class: 'card-body' }, h('div', { class: 'card-name' }, hl(c.name, resourceFilter.text)),
          h('div', { class: 'chips' }, !c.enabled ? h('span', { class: 'chip off' }, 'inaktiv') : null,
            R.describe(c.rule) ? h('span', { class: 'chip rule' }, R.describe(c.rule)) : null,
            c.enabled && !R.matches(c.rule, wc) ? h('span', { class: 'chip off' }, 'gilt jetzt nicht') : null,
            c.type === 'video' && c.speed !== 1 ? h('span', { class: 'chip', title: 'Abspielgeschwindigkeit' }, fmtSpeed(c.speed)) : null,
            c.subtitles ? h('span', { class: 'chip', title: 'Untertitel: ' + c.subtitles.name }, 'Untertitel') : null,
            c.tags.map((t) => h('span', { class: 'chip' }, t)))))));
      if (!list.length) set(grid, h('div', { class: 'empty', style: { gridColumn: '1 / -1' } }, h('strong', {}, 'Keine Ressource passt zum Filter'), 'Suchtext oder Tag ändern.'));
    }

    const onDragOver = (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); document.body.classList.add('dropping'); } };
    const onDragLeave = (e) => { if (!e.relatedTarget) document.body.classList.remove('dropping'); };
    const onDrop = (e) => { if (!e.dataTransfer || !e.dataTransfer.files.length) return; e.preventDefault(); document.body.classList.remove('dropping'); uploadFiles([...e.dataTransfer.files]); };
    window.addEventListener('dragover', onDragOver); window.addEventListener('dragleave', onDragLeave); window.addEventListener('drop', onDrop);
    cleanup.push(() => { window.removeEventListener('dragover', onDragOver); window.removeEventListener('dragleave', onDragLeave); window.removeEventListener('drop', onDrop); document.body.classList.remove('dropping'); });

    draw();
    return h('div', {}, picker,
      h('div', { class: 'head' }, h('h1', {}, 'Ressourcen'),
        h('button', { class: 'btn', onclick: webResourceDialog }, 'Webseite hinzufügen'),
        h('button', { class: 'btn primary', onclick: () => picker.click() }, 'Dateien hochladen')),
      h('div', { class: 'filters' }, h('input', { type: 'text', placeholder: 'Ressourcen durchsuchen', 'aria-label': 'Ressourcen durchsuchen', value: resourceFilter.text, oninput: (e) => { resourceFilter.text = e.target.value; draw(); } }), tagRow),
      grid);
  }

  function webResourceDialog() {
    const d = { name: '', url: '', duration: 30 };
    dialog('Webseite hinzufügen', h('div', {},
      h('label', { class: 'field' }, h('span', {}, 'Adresse'), h('input', { type: 'url', placeholder: 'https://', oninput: (e) => { d.url = e.target.value; } })),
      h('label', { class: 'field' }, h('span', {}, 'Name'), h('input', { type: 'text', oninput: (e) => { d.name = e.target.value; } })),
      h('label', { class: 'field' }, h('span', {}, 'Anzeigedauer in Sekunden'), h('input', { type: 'number', min: 1, value: 30, oninput: (e) => { d.duration = e.target.value; } })),
      h('p', { class: 'hint' }, 'Viele fremde Seiten verbieten das Einbetten. Gedacht für eigene Seiten wie einen Kursplan.')), (close) => [
      h('button', { class: 'btn', onclick: close }, 'Abbrechen'),
      h('button', { class: 'btn primary', onclick: async () => { try { await api('POST', '/api/resources', d); state.resources = await api('GET', '/api/resources'); close(); render(); } catch (e) { oops(e); } } }, 'Hinzufügen')
    ]);
  }

  /** Ressource bearbeiten. refresh(deletedId) zeichnet danach neu: auf der Ressourcen-Seite die ganze Seite,
      im Sequenz-Editor nur Ressourcen-Liste, Zeitleiste und Vorschau, damit Abspielmarke und Auswahl bleiben. */
  function resourceDialog(c, refresh = () => render()) {
    const d = { name: c.name, tags: [...c.tags], duration: c.duration, fit: c.fit, speed: c.speed || 1, rule: c.rule, enabled: c.enabled, url: c.url };
    const ruleBox = h('span', {});
    const drawRule = () => set(ruleBox, ruleChip(d.rule, () => ruleDialog('Wann darf „' + d.name + '" laufen?', d.rule, (r) => { d.rule = r; drawRule(); }), 'immer'));
    drawRule();
    const replace = h('input', { type: 'file', accept: 'video/*,image/*', style: { display: 'none' }, onchange: (e) => { if (e.target.files.length) { close(); uploadFiles([e.target.files[0]], c.id, refresh); } } });
    const media = c.type === 'video' ? h('video', { class: 'preview-media', src: c.src, controls: true, muted: true, preload: 'metadata', poster: c.thumb || undefined, defaultPlaybackRate: c.speed || 1 })
      : c.type === 'image' ? h('img', { class: 'preview-media', src: c.src, alt: '' }) : null;
    const usedIn = state.sequences.filter((s) => s.items.some((i) => (i.type === 'clip' && i.ref === c.id) || (i.type === 'tag' && hasTag(c, i.ref)))).map((s) => s.name);

    // Untertitel werden sofort gespeichert, unabhängig vom Knopf "Speichern".
    let subtitles = c.subtitles;
    const subsBox = h('div', { class: 'row' });
    const subsChanged = async (saved, text) => {
      subtitles = saved.subtitles;
      state.resources = await api('GET', '/api/resources');
      drawSubs();
      refresh();
      toast(text);
    };
    const subsPicker = h('input', { type: 'file', accept: SUBTITLE_ACCEPT, style: { display: 'none' }, onchange: async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try { const saved = await saveSubtitles(c.id, file); await subsChanged(saved, saved.cues + ' Untertitel gespeichert'); } catch (ex) { oops(ex); }
    } });
    function drawSubs() {
      set(subsBox,
        subtitles ? h('span', { class: 'chip' }, subtitles.name) : h('span', { class: 'hint' }, 'keine'),
        h('button', { type: 'button', class: 'btn small', onclick: () => subsPicker.click() }, subtitles ? 'Ersetzen' : 'Datei auswählen'),
        subtitles ? h('button', { type: 'button', class: 'btn small danger', onclick: async () => {
          try { await subsChanged(await api('DELETE', '/api/resources/' + c.id + '/subtitles'), 'Untertitel entfernt'); } catch (ex) { oops(ex); }
        } }, 'Entfernen') : null);
      // Die Vorschau oben im Dialog zeigt die Untertitel gleich mit.
      for (const t of [...media.querySelectorAll('track')]) t.remove();
      if (subtitles) {
        media.append(h('track', { kind: 'captions', label: 'Untertitel', default: true, src: subtitles.src }));
        if (media.textTracks[0]) media.textTracks[0].mode = 'showing';
      }
    }
    if (c.type === 'video') drawSubs();
    const body = h('div', {}, media, replace,
      h('label', { class: 'field' }, h('span', {}, 'Name'), h('input', { type: 'text', value: d.name, oninput: (e) => { d.name = e.target.value; } })),
      c.type === 'web' ? h('label', { class: 'field' }, h('span', {}, 'Adresse'), h('input', { type: 'url', value: d.url, oninput: (e) => { d.url = e.target.value; } })) : null,
      h('div', { class: 'field' }, h('div', { class: 'field-label' }, 'Tags'), tagInput(d.tags, () => {})),
      c.type !== 'video' ? h('label', { class: 'field' }, h('span', {}, 'Anzeigedauer in Sekunden'), h('input', { type: 'number', min: 1, value: d.duration, oninput: (e) => { d.duration = e.target.value; } })) : null,
      c.type !== 'web' ? h('label', { class: 'field' }, h('span', {}, 'Darstellung'), h('select', { onchange: (e) => { d.fit = e.target.value; } },
        h('option', { value: 'contain', selected: d.fit === 'contain' }, 'Einpassen (alles sichtbar, eventuell Ränder)'),
        h('option', { value: 'cover', selected: d.fit === 'cover' }, 'Füllen (Bildschirm voll, Ränder beschnitten)'))) : null,
      c.type === 'video' ? h('label', { class: 'field' }, h('span', {}, 'Abspielgeschwindigkeit'),
        h('select', { onchange: (e) => { d.speed = Number(e.target.value); if (media) media.playbackRate = d.speed; } },
          R.SPEEDS.map((v) => h('option', { value: v, selected: v === d.speed }, fmtSpeed(v) + (v === 1 ? ' (normal)' : '')))),
        h('div', { class: 'hint' }, 'Gilt überall, wo die Ressource läuft. In einer Sequenz lässt sich die Geschwindigkeit pro Stelle übersteuern.')) : null,
      c.type === 'video' ? h('div', { class: 'field' }, h('div', { class: 'field-label' }, 'Untertitel'), subsBox, subsPicker,
        h('div', { class: 'hint', style: { marginTop: '5px' } }, 'SRT, VTT, ASS, SSA oder SBV. Die Untertitel erscheinen überall, wo die Ressource läuft.')) : null,
      h('div', { class: 'field' }, h('div', { class: 'field-label' }, 'Regel (gilt überall, wo die Ressource vorkommt)'), ruleBox),
      h('div', { class: 'field' }, h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: d.enabled, onchange: (e) => { d.enabled = e.target.checked; } }), 'Aktiv')),
      h('p', { class: 'hint' }, [typeLabel[c.type], c.width ? c.width + ' × ' + c.height : '', c.type === 'video' ? fmtDuration(c.duration) + ' min' : '', fmtSize(c.size), usedIn.length ? 'verwendet in: ' + usedIn.join(', ') : 'in keiner Sequenz verwendet'].filter(Boolean).join(', ')));
    const close = dialog('Ressource bearbeiten', body, (cl) => [
      h('button', { class: 'btn danger left', onclick: () => removeWithUsage('/api/resources/' + c.id, '„' + c.name + '" löschen?', 'Die Ressource und ihre Datei werden gelöscht.', async () => { cl(); state.resources = await api('GET', '/api/resources'); state.sequences = await api('GET', '/api/sequences'); toast('Ressource gelöscht'); refresh(c.id); }) }, 'Löschen'),
      c.type !== 'web' ? h('button', { class: 'btn', onclick: () => replace.click() }, 'Datei ersetzen') : null,
      h('button', { class: 'btn primary', onclick: async () => { try { await api('PUT', '/api/resources/' + c.id, d); state.resources = await api('GET', '/api/resources'); cl(); refresh(); toast('Gespeichert'); } catch (e) { oops(e); } } }, 'Speichern')
    ], true);
  }

  // ───────── Listen: Sequenzen und Mastersequenzen ─────────

  /** Alle Clips, die ein Eintrag einer Sequenz beisteuert. */
  function itemClips(item) {
    if (item.type === 'clip') { const c = clipById(item.ref); return c ? [c] : []; }
    if (item.type === 'tag') return state.resources.filter((c) => c.enabled && hasTag(c, item.ref));
    return [];
  }
  /** Länge eines Eintrags auf der Zeitleiste in Sekunden; rechnet wie der Server. */
  function itemDuration(item) {
    if (item.type === 'sequence') { const s = seqById(item.ref); return s ? seqDuration(s) : 0; }
    if (item.type === 'tag') return itemClips(item).reduce((sum, c) => sum + R.clipLength(c, c.type === 'video' ? null : item.duration), 0);
    return R.clipLength(clipById(item.ref), item.duration, item.offset, item.speed);
  }
  /** Ende einer Überlagerung auf der Zeitleiste, 0 wenn sie nicht läuft (ausgesetzt oder Clip inaktiv). */
  function overlayEnd(item) {
    const c = item.type === 'clip' ? clipById(item.ref) : null;
    return item.enabled && c && c.enabled ? (item.start || 0) + R.clipLength(c, item.duration, item.offset, item.speed) : 0;
  }
  /** Länge eines Durchlaufs: bis zum Ende des letzten Inhalts, Hauptspur oder Überlagerung. */
  const seqDuration = (seq) => {
    const inUse = (i) => Boolean(seq.split) || i.area !== 1;   // Bereich B zählt nur, solange die Sequenz geteilt ist
    const main = [0, 0];
    for (const i of seq.items) if (i.enabled && !(i.track > 0) && inUse(i)) main[i.area === 1 ? 1 : 0] += itemDuration(i);
    return Math.max(main[0], main[1], ...seq.items.filter((i) => i.track > 0 && inUse(i)).map(overlayEnd));
  };

  function previewUrl(seq, sim) {
    return '/player/?preview=' + seq.kind + ':' + seq.id + (sim ? '&at=' + encodeURIComponent(sim) : '');
  }

  /** Dialog zum Umbenennen einer Sequenz oder Mastersequenz. Enter speichert, Escape bricht ab. apply(name) übernimmt den neuen Namen. */
  function renameDialog(seq, apply) {
    const input = h('input', { type: 'text', value: seq.name, maxlength: 200, 'aria-label': 'Name' });
    let saveBtn;
    const save = async (close) => {
      const name = input.value.trim();
      if (!name) return input.focus();
      if (name === seq.name) return close();
      try { await apply(name); close(); } catch (e) { oops(e); }
    };
    const body = h('label', { class: 'field' }, h('span', {}, 'Name'), input);
    const close = dialog((seq.kind === 'master' ? 'Mastersequenz' : 'Sequenz') + ' umbenennen', body, (cl) => [
      h('button', { class: 'btn', onclick: cl }, 'Abbrechen'),
      saveBtn = h('button', { class: 'btn primary', onclick: () => save(cl) }, 'Speichern')
    ]);
    input.addEventListener('input', () => { saveBtn.disabled = !input.value.trim(); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(close); } });
    input.focus();
    input.select();
  }

  function listPage(kind) {
    const master = kind === 'master';
    const base = master ? '#/masters/' : '#/sequences/';
    const wrap = h('div', {});
    const create = async () => {
      try { const s = await api('POST', '/api/sequences', { kind }); state.sequences = await api('GET', '/api/sequences'); location.hash = base + s.id; } catch (e) { oops(e); }
    };
    function draw() {
      const list = state.sequences.filter((s) => s.kind === kind);
      const wc = clockAt();
      const rows = list.map((s) => {
        const on = playingOn(s);
        return h('div', { class: 'list-row' },
          h('div', { class: 'grow' },
            h('a', { class: 'title', href: base + s.id }, s.name),
            h('div', { class: 'meta' },
              h('span', {}, s.items.length + (master ? (s.items.length === 1 ? ' Sequenz' : ' Sequenzen') : (s.items.length === 1 ? ' Eintrag' : ' Einträge')) + ', ' + fmtDuration(seqDuration(s)) + ' min'),
              !s.enabled ? h('span', { class: 'chip off' }, 'inaktiv') : null,
              R.describe(s.rule) ? h('span', { class: 'chip rule' }, R.describe(s.rule)) : null,
              s.enabled && !R.matches(s.rule, wc) ? h('span', { class: 'chip off' }, 'gilt jetzt nicht') : null,
              s.tags.map((t) => h('span', { class: 'chip' }, t)),
              on.length ? h('span', { class: 'chip live' }, 'läuft auf: ' + on.map((x) => x.name).join(', ')) : null)),
          h('a', { class: 'btn small', href: base + s.id }, 'Öffnen'),
          h('button', { class: 'btn small', onclick: () => renameDialog(s, async (name) => { await api('PUT', '/api/sequences/' + s.id, { name }); state.sequences = await api('GET', '/api/sequences'); render(); }) }, 'Umbenennen'),
          h('button', { class: 'btn small', onclick: () => previewModal(s) }, 'Vorschau'),
          h('button', { class: 'btn small', onclick: async () => { try { await api('POST', '/api/sequences/' + s.id + '/duplicate'); state.sequences = await api('GET', '/api/sequences'); render(); } catch (e) { oops(e); } } }, 'Duplizieren'),
          h('button', { class: 'btn small danger', onclick: () => removeWithUsage('/api/sequences/' + s.id, '„' + s.name + '" löschen?', 'Die ' + (master ? 'Mastersequenz' : 'Sequenz') + ' wird gelöscht. Die Ressourcen bleiben erhalten.', async () => { state.sequences = await api('GET', '/api/sequences'); render(); }) }, 'Löschen'));
      });
      set(wrap, 
        h('div', { class: 'head' }, h('h1', {}, master ? 'Mastersequenzen' : 'Sequenzen'), h('button', { class: 'btn primary', onclick: create }, master ? 'Neue Mastersequenz' : 'Neue Sequenz')),
        h('p', { class: 'sub' }, master ? 'Eine Mastersequenz spielt mehrere Sequenzen nacheinander ab: erst Sequenz A komplett, dann B, dann C.' : 'Eine Sequenz ist eine Abfolge von Clips, die in Schleife läuft.'),
        list.length ? h('div', { class: 'list' }, rows) : h('div', { class: 'empty' }, h('strong', {}, master ? 'Noch keine Mastersequenz' : 'Noch keine Sequenz'),
          master ? 'Zuerst Sequenzen anlegen, dann hier aneinanderreihen.' : 'Clips zu einer Abfolge zusammenstellen und einem Bildschirm zuweisen.', h('br'),
          h('button', { class: 'btn primary', onclick: create }, master ? 'Neue Mastersequenz' : 'Neue Sequenz')));
    }
    liveListeners.push(draw);
    draw();
    return wrap;
  }

  // ───────── Editoren ─────────

  function firstThumb(s) {
    for (const it of s.items) { const c = itemClips(it)[0]; if (c && (c.thumb || c.type === 'image')) return c.thumb || c.src; }
    return '';
  }

  /** Anzeige-Angaben zu einem Eintrag: Name, Vorschaubild und ob er zur Wanduhrzeit wc gilt. */
  function itemInfo(item, wc) {
    if (item.type === 'sequence') {
      const s = seqById(item.ref);
      return { name: s ? s.name : 'Gelöschte Sequenz', thumb: s ? firstThumb(s) : '', label: 'Sequenz', sub: s ? s.items.length + ' Einträge, ' + fmtDuration(seqDuration(s)) + ' min' : '',
        valid: Boolean(s && s.enabled && R.matches(s.rule, wc)), off: s && !s.enabled };
    }
    if (item.type === 'tag') {
      const cs = itemClips(item);
      return { name: 'Alle Ressourcen mit Tag „' + item.ref + '"', thumb: cs[0] ? cs[0].thumb || (cs[0].type === 'image' ? cs[0].src : '') : '', label: 'Tag',
        sub: cs.length + (cs.length === 1 ? ' Ressource' : ' Ressourcen') + ', ' + fmtDuration(itemDuration(item)) + ' min', valid: cs.some((c) => R.matches(c.rule, wc)) };
    }
    const c = clipById(item.ref);
    return { name: c ? c.name : 'Gelöschte Ressource', thumb: c ? c.thumb || (c.type === 'image' ? c.src : '') : '', label: c ? typeLabel[c.type] : '', clip: c,
      sub: c ? (c.type === 'video' ? fmtDuration(c.duration) + ' min' : '') : '', valid: Boolean(c && c.enabled && R.matches(c.rule, wc)), off: c && !c.enabled };
  }

  /** Was beide Editoren teilen: Arbeitskopie mit automatischem Speichern, Kopfzeile, Leiste mit Regel und Zeit-Simulation.
      redraw() zeichnet den Editor neu, afterSave() läuft nach jedem erfolgreichen Speichern. */
  /** Ein beschriftetes Feld in der Eigenschaften-Karte eines Editors. */
  const prop = (label, size, ...kids) => h('div', { class: 'prop' + (size ? ' ' + size : '') }, h('div', { class: 'prop-label' }, label), kids);

  /** Mastersequenz: Wann läuft die Sequenz an dieser Stelle? Wie eingestellt, zusätzlich eingeschränkt oder übersteuert. */
  function slotDialog(item, s, onSave) {
    const own = (s && R.describe(s.rule)) || 'immer';
    let mode = item.override ? 'override' : R.isEmpty(item.rule) ? 'same' : 'and';
    const f = ruleFields(item.rule || {});
    const fieldsBox = h('div', { class: 'choice-fields', hidden: mode === 'same' }, f.el);
    const choice = (value, title, text) => h('label', { class: 'choice' },
      h('input', { type: 'radio', name: 'slotmode', checked: mode === value, onchange: () => { mode = value; fieldsBox.hidden = mode === 'same'; } }),
      h('span', {}, h('b', {}, title), h('span', { class: 'hint' }, text)));
    dialog('Ausstrahlung an dieser Stelle', h('div', {},
      h('p', {}, 'Die Sequenz „' + (s ? s.name : '') + '" ist selbst so eingestellt: ', h('b', {}, own), '.'),
      choice('same', 'Wie in der Sequenz eingestellt', 'Hier gilt die Ausstrahlung der Sequenz, ohne Änderung.'),
      choice('and', 'Zusätzlich einschränken', 'Die Sequenz läuft hier nur, wenn ihre eigene Ausstrahlung und die Regel unten zutreffen.'),
      choice('override', 'Übersteuern', 'Hier gilt nur die Regel unten. Die Ausstrahlung der Sequenz wird an dieser Stelle nicht beachtet.'),
      fieldsBox), (close) => [
      h('button', { class: 'btn', onclick: close }, 'Abbrechen'),
      h('button', { class: 'btn primary', onclick: () => { onSave(mode === 'same' ? {} : f.get(), mode === 'override'); close(); } }, 'Übernehmen')
    ], true);
  }
  /** Kurztext zur Ausstrahlung eines Eintrags in der Mastersequenz. */
  function slotText(item, s) {
    const own = (s && R.describe(s.rule)) || 'immer', mine = R.describe(item.rule);
    if (item.override) return { text: 'übersteuert: ' + (mine || 'immer') + ' (statt ' + own + ')', title: 'Statt der Einstellung der Sequenz (' + own + ')', cls: ' rule' };
    if (mine) return { text: own + ' · zusätzlich: ' + mine, title: 'Einstellung der Sequenz und zusätzliche Regel müssen beide zutreffen', cls: ' rule' };
    return { text: 'wie Sequenz: ' + own, title: 'Es gilt die Einstellung der Sequenz', cls: '' };
  }

  function editorBase(original, redraw, afterSave, extraProps) {
    const seq = JSON.parse(JSON.stringify(original));
    const master = seq.kind === 'master';
    let sim = '', saveTimer = null;
    const saveState = h('span', { class: 'savestate' }, 'Gespeichert');
    const title = h('h1', {}, seq.name);
    const statusBox = h('span', { class: 'chips' });
    const ruleBox = h('div', { class: 'prop-main' });
    const lengthBox = h('div', {});
    const usageBox = h('div', { class: 'chips' });
    const previewLink = h('a', { class: 'btn', target: '_blank', rel: 'noopener' }, master ? 'Vorschau' : 'Vorschau im neuen Tab');
    const liveBox = h('span', { class: 'chips' });

    async function save() {
      saveTimer = null;
      try {
        // Clips, die noch hochladen, kommen erst mit ins Speichern, wenn es sie am Server gibt.
        const items = seq.items.filter((i) => !isUploading(i.ref));
        const saved = await api('PUT', '/api/sequences/' + seq.id, { name: seq.name, tags: seq.tags, items, rule: seq.rule, enabled: seq.enabled, split: seq.split || null });
        const i = state.sequences.findIndex((s) => s.id === seq.id);
        if (i >= 0) state.sequences[i] = saved;
        saveState.textContent = 'Gespeichert';
        if (afterSave) afterSave();
      } catch (e) { saveState.textContent = 'Nicht gespeichert'; oops(e); }
    }
    function touch(again = true) {
      saveState.textContent = 'Speichert';
      clearTimeout(saveTimer);
      saveTimer = setTimeout(save, 500);
      if (again) redraw();
    }
    /** Ausstehende Änderungen sofort speichern. */
    const flush = () => { if (!saveTimer) return Promise.resolve(); clearTimeout(saveTimer); return save(); };
    cleanup.push(flush);

    /** Welcher Eintrag läuft gerade auf welchen Bildschirmen? */
    const liveItems = () => {
      const map = new Map();
      for (const s of playingOn(seq)) {
        const id = master ? s.now.masterItemId : s.now.itemId;
        map.set(id, [...(map.get(id) || []), s.name]);
      }
      return map;
    };
    function drawLiveBox() {
      const on = playingOn(seq);
      set(liveBox, ...(on.length ? [h('span', { class: 'chip live' }, 'läuft auf: ' + on.map((s) => s.name).join(', '))] : []));
    }
    /** Wo die Sequenz vorkommt: in Mastersequenzen (mit Hinweis, wenn dort übersteuert) und direkt an Bildschirmen. */
    function drawUsage() {
      const masters = master ? [] : state.sequences.filter((m) => m.kind === 'master' && m.items.some((i) => i.ref === seq.id));
      const screens = state.screens.filter((s) => s.content && s.content.kind === seq.kind && s.content.id === seq.id);
      const chips = [
        ...masters.map((m) => {
          const slots = m.items.filter((i) => i.ref === seq.id);
          const over = slots.filter((i) => i.override);
          const extra = slots.filter((i) => !i.override && !R.isEmpty(i.rule));
          const note = over.length ? 'übersteuert: ' + over.map((i) => R.describe(i.rule) || 'immer').join(' / ')
            : extra.length ? 'zusätzlich: ' + extra.map((i) => R.describe(i.rule)).join(' / ') : '';
          return h('a', { class: 'chip' + (over.length ? ' rule' : ''), href: '#/masters/' + m.id, title: 'Mastersequenz öffnen' }, 'Mastersequenz ' + m.name + (note ? ' (' + note + ')' : ''));
        }),
        ...screens.map((s) => h('span', { class: 'chip' }, 'Bildschirm ' + s.name))
      ];
      set(usageBox, ...(chips.length ? chips : [h('span', { class: 'hint' }, master ? 'Keinem Bildschirm zugewiesen' : 'Noch in keiner Mastersequenz und an keinem Bildschirm')]));
    }
    /** Eigenschaften an den Stand anpassen. Meldet, ob die Sequenz zur Wanduhrzeit wc gilt. */
    function refresh(wc) {
      const valid = seq.enabled && R.matches(seq.rule, wc);
      const text = R.describe(seq.rule);
      const editRule = () => ruleDialog('Wann wird „' + seq.name + '" ausgestrahlt?', seq.rule, (r) => { seq.rule = r; touch(); });
      set(statusBox, !seq.enabled ? h('span', { class: 'chip off' }, 'inaktiv')
        : h('span', { class: 'chip ' + (valid ? 'ok' : 'off') }, (sim ? 'gilt dann' : 'gilt jetzt') + (valid ? '' : ' nicht')));
      set(ruleBox, h('strong', { class: text ? 'rule-text' : '' }, text || 'Immer'), h('button', { type: 'button', class: 'btn small', onclick: editRule }, 'Ändern'));
      const n = seq.items.length;
      set(lengthBox, h('div', { class: 'prop-main' }, h('strong', {}, fmtDuration(seqDuration(seq)) + ' min')),
        h('div', { class: 'hint' }, n + (master ? (n === 1 ? ' Sequenz' : ' Sequenzen') : (n === 1 ? ' Eintrag' : ' Einträge'))));
      previewLink.href = previewUrl(seq, sim);
      drawUsage();
      drawLiveBox();
      return valid;
    }

    const head = [
      h('div', { class: 'editor-head' },
        h('a', { class: 'btn', href: master ? '#/masters' : '#/sequences' }, 'Zurück'),
        h('div', { class: 'title' }, title,
          h('button', { type: 'button', class: 'btn small edit', title: 'Titel ändern', 'aria-label': 'Titel ändern',
            onclick: () => renameDialog(seq, (name) => { seq.name = name; title.textContent = name; touch(); }) }, h('span', { 'aria-hidden': 'true' }, '✎'))),
        saveState, previewLink),
      h('section', { class: 'props', 'aria-label': 'Eigenschaften der ' + (master ? 'Mastersequenz' : 'Sequenz') },
        prop('Status', 'narrow',
          h('div', { class: 'prop-main' }, h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: seq.enabled, onchange: (e) => { seq.enabled = e.target.checked; touch(); } }), 'Aktiv'), statusBox),
          liveBox),
        prop('Ausstrahlung', 'wide', ruleBox,
          h('div', { class: 'hint' }, master ? 'Gilt für alle Sequenzen dieser Mastersequenz.' : 'Vorgabe der Sequenz. In einer Mastersequenz je Eintrag übersteuerbar.')),
        prop('Länge', 'narrow', lengthBox),
        prop('Verwendet in', 'wide', usageBox),
        extraProps ? extraProps() : null,
        prop('Tags', '', tagInput(seq.tags, () => touch(false))),
        prop('Prüfen', 'check', h('label', {}, h('span', { class: 'hint' }, 'Zeitpunkt simulieren'),
          h('input', { type: 'datetime-local', onchange: (e) => { sim = e.target.value; redraw(); } }))))
    ];
    return { seq, touch, flush, head, refresh, liveItems, drawLiveBox, clock: () => clockAt(sim), sim: () => sim };
  }

  // ───────── Mastersequenz: Liste von Sequenzen ─────────

  function masterPage(original) {
    const base = editorBase(original, () => draw());
    const { seq, touch } = base;
    let dragFrom = null, libText = '';
    let libRef = null;        // Sequenz, die gerade aus der Mediathek gezogen wird
    const strip = h('div', { class: 'strip' });
    const listEl = h('div', {});
    const libEl = h('div', { class: 'lib' });

    /** Gilt die Sequenz hinter dem Eintrag zur Zeit wc? Ein übersteuernder Eintrag beachtet ihre eigene Ausstrahlung nicht. */
    const slotValid = (item, wc) => { const s = seqById(item.ref); return Boolean(s && s.enabled && (item.override || R.matches(s.rule, wc))); };

    function move(from, to) {
      if (to < 0 || to >= seq.items.length || from === to) return;
      const [it] = seq.items.splice(from, 1);
      seq.items.splice(to, 0, it);
      touch();
    }

    function draw() {
      const wc = base.clock(), seqValid = base.refresh(wc), live = base.liveItems();

      set(strip, ...seq.items.map((item, i) => {
        const info = itemInfo(item, wc);
        const ok = item.enabled && slotValid(item, wc) && R.matches(item.rule, wc) && seqValid;
        return h('div', { class: 'frame' + (ok ? '' : ' skip') + (live.has(item.id) ? ' live' : ''), 'data-item': item.id, title: (i + 1) + '. ' + info.name, style: { ...bg(info.thumb), flexGrow: String(Math.max(1, itemDuration(item))) } }, h('span', {}, String(i + 1)));
      }));

      if (!seq.items.length) {
        set(listEl, h('div', { class: 'empty' }, h('strong', {}, 'Noch leer'), 'Rechts eine Sequenz mit + anhängen oder hierher ziehen.'));
      } else {
        set(listEl, ...seq.items.map((item, i) => {
          const info = itemInfo(item, wc);
          const ruleOk = R.matches(item.rule, wc);
          const seqOk = slotValid(item, wc);
          const ok = item.enabled && seqOk && ruleOk;
          const slot = slotText(item, seqById(item.ref));
          const row = h('div', { class: 'item' + (ok ? '' : ' skip') + (live.has(item.id) ? ' live' : ''), 'data-item': item.id, draggable: true,
            ondragstart: (e) => { dragFrom = i; row.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', item.id); },
            ondragend: () => { dragFrom = null; row.classList.remove('dragging'); },
            ondragover: (e) => { if (dragFrom !== null || libRef) { e.preventDefault(); row.classList.add('over'); } },
            ondragleave: () => row.classList.remove('over'),
            ondrop: (e) => {
              e.preventDefault(); row.classList.remove('over');
              if (libRef) { const ref = libRef; libRef = null; add(ref, i); } else if (dragFrom !== null) move(dragFrom, i);
            } },
            h('span', { class: 'grip', title: 'Ziehen zum Umordnen', 'aria-hidden': 'true' }, '⠿'),
            h('span', { class: 'pos' }, String(i + 1)),
            h('div', { class: 'mini', style: bg(info.thumb) }, info.thumb ? null : info.label),
            h('div', { class: 'grow' },
              h('div', { class: 'item-name' }, info.name),
              h('div', { class: 'meta' },
                h('span', { class: 'live-slot' }, live.has(item.id) ? h('span', { class: 'chip live' }, live.get(item.id).join(', ')) : null),
                info.sub ? h('span', {}, info.sub) : null,
                h('button', { type: 'button', class: 'chip' + slot.cls, title: slot.title + '. Klicken zum Ändern.',
                  onclick: () => slotDialog(item, seqById(item.ref), (r, override) => { item.rule = r; item.override = override; touch(); }) }, slot.text),
                !item.enabled ? h('span', { class: 'chip off' }, 'ausgesetzt') : null,
                info.off ? h('span', { class: 'chip off' }, 'Sequenz inaktiv') : null,
                item.enabled && !info.off && !(seqOk && ruleOk) ? h('span', { class: 'chip off' }, base.sim() ? 'gilt dann nicht' : 'gilt jetzt nicht') : null)),
            h('div', { class: 'tools' },
              h('div', { class: 'order', role: 'group', 'aria-label': 'Reihenfolge' },
                h('button', { class: 'btn ghost small', title: 'Nach oben', 'aria-label': 'Nach oben', disabled: i === 0, onclick: () => move(i, i - 1) }, '↑'),
                h('button', { class: 'btn ghost small', title: 'Nach unten', 'aria-label': 'Nach unten', disabled: i === seq.items.length - 1, onclick: () => move(i, i + 1) }, '↓')),
              h('button', { class: 'btn ghost small pause', onclick: () => { item.enabled = !item.enabled; touch(); } }, item.enabled ? 'Aussetzen' : 'Fortsetzen'),
              h('button', { class: 'btn ghost small danger del', title: 'Eintrag entfernen', 'aria-label': 'Eintrag entfernen', onclick: () => { seq.items.splice(i, 1); touch(); } }, '×')));
          return row;
        }));
        // Spaltenüberschrift über den Pfeilen; die Platzhalter halten sie bündig mit den Knöpfen darunter.
        listEl.prepend(h('div', { class: 'list-cols', 'aria-hidden': 'true' }, h('span', { class: 'grow' }),
          h('div', { class: 'tools' }, h('span', { class: 'order' }, 'Reihenfolge'), h('span', { class: 'pause' }), h('span', { class: 'del' }))));
      }
      drawLib();
    }

    // Live-Meldungen ändern nur die Markierungen, damit Eingaben nicht den Fokus verlieren.
    liveListeners.push(() => {
      const live = base.liveItems();
      for (const el of [...strip.children, ...listEl.children]) {
        const id = el.dataset && el.dataset.item;
        if (!id) continue;
        el.classList.toggle('live', live.has(id));
        const slot = el.querySelector('.live-slot');
        if (slot) set(slot, ...(live.has(id) ? [h('span', { class: 'chip live' }, live.get(id).join(', '))] : []));
      }
      base.drawLiveBox();
    });

    /** Sequenz einfügen, ohne Stelle hinten. */
    function add(ref, at = seq.items.length) {
      seq.items.splice(at, 0, { id: Math.random().toString(36).slice(2, 9), type: 'sequence', ref, duration: null, rule: {}, override: false, enabled: true });
      touch();
    }
    // Aus der Mediathek gezogen: auf einen Eintrag fallen lassen fügt davor ein, sonst kommt sie ans Ende.
    listEl.addEventListener('dragover', (e) => { if (libRef) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; listEl.classList.toggle('drop-end', !e.target.closest('[data-item]')); } });
    listEl.addEventListener('dragleave', (e) => { if (!listEl.contains(e.relatedTarget)) listEl.classList.remove('drop-end'); });
    listEl.addEventListener('drop', (e) => { listEl.classList.remove('drop-end'); if (libRef && !e.target.closest('[data-item]')) { e.preventDefault(); add(libRef); libRef = null; } });

    function drawLib() {
      const text = libText.toLowerCase();
      const list = state.sequences.filter((s) => s.kind === 'sequence' && (!text || s.name.toLowerCase().includes(text)));
      set(libEl, ...(list.length ? list.map((s) => h('div', { class: 'item', draggable: true, title: 'In die Abfolge ziehen oder mit + anhängen',
        ondragstart: (e) => { libRef = s.id; e.dataTransfer.effectAllowed = 'copy'; e.dataTransfer.setData('text/plain', s.name); },
        ondragend: () => { libRef = null; listEl.classList.remove('drop-end'); } },
        h('div', { class: 'mini', style: bg(firstThumb(s)) }, firstThumb(s) ? null : 'Sequenz'),
        h('div', { class: 'grow' }, h('div', { class: 'item-name' }, hl(s.name, libText)), h('div', { class: 'meta' }, h('span', {}, s.items.length + ' Einträge, ' + fmtDuration(seqDuration(s)) + ' min'),
          h('span', { class: 'chip' + (R.describe(s.rule) ? ' rule' : ''), title: 'Ausstrahlung laut Sequenz' }, R.describe(s.rule) || 'immer'),
          !s.enabled ? h('span', { class: 'chip off' }, 'inaktiv') : null)),
        h('button', { type: 'button', class: 'add', title: 'Hinten anhängen', 'aria-label': s.name + ' hinten anhängen', onclick: () => add(s.id) }, '+')))
        : [h('div', { class: 'empty' }, h('strong', {}, 'Keine Sequenz gefunden'), h('a', { href: '#/sequences' }, 'Sequenzen anlegen'))]));
    }

    draw();
    return h('div', {}, base.head, strip,
      h('div', { class: 'cols' },
        h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', {}, 'Abfolge der Sequenzen')), listEl),
        h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', {}, 'Sequenz anhängen'),
          h('input', { type: 'text', placeholder: 'Suchen', 'aria-label': 'Suchen', oninput: (e) => { libText = e.target.value; drawLib(); } })), libEl)));
  }

  // ───────── Sequenz: Zeitleiste mit Ebenen ─────────

  const TRACK_NAMES = ['Ebene 1', 'Ebene 2', 'Ebene 3', 'Ebene 4'];   // Ebene 1 ist die Hauptspur
  const GUTTER = 96;        // Breite der Spurbeschriftung in Pixeln
  const MIN_LEN = 0.5;      // kürzeste Länge eines Clips auf der Zeitleiste in Sekunden
  const ZOOM_MIN = 1.5, ZOOM_MAX = 200;   // Massstab der Zeitleiste in Pixeln pro Sekunde
  const r2 = (n) => Math.round(n * 100) / 100;
  const FRAME = 1 / 25;   // ein Bild für die Einzelbild-Schritte im Editor (25 Bilder pro Sekunde)
  /** Stelle in der Zeitleiste mit Hundertstelsekunden, z. B. 1:05.40 */
  function fmtPos(sec) {
    const cs = Math.round(Math.max(0, sec) * 100);
    const m = Math.floor(cs / 6000), s = Math.floor(cs / 100) % 60;
    return m + ':' + String(s).padStart(2, '0') + '.' + String(cs % 100).padStart(2, '0');
  }
  const fmtLen = (s) => (s < 60 ? String(Math.round(s * 10) / 10).replace('.', ',') + ' s' : fmtDuration(s));
  const fmtSpeed = (v) => String(v).replace('.', ',') + '×';

  function timelinePage(original) {
    let frame = null, frameSim = '';   // Vorschau-Monitor und der Zeitpunkt, mit dem er gestartet wurde
    const tell = (message) => { if (frame && frame.contentWindow) frame.contentWindow.postMessage(message, location.origin); };
    const splitBox = h('div', {});
    const base = editorBase(original, () => draw(), () => tell({ koi: 'reload' }), () => prop('Bereiche', 'areas', splitBox));
    const { seq, touch } = base;
    // Bereiche: Jede Ebene gehört zu Bereich A oder B. In der Zeitleiste ist eine Zeile eine "Spur" = Bereich × Ebene.
    const LANES = TRACK_NAMES.length;
    const laneOf = (item) => (item.area === 1 ? LANES : 0) + (item.track || 0);
    const isOverLane = (lane) => lane % LANES > 0;
    const areaOfLane = (lane) => Math.floor(lane / LANES);
    const mainLane = (lane) => lane - lane % LANES;
    const laneName = (lane) => (seq.split ? (areaOfLane(lane) ? 'B · ' : 'A · ') : '') + TRACK_NAMES[lane % LANES];
    let selected = null;      // Kennung des gewählten Eintrags (bei mehreren: der zuletzt angeklickte)
    const picked = new Set(); // alle gewählten Einträge, auch mehrere (Rechteck, Umschalt- oder Befehlstaste)
    let marquee = null;       // laufendes Aufziehen eines Auswahlrechtecks
    const marqueeBox = h('div', { class: 'tl-marquee', hidden: true });
    /** Genau einen Eintrag wählen (oder keinen), ohne neu zu zeichnen. */
    const pickOnly = (id) => { selected = id; picked.clear(); if (id) picked.add(id); };
    let zoom = 0;             // 0: ganze Sequenz einpassen, sonst Pixel pro Sekunde
    let pps = 10;             // aktueller Massstab: Pixel pro Sekunde
    let playT = 0;            // Abspielposition der Vorschau in Sekunden
    let playing = false;      // Vorschau läuft (sonst angehalten oder gar nicht gestartet)
    let awaitPause = false;   // angehalten, die genaue Stelle vom Player steht noch aus
    let drag = null;          // laufendes Ziehen in der Zeitleiste
    let scrubbing = false, seekTimer = null;   // Abspielmarke wird gezogen
    let libDrag = null;       // Clip, der gerade aus der Mediathek gezogen wird
    let libText = '';
    const libTags = [];
    let fields = [];          // Eingabefelder der Eigenschaften, zum Nachführen beim Ziehen
    let transforming = false; // „Transformieren" an: Griffe für Position, Größe und Drehung im Monitor
    const els = new Map();    // Kennung -> Block in der Zeitleiste

    const monitor = h('div', { class: 'monitor' });
    const inspector = h('div', { class: 'inspector' });
    const libEl = h('div', { class: 'lib' });
    const posLabel = h('span', { class: 'tl-pos' });
    const playBtn = h('button', { class: 'btn small tl-play', onclick: () => togglePlay() });
    const transport = h('div', { class: 'tl-transport', role: 'group', 'aria-label': 'Wiedergabe' },
      h('button', { class: 'btn small', title: 'Ein Bild zurück (Pfeil links)', 'aria-label': 'Ein Bild zurück', onclick: () => stepFrame(-1) }, '<'),
      playBtn,
      h('button', { class: 'btn small', title: 'Ein Bild vor (Pfeil rechts)', 'aria-label': 'Ein Bild vor', onclick: () => stepFrame(1) }, '>'),
      posLabel);
    const marker = h('div', { class: 'tl-marker', hidden: true });
    const playhead = h('div', { class: 'tl-playhead' });
    const endShade = h('div', { class: 'tl-end', title: 'Ende der Sequenz: Hier beginnt die nächste Runde' });
    const inner = h('div', { class: 'tl-inner' });
    const scroll = h('div', { class: 'tl-scroll' }, inner);
    // Der Regler arbeitet logarithmisch: gleiche Wege am Regler vergrössern um den gleichen Faktor.
    const zoomSlider = h('input', { type: 'range', class: 'tl-zoom', min: 0, max: 100, step: 'any', title: 'Stufenlos zoomen', 'aria-label': 'Massstab der Zeitleiste',
      oninput: (e) => setZoom(ZOOM_MIN * Math.pow(ZOOM_MAX / ZOOM_MIN, e.target.value / 100)) });

    // ── Lage der Einträge ──

    /** Wo jeder Eintrag liegt. Die Hauptspur ist lückenlos (Reihenfolge der Liste), Überlagerungen haben eine eigene Startzeit. */
    function layout() {
      // b.track ist hier die Spur (Bereich × Ebene), b.area der Bereich. Jeder Bereich hat seine eigene lückenlose Hauptspur.
      const blocks = [], at = [0, 0];
      for (const item of seq.items) {
        const clip = item.type === 'clip' ? clipById(item.ref) : null;
        const len = itemDuration(item), area = item.area === 1 ? 1 : 0, lane = area * LANES + (item.track || 0);
        if (item.track > 0) blocks.push({ item, clip, track: lane, area, start: item.start || 0, len });
        else { blocks.push({ item, clip, track: lane, area, start: at[area], len }); at[area] += len; }
      }
      // Die Sequenz dauert bis zum Ende des letzten Inhalts in irgendeinem Bereich; ragt etwas über die Hauptspur von A hinaus, läuft es dort über Schwarz weiter.
      const inUse = (i) => Boolean(seq.split) || i.area !== 1;
      const total = seq.items.reduce((m, i) => (i.track > 0 && inUse(i) ? Math.max(m, overlayEnd(i)) : m), seq.split ? Math.max(at[0], at[1]) : at[0]);
      return { blocks, total, main: at[0], end: blocks.reduce((m, b) => Math.max(m, b.start + b.len), total) };
    }
    const blockOf = (L, item) => L.blocks.find((b) => b.item === item);
    const sameTrack = (L, b) => L.blocks.filter((x) => x.track === b.track && x.item !== b.item);
    const nextStart = (L, b) => sameTrack(L, b).filter((x) => x.start > b.start).reduce((m, x) => Math.min(m, x.start), Infinity);
    const prevEnd = (L, b) => sameTrack(L, b).filter((x) => x.start < b.start).reduce((m, x) => Math.max(m, x.start + x.len), 0);

    /** Hauptspur neu ordnen: item kommt an die Stelle index. Gespeichert wird erst die Hauptspur in Abspielfolge, dann die Überlagerungen. */
    function reorder(item, index, area = 0) {
      const others = seq.items.filter((i) => i !== item);
      const mainA = others.filter((i) => !i.track && i.area !== 1), mainB = others.filter((i) => !i.track && i.area === 1), over = others.filter((i) => i.track > 0);
      item.track = 0;
      item.start = 0;
      item.area = area;
      const list = area ? mainB : mainA;
      list.splice(Math.max(0, Math.min(index, list.length)), 0, item);
      seq.items = [...mainA, ...mainB, ...over];
    }

    /** Nächste freie Stelle auf einer Überlagerungs-Ebene, an der ein Clip der Länge len Platz hat. */
    function freeSpot(L, track, want, len, item) {
      const busy = L.blocks.filter((b) => b.track === track && b.item !== item).sort((a, b) => a.start - b.start);
      let best = null, from = 0;
      const consider = (lo, hi) => {
        if (hi - lo < len - 0.001) return;
        const s = Math.min(Math.max(want, lo), hi - len);
        if (best === null || Math.abs(s - want) < Math.abs(best - want)) best = s;
      };
      for (const b of busy) { consider(from, b.start); from = Math.max(from, b.start + b.len); }
      consider(from, Infinity);
      return Math.max(0, best);
    }

    /** Länge eines Clip-Eintrags setzen. Die volle Länge eines Videos wird als "ganz" gespeichert und folgt dann dem Clip. */
    function setLength(item, clip, len) {
      const isVideo = clip.type === 'video';
      const full = isVideo && clip.duration > 0 ? (clip.duration - (item.offset || 0)) / R.clipSpeed(clip, item.speed) : Infinity;
      len = Math.max(MIN_LEN, Math.min(len, full, 3600));
      item.duration = isVideo && len >= full - 0.05 ? null : r2(len);
    }
    /** Eine Überlagerung darf nicht in den nächsten Clip derselben Ebene ragen. */
    function fitOverlay(item) {
      if (!item.track) return;
      const L = layout(), b = blockOf(L, item), room = nextStart(L, b) - b.start;
      if (b.clip && b.len > room + 0.01) setLength(item, b.clip, room);
    }

    function newItem(type, ref) {
      return { id: Math.random().toString(36).slice(2, 9), type, ref, duration: null, rule: {}, enabled: true, track: 0, start: 0, offset: 0, speed: null, fadeIn: 0.5, fadeOut: 0 };
    }
    function add(type, ref) {
      const item = newItem(type, ref);
      reorder(item, Infinity);
      pickOnly(item.id);
      touch();
      scroll.scrollLeft = scroll.scrollWidth;
    }
    function removeItem(item) {
      seq.items = seq.items.filter((i) => i !== item);
      picked.delete(item.id);
      if (selected === item.id) selected = null;
      touch();
    }
    /** Alle gewählten Einträge entfernen. */
    function removePicked() {
      if (!picked.size) return;
      seq.items = seq.items.filter((i) => !picked.has(i.id));
      pickOnly(null);
      touch();
    }
    function shiftMain(item, dir) {
      const main = seq.items.filter((i) => !i.track && (i.area === 1) === (item.area === 1)), to = main.indexOf(item) + dir;
      if (to < 0 || to >= main.length) return;
      reorder(item, to, item.area === 1 ? 1 : 0);
      touch();
    }
    /** Eintrag auf eine andere Spur legen (Bereich und Ebene). */
    function toTrack(item, lane) {
      const L = layout(), b = blockOf(L, item);
      if (!isOverLane(lane)) {
        const others = L.blocks.filter((x) => x.track === lane && x.item !== item);
        const index = others.findIndex((x) => b.start < x.start + x.len / 2);
        reorder(item, index < 0 ? others.length : index, areaOfLane(lane));
      } else {
        item.start = r2(freeSpot(L, lane, b.start, b.len, item));
        item.area = areaOfLane(lane);
        item.track = lane % LANES;
      }
      touch();
    }

    // ── Zeichnen ──

    const timeAt = (clientX) => (clientX - inner.getBoundingClientRect().left - GUTTER) / pps;
    const rowOf = (track) => inner.querySelector('.tl-track[data-track="' + track + '"]');
    function trackAt(clientY, fallback) {
      const rows = [...inner.querySelectorAll('.tl-track')];
      if (!rows.length) return fallback;
      for (const row of rows) { const r = row.getBoundingClientRect(); if (clientY >= r.top && clientY < r.bottom) return Number(row.dataset.track); }
      return Number((clientY < rows[0].getBoundingClientRect().top ? rows[0] : rows[rows.length - 1]).dataset.track);
    }

    function place(el, b, shift = 0) {
      const width = Math.max(3, b.len * pps - 1);
      const speed = b.clip ? R.clipSpeed(b.clip, b.item.speed) : 1;
      el.style.left = GUTTER + (b.start + shift) * pps + 'px';
      el.style.width = width + 'px';
      el.classList.toggle('tiny', width < 44);
      el.querySelector('.blk-len').textContent = fmtLen(b.len) + (speed !== 1 ? ' · ' + fmtSpeed(speed) : '');
      el.querySelector('.fade.in').style.width = Math.min(b.len, b.item.fadeIn || 0) * pps + 'px';
      el.querySelector('.fade.out').style.width = Math.min(b.len, b.item.fadeOut || 0) * pps + 'px';
    }
    function placePlayhead() {
      playhead.style.left = GUTTER + playT * pps - 1 + 'px';
    }
    function placeMarks(L) {
      endShade.style.left = GUTTER + L.total * pps + 'px';
      posLabel.textContent = fmtPos(playT) + ' / ' + fmtDuration(L.total);
      placePlayhead();
      markTfAway(L);
    }
    /** Nur die Lage aller Blöcke nachführen (beim Ziehen), ohne die Zeitleiste neu aufzubauen.
        vis: auf der Hauptspur alles ab "from" sichtbar um "shift" Sekunden versetzen (Anfang ziehen). */
    function positionAll(vis) {
      const L = layout();
      for (const b of L.blocks) {
        const el = els.get(b.item.id);
        if (el) place(el, b, vis && b.track === vis.lane && b.start >= vis.from - 0.001 ? vis.shift : 0);
      }
      placeMarks(L);
      syncFields();
    }
    function showMarker(track, t) {
      const row = rowOf(track);
      if (!row) return;
      marker.hidden = false;
      marker.style.left = GUTTER + t * pps - 2 + 'px';
      marker.style.top = row.offsetTop + 3 + 'px';
      marker.style.height = row.offsetHeight - 6 + 'px';
    }

    function block(b, wc, seqValid, live) {
      const item = b.item, info = itemInfo(item, wc);
      const ok = item.enabled && info.valid && R.matches(item.rule, wc) && seqValid;
      const el = h('div', {
        class: 'blk' + (b.clip && isUploading(b.clip.id) ? ' uploading' : '') + (isOverLane(b.track) ? ' over' : '') + (b.area ? ' area-b' : '') + (ok ? '' : ' skip') + (picked.has(item.id) ? ' sel' : '') + (live.has(item.id) ? ' live' : ''),
        'data-item': item.id, tabIndex: 0, role: 'button', 'aria-pressed': String(picked.has(item.id)), title: info.name,
        'aria-label': info.name + ', ' + laneName(b.track) + ', Start ' + fmtDuration(b.start) + ', Länge ' + fmtLen(b.len),
        style: bg(info.thumb),
        onpointerdown: (e) => down(e, item, 'move'), onpointermove: moveDrag, onpointerup: endDrag, onpointercancel: endDrag,
        // Mit Umschalt- oder Befehlstaste angeklickt: kein Fokuswechsel, der die Mehrfachauswahl auflösen würde.
        onmousedown: (e) => { if (e.shiftKey || e.metaKey || e.ctrlKey) e.preventDefault(); },
        onfocus: () => { if (!picked.has(item.id)) select(item.id); }, onkeydown: (e) => blockKey(e, item), oncontextmenu: (e) => openMenu(e, item)
      },
        h('i', { class: 'fade in' }), h('i', { class: 'fade out' }),
        h('span', { class: 'blk-name' }, item.type === 'tag' ? 'Tag: ' + item.ref : info.name),
        h('span', { class: 'blk-len' }),
        b.clip && isUploading(b.clip.id) ? h('span', { class: 'blk-up', title: 'Lädt hoch' }, h('i', { style: { width: Math.round((b.clip.progress || 0) * 100) + '%' } })) : null,
        b.clip ? h('span', { class: 'grab l', title: 'Ziehen: Anfang kürzen oder verlängern', onpointerdown: (e) => down(e, item, 'l') }) : null,
        b.clip ? h('span', { class: 'grab r', title: 'Ziehen: Ende kürzen oder verlängern', onpointerdown: (e) => down(e, item, 'r') }) : null);
      els.set(item.id, el);
      place(el, b);
      return el;
    }

    function ruler(span) {
      const step = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600].find((s) => s * pps >= 56) || 3600;
      const ticks = [];
      for (let t = 0; t <= span; t += step) ticks.push(h('span', { class: 'tl-tick', style: { left: GUTTER + t * pps + 'px' } }, fmtDuration(t)));
      return h('div', { class: 'tl-ruler', title: 'Klicken oder ziehen setzt die Abspielposition',
        onpointerdown: (e) => { if (e.button !== 0) return; scrubbing = true; e.currentTarget.setPointerCapture(e.pointerId); scrubTo(e); },
        onpointermove: (e) => { if (scrubbing) scrubTo(e); }, onpointerup: endScrub, onpointercancel: endScrub }, ticks);
    }

    function drawTimeline() {
      const L = layout(), wc = base.clock(), seqValid = base.refresh(wc), live = base.liveItems();
      const hadFocus = inner.contains(document.activeElement);
      // Je Bereich mindestens zwei Ebenen und immer eine freie obenauf.
      const rowsFor = (area) => Math.min(LANES, Math.max(2, L.blocks.filter((b) => b.area === area).reduce((m, b) => Math.max(m, b.track % LANES), 0) + 2));
      const room = (scroll.clientWidth || Math.max(420, window.innerWidth - 300)) - GUTTER - 24;
      pps = zoom || Math.min(40, Math.max(ZOOM_MIN, room / Math.max(L.end * 1.15, 30)));   // eingepasst bleibt rechts etwas Platz zum Ablegen
      const span = Math.max(zoom ? L.end + 10 : 0, room / pps);   // so viele Sekunden zeigt die Zeitleiste
      if (document.activeElement !== zoomSlider) zoomSlider.value = String(100 * Math.log(pps / ZOOM_MIN) / Math.log(ZOOM_MAX / ZOOM_MIN));
      els.clear();
      const tracks = [];
      for (const area of seq.split ? [0, 1] : [0]) {
        if (seq.split) tracks.push(h('div', { class: 'tl-area-sep' + (area ? ' b' : '') }, h('span', {}, area ? 'Bereich B' : 'Bereich A')));
        for (let t = rowsFor(area) - 1; t >= 0; t--) {
          const lane = area * LANES + t;
          tracks.push(h('div', { class: 'tl-track' + (t ? '' : ' primary') + (area ? ' area-b' : ''), 'data-track': lane,
            onpointerdown: (e) => { if (e.target === e.currentTarget) startMarquee(e); },
            ondragover: (e) => libOver(e, lane), ondrop: (e) => libDrop(e, lane) },
            h('span', { class: 'tl-label' }, laneName(lane), h('small', {}, t ? 'Überlagerung' : 'Hauptspur')),
            t === 0 && !L.blocks.some((b) => b.track === lane) ? h('span', { class: 'tl-hint' }, area ? 'Clips für Bereich B hierher ziehen' : 'Ressourcen oder Dateien vom Rechner hierher ziehen, oder mit + anhängen') : null,
            L.blocks.filter((b) => b.track === lane).map((b) => block(b, wc, seqValid, live))));
        }
      }
      inner.style.width = GUTTER + span * pps + 'px';
      set(inner, ruler(span), tracks, endShade, marker, playhead, marqueeBox);
      placeMarks(L);
      if (hadFocus && els.get(selected)) els.get(selected).focus({ preventScroll: true });
    }

    function select(id) {
      if (selected === id && picked.size === (id ? 1 : 0)) return;
      pickOnly(id);
      markPicked();
      drawInspector();
      // Beim Transformieren muss der Clip im Monitor zu sehen sein.
      const item = transforming && id && seq.items.find((i) => i.id === id);
      if (item) showItemInMonitor(item);
    }
    function markPicked() {
      for (const [key, el] of els) { const on = picked.has(key); el.classList.toggle('sel', on); el.setAttribute('aria-pressed', String(on)); }
    }
    /** Umschalt- oder Befehlstaste: einen Eintrag zur Auswahl hinzufügen oder herausnehmen. */
    function togglePick(id) {
      if (picked.has(id)) picked.delete(id); else picked.add(id);
      selected = picked.has(id) ? id : picked.size ? [...picked][picked.size - 1] : null;
      markPicked();
      drawInspector();
    }

    // ── Auswahlrechteck: auf freier Fläche einer Spur aufziehen ──

    function startMarquee(e) {
      if (e.button !== 0) return;
      const r = inner.getBoundingClientRect();
      const add = e.shiftKey || e.metaKey || e.ctrlKey;
      marquee = { x: e.clientX - r.left, y: e.clientY - r.top, base: add ? new Set(picked) : new Set(), add, moved: false };
      window.addEventListener('pointermove', moveMarquee);
      window.addEventListener('pointerup', endMarquee);
      window.addEventListener('pointercancel', endMarquee);
      e.preventDefault();
    }
    function moveMarquee(e) {
      if (!marquee) return;
      const r = inner.getBoundingClientRect();
      const x = Math.max(0, Math.min(e.clientX - r.left, r.width)), y = Math.max(0, Math.min(e.clientY - r.top, r.height));
      if (!marquee.moved && Math.abs(x - marquee.x) < 4 && Math.abs(y - marquee.y) < 4) return;
      marquee.moved = true;
      const left = Math.min(x, marquee.x), top = Math.min(y, marquee.y), w = Math.abs(x - marquee.x), hgt = Math.abs(y - marquee.y);
      Object.assign(marqueeBox.style, { left: left + 'px', top: top + 'px', width: w + 'px', height: hgt + 'px' });
      marqueeBox.hidden = false;
      // Jeder Clip, den das Rechteck berührt, gehört dazu.
      const box = { l: r.left + left, t: r.top + top, r: r.left + left + w, b: r.top + top + hgt };
      picked.clear();
      for (const id of marquee.base) picked.add(id);
      for (const [id, el] of els) {
        const c = el.getBoundingClientRect();
        if (c.right > box.l && c.left < box.r && c.bottom > box.t && c.top < box.b) picked.add(id);
      }
      markPicked();
    }
    function endMarquee() {
      window.removeEventListener('pointermove', moveMarquee);
      window.removeEventListener('pointerup', endMarquee);
      window.removeEventListener('pointercancel', endMarquee);
      if (!marquee) return;
      const { moved, add } = marquee;
      marquee = null;
      marqueeBox.hidden = true;
      if (!moved) { if (!add) select(null); return; }   // nur geklickt: Auswahl aufheben wie bisher
      selected = picked.has(selected) ? selected : picked.size ? [...picked][picked.size - 1] : null;
      drawInspector();
    }
    cleanup.push(endMarquee);

    // ── Ziehen: verschieben, Ebene wechseln, Anfang und Ende kürzen ──

    /** Kanten, an denen ein gezogener Clip einrastet: die anderen Clips, der Anfang, die Abspielposition. */
    function snapPoints(L, item, withMain) {
      const pts = [0, playT];
      for (const b of L.blocks) if (b.item !== item && (withMain || isOverLane(b.track))) pts.push(b.start, b.start + b.len);
      return pts;
    }
    /** Rastet t (mit len auch das Ende des Clips) an der nächsten Kante ein, sonst auf Zehntelsekunden. */
    function snap(t, pts, len) {
      let best = null, dist = 7 / pps;
      for (const p of pts) {
        if (Math.abs(p - t) <= dist) { dist = Math.abs(p - t); best = p; }
        if (len && Math.abs(p - (t + len)) <= dist) { dist = Math.abs(p - (t + len)); best = p - len; }
      }
      return best === null ? Math.round(t * 10) / 10 : best;
    }

    function down(e, item, mode) {
      if (e.button !== 0) return;
      e.stopPropagation();
      if (e.shiftKey || e.metaKey || e.ctrlKey) { togglePick(item.id); return; }
      select(item.id);
      const L = layout(), el = els.get(item.id);
      drag = { item, mode, el, x: e.clientX, y: e.clientY, L, b: blockOf(L, item), offset: item.offset || 0, moved: false, target: null };
      el.setPointerCapture(e.pointerId);
    }

    function moveDrag(e) {
      if (!drag) return;
      if (!drag.moved) {
        if (Math.abs(e.clientX - drag.x) < 4 && Math.abs(e.clientY - drag.y) < 4) return;
        drag.moved = true;
        drag.el.classList.add('dragging');
      }
      const { item, b, L } = drag, clip = b.clip, dt = (e.clientX - drag.x) / pps;
      if (drag.mode === 'r') {
        // Ende ziehen: auf der Hauptspur rückt alles Folgende mit.
        let len = snap(b.start + b.len + dt, snapPoints(L, item, isOverLane(b.track))) - b.start;
        if (isOverLane(b.track)) len = Math.min(len, nextStart(L, b) - b.start);
        setLength(item, clip, len);
        positionAll();
      } else if (drag.mode === 'l') {
        // Anfang ziehen: Bei Videos wandert der Einstieg im Film mit, bei Bildern ändert sich nur die Dauer.
        const speed = R.clipSpeed(clip, item.speed);
        const over = isOverLane(b.track);
        let d = over ? snap(b.start + dt, snapPoints(L, item, true)) - b.start : Math.round(dt * 10) / 10;
        let min = b.len - 3600;
        if (clip.type === 'video') min = Math.max(min, -drag.offset / speed);
        if (over) min = Math.max(min, prevEnd(L, b) - b.start);
        d = Math.max(min, Math.min(d, b.len - MIN_LEN));
        if (clip.type === 'video') item.offset = r2(drag.offset + d * speed);
        if (over) item.start = r2(b.start + d);
        setLength(item, clip, b.len - d);
        positionAll(over ? null : { from: b.start, shift: d, lane: b.track });
      } else {
        // Verschieben: auf der Hauptspur zwischen die anderen Clips einsortieren, auf den Ebenen darüber frei platzieren.
        let track = trackAt(e.clientY, b.track);
        if (item.type === 'tag') track = mainLane(track);   // Tag-Einträge nur auf einer Hauptspur
        const home = rowOf(b.track), row = rowOf(track);
        drag.el.style.transform = home && row ? 'translateY(' + (row.offsetTop - home.offsetTop) + 'px)' : '';
        if (!isOverLane(track)) {
          const tp = timeAt(e.clientX);
          const others = L.blocks.filter((x) => x.track === track && x.item !== item);
          let index = others.findIndex((x) => tp < x.start + x.len / 2);
          if (index < 0) index = others.length;
          const last = others[others.length - 1];
          showMarker(track, index < others.length ? others[index].start : last ? last.start + last.len : 0);
          drag.el.style.left = GUTTER + (b.start + dt) * pps + 'px';
          drag.target = { track, index };
        } else {
          const start = freeSpot(L, track, snap(Math.max(0, b.start + dt), snapPoints(L, item, true), b.len), b.len, item);
          marker.hidden = true;
          drag.el.style.left = GUTTER + start * pps + 'px';
          drag.target = { track, start };
        }
      }
    }

    function endDrag() {
      if (!drag) return;
      const { item, mode, target, moved, el } = drag;
      drag = null;
      marker.hidden = true;
      el.classList.remove('dragging');
      el.style.transform = '';
      if (!moved) return;   // nur ein Klick: Die Auswahl steht schon
      if (mode === 'move' && target) {
        if (!isOverLane(target.track)) reorder(item, target.index, areaOfLane(target.track));
        else { item.area = areaOfLane(target.track); item.track = target.track % LANES; item.start = r2(target.start); }
      }
      touch();
    }

    function blockKey(e, item) {
      if (e.target !== e.currentTarget) return;
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); if (picked.size > 1 && picked.has(item.id)) removePicked(); else removeItem(item); return; }
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const dir = e.key === 'ArrowLeft' ? -1 : 1;
      if (!item.track) return shiftMain(item, dir);
      const L = layout(), b = blockOf(L, item);
      item.start = r2(freeSpot(L, laneOf(item), Math.max(0, b.start + dir * (e.shiftKey ? 0.1 : 1)), b.len, item));
      touch();
    }

    // ── Kontextmenü: Rechtsklick auf einen Clip ──

    let menu = null;
    const menuAway = (e) => { if (menu && !menu.contains(e.target)) closeMenu(); };
    const menuKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); closeMenu(true); } };
    function closeMenu(refocus) {
      if (!menu) return;
      menu.remove();
      menu = null;
      document.removeEventListener('pointerdown', menuAway, true);
      document.removeEventListener('keydown', menuKey, true);
      window.removeEventListener('blur', closeMenu);
      window.removeEventListener('resize', closeMenu);
      scroll.removeEventListener('scroll', closeMenu);
      if (refocus === true && els.get(selected)) els.get(selected).focus({ preventScroll: true });
    }
    function openMenu(e, item) {
      e.preventDefault();
      closeMenu();
      const many = picked.size > 1 && picked.has(item.id);   // Rechtsklick in eine Mehrfachauswahl wirkt auf alle
      if (!many) select(item.id);
      const remove = h('button', { type: 'button', role: 'menuitem', class: 'danger', onclick: () => { closeMenu(); if (many) removePicked(); else removeItem(item); } },
        many ? picked.size + ' Clips entfernen' : 'Clip entfernen');
      showMenu(e, 'Aktionen für den Clip', [remove]);
    }
    /** Kontextmenü an der Maus (über die Menü-Taste der Tastatur am Element), immer im Fenster. */
    function showMenu(e, label, buttons) {
      menu = h('div', { class: 'ctxmenu', role: 'menu', 'aria-label': label }, buttons);
      document.body.append(menu);
      // An der Maus öffnen; über die Menü-Taste der Tastatur gibt es keine Mausposition, dann am Clip. Immer im Fenster bleiben.
      const box = e.currentTarget.getBoundingClientRect(), size = menu.getBoundingClientRect();
      const x = e.clientX || box.left + 12, y = e.clientY || box.bottom;
      menu.style.left = Math.max(8, Math.min(x, window.innerWidth - size.width - 8)) + 'px';
      menu.style.top = Math.max(8, Math.min(y, window.innerHeight - size.height - 8)) + 'px';
      buttons[0].focus();
      document.addEventListener('pointerdown', menuAway, true);
      document.addEventListener('keydown', menuKey, true);
      window.addEventListener('blur', closeMenu);
      window.addEventListener('resize', closeMenu);
      scroll.addEventListener('scroll', closeMenu);
    }
    cleanup.push(closeMenu);
    /** Rechtsklick auf eine Ressource in der Liste neben dem Monitor. */
    function openLibMenu(e, id) {
      const res = clipById(id);
      if (!res) return;
      e.preventDefault();
      closeMenu();
      showMenu(e, 'Aktionen für „' + res.name + '"', [
        h('button', { type: 'button', role: 'menuitem', onclick: () => { closeMenu(); openResource(res); } }, 'Öffnen'),
        h('button', { type: 'button', role: 'menuitem', onclick: () => { closeMenu(); add('clip', res.id); } }, 'Hinten anhängen')]);
    }
    /** Ressource im Dialog bearbeiten, ohne den Editor zu verlassen. Gelöscht: auch hier aus der Sequenz nehmen. */
    function openResource(res) {
      resourceDialog(res, (deleted) => {
        if (!alive) return;
        if (deleted) {
          const gone = seq.items.filter((i) => i.type === 'clip' && i.ref === deleted);
          for (const i of gone) { picked.delete(i.id); if (selected === i.id) selected = null; }
          seq.items = seq.items.filter((i) => !gone.includes(i));
          if (gone.length) { touch(); return; }
        }
        drawLib(); drawTimeline(); drawInspector();
        tell({ koi: 'reload' });   // Länge, Geschwindigkeit oder Datei können sich geändert haben
      });
    }

    // ── Aus der Mediathek in die Zeitleiste ziehen ──

    function libSpot(e, track) {
      const L = layout(), tp = Math.max(0, timeAt(e.clientX));
      if (!isOverLane(track)) {
        const main = L.blocks.filter((b) => b.track === track);
        let index = main.findIndex((b) => tp < b.start + b.len / 2);
        if (index < 0) index = main.length;
        const last = main[main.length - 1];
        return { index, at: index < main.length ? main[index].start : last ? last.start + last.len : 0 };
      }
      const len = libDrag ? R.clipLength(clipById(libDrag.ref)) : 10;   // Dateien vom Rechner: Länge erst nach dem Ablegen bekannt
      return { at: freeSpot(L, track, snap(tp, snapPoints(L, null, true), len), len, null) };
    }
    function libOver(e, track) {
      if (isFileDrag(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; showMarker(track, libSpot(e, track).at); return; }
      if (!libDrag || (libDrag.type === 'tag' && isOverLane(track))) return;   // Tag-Einträge gibt es nur auf einer Hauptspur
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      showMarker(track, libSpot(e, track).at);
    }
    function libDrop(e, track) {
      if (isFileDrag(e)) return dropFiles(e, track);
      if (!libDrag || (libDrag.type === 'tag' && isOverLane(track))) return;
      e.preventDefault();
      const spot = libSpot(e, track), item = newItem(libDrag.type, libDrag.ref);
      if (!isOverLane(track)) reorder(item, spot.index, areaOfLane(track));
      else { item.area = areaOfLane(track); item.track = track % LANES; item.start = r2(spot.at); item.fadeOut = 0.5; seq.items.push(item); }
      libDrag = null;
      marker.hidden = true;
      pickOnly(item.id);
      touch();
    }

    // ── Dateien vom Rechner direkt auf die Zeitleiste: legen sofort einen Platzhalter ab und laden im Hintergrund in die Clips ──

    let alive = true;
    cleanup.push(() => { alive = false; });
    const isFileDrag = (e) => !libDrag && Boolean(e.dataTransfer) && [...e.dataTransfer.types].includes('Files');
    // Daneben fallen gelassen: nicht die Datei im Browser öffnen.
    const blockFileDrop = (e) => { if (isFileDrag(e) && !e.defaultPrevented) { e.preventDefault(); e.dataTransfer.dropEffect = 'none'; marker.hidden = true; } };
    window.addEventListener('dragover', blockFileDrop);
    window.addEventListener('drop', blockFileDrop);
    cleanup.push(() => { window.removeEventListener('dragover', blockFileDrop); window.removeEventListener('drop', blockFileDrop); });

    async function dropFiles(e, track) {
      e.preventDefault();
      marker.hidden = true;
      const files = [...e.dataTransfer.files], spot = libSpot(e, track);
      const media = files.filter(isMediaFile), subs = files.filter(isSubtitleFile);
      const other = files.filter((f) => !media.includes(f) && !subs.includes(f));
      if (other.length) toast(other.map((f) => f.name).join(', ') + ': nicht unterstützt. Möglich sind Videos (MP4, WebM, MOV) und Bilder (JPG, PNG, WebP, GIF).', true);
      if (!media.length) { if (subs.length) await uploadSubtitles(subs, []); if (alive) drawLib(); return; }
      // Länge und Vorschaubild liest der Browser in einem Augenblick aus, dann stehen die Platzhalter mit der richtigen Länge da.
      const metas = await Promise.all(media.map(probe));
      if (!alive) return;
      const placed = [];
      let index = spot.index, at = spot.at;
      media.forEach((file, n) => {
        const meta = metas[n], video = isVideoFile(file);
        const temp = { id: 'up:' + Math.random().toString(36).slice(2, 9), name: file.name.replace(/\.[^.]+$/, ''), type: video ? 'video' : 'image',
          src: '', thumb: meta.thumb ? URL.createObjectURL(meta.thumb) : '', duration: video ? meta.duration || 10 : 10, width: meta.width || null, height: meta.height || null,
          speed: 1, fit: 'contain', enabled: true, tags: [], rule: {}, progress: 0 };
        state.resources.push(temp);
        const item = newItem('clip', temp.id);
        if (!isOverLane(track)) reorder(item, index++, areaOfLane(track));
        else {
          const len = R.clipLength(temp), L = layout();
          item.area = areaOfLane(track); item.track = track % LANES; item.start = r2(freeSpot(L, track, at, len, null)); item.fadeOut = 0.5;
          at = item.start + len;
          seq.items.push(item);
        }
        placed.push({ file, meta, temp, item });
      });
      pickOnly(placed[placed.length - 1].item.id);
      touch();
      drawLib();
      const fresh = [];
      for (const p of placed) {
        const u = { name: p.file.name, progress: 0, done: false, error: '' };
        uploads.push(u); drawUploads();
        try {
          const clip = await uploadClip(p.file, p.meta, (v) => {
            u.progress = v; p.temp.progress = v; drawUploads();
            for (const el of inner.querySelectorAll('.blk.uploading')) {
              const it = seq.items.find((i) => i.id === el.dataset.item);
              if (it && it.ref === p.temp.id) el.querySelector('.blk-up i').style.width = Math.round(v * 100) + '%';
            }
          });
          fresh.push(clip);
          if (p.meta.unreadable && isVideoFile(p.file)) u.error = unreadableNote;
          u.progress = 1;
          swapUploaded(p, clip);
        } catch (ex) {
          u.error = ex.message;
          dropPlaceholder(p);
        }
        u.done = true; drawUploads();
      }
      state.resources = [...(await api('GET', '/api/resources')), ...state.resources.filter((c) => isUploading(c.id))];
      await uploadSubtitles(subs, fresh);
      if (alive) { drawLib(); drawTimeline(); drawInspector(); }
    }
    /** Hochgeladen: Der Platzhalter wird zum echten Clip. Ist der Editor schon zu, wird der Eintrag direkt in der gespeicherten Sequenz ergänzt. */
    async function swapUploaded(p, clip) {
      const i = state.resources.indexOf(p.temp);
      if (i >= 0) state.resources[i] = clip; else state.resources.push(clip);
      if (p.temp.thumb) URL.revokeObjectURL(p.temp.thumb);
      for (const it of seq.items) if (it.ref === p.temp.id) it.ref = clip.id;
      if (alive) { touch(); return; }
      if (!seq.items.includes(p.item)) return;
      try {
        const saved = (await api('GET', '/api/sequences')).find((s) => s.id === seq.id);
        if (!saved) return;
        // Nach dem letzten fertigen Eintrag einreihen, der im Editor davor lag.
        const before = seq.items.slice(0, seq.items.indexOf(p.item)).reverse().find((x) => !isUploading(x.ref) && saved.items.some((y) => y.id === x.id));
        const items = [...saved.items];
        items.splice(before ? items.findIndex((y) => y.id === before.id) + 1 : 0, 0, p.item);
        const next = await api('PUT', '/api/sequences/' + seq.id, { items });
        const k = state.sequences.findIndex((s) => s.id === seq.id);
        if (k >= 0) state.sequences[k] = next;
      } catch (ex) { oops(ex); }
    }
    function dropPlaceholder(p) {
      state.resources = state.resources.filter((c) => c !== p.temp);
      if (p.temp.thumb) URL.revokeObjectURL(p.temp.thumb);
      for (const it of seq.items.filter((i) => i.ref === p.temp.id)) { picked.delete(it.id); if (selected === it.id) selected = null; }
      seq.items = seq.items.filter((i) => i.ref !== p.temp.id);
      if (alive) touch();
    }

    // ── Eigenschaften des gewählten Clips ──

    function syncFields() {
      for (const f of fields) if (document.activeElement !== f.input) f.input.value = f.read();
    }

    /** Bereich „Transformieren" in den Eigenschaften: Schalter für die Griffe im Monitor und die Werte als Zahlen. */
    function tfSection(item) {
      const num = (label, key, min, max, step, title) => {
        const read = () => String(({ ...TF0, ...item.tf })[key]);
        const input = h('input', { type: 'number', min, max, step, value: read(), title, onchange: () => {
          if (input.value.trim() !== '') setTf(item, { [key]: Number(input.value) });
          input.value = read();
        } });
        fields.push({ input, read });
        return h('label', { class: 'field' }, h('span', {}, label), input);
      };
      const toggle = h('input', { type: 'checkbox', checked: transforming, onchange: (e) => {
        transforming = e.target.checked;
        if (transforming) showItemInMonitor(item);
        drawInspector();
      } });
      return h('div', { class: 'insp-tf' },
        h('div', { class: 'tf-head' },
          h('label', { class: 'tf-check' }, toggle, h('span', {}, 'Transformieren')),
          h('span', { class: 'chip tf-chip', hidden: !item.tf, title: 'Position, Größe oder Drehung sind verändert' }, 'verändert')),
        transforming ? h('div', { class: 'insp-grid' },
          num('Größe (%)', 'scale', 5, 400, 1, '100 % füllt den Bildschirm'),
          num('Drehung (°)', 'rotate', -180, 180, 1, 'Im Uhrzeigersinn'),
          num('Mitte waagrecht (%)', 'x', -100, 200, 0.5, '0 ist der linke Rand, 50 die Mitte, 100 der rechte Rand'),
          num('Mitte senkrecht (%)', 'y', -100, 200, 0.5, '0 ist der obere Rand, 50 die Mitte, 100 der untere Rand')) : null,
        transforming ? h('div', { class: 'tf-tools' },
          h('span', { class: 'hint' }, 'Im Monitor: Rahmen ziehen verschiebt, Ecken ändern die Größe, der runde Griff dreht.'),
          h('button', { type: 'button', class: 'btn small', disabled: !item.tf, onclick: () => { setTf(item, TF0); drawInspector(); } }, 'Zurücksetzen')) : null);
    }

    function drawInspector() {
      fields = [];
      drawTfOverlay();
      if (picked.size > 1) {
        const items = seq.items.filter((i) => picked.has(i.id));
        const allOff = items.every((i) => !i.enabled);
        set(inspector, h('div', { class: 'insp-multi' },
          h('div', { class: 'item-name' }, items.length + ' Clips gewählt'),
          h('p', { class: 'hint' }, 'Rechteck auf freier Fläche aufziehen wählt mehrere. Mit Umschalt- oder Befehlstaste einzelne dazunehmen oder herausnehmen. Entf entfernt alle, Escape hebt die Auswahl auf.'),
          h('div', { class: 'chips' }, items.map((i) => h('span', { class: 'chip' }, i.type === 'tag' ? 'Tag: ' + i.ref : (clipById(i.ref) || {}).name || 'Clip'))),
          h('div', { class: 'insp-tools' },
            h('button', { class: 'btn small', onclick: () => { for (const i of items) i.enabled = allOff; touch(); } }, allOff ? 'Alle fortsetzen' : 'Alle aussetzen'),
            h('button', { class: 'btn small', onclick: () => select(null) }, 'Auswahl aufheben'),
            h('button', { class: 'btn small danger', onclick: removePicked }, items.length + ' Clips entfernen'))));
        return;
      }
      const item = seq.items.find((i) => i.id === selected);
      if (!item) {
        set(inspector, h('div', { class: 'empty' }, h('strong', {}, 'Kein Clip gewählt'), 'Einen Clip in der Zeitleiste anklicken. Hier erscheinen dann seine Eigenschaften: Dauer, Geschwindigkeit, Übergänge und Regel.'));
        return;
      }
      const wc = base.clock(), info = itemInfo(item, wc), clip = info.clip;
      const isTag = item.type === 'tag', isVideo = Boolean(clip && clip.type === 'video'), main = !item.track;
      const show = (n) => (n == null ? '' : String(n));
      const changed = () => { touch(false); drawTimeline(); syncFields(); };
      /** Zahlenfeld in Sekunden. write bekommt die Eingabe (null, wenn leer) und trägt sie am Eintrag ein. */
      const seconds = (label, read, write, hint, title) => {
        const input = h('input', { type: 'number', min: 0, step: 0.1, value: read(), placeholder: hint || '', title: title || '', onchange: () => {
          write(input.value.trim() === '' ? null : Math.max(0, Number(input.value) || 0));
          input.value = read();
          changed();
        } });
        fields.push({ input, read });
        return h('label', { class: 'field' }, h('span', {}, label), input);
      };
      const ruleOk = R.matches(item.rule, wc);
      const L = layout(), b = blockOf(L, item);

      set(inspector,
        h('div', { class: 'insp-head' },
          h('div', { class: 'mini', style: bg(info.thumb) }, info.thumb ? null : info.label),
          h('div', { class: 'grow' }, h('div', { class: 'item-name' }, info.name),
            h('div', { class: 'meta' },
              h('span', {}, [info.label, info.sub].filter(Boolean).join(', ')),
              !item.enabled ? h('span', { class: 'chip off' }, 'ausgesetzt') : null,
              info.off ? h('span', { class: 'chip off' }, 'Ressource inaktiv') : null,
              item.enabled && !info.off && !(info.valid && ruleOk) ? h('span', { class: 'chip off' }, base.sim() ? 'gilt dann nicht' : 'gilt jetzt nicht') : null,
              clip && R.describe(clip.rule) ? h('span', { class: 'chip rule', title: 'Regel der Ressource' }, 'Ressource: ' + R.describe(clip.rule)) : null,
              clip && clip.subtitles ? h('span', { class: 'chip', title: 'Untertitel: ' + clip.subtitles.name }, 'Untertitel') : null))),
        h('div', { class: 'insp-grid' },
          !isTag ? h('label', { class: 'field' }, h('span', {}, 'Ebene'),
            h('select', { onchange: (e) => toTrack(item, Number(e.target.value)) }, (seq.split ? [0, 1] : [0]).flatMap((area) => TRACK_NAMES.map((name, t) => {
              const lane = area * LANES + t;
              return h('option', { value: lane, selected: lane === laneOf(item) }, laneName(lane) + (t ? '' : ', Hauptspur'));
            })))) : null,
          main ? h('div', { class: 'field' }, h('div', { class: 'field-label' }, 'Start'), h('div', { class: 'insp-static', title: 'Folgt aus der Reihenfolge auf der Hauptspur' }, 'bei ' + fmtDuration(b.start)))
            : seconds('Start (Sek.)', () => show(item.start), (v) => { const now = layout(); item.start = r2(freeSpot(now, laneOf(item), v || 0, blockOf(now, item).len, item)); }),
          isTag ? seconds('Standdauer je Bild (Sek.)', () => show(item.duration), (v) => { item.duration = v ? r2(v) : null; }, 'wie in der Ressource', 'Gilt für Bilder und Webseiten mit diesem Tag. Videos laufen ganz.')
            : clip ? seconds('Dauer (Sek.)', () => show(item.duration), (v) => { if (v) { setLength(item, clip, v); fitOverlay(item); } else { item.duration = null; fitOverlay(item); } },
              isVideo ? 'ganz' : show(clip.duration || 10), isVideo ? 'Leer: das Video läuft bis zu seinem Ende' : 'Leer: die Standdauer der Ressource') : null,
          isVideo ? seconds('Anfang abschneiden (Sek.)', () => show(item.offset || 0), (v) => {
            item.offset = r2(Math.min(v || 0, Math.max(0, (clip.duration || 0) - MIN_LEN)));
            if (item.duration) setLength(item, clip, item.duration);
            fitOverlay(item);
          }, '', 'So viele Sekunden des Films werden am Anfang übersprungen') : null,
          isVideo ? h('label', { class: 'field' }, h('span', {}, 'Geschwindigkeit'),
            h('select', { title: 'Übersteuert die Vorgabe der Ressource nur an dieser Stelle', onchange: (e) => {
              item.speed = e.target.value ? Number(e.target.value) : null;
              if (item.duration) setLength(item, clip, item.duration);
              fitOverlay(item);
              changed();
            } },
              h('option', { value: '', selected: !item.speed }, 'Wie in der Ressource (' + fmtSpeed(clip.speed || 1) + ')'),
              R.SPEEDS.map((v) => h('option', { value: v, selected: item.speed === v }, fmtSpeed(v))))) : null,
          seconds('Einblenden (Sek.)', () => show(item.fadeIn), (v) => { item.fadeIn = Math.min(10, r2(v || 0)); }, '', main ? '0 ist ein harter Schnitt, sonst wird vom vorherigen Clip übergeblendet' : '0 ist ein harter Schnitt'),
          seconds('Ausblenden (Sek.)', () => show(item.fadeOut), (v) => { item.fadeOut = Math.min(10, r2(v || 0)); }, '', main ? 'Blendet am Ende nach Schwarz aus' : 'Blendet am Ende aus und gibt die Ebene darunter frei'),
          h('div', { class: 'field' }, h('div', { class: 'field-label' }, 'Regel Anzeigedauer'),
            ruleChip(item.rule, () => ruleDialog('Regel für diesen Eintrag', item.rule, (r) => { item.rule = r; touch(); }), 'immer'))),
        tfSection(item),
        h('div', { class: 'insp-tools' },
          main ? h('button', { class: 'btn small', title: 'In der Reihenfolge nach vorn', 'aria-label': 'Früher abspielen', onclick: () => shiftMain(item, -1) }, '◀') : null,
          main ? h('button', { class: 'btn small', title: 'In der Reihenfolge nach hinten', 'aria-label': 'Später abspielen', onclick: () => shiftMain(item, 1) }, '▶') : null,
          h('button', { class: 'btn small', onclick: () => { item.enabled = !item.enabled; touch(); } }, item.enabled ? 'Aussetzen' : 'Fortsetzen'),
          h('button', { class: 'btn small danger', onclick: () => removeItem(item) }, 'Entfernen')));
    }

    // ── Mediathek ──

    function drawLib() {
      const text = libText.toLowerCase();
      const tags = [...new Set(state.resources.flatMap((c) => c.tags))].sort((a, b) => a.localeCompare(b, 'de'));
      const chips = tagFilterChips(tags, libTags, drawLib);
      const list = state.resources.filter((c) => !isUploading(c.id) && (!text || c.name.toLowerCase().includes(text)) && hasAnyTag(c, libTags));
      // Hinzufügen nur über das Plus oder durch Ziehen auf die Zeitleiste, ein Klick auf den Eintrag selbst tut nichts.
      const entry = (type, ref, mini, name, meta, label = name) => h('div', { class: 'item', draggable: true, title: 'Auf die Zeitleiste ziehen oder mit + anhängen',
        ondragstart: (e) => { libDrag = { type, ref }; e.dataTransfer.effectAllowed = 'copy'; e.dataTransfer.setData('text/plain', name); },
        ondragend: () => { libDrag = null; marker.hidden = true; },
        oncontextmenu: type === 'clip' ? (e) => openLibMenu(e, ref) : null },
        mini, h('div', { class: 'grow' }, h('div', { class: 'item-name' }, label), h('div', { class: 'meta' }, meta)),
        h('button', { type: 'button', class: 'add', title: 'Hinten anhängen', 'aria-label': name + ' hinten anhängen', onclick: () => add(type, ref) }, '+'));
      set(libEl,
        tags.length ? h('div', { class: 'item', style: { flexWrap: 'wrap', cursor: 'default' } }, chips) : null,
        ...libTags.map((t) => entry('tag', t, h('div', { class: 'mini' }, 'Tag'), 'Alle Ressourcen mit Tag „' + t + '"', 'Neue Ressourcen mit diesem Tag laufen automatisch mit')),
        ...(list.length ? list.map((c) => entry('clip', c.id,
          h('div', { class: 'mini', style: bg(c.thumb || (c.type === 'image' ? c.src : '')) }, c.thumb || c.type === 'image' ? null : typeLabel[c.type]), c.name,
          [typeLabel[c.type] + ', ' + fmtLen(R.clipLength(c)) + (c.type === 'video' && c.speed !== 1 ? ' bei ' + fmtSpeed(c.speed) : ''), !c.enabled ? h('span', { class: 'chip off' }, 'inaktiv') : null], hl(c.name, libText)))
          : [h('div', { class: 'empty' }, h('strong', {}, state.resources.length ? 'Keine Ressource passt' : 'Noch keine Ressourcen'), h('a', { href: '#/resources' }, 'Ressourcen hochladen'))]));
    }

    // ── Vorschau-Monitor: der Player im Kleinen, meldet seine Position für die Abspielmarke ──

    /** Der Monitor zeigt immer das Bild an der Abspielmarke: angehalten als Standbild, sonst läuft er.
        Ein Klick ins Bild wählt den Clip, der an dieser Stelle zuoberst liegt. Abspielen geht über den Knopf unter dem Monitor. */
    const monitorHit = h('div', { class: 'monitor-hit', title: 'Klicken wählt den Clip an dieser Stelle' });
    monitorHit.addEventListener('click', (e) => pickAt(e.clientX, e.clientY, e.shiftKey || e.metaKey || e.ctrlKey));
    const monitorPlay = h('button', { type: 'button', class: 'btn small monitor-play', onclick: () => togglePlay() });

    /** Welcher Eintrag ist an dieser Stelle im Monitor zu sehen? Gesucht wird im Bereich (A oder B) unter dem Punkt,
        von der obersten Ebene abwärts, unter Beachtung von Position, Größe und Drehung. Trifft keine Überlagerung,
        gilt der Clip der Hauptspur, der dort gerade läuft. */
    function itemAt(clientX, clientY) {
      const r = monitor.getBoundingClientRect(), w = monitor.clientWidth, hh = monitor.clientHeight;
      if (!w || !hh) return null;
      const px = clientX - r.left - monitor.clientLeft, py = clientY - r.top - monitor.clientTop;
      let area = 0;
      if (seq.split) { const sl = R.splitLine(seq.split, w, hh); area = px * sl.nx + py * sl.ny <= sl.d ? 0 : 1; }
      const t = playT + 0.001;
      const live = layout().blocks.filter((b) => b.area === area && b.item.enabled && (!b.clip || b.clip.enabled) && b.start <= t && t < b.start + b.len)
        .sort((a, b) => (b.item.track || 0) - (a.item.track || 0));
      const hit = live.find((b) => {
        const tf = { ...TF0, ...b.item.tf }, s = tf.scale / 100, [bw, bh] = contentBox(b.item, w, hh);
        const vx = px - tf.x / 100 * w, vy = py - tf.y / 100 * hh, a = tf.rotate * Math.PI / 180;
        const ux = vx * Math.cos(a) + vy * Math.sin(a), uy = -vx * Math.sin(a) + vy * Math.cos(a);
        return Math.abs(ux) <= bw * s / 2 && Math.abs(uy) <= bh * s / 2;
      }) || live.find((b) => !b.item.track);
      return hit ? hit.item : null;
    }
    /** Klick ins Bild: den Eintrag dort wählen und in der Zeitleiste zeigen. Mit Umschalt- oder Befehlstaste zur Auswahl hinzufügen. */
    function pickAt(clientX, clientY, additive) {
      const item = itemAt(clientX, clientY);
      if (!item) { if (!additive) select(null); return; }
      if (additive) togglePick(item.id); else select(item.id);
      // Nur die Zeitleiste waagrecht nachführen, die Seite selbst bleibt stehen.
      const el = els.get(item.id);
      if (!el) return;
      const sr = scroll.getBoundingClientRect(), er = el.getBoundingClientRect();
      if (er.left < sr.left + GUTTER) scroll.scrollLeft -= sr.left + GUTTER - er.left + 20;
      else if (er.right > sr.right) scroll.scrollLeft += Math.min(er.right - sr.right + 20, er.left - sr.left - GUTTER - 20);
    }
    async function startPreview() {
      await base.flush();
      frameSim = base.sim();
      frame = h('iframe', { title: 'Vorschau der Sequenz', tabIndex: -1, src: previewUrl(seq, frameSim) + '&embed=1&t=' + playT.toFixed(3) + (playing ? '' : '&paused=1') });
      set(monitor, frame, monitorHit, tfLayer, splitLayer);
      drawSplitOverlay();
      drawTfOverlay();
    }

    // ── Bereiche: Teilung in A und B, im Monitor ziehen, Drehung am Regler ──

    const SVGNS = 'http://www.w3.org/2000/svg';
    const svg = (tag, attrs) => { const el = document.createElementNS(SVGNS, tag); for (const k in attrs) el.setAttribute(k, attrs[k]); return el; };
    const splitLayer = h('div', { class: 'split-layer' });
    let splitDrag = false;

    /** Teilung ändern: speichern, Linie und Regler nachführen, ohne die Zeitleiste neu aufzubauen. */
    function setSplit(patchValues) {
      seq.split = R.cleanSplit({ ...seq.split, ...patchValues });
      drawSplitOverlay();
      drawSplitBox(true);
      tell({ koi: 'split', split: seq.split });   // Vorschau sofort zuschneiden, ohne neu zu laden
      if (!splitDrag) touch(false);                // beim Ziehen erst am Ende speichern
    }
    function addAreaB() {
      seq.split = { pos: 0.5, angle: 0 };
      touch();
    }
    function removeAreaB() {
      const inB = seq.items.filter((i) => i.area === 1);
      const go = () => { seq.items = seq.items.filter((i) => i.area !== 1); seq.split = null; picked.clear(); selected = null; touch(); };
      if (!inB.length) return go();
      confirmDialog('Bereich B entfernen?', (inB.length === 1 ? 'Ein Clip liegt' : inB.length + ' Clips liegen') + ' in Bereich B. Sie werden aus der Sequenz entfernt, die Ressourcen bleiben erhalten.', 'Entfernen', async () => go());
    }
    /** Feld „Bereiche" in den Eigenschaften. light: nur Zahlen nachführen (beim Ziehen), Regler nicht neu bauen. */
    function drawSplitBox(light) {
      const sp = seq.split;
      if (light && sp && splitBox.querySelector('.split-ctl')) {
        const [posIn, angIn] = splitBox.querySelectorAll('input[type=range]');
        if (document.activeElement !== posIn) posIn.value = String(Math.round(sp.pos * 100));
        if (document.activeElement !== angIn) angIn.value = String(sp.angle);
        splitBox.querySelector('.pos-val').textContent = Math.round(sp.pos * 100) + ' %';
        splitBox.querySelector('.ang-val').textContent = Math.round(sp.angle) + '°';
        for (const b of splitBox.querySelectorAll('[data-angle]')) b.classList.toggle('on', Number(b.dataset.angle) === Math.round(sp.angle));
        return;
      }
      if (!sp) {
        set(splitBox, h('div', { class: 'prop-main' }, h('strong', {}, 'Nur Bereich A'), h('button', { type: 'button', class: 'btn small', onclick: addAreaB }, '+ Bereich B')),
          h('div', { class: 'hint' }, 'Bildschirm teilen: links A, rechts B, auch waagrecht oder schräg.'));
        return;
      }
      const preset = (label, angle, title) => h('button', { type: 'button', class: 'btn small' + (Math.round(sp.angle) === angle ? ' on' : ''), 'data-angle': angle, title, onclick: () => setSplit({ angle }) }, label);
      set(splitBox,
        h('div', { class: 'split-ctl' },
          h('label', { class: 'split-row' }, h('span', {}, 'Teilung'),
            h('input', { type: 'range', min: 5, max: 95, step: 1, value: Math.round(sp.pos * 100), 'aria-label': 'Teilung in Prozent', oninput: (e) => setSplit({ pos: Number(e.target.value) / 100 }) }),
            h('b', { class: 'pos-val' }, Math.round(sp.pos * 100) + ' %')),
          h('label', { class: 'split-row' }, h('span', {}, 'Drehung'),
            h('input', { type: 'range', min: -90, max: 90, step: 1, value: sp.angle, 'aria-label': 'Drehung der Teilung in Grad', oninput: (e) => setSplit({ angle: Number(e.target.value) }) }),
            h('b', { class: 'ang-val' }, Math.round(sp.angle) + '°')),
          h('div', { class: 'split-presets' },
            preset('│ Senkrecht', 0, 'A links, B rechts'), preset('─ Waagrecht', 90, 'A oben, B unten'), preset('╱ Schräg', 45, 'Diagonal von links unten nach rechts oben'), preset('╲ Schräg', -45, 'Diagonal von links oben nach rechts unten'),
            h('button', { type: 'button', class: 'btn small danger', onclick: removeAreaB }, 'B entfernen'))),
        h('div', { class: 'hint' }, 'Die Linie lässt sich im Vorschau-Monitor ziehen.'));
    }
    /** Teilungslinie mit A und B über dem Vorschau-Monitor. */
    function drawSplitOverlay() {
      splitLayer.replaceChildren();
      const sp = seq.split, w = monitor.clientWidth, hh = monitor.clientHeight;
      splitLayer.hidden = !sp || !w || !hh;
      if (splitLayer.hidden) return;
      const L = R.splitLine(sp, w, hh);
      // Schnittpunkte der Linie mit dem Rand
      const corners = [[0, 0], [w, 0], [w, hh], [0, hh]], cut = [];
      const f = (p) => p[0] * L.nx + p[1] * L.ny - L.d;
      for (let i = 0; i < 4; i++) {
        const p = corners[i], q = corners[(i + 1) % 4], fp = f(p), fq = f(q);
        if ((fp <= 0) !== (fq <= 0)) { const t = fp / (fp - fq); cut.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]); }
      }
      if (cut.length < 2) return;
      // Griff bei einem Viertel der Linie, damit er nicht unter dem Abspielknopf in der Mitte liegt.
      const [a, b] = cut[0][1] <= cut[1][1] ? cut : [cut[1], cut[0]], mid = [a[0] + (b[0] - a[0]) * 0.25, a[1] + (b[1] - a[1]) * 0.25];
      const root = svg('svg', { width: w, height: hh, viewBox: '0 0 ' + w + ' ' + hh });
      const line = { x1: a[0], y1: a[1], x2: b[0], y2: b[1] };
      root.append(
        svg('line', { ...line, class: 'split-shadow' }), svg('line', { ...line, class: 'split-line' }),
        svg('line', { ...line, class: 'split-hit' }), svg('circle', { cx: mid[0], cy: mid[1], r: 9, class: 'split-handle' }));
      // Beschriftung in der Mitte jedes Bereichs
      for (const area of [0, 1]) {
        const pts = R.splitPolygon(sp, area, w / hh);
        const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length / 100 * w, cy = pts.reduce((s, p) => s + p[1], 0) / pts.length / 100 * hh;
        root.append(svg('circle', { cx, cy, r: 14, class: 'split-tag-bg' + (area ? ' b' : '') }));
        const txt = svg('text', { x: cx, y: cy + 5, class: 'split-tag' });
        txt.textContent = area ? 'B' : 'A';
        root.append(txt);
      }
      for (const el of root.querySelectorAll('.split-hit, .split-handle')) {
        el.addEventListener('pointerdown', startSplitDrag);
        el.addEventListener('click', (e) => e.stopPropagation());
      }
      splitLayer.append(root);
    }
    // Ziehen hängt am Fenster: Die Linie wird dabei neu gezeichnet, ihr Element gibt es danach nicht mehr.
    function startSplitDrag(e) {
      e.preventDefault(); e.stopPropagation();
      splitDrag = true;
      monitor.classList.add('splitting');
      // Die Ebene über dem Monitor hält die Maus fest; sonst schluckt das Vorschau-Fenster die Bewegungen, sobald die Maus darüber ist.
      try { splitLayer.setPointerCapture(e.pointerId); } catch { /* ohne Zeiger-Kennung: Fenster-Ereignisse genügen */ }
      window.addEventListener('pointermove', moveSplitDrag);
      window.addEventListener('pointerup', endSplitDrag);
      window.addEventListener('pointercancel', endSplitDrag);
    }
    function moveSplitDrag(e) {
      if (!splitDrag || !seq.split) return;
      const r = monitor.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, LL = R.splitLine(seq.split, r.width, r.height);
      setSplit({ pos: (x * LL.nx + y * LL.ny - LL.lo) / (LL.hi - LL.lo) });
    }
    function endSplitDrag() {
      if (splitDrag) touch(false);   // jetzt speichern
      splitDrag = false;
      monitor.classList.remove('splitting');
      window.removeEventListener('pointermove', moveSplitDrag);
      window.removeEventListener('pointerup', endSplitDrag);
      window.removeEventListener('pointercancel', endSplitDrag);
    }
    cleanup.push(endSplitDrag);

    // ── Transformieren: Position, Größe und Drehung des gewählten Clips mit Griffen im Monitor ──

    const TF0 = { x: 50, y: 50, scale: 100, rotate: 0 };
    const TF_PAD = 12;   // so weit dürfen Griffe über den Rand des Monitors ragen
    const tfLayer = h('div', { class: 'tf-layer', hidden: true });
    let tfDrag = null;
    /** Der eine gewählte Eintrag (bei Mehrfachauswahl keiner): Er bekommt im Monitor den gelben Rahmen. */
    const selItem = () => (picked.size <= 1 && selected ? seq.items.find((i) => i.id === selected) || null : null);
    /** Derselbe Eintrag, aber nur bei eingeschaltetem „Transformieren": Dann hat der Rahmen Griffe. */
    const tfItem = () => (transforming ? selItem() : null);

    /** Transformation ändern: Vorschau sofort nachführen, beim Ziehen erst am Ende speichern. */
    function setTf(item, patchValues) {
      item.tf = R.cleanTransform({ ...TF0, ...item.tf, ...patchValues });
      tell({ koi: 'transform', itemId: item.id, tf: item.tf });
      drawTfOverlay();
      syncFields();
      const chip = inspector.querySelector('.tf-chip');
      if (chip) chip.hidden = !item.tf;
      if (!tfDrag) touch(false);
    }
    /** Fläche, die der Inhalt bei 100 % auf einem Bildschirm w × hh einnimmt: Bei „Einpassen" das Bild selbst ohne die Ränder,
        bei „Füllen" der ganze Bildschirm (der Rest ist beschnitten). Webseiten, Tag-Einträge und Inhalte ohne bekannte Maße füllen den Bildschirm. */
    function contentBox(item, w, hh) {
      const clip = item.type === 'clip' ? clipById(item.ref) : null;
      if (!clip || clip.type === 'web' || clip.fit === 'cover' || !(clip.width > 0) || !(clip.height > 0)) return [w, hh];
      const ar = clip.width / clip.height;
      return ar > w / hh ? [w, w / ar] : [hh * ar, hh];
    }
    /** Gelber Rahmen um den gewählten Clip im Monitor, genau um sein sichtbares Bild, nicht um den ganzen Bildschirm.
        Nur beim Transformieren hat er Griffe zum Ziehen, Skalieren und Drehen; sonst ist er reine Anzeige und Klicks gehen durch. */
    function drawTfOverlay() {
      const item = selItem(), w = monitor.clientWidth, hh = monitor.clientHeight;
      tfLayer.hidden = !item || !w || !hh;
      const edit = !tfLayer.hidden && transforming;
      monitor.classList.toggle('transforming', edit);
      tfLayer.classList.toggle('passive', !edit);
      if (tfLayer.hidden) { tfLayer.replaceChildren(); return; }
      const tf = { ...TF0, ...item.tf }, s = tf.scale / 100, [bw, bh] = contentBox(item, w, hh);
      const fw = bw * s, fh = bh * s, cx = tf.x / 100 * w + TF_PAD, cy = tf.y / 100 * hh + TF_PAD;
      // Drehgriff über der oberen Kante; läge er ausserhalb des Monitors, kommt er nach innen.
      const a = tf.rotate * Math.PI / 180, up = [Math.sin(a), -Math.cos(a)];
      const out = fh / 2 + 26, ox = cx - TF_PAD + up[0] * out, oy = cy - TF_PAD + up[1] * out;
      const inside = ox >= 0 && ox <= w && oy >= 0 && oy <= hh;
      const stem = inside ? 26 : -Math.min(26, fh / 2 - 10);
      const frameEl = h('div', { class: 'tf-frame', style: { left: cx - fw / 2 + 'px', top: cy - fh / 2 + 'px', width: fw + 'px', height: fh + 'px', transform: 'rotate(' + tf.rotate + 'deg)' },
        title: edit ? 'Ziehen verschiebt den Clip, ein Klick wählt den Clip an dieser Stelle' : null });
      if (!edit) { tfLayer.replaceChildren(frameEl); markTfAway(); return; }
      frameEl.addEventListener('pointerdown', (e) => startTfDrag(e, 'move'));
      for (const c of ['nw', 'ne', 'se', 'sw']) {
        const el = h('div', { class: 'tf-handle ' + c, title: 'Größe ändern' });
        el.addEventListener('pointerdown', (e) => startTfDrag(e, 'scale'));
        frameEl.append(el);
      }
      const rot = h('div', { class: 'tf-rot', style: { height: Math.abs(stem) + 'px', top: (stem > 0 ? -stem : 0) + 'px' } },
        h('div', { class: 'tf-rot-knob' + (stem > 0 ? '' : ' in'), title: 'Drehen (mit Umschalttaste in 15°-Schritten)' }));
      rot.lastChild.addEventListener('pointerdown', (e) => startTfDrag(e, 'rotate'));
      frameEl.append(rot);
      tfLayer.replaceChildren(frameEl);
      markTfAway();
    }
    /** Liegt die Abspielmarke ausserhalb des Clips, ist er im Monitor nicht zu sehen: Rahmen dann blasser. */
    function markTfAway(L) {
      const item = selItem();
      if (!item || tfLayer.hidden) return;
      const b = blockOf(L || layout(), item);
      tfLayer.classList.toggle('away', !b || playT < b.start - 0.01 || playT >= b.start + b.len);
    }
    /** Abspielmarke in den Clip setzen, damit man ihn beim Transformieren sieht. */
    function showItemInMonitor(item) {
      const L = layout(), b = blockOf(L, item);
      if (!b || (playT >= b.start && playT < b.start + b.len)) return;
      playT = r2(b.start + Math.min(1, b.len / 2));
      awaitPause = false;
      placeMarks(L);
      if (frame) tell({ koi: 'seek', t: playT }); else startPreview();
    }
    function startTfDrag(e, mode) {
      const item = tfItem();
      if (!item || e.button > 0) return;
      e.preventDefault(); e.stopPropagation();
      const r = monitor.getBoundingClientRect(), tf = { ...TF0, ...item.tf };
      const c = [r.left + tf.x / 100 * r.width, r.top + tf.y / 100 * r.height];
      tfDrag = { item, mode, r, c, tf, x0: e.clientX, y0: e.clientY, moved: false, d0: Math.hypot(e.clientX - c[0], e.clientY - c[1]) || 1 };
      monitor.classList.add('tf-dragging');
      tfLayer.dataset.mode = mode;
      try { tfLayer.setPointerCapture(e.pointerId); } catch { /* Fenster-Ereignisse genügen */ }
      window.addEventListener('pointermove', moveTfDrag);
      window.addEventListener('pointerup', endTfDrag);
      window.addEventListener('pointercancel', endTfDrag);
    }
    function moveTfDrag(e) {
      const d = tfDrag;
      if (!d) return;
      if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 3) return;
      d.moved = true;
      const snap = (v, to, within) => (!e.altKey && Math.abs(v - to) < within ? to : v);
      if (d.mode === 'move') {
        // Nahe der Mitte rastet der Clip ein (Alt-Taste: frei)
        const x = d.tf.x + (e.clientX - d.x0) / d.r.width * 100, y = d.tf.y + (e.clientY - d.y0) / d.r.height * 100;
        setTf(d.item, { x: snap(x, 50, 1.5), y: snap(y, 50, 1.5) });
      } else if (d.mode === 'scale') {
        // Ecke ziehen: Größe im Verhältnis zum Abstand von der Mitte, die Mitte bleibt stehen.
        const scale = d.tf.scale * Math.hypot(e.clientX - d.c[0], e.clientY - d.c[1]) / d.d0;
        setTf(d.item, { scale: snap(scale, 100, 2) });
      } else {
        let deg = Math.atan2(e.clientY - d.c[1], e.clientX - d.c[0]) * 180 / Math.PI + 90;
        if (deg > 180) deg -= 360;
        if (e.shiftKey) deg = Math.round(deg / 15) * 15;
        else deg = [-180, -90, 0, 90, 180].reduce((v, to) => snap(v, to, 3), deg);
        setTf(d.item, { rotate: deg });
      }
    }
    function endTfDrag() {
      const d = tfDrag;
      tfDrag = null;
      monitor.classList.remove('tf-dragging');
      delete tfLayer.dataset.mode;
      window.removeEventListener('pointermove', moveTfDrag);
      window.removeEventListener('pointerup', endTfDrag);
      window.removeEventListener('pointercancel', endTfDrag);
      if (!d) return;
      if (d.moved) touch(false);                       // jetzt speichern
      else if (d.mode === 'move') pickAt(d.x0, d.y0);  // ein Klick auf den Rahmen wirkt wie ein Klick ins Bild
    }
    cleanup.push(endTfDrag);
    function drawTransport() {
      monitorPlay.textContent = playing ? '❚❚ Anhalten' : '▶ Abspielen';
      monitorPlay.title = (playing ? 'Anhalten' : 'Abspielen') + ' (Leertaste)';
      monitorPlay.classList.toggle('on', playing);
      playBtn.textContent = playing ? '❚❚' : '▶';
      playBtn.title = (playing ? 'Anhalten' : 'Abspielen') + ' (Leertaste)';
      playBtn.setAttribute('aria-label', playing ? 'Anhalten' : 'Abspielen');
      playBtn.classList.toggle('on', playing);
    }
    function playPreview() {
      const L = layout();
      if (playT >= L.total - FRAME) playT = 0;   // am Ende: von vorne
      playing = true;
      drawTransport();
      if (frame) tell({ koi: 'play' }); else startPreview();
    }
    function pausePreview() {
      playing = false;
      awaitPause = true;
      drawTransport();
      tell({ koi: 'pause' });
    }
    const togglePlay = () => (playing ? pausePreview() : playPreview());
    /** Ein Bild vor oder zurück. Hält die Vorschau an; ohne laufende Vorschau startet sie angehalten an der neuen Stelle. */
    function stepFrame(dir) {
      const L = layout();
      if (playing) pausePreview();
      awaitPause = false;
      playT = Math.max(0, Math.min((Math.round(playT / FRAME) + dir) * FRAME, Math.max(0, L.total - FRAME)));
      placeMarks(L);
      if (frame) tell({ koi: 'seek', t: playT }); else startPreview();
    }
    /** Leertaste spielt ab oder hält an, Pfeil links und rechts gehen ein Bild weiter. Nicht in Eingabefeldern, Dialogen und Menüs. */
    function transportKey(key, target) {
      if (document.querySelector('.backdrop, .ctxmenu')) return false;
      if (target && target.closest && target.closest('input, textarea, select, [contenteditable]')) return false;
      if (key === ' ') togglePlay();
      else if (key === 'ArrowLeft') stepFrame(-1);
      else if (key === 'ArrowRight') stepFrame(1);
      else return false;
      return true;
    }
    /** Auswahl per Tastatur: Befehl/Strg+A wählt alle Clips, Escape hebt auf, Entf entfernt eine Mehrfachauswahl. */
    const onSelectKey = (e) => {
      if (e.defaultPrevented || document.querySelector('.backdrop, .ctxmenu')) return;
      if (e.target.closest && e.target.closest('input, textarea, select, [contenteditable]')) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        pickOnly(null);
        for (const i of seq.items) picked.add(i.id);
        selected = seq.items.length ? seq.items[seq.items.length - 1].id : null;
        markPicked(); drawInspector();
      } else if (e.key === 'Escape' && picked.size) { e.preventDefault(); select(null); }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && picked.size > 1) { e.preventDefault(); removePicked(); }
    };
    document.addEventListener('keydown', onSelectKey);
    cleanup.push(() => document.removeEventListener('keydown', onSelectKey));
    const onTransportKey = (e) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.repeat && e.key === ' ') return;
      if (transportKey(e.key, e.target)) e.preventDefault();
    };
    // Manche Browser lösen einen fokussierten Knopf erst beim Loslassen der Leertaste aus: dort ebenfalls abfangen.
    const onTransportKeyUp = (e) => {
      if (e.key === ' ' && !document.querySelector('.backdrop, .ctxmenu') && !(e.target.closest && e.target.closest('input, textarea, select, [contenteditable]'))) e.preventDefault();
    };
    document.addEventListener('keydown', onTransportKey);
    document.addEventListener('keyup', onTransportKeyUp);
    cleanup.push(() => { document.removeEventListener('keydown', onTransportKey); document.removeEventListener('keyup', onTransportKeyUp); });
    /** Abspielmarke an die Maus setzen (Klick oder Ziehen auf der Zeitskala). Die Vorschau folgt leicht gebremst, damit sie beim Ziehen nicht stockt. */
    function scrubTo(e) {
      const L = layout();
      playT = Math.max(0, Math.min(timeAt(e.clientX), L.total - 0.1));
      awaitPause = false;
      placeMarks(L);
      if (!seekTimer) seekTimer = setTimeout(() => { seekTimer = null; tell({ koi: 'seek', t: playT }); }, 80);
    }
    function endScrub() {
      if (!scrubbing) return;
      scrubbing = false;
      clearTimeout(seekTimer);
      seekTimer = null;
      tell({ koi: 'seek', t: playT });
    }
    const onMessage = (e) => {
      if (e.origin !== location.origin || !frame || e.source !== frame.contentWindow) return;
      const m = e.data || {};
      // Angehalten bestimmt die Verwaltung die Stelle, sonst würden Meldungen von vorher die Einzelbild-Schritte überschreiben.
      if (m.koi === 'time' && typeof m.t === 'number' && playing && !drag && !scrubbing) { playT = m.t; placeMarks(layout()); }
      else if (m.koi === 'paused' && typeof m.t === 'number' && awaitPause && !playing) { awaitPause = false; playT = m.t; placeMarks(layout()); }
      else if (m.koi === 'key') transportKey(m.key, null);
    };
    window.addEventListener('message', onMessage);
    cleanup.push(() => window.removeEventListener('message', onMessage));

    // ── Zusammenbau ──

    function draw() {
      drawTimeline();
      drawInspector();
      if (!splitDrag) { drawSplitBox(); drawSplitOverlay(); }
      if (frame && frameSim !== base.sim()) startPreview();   // simulierter Zeitpunkt geändert: Vorschau neu starten
    }
    /** Massstab in Pixeln pro Sekunde setzen (0: ganze Sequenz einpassen). Die Mitte des sichtbaren Ausschnitts bleibt stehen. */
    function setZoom(next) {
      const mid = (scroll.scrollLeft + scroll.clientWidth / 2 - GUTTER) / pps;
      zoom = next ? Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next)) : 0;
      drawTimeline();
      scroll.scrollLeft = Math.max(0, GUTTER + mid * pps - scroll.clientWidth / 2);
    }
    const onResize = () => { if (!zoom && !drag) drawTimeline(); drawSplitOverlay(); drawTfOverlay(); };
    window.addEventListener('resize', onResize);
    cleanup.push(() => window.removeEventListener('resize', onResize));

    // Live-Meldungen ändern nur die Markierungen.
    liveListeners.push(() => {
      const live = base.liveItems();
      for (const [id, el] of els) el.classList.toggle('live', live.has(id));
      base.drawLiveBox();
    });

    draw();
    drawLib();
    drawTransport();
    startPreview();   // gleich das Standbild am Anfang zeigen
    requestAnimationFrame(() => { if (scroll.isConnected) drawTimeline(); });   // jetzt ist die Breite bekannt

    return h('div', {}, base.head,
      h('div', { class: 'ed-top' },
        h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', {}, 'Ressourcen'),
          h('input', { type: 'text', placeholder: 'Suchen', 'aria-label': 'Ressourcen durchsuchen', oninput: (e) => { libText = e.target.value; drawLib(); } })), libEl),
        h('div', { class: 'monitor-col' }, monitor, h('div', { class: 'monitor-bar' }, monitorPlay)),
        h('section', { class: 'panel', 'aria-label': 'Eigenschaften des gewählten Clips' }, inspector)),
      h('section', { class: 'tl', 'aria-label': 'Zeitleiste' },
        h('div', { class: 'tl-bar' },
          h('button', { class: 'btn small', title: 'Zeitleiste verkleinern', 'aria-label': 'Zeitleiste verkleinern', onclick: () => setZoom(pps / 1.5) }, '−'),
          zoomSlider,
          h('button', { class: 'btn small', title: 'Zeitleiste vergrössern', 'aria-label': 'Zeitleiste vergrössern', onclick: () => setZoom(pps * 1.5) }, '+'),
          h('button', { class: 'btn small', onclick: () => setZoom(0) }, 'Einpassen'),
          transport,
          h('span', { class: 'tl-help' }, 'Ziehen verschiebt, an den Kanten ziehen kürzt, Rechtsklick entfernt. Obere Ebenen liegen über der Hauptspur.')),
        scroll));
  }

  // ───────── Tags: alle an einem Ort ─────────

  /** Eingabedialog für einen Namen. apply(name) speichert; Enter speichert, Escape bricht ab. */
  function nameDialog(title, value, hint, apply) {
    const input = h('input', { type: 'text', value, maxlength: 30, 'aria-label': 'Name' });
    const save = async (close) => {
      const v = input.value.trim();
      if (!v) return input.focus();
      if (v === value) return close();
      try { await apply(v); close(); } catch (e) { oops(e); }
    };
    const close = dialog(title, h('div', {}, h('label', { class: 'field' }, h('span', {}, 'Name'), input), hint ? h('p', { class: 'hint' }, hint) : null), (cl) => [
      h('button', { class: 'btn', onclick: cl }, 'Abbrechen'),
      h('button', { class: 'btn primary', onclick: () => save(cl) }, 'Speichern')
    ]);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(close); } });
    input.focus();
    input.select();
  }

  let tagFilter = '';
  function tagsPage() {
    const listEl = h('div', {});
    const KIND = { resource: 'Ressource', sequence: 'Sequenz', master: 'Mastersequenz', screen: 'Bildschirm' };
    /** Alles, was einen Tag trägt, mit Art, Untertyp und Ziel zum Öffnen. */
    function tagged(tag) {
      const out = [];
      for (const c of state.resources) if (hasTag(c, tag)) out.push({ kind: 'resource', sub: typeLabel[c.type], x: c, open: () => resourceDialog(c), path: '/api/resources/' + c.id });
      for (const s of state.sequences) if (hasTag(s, tag)) out.push({ kind: s.kind, x: s, href: (s.kind === 'master' ? '#/masters/' : '#/sequences/') + s.id, path: '/api/sequences/' + s.id });
      for (const s of state.screens) if (hasTag(s, tag)) out.push({ kind: 'screen', x: s, open: () => screenDialog(s), path: '/api/screens/' + s.id });
      return out;
    }
    /** Sequenzen, die den Tag als Eintrag verwenden: Dort laufen alle Clips mit diesem Tag. */
    const asEntry = (tag) => state.sequences.filter((s) => s.kind === 'sequence' && s.items.some((i) => i.type === 'tag' && i.ref.toLowerCase() === tag.toLowerCase()));
    const reload = async () => { await loadAll(); render(); };

    function draw() {
      const q = tagFilter.trim().toLowerCase();
      const tags = allTags().filter((t) => !q || t.toLowerCase().includes(q));
      if (!allTags().length) {
        set(listEl, h('div', { class: 'empty' }, h('strong', {}, 'Noch keine Tags'), 'Tags vergibt man an Ressourcen, Sequenzen, Mastersequenzen und Bildschirmen. Sie erscheinen dann hier.'));
        return;
      }
      if (!tags.length) { set(listEl, h('div', { class: 'empty' }, h('strong', {}, 'Kein Tag passt'), 'Suchtext ändern.')); return; }
      set(listEl, ...tags.map((tag) => {
        const items = tagged(tag), entries = asEntry(tag);
        const counts = Object.entries(items.reduce((m, it) => { m[it.kind] = (m[it.kind] || 0) + 1; return m; }, {}))
          .map(([k, n]) => n + ' ' + (n === 1 ? KIND[k] : { resource: 'Ressourcen', sequence: 'Sequenzen', master: 'Mastersequenzen', screen: 'Bildschirme' }[k])).join(', ');
        return h('section', { class: 'panel tag-card' },
          h('div', { class: 'tag-card-head' },
            h('span', { class: 'chip tag-name' }, h('span', {}, hl(tag, tagFilter))),
            h('span', { class: 'hint grow' }, counts || 'nirgends vergeben'),
            h('button', { class: 'btn small', title: 'Tag umbenennen', onclick: () => nameDialog('Tag umbenennen', tag, 'Gilt überall, wo der Tag vergeben ist, auch für Tag-Einträge in Sequenzen. Gibt es den neuen Namen schon, werden beide Tags zusammengeführt.',
              async (to) => { await api('POST', '/api/tags/rename', { from: tag, to }); toast('Tag umbenannt'); await reload(); }) }, 'Umbenennen'),
            h('button', { class: 'btn small danger', onclick: () => confirmDialog('Tag „' + tag + '" löschen?',
              'Der Tag wird bei ' + (items.length === 1 ? 'einem Inhalt' : items.length + ' Inhalten') + ' entfernt. Die Inhalte selbst bleiben.' + (entries.length ? ' Achtung: ' + entries.map((s) => '„' + s.name + '"').join(', ') + ' verwendet den Tag als Eintrag; dieser zeigt danach nichts mehr.' : ''),
              'Löschen', async () => { await api('POST', '/api/tags/delete', { name: tag }); toast('Tag gelöscht'); await reload(); }) }, 'Löschen')),
          h('div', { class: 'tag-items' }, items.map((it) => h('div', { class: 'tag-item' },
            h('span', { class: 'kind kind-' + it.kind }, KIND[it.kind] + (it.sub ? ' · ' + it.sub : '')),
            it.href ? h('a', { class: 'grow', href: it.href }, it.x.name) : h('button', { type: 'button', class: 'linkish grow', onclick: it.open }, it.x.name),
            h('button', { type: 'button', class: 'btn ghost small', title: 'Tag hier entfernen', 'aria-label': 'Tag bei ' + it.x.name + ' entfernen',
              onclick: async () => { try { await api('PUT', it.path, { tags: it.x.tags.filter((t) => t.toLowerCase() !== tag.toLowerCase()) }); await reload(); } catch (e) { oops(e); } } }, '×')))),
          entries.length ? h('div', { class: 'tag-entries hint' }, 'Als Tag-Eintrag in: ', entries.map((s, i) => [i ? ', ' : '', h('a', { href: '#/sequences/' + s.id }, s.name)])) : null);
      }));
    }
    draw();
    return h('div', {},
      h('div', { class: 'head' }, h('h1', {}, 'Tags')),
      h('p', { class: 'sub' }, 'Alle Tags an einem Ort: was damit markiert ist, umbenennen, löschen. Einen neuen Tag legt man direkt an der Ressource, an der Sequenz oder am Bildschirm an.'),
      h('div', { class: 'filters' }, h('input', { type: 'text', placeholder: 'Tags durchsuchen', 'aria-label': 'Tags durchsuchen', value: tagFilter, oninput: (e) => { tagFilter = e.target.value; draw(); } })),
      listEl);
  }

  // ───────── Einstellungen ─────────

  function settingsPage() {
    const zones = ['Europe/Vienna', 'Europe/Berlin', 'Europe/Zurich', 'Europe/London', 'UTC'];
    if (!zones.includes(state.tz)) zones.unshift(state.tz);
    const pw = { current: '', password: '' };
    return h('div', {},
      h('div', { class: 'head' }, h('h1', {}, 'Einstellungen')),
      h('div', { class: 'settings' },
        h('section', { class: 'panel' }, h('h2', {}, 'Zeitzone'),
          h('p', { class: 'hint' }, 'Alle Regeln (Uhrzeiten, Wochentage, Datum) gelten in dieser Zeitzone, egal wie die Uhr am Bildschirm eingestellt ist.'),
          h('select', { onchange: async (e) => { try { await api('PUT', '/api/settings', { tz: e.target.value }); state.tz = e.target.value; toast('Zeitzone gespeichert'); } catch (ex) { oops(ex); } } },
            zones.map((z) => h('option', { value: z, selected: z === state.tz }, z)))),
        h('section', { class: 'panel' }, h('h2', {}, 'Adresse für Bildschirme'),
          h('p', {}, h('b', {}, location.origin + '/player/')),
          h('p', { class: 'hint' }, location.protocol === 'https:' || location.hostname === 'localhost' ? 'Diese Adresse im Vollbild-Browser des Geräts öffnen.' : 'Diese Adresse im Vollbild-Browser des Geräts öffnen. Hinweis: Ohne HTTPS können die Bildschirme keine Dateien für den Betrieb ohne Netz speichern.')),
        state.fixedPassword ? h('section', { class: 'panel' }, h('h2', {}, 'Passwort'), h('p', { class: 'hint' }, 'Das Passwort ist am Server über ADMIN_PASSWORD fest vorgegeben.'))
          : h('form', { class: 'panel', onsubmit: async (e) => { e.preventDefault(); try { await api('POST', '/api/auth/password', pw); toast('Passwort geändert'); e.target.reset(); } catch (ex) { oops(ex); } } },
            h('h2', {}, 'Passwort ändern'),
            h('label', { class: 'field' }, h('span', {}, 'Aktuelles Passwort'), h('input', { type: 'password', autocomplete: 'current-password', oninput: (e) => { pw.current = e.target.value; } })),
            h('label', { class: 'field' }, h('span', {}, 'Neues Passwort (mindestens 8 Zeichen)'), h('input', { type: 'password', autocomplete: 'new-password', oninput: (e) => { pw.password = e.target.value; } })),
            h('button', { class: 'btn primary' }, 'Passwort ändern')),
        h('section', { class: 'panel' }, h('h2', {}, 'Sitzung'),
          h('button', { class: 'btn', onclick: async () => { await api('POST', '/api/auth/logout'); location.reload(); } }, 'Abmelden'))));
  }

  // ───────── Start ─────────

  function connectLive() {
    if (events) events.close();
    events = new EventSource('/api/events');
    events.addEventListener('screens', (e) => {
      takeScreens(JSON.parse(e.data));
      liveListeners.forEach((fn) => fn());
      const side = document.querySelector('.side');
      if (side) side.replaceWith(buildNav());
    });
  }

  async function start() {
    try {
      const auth = await api('GET', '/api/auth/state');
      state.fixedPassword = auth.fixedPassword;
      if (!auth.loggedIn) return gate(!auth.setup);
      await loadAll();
      render();
      connectLive();
    } catch (e) {
      set(app, h('div', { class: 'gate' }, h('form', {}, brand(), h('p', { class: 'error' }, 'Server nicht erreichbar: ' + e.message),
        h('button', { class: 'btn', type: 'button', onclick: () => location.reload() }, 'Erneut versuchen'))));
    }
  }

  window.addEventListener('hashchange', render);
  start();
})();
