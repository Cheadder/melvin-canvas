/* Melvin canvas: renders one "melvin-canvas/1" spec from the URL fragment and sends the answers back via sendData.
 *
 * Privacy: the page content lives only in the fragment (#v1.<nonce>.<deflate-raw, base64url>), which browsers never
 * send to the web host. This file holds no data of anyone's. Text is always set with textContent (never innerHTML);
 * images must be data:image URIs; there are no links, fonts or requests to anywhere (see the CSP in index.html).
 */
(function () {
  'use strict';
  var TG = window.MelvinTG;
  var doc = document;
  var app = doc.getElementById('app');
  var bar = doc.getElementById('bar');
  var SVGNS = 'http://www.w3.org/2000/svg';
  var TOKEN_RE = /^v1\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]+)$/;
  var IMG_RE = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;
  var ACCENTS = {
    violet: ['#8b5cf6', '#ec4899'], cyan: ['#22d3ee', '#3b82f6'], blue: ['#3b82f6', '#8b5cf6'],
    green: ['#22c55e', '#14b8a6'], amber: ['#f59e0b', '#ef4444'], pink: ['#ec4899', '#f97316'],
    red: ['#ef4444', '#f97316'], teal: ['#14b8a6', '#22d3ee']
  };
  var S = { spec: null, nonce: null, answers: {}, initial: {}, fields: [], dirty: false, busy: false, charts: [], width: 0,
    save: null, sheet: false, accentHex: '#8b5cf6' };
  var uid = 0;
  // The paper (kind "paper"): a row's untouched value ("open" item, "wait" proposal, "parked" proposal, or an item
  // already done / snoozed / stopped) is shown as NO selection and never as a button, so only the reader's own taps
  // light up; tapping a lit option again clears it. A closed item says so in a small tag next to its title.
  var PAPER_REST = ['open', 'wait', 'parked', 'done', 'snoozed', 'stopped'];
  var PAPER_CLOSED = ['done', 'snoozed', 'stopped'];
  // footers from older paper builds ("... “done 3” still works."): the paper carries no help notes
  var PAPER_FOOT_RE = /still works\.?$|^Save changes only/i;

  // ------------------------------------------------------------------------------------------------ helpers
  function el(tag, cls, text) {
    var e = doc.createElement(tag);
    if (cls) { e.className = cls; }
    if (text !== undefined && text !== null && text !== '') { e.textContent = String(text); }
    return e;
  }
  function svg(tag, attrs) {
    var e = doc.createElementNS(SVGNS, tag);
    Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, String(attrs[k])); });
    return e;
  }
  function str(v, max) {
    if (v === undefined || v === null) { return ''; }
    v = String(v);
    return max && v.length > max ? v.slice(0, max) : v;
  }
  function tone(t) { return ['good', 'warn', 'bad', 'info', 'neutral'].indexOf(t) >= 0 ? t : 'neutral'; }
  function decimals(x) { var s = String(x); var i = s.indexOf('.'); return i < 0 ? 0 : Math.min(4, s.length - i - 1); }
  function fmt(v, d) {
    var n = Number(v);
    if (!isFinite(n)) { return String(v); }
    if (d === undefined) { d = Math.abs(n) >= 1000 ? 0 : Math.min(2, decimals(n)); }
    return n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function fmtShort(v) {
    var n = Number(v), a = Math.abs(n);
    if (a >= 1e6) { return (n / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M'; }
    if (a >= 1e4) { return (n / 1e3).toFixed(a >= 1e5 ? 0 : 1) + 'k'; }
    return fmt(n);
  }
  function equal(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  function session(key, value) {
    try {
      if (value === undefined) { return window.sessionStorage.getItem(key); }
      if (value === null) { window.sessionStorage.removeItem(key); } else { window.sessionStorage.setItem(key, value); }
    } catch (e) { /* storage blocked: drafts are a convenience only */ }
    return null;
  }

  // ------------------------------------------------------------------------------------------------ colour & theme
  function hexToRgb(h) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(h || '').trim());
    if (!m) {
      var s = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(String(h || '').trim());
      if (!s) { return null; }
      m = [0, s[1] + s[1] + s[2] + s[2] + s[3] + s[3]];
    }
    var n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgbToHex(c) { return '#' + c.map(function (x) { return ('0' + Math.round(x).toString(16)).slice(-2); }).join(''); }
  function luminance(c) {
    var a = c.map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
  }
  function rotate(hex, deg) {
    var c = hexToRgb(hex);
    if (!c) { return '#ec4899'; }
    var r = c[0] / 255, g = c[1] / 255, b = c[2] / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b), h = 0, s = 0, l = (max + min) / 2;
    if (max !== min) {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h /= 6;
    }
    h = (h + deg / 360) % 1;
    function f(p, q, t) {
      if (t < 0) { t += 1; } if (t > 1) { t -= 1; }
      if (t < 1 / 6) { return p + (q - p) * 6 * t; } if (t < 1 / 2) { return q; }
      if (t < 2 / 3) { return p + (q - p) * (2 / 3 - t) * 6; } return p;
    }
    var q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    return rgbToHex([f(p, q, h + 1 / 3) * 255, f(p, q, h) * 255, f(p, q, h - 1 / 3) * 255]);
  }

  function applyTheme() {
    var t = TG.theme() || {};
    var root = doc.documentElement, st = root.style;
    var bgRgb = hexToRgb(t.bg_color);
    var scheme;
    if (bgRgb) { scheme = luminance(bgRgb) > 0.45 ? 'light' : 'dark'; }
    else { scheme = (!TG.inTelegram && window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark'; }
    root.setAttribute('data-scheme', scheme);
    var light = scheme === 'light';
    var bg = bgRgb ? rgbToHex(bgRgb) : (light ? '#f5f6fb' : '#090b14');
    st.setProperty('--bg', bg);
    st.setProperty('--text', hexToRgb(t.text_color) ? t.text_color : (light ? '#0f172a' : '#eef0ff'));
    st.setProperty('--hint', hexToRgb(t.hint_color) ? t.hint_color : (light ? '#64748b' : '#98a0c4'));
    var surf = t.secondary_bg_color || t.section_bg_color;
    st.setProperty('--surface', hexToRgb(surf) ? surf : (light ? '#ffffff' : '#12162a'));
    var pair = ACCENTS[(S.spec && S.spec.accent) || ''];
    var a1 = pair ? pair[0] : (hexToRgb(t.button_color) ? t.button_color : '#8b5cf6');
    var a2 = pair ? pair[1] : rotate(a1, 42);
    S.accentHex = rgbToHex(hexToRgb(a1));
    st.setProperty('--accent-rgb', hexToRgb(a1).join(', '));
    st.setProperty('--accent2-rgb', hexToRgb(a2).join(', '));
    st.setProperty('--accent-text', pair ? '#ffffff' : (hexToRgb(t.button_text_color) ? t.button_text_color : '#ffffff'));
    TG.colors(bg);
  }

  function insets(prefix, d) {
    if (!d) { return; }
    ['top', 'bottom', 'left', 'right'].forEach(function (k) {
      if (typeof d[k] === 'number') { doc.documentElement.style.setProperty(prefix + k, d[k] + 'px'); }
    });
  }

  // ------------------------------------------------------------------------------------------------ decoding
  function bytesFromB64url(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) { s += '='; }
    var bin = atob(s), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) { out[i] = bin.charCodeAt(i); }
    return out;
  }
  function inflate(bytes) {
    if (typeof DecompressionStream === 'undefined' || typeof Blob === 'undefined' || !Blob.prototype.stream) {
      return Promise.reject(new Error('no_decompression'));
    }
    var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).text();
  }
  function loadSpec(token) {
    if (token === 'demo') { return Promise.resolve({ nonce: null, spec: DEMO }); }
    var m = TOKEN_RE.exec(token || '');
    if (!m) { return Promise.reject(new Error('no_token')); }
    var bytes;
    try { bytes = bytesFromB64url(m[2]); } catch (e) { return Promise.reject(new Error('bad_spec')); }
    return inflate(bytes).then(function (text) {
      var spec = JSON.parse(text);
      if (!spec || spec.canvas !== 'melvin-canvas/1' || !Array.isArray(spec.blocks)) { throw new Error('bad_spec'); }
      return { nonce: m[1], spec: spec };
    }, function (e) { throw new Error(e && e.message === 'no_decompression' ? 'no_decompression' : 'bad_spec'); });
  }

  // ------------------------------------------------------------------------------------------------ answers
  var INPUT_TYPES = ['toggle', 'check', 'choice', 'slider', 'input'];
  function initialValue(b) {
    if (b.type === 'toggle' || b.type === 'check') { return !!b.value; }
    if (b.type === 'choice') {
      var ok = (b.options || []).some(function (o) { return o.value === b.value; });
      return ok ? b.value : null;
    }
    if (b.type === 'slider') { var v = Number(b.value); return isFinite(v) ? v : Number(b.min) || 0; }
    return str(b.value, b.max || 300);
  }
  function setAnswer(id, value) {
    S.answers[id] = value;
    S.dirty = !equal(S.answers, S.initial);
    TG.closingConfirmation(S.dirty);
    if (S.nonce) { session('melvin-canvas:a:' + S.nonce, JSON.stringify(S.answers)); }
    updateSave();
  }
  function isPaper() { return !!(S.spec && S.spec.kind === 'paper'); }
  function restOf(b) {
    if (!isPaper() || !b || b.type !== 'choice') { return null; }
    var v = S.initial[b.id];
    if (PAPER_REST.indexOf(v) < 0) { return null; }
    return (b.options || []).some(function (o) { return o.value === v; }) ? v : null;
  }
  function changedCount() {
    return S.fields.filter(function (b) { return !equal(S.answers[b.id], S.initial[b.id]); }).length;
  }
  function restoreDraft() {
    if (!S.nonce) { return; }
    var raw = session('melvin-canvas:a:' + S.nonce);
    if (!raw) { return; }
    try {
      var d = JSON.parse(raw);
      S.fields.forEach(function (b) {
        if (!(b.id in d) || b.disabled) { return; }
        var v = d[b.id], ok = false;
        if (b.type === 'toggle' || b.type === 'check') { ok = typeof v === 'boolean'; }
        else if (b.type === 'choice') { ok = v === null || (b.options || []).some(function (o) { return o.value === v; }); }
        else if (b.type === 'slider') { ok = typeof v === 'number' && v >= b.min && v <= b.max; }
        else { ok = typeof v === 'string' && v.length <= (b.max || 300); }
        if (ok) { S.answers[b.id] = v; }
      });
      S.dirty = !equal(S.answers, S.initial);
      TG.closingConfirmation(S.dirty);
    } catch (e) { /* a broken draft is ignored */ }
  }

  // ------------------------------------------------------------------------------------------------ blocks
  var R = {};
  R.hero = function (b) {
    var c = el('section', 'glass hero');
    if (b.emoji) { c.appendChild(el('div', 'orb', str(b.emoji, 8))); }
    c.appendChild(el('h1', 'grad-text', str(b.title, 80)));
    if (b.text) { c.appendChild(el('p', '', str(b.text, 400))); }
    return c;
  };
  R.section = function (b) {
    var c = el('section', 'section');
    c.appendChild(el('h2', '', str(b.title, 60)));
    if (b.text) { c.appendChild(el('p', '', str(b.text, 300))); }
    return c;
  };
  R.text = function (b) { return el('p', 'text', str(b.text, 600)); };
  R.note = function (b) {
    var c = el('div', 'note tone-' + tone(b.tone || 'info'));
    c.appendChild(el('span', 'dot'));
    c.appendChild(el('span', '', str(b.text, 400)));
    return c;
  };
  R.divider = function () { return el('div', 'divider'); };
  R.card = function (b) {
    var c = el('article', 'glass card tone-' + tone(b.tone));
    var top = el('div', 'card-top');
    if (b.emoji) { top.appendChild(el('span', 'emoji', str(b.emoji, 8))); }
    top.appendChild(el('h3', '', str(b.title, 80)));
    if (b.meta) { top.appendChild(el('span', 'meta', str(b.meta, 40))); }
    c.appendChild(top);
    if (b.text) { c.appendChild(el('p', '', str(b.text, 400))); }
    if (b.badge) { c.appendChild(el('span', 'badge tone-' + tone(b.tone), str(b.badge, 28))); }
    return c;
  };
  R.list = function (b) {
    var c = el('section', 'glass list');
    if (b.title) { c.appendChild(el('h3', '', str(b.title, 60))); }
    (b.items || []).slice(0, 20).forEach(function (it, k) {
      var row = el('div', 'list-row tone-' + tone(it.tone || 'info'));
      row.appendChild(el('span', 'lead', it.emoji ? str(it.emoji, 8) : String(k + 1)));
      var body = el('div', 'body');
      body.appendChild(el('div', 't', str(it.title, 80)));
      if (it.text) { body.appendChild(el('div', 's', str(it.text, 200))); }
      row.appendChild(body);
      if (it.meta) { row.appendChild(el('span', 'm', str(it.meta, 40))); }
      c.appendChild(row);
    });
    return c;
  };
  R.stats = function (b) {
    var wrap = el('section', 'stats-wrap');
    if (b.title) { wrap.appendChild(el('h3', '', str(b.title, 60))); }
    var grid = el('div', 'stats');
    (b.items || []).slice(0, 8).forEach(function (it) {
      var t = el('div', 'glass stat tone-' + tone(it.tone));
      t.appendChild(el('div', 'l', str(it.label, 40)));
      var v = el('div', 'v');
      var num = el('span', 'n', typeof it.value === 'number' ? fmt(it.value) : str(it.value, 16));
      if (typeof it.value === 'number') { num.setAttribute('data-to', String(it.value)); }
      v.appendChild(num);
      if (it.unit) { v.appendChild(el('span', 'u', str(it.unit, 12))); }
      t.appendChild(v);
      if (it.delta) { t.appendChild(el('span', 'd', str(it.delta, 16))); }
      grid.appendChild(t);
    });
    wrap.appendChild(grid);
    return wrap;
  };
  function chartBlock(b, draw) {
    var c = el('section', 'glass chart');
    if (b.title || b.unit) { c.appendChild(el('h3', '', str(b.title, 60) + (b.unit ? ' · ' + str(b.unit, 12) : ''))); }
    var host = el('div', 'plot');
    c.appendChild(host);
    S.charts.push(function (animate) { draw(host, b, Math.max(220, Math.floor(host.clientWidth || 300)), animate); });
    return c;
  }
  R.bars = function (b) { return chartBlock(b, drawBars); };
  R.line = function (b) { return chartBlock(b, drawLine); };
  R.image = function (b) {
    if (!IMG_RE.test(String(b.src || ''))) { return null; }
    var f = el('figure', 'glass image');
    f.style.margin = '0';
    var img = el('img');
    img.alt = str(b.alt || 'image', 120);
    img.decoding = 'async';
    img.src = b.src;
    f.appendChild(img);
    if (b.caption) { f.appendChild(el('figcaption', '', str(b.caption, 120))); }
    return f;
  };

  function rowInput(b, kind) {
    var r = el('button', 'glass row ' + kind);
    r.type = 'button';
    r.setAttribute('role', kind === 'toggle' ? 'switch' : 'checkbox');
    if (b.disabled) { r.setAttribute('aria-disabled', 'true'); }
    if (kind === 'check') {
      var box = el('span', 'box');
      var s = svg('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true' });
      s.appendChild(svg('path', { d: 'M3 8.6l3.1 3.1L13 4.9' }));
      box.appendChild(s);
      r.appendChild(box);
    }
    var main = el('span', 'main');
    main.appendChild(el('span', 'label', str(b.label, 90)));
    if (b.badge || b.hint) {
      var sub = el('span', 'sub');
      if (b.badge) { sub.appendChild(el('span', 'badge tone-' + tone(b.tone), str(b.badge, 28))); }
      if (b.hint) { sub.appendChild(el('span', 'hint', str(b.hint, 140))); }
      main.appendChild(sub);
    }
    r.appendChild(main);
    if (kind === 'toggle') { r.appendChild(el('span', 'switch')); }
    function paint() {
      var on = !!S.answers[b.id];
      r.classList.toggle('on', on);
      r.setAttribute('aria-checked', String(on));
    }
    r.addEventListener('click', function () {
      if (b.disabled) {
        TG.haptic('notification', 'warning');
        toast(b.hint ? str(b.hint, 120) : 'This one can’t be changed here.');
        return;
      }
      setAnswer(b.id, !S.answers[b.id]);
      paint();
      TG.haptic('selection');
    });
    paint();
    return r;
  }
  R.toggle = function (b) { return rowInput(b, 'toggle'); };
  R.check = function (b) { return rowInput(b, 'check'); };

  function fieldShell(b) {
    var f = el('div', 'glass field');
    f.appendChild(el('div', 'flabel', str(b.label, 90)));
    if (b.hint) { f.appendChild(el('div', 'fhint', str(b.hint, 140))); }
    return f;
  }
  // a parked proposal on the paper: its name and one "Bring back" button (tap again = stays parked)
  function parkedRow(b, rest, opt) {
    var r = el('div', 'parked-row');
    var main = el('span', 'pmain');
    main.appendChild(el('span', 'plabel', str(b.label, 90)));
    if (b.hint) { main.appendChild(el('span', 'phint', str(b.hint, 140))); }
    r.appendChild(main);
    var bt = el('button', 'pbtn', str(opt.label, 24) || 'Bring back');
    bt.type = 'button';
    function paint() {
      var on = S.answers[b.id] === opt.value;
      bt.setAttribute('aria-pressed', String(on));
      r.classList.toggle('on', on);
    }
    bt.addEventListener('click', function () {
      setAnswer(b.id, S.answers[b.id] === opt.value ? rest : opt.value);
      paint();
      TG.haptic('selection');
    });
    r.appendChild(bt);
    paint();
    return r;
  }
  R.choice = function (b) {
    var rest = restOf(b);
    var opts = (b.options || []).slice(0, 12).filter(function (o) { return rest === null || o.value !== rest; });
    if (rest === 'parked' && opts.length) { return parkedRow(b, rest, opts[0]); }
    var f = fieldShell(b);
    if (rest !== null) { f.classList.add('rest'); }
    if (PAPER_CLOSED.indexOf(rest) >= 0) {
      var was = (b.options || []).filter(function (o) { return o.value === rest; })[0];
      f.firstChild.appendChild(el('span', 'ftag', str(was && was.label, 24)));
    }
    var nodes = [];
    function idx() {
      for (var k = 0; k < opts.length; k++) { if (opts[k].value === S.answers[b.id]) { return k; } }
      return -1;
    }
    var pill = null;
    function paint() {
      var i = idx();
      nodes.forEach(function (n, k) { n.setAttribute('aria-checked', String(k === i)); });
      if (pill) {
        pill.style.width = 'calc((100% - 8px) / ' + opts.length + ')';
        pill.style.opacity = i < 0 ? '0' : '1';
        pill.style.transform = 'translateX(' + (Math.max(i, 0) * 100) + '%)';
      }
      if (rest !== null) { f.classList.toggle('touched', !equal(S.answers[b.id], S.initial[b.id])); }
    }
    function pick(k) {
      var v = opts[k].value;
      setAnswer(b.id, rest !== null && S.answers[b.id] === v ? rest : v);
      paint();
      TG.haptic('selection');
    }
    var group;
    if (b.style === 'segmented') {
      group = el('div', 'seg');
      pill = el('span', 'pill');
      group.appendChild(pill);
      opts.forEach(function (o, k) {
        var bt = el('button', '', (o.emoji ? str(o.emoji, 8) + ' ' : '') + str(o.label, 60));
        bt.type = 'button';
        bt.setAttribute('role', 'radio');
        bt.addEventListener('click', function () { pick(k); });
        nodes.push(bt);
        group.appendChild(bt);
      });
    } else {
      group = el('div', 'opts');
      opts.forEach(function (o, k) {
        var bt = el('button', 'opt');
        bt.type = 'button';
        bt.setAttribute('role', 'radio');
        if (o.emoji) { bt.appendChild(el('span', 'oe', str(o.emoji, 8))); }
        var body = el('span', 'ob');
        body.appendChild(el('div', 'ol', str(o.label, 60)));
        if (o.hint) { body.appendChild(el('div', 'oh', str(o.hint, 100))); }
        bt.appendChild(body);
        bt.appendChild(el('span', 'radio'));
        bt.addEventListener('click', function () { pick(k); });
        nodes.push(bt);
        group.appendChild(bt);
      });
    }
    group.setAttribute('role', 'radiogroup');
    f.appendChild(group);
    paint();
    return f;
  };
  R.slider = function (b) {
    var f = el('div', 'glass field');
    var lo = Number(b.min), hi = Number(b.max), step = Number(b.step) || 1, d = Math.max(decimals(step), decimals(lo));
    var top = el('div', 'slider-top');
    top.appendChild(el('div', 'flabel', str(b.label, 90)));
    var val = el('div', 'slider-val');
    top.appendChild(val);
    f.appendChild(top);
    if (b.hint) { f.appendChild(el('div', 'fhint', str(b.hint, 140))); }
    var inp = el('input');
    inp.type = 'range';
    inp.min = String(lo);
    inp.max = String(hi);
    inp.step = String(step);
    inp.value = String(S.answers[b.id]);
    inp.setAttribute('aria-label', str(b.label, 90));
    var unit = b.unit ? ' ' + str(b.unit, 12) : '';
    function paint() {
      var v = Number(inp.value);
      inp.style.setProperty('--p', ((v - lo) / (hi - lo) * 100) + '%');
      val.textContent = fmt(v, d);
      if (b.unit) { val.appendChild(el('small', '', str(b.unit, 12))); }
    }
    var last = null;
    inp.addEventListener('input', function () {
      var v = Number(inp.value);
      v = Number((lo + Math.round((v - lo) / step) * step).toFixed(d));
      setAnswer(b.id, v);
      paint();
      if (v !== last) { TG.haptic('selection'); last = v; }
    });
    f.appendChild(inp);
    var ends = el('div', 'slider-ends');
    ends.appendChild(el('span', '', fmt(lo, d) + unit));
    ends.appendChild(el('span', '', fmt(hi, d) + unit));
    f.appendChild(ends);
    paint();
    return f;
  };
  R.input = function (b) {
    var f = el('div', 'glass field');
    var id = 'f-' + b.id;
    var lab = el('label', 'flabel', str(b.label, 90));
    lab.htmlFor = id;
    f.appendChild(lab);
    if (b.hint) { f.appendChild(el('div', 'fhint', str(b.hint, 140))); }
    var t = b.multiline ? el('textarea', 'tin') : el('input', 'tin');
    if (!b.multiline) { t.type = 'text'; t.enterKeyHint = 'done'; } else { t.rows = 3; }
    t.id = id;
    t.maxLength = Math.min(1000, Number(b.max) || 300);
    t.placeholder = str(b.placeholder, 80);
    t.value = S.answers[b.id] || '';
    t.autocomplete = 'off';
    var count = el('div', 'count');
    function upd() {
      count.textContent = t.value.length + ' / ' + t.maxLength;
      if (b.multiline) { t.style.height = 'auto'; t.style.height = Math.min(260, t.scrollHeight + 2) + 'px'; }
    }
    t.addEventListener('input', function () { setAnswer(b.id, t.value); upd(); });
    if (!b.multiline) { t.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); t.blur(); } }); }
    f.appendChild(t);
    f.appendChild(count);
    setTimeout(upd, 0);
    return f;
  };

  // ------------------------------------------------------------------------------------------------ charts (inline SVG)
  function gradient(defs, vertical) {
    var id = 'g' + (++uid);
    var g = svg('linearGradient', vertical ? { id: id, x1: 0, y1: 0, x2: 0, y2: 1 } : { id: id, x1: 0, y1: 0, x2: 1, y2: 0 });
    var a = svg('stop', { offset: '0%' }), z = svg('stop', { offset: '100%' });
    a.style.stopColor = 'rgb(var(--accent' + (vertical ? '2' : '') + '-rgb))';
    z.style.stopColor = 'rgb(var(--accent' + (vertical ? '' : '2') + '-rgb))';
    g.appendChild(a);
    g.appendChild(z);
    defs.appendChild(g);
    return 'url(#' + id + ')';
  }
  function scaleY(vals, top, h, pad) {
    var max = Math.max.apply(null, vals), min = Math.min.apply(null, vals);
    if (pad) { var span = (max - min) || Math.abs(max) || 1; max += span * pad; min -= span * pad; }
    if (max === min) { max += 1; min -= 1; }
    return function (v) { return top + (max - v) / (max - min) * h; };
  }
  function drawBars(host, b, W, animate) {
    host.textContent = '';
    var items = (b.items || []).slice(0, 24), n = items.length;
    if (!n) { return; }
    var H = 184, top = 24, bottom = 26, side = 4;
    var vals = items.map(function (i) { return Number(i.value) || 0; });
    var y = scaleY(vals.concat([0]), top, H - top - bottom, 0);
    var zero = y(0), slot = (W - side * 2) / n, bw = Math.max(5, Math.min(44, slot * 0.62));
    var s = svg('svg', { viewBox: '0 0 ' + W + ' ' + H, width: W, height: H, role: 'img', 'aria-label': str(b.title || 'Bar chart', 60) });
    var defs = svg('defs', {});
    s.appendChild(defs);
    var fill = gradient(defs, true);
    [top, zero].forEach(function (gy) { s.appendChild(svg('line', { x1: 0, x2: W, y1: gy, y2: gy, 'class': 'grid', 'stroke-dasharray': '3 5' })); });
    var maxI = vals.indexOf(Math.max.apply(null, vals));
    var step = Math.ceil(n / 8);
    items.forEach(function (it, k) {
      var v = vals[k], cx = side + k * slot + slot / 2, yv = y(v);
      var r = svg('rect', { x: cx - bw / 2, y: Math.min(yv, zero), width: bw, height: Math.max(1.5, Math.abs(zero - yv)),
        rx: Math.min(9, bw / 2), fill: fill, 'class': 'bar' + (v < 0 ? ' neg' : '') });
      r.style.opacity = k === maxI ? '1' : '0.72';
      if (animate) { r.style.animationDelay = (k * 55) + 'ms'; } else { r.style.animation = 'none'; }
      s.appendChild(r);
      if (n <= 12) {
        var t = svg('text', { x: cx, y: v >= 0 ? yv - 7 : yv + 15, 'text-anchor': 'middle', 'class': 'val' });
        t.textContent = fmtShort(v);
        s.appendChild(t);
      }
      if (k % step === 0) {
        var lab = svg('text', { x: cx, y: H - 7, 'text-anchor': 'middle', 'class': 'axis' });
        var maxChars = Math.max(2, Math.floor(slot * step / 6.6));
        var l = str(it.label, 16);
        lab.textContent = l.length > maxChars ? l.slice(0, maxChars - 1) + '…' : l;
        s.appendChild(lab);
      }
    });
    host.appendChild(s);
  }
  function smooth(pts) {
    if (pts.length < 3) { return 'M' + pts.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' L'); }
    var d = 'M' + pts[0][0].toFixed(1) + ',' + pts[0][1].toFixed(1), t = 0.18;
    for (var i = 0; i < pts.length - 1; i++) {
      var p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
      var c1 = [p1[0] + (p2[0] - p0[0]) * t, p1[1] + (p2[1] - p0[1]) * t];
      var c2 = [p2[0] - (p3[0] - p1[0]) * t, p2[1] - (p3[1] - p1[1]) * t];
      d += ' C' + c1[0].toFixed(1) + ',' + c1[1].toFixed(1) + ' ' + c2[0].toFixed(1) + ',' + c2[1].toFixed(1) + ' ' + p2[0].toFixed(1) + ',' + p2[1].toFixed(1);
    }
    return d;
  }
  function drawLine(host, b, W, animate) {
    host.textContent = '';
    var items = (b.items || []).slice(0, 48), n = items.length;
    if (n < 2) { return; }
    var H = 176, top = 22, bottom = 26, left = 8, right = 14;
    var vals = items.map(function (i) { return Number(i.value) || 0; });
    var y = scaleY(vals, top, H - top - bottom, 0.12);
    var x = function (k) { return left + k * (W - left - right) / (n - 1); };
    var pts = vals.map(function (v, k) { return [x(k), y(v)]; });
    var s = svg('svg', { viewBox: '0 0 ' + W + ' ' + H, width: W, height: H, role: 'img', 'aria-label': str(b.title || 'Line chart', 60) });
    var defs = svg('defs', {});
    s.appendChild(defs);
    var stroke = gradient(defs, false);
    var aid = 'g' + (++uid);
    var ag = svg('linearGradient', { id: aid, x1: 0, y1: 0, x2: 0, y2: 1 });
    var s1 = svg('stop', { offset: '0%' }), s2 = svg('stop', { offset: '100%' });
    s1.style.stopColor = 'rgba(var(--accent-rgb), 0.38)';
    s2.style.stopColor = 'rgba(var(--accent-rgb), 0)';
    ag.appendChild(s1);
    ag.appendChild(s2);
    defs.appendChild(ag);
    [top, H - bottom].forEach(function (gy) { s.appendChild(svg('line', { x1: 0, x2: W, y1: gy, y2: gy, 'class': 'grid', 'stroke-dasharray': '3 5' })); });
    var d = smooth(pts);
    var area = svg('path', { d: d + ' L' + x(n - 1).toFixed(1) + ',' + (H - bottom) + ' L' + x(0).toFixed(1) + ',' + (H - bottom) + ' Z', fill: 'url(#' + aid + ')', 'class': 'area' });
    if (!animate) { area.style.animation = 'none'; area.style.opacity = '1'; }
    s.appendChild(area);
    var line = svg('path', { d: d, stroke: stroke, 'class': 'line' });
    s.appendChild(line);
    var hi = vals.indexOf(Math.max.apply(null, vals)), lo = vals.indexOf(Math.min.apply(null, vals));
    [[hi, -9], [lo, 17]].forEach(function (p, j) {
      if (j === 1 && lo === hi) { return; }
      var t = svg('text', { x: Math.min(W - 18, Math.max(18, pts[p[0]][0])), y: pts[p[0]][1] + p[1], 'text-anchor': 'middle', 'class': 'val' });
      t.textContent = fmtShort(vals[p[0]]);
      s.appendChild(t);
    });
    var last = pts[n - 1];
    var ping = svg('circle', { cx: last[0], cy: last[1], r: 4.5, 'class': 'pt-last' });
    ping.style.fill = 'rgb(var(--accent2-rgb))';
    s.appendChild(ping);
    var dot = svg('circle', { cx: last[0], cy: last[1], r: 4.5, stroke: '#fff', 'stroke-width': 2 });
    dot.style.fill = 'rgb(var(--accent2-rgb))';
    s.appendChild(dot);
    [0, Math.floor((n - 1) / 2), n - 1].filter(function (k, i, a) { return a.indexOf(k) === i; }).forEach(function (k) {
      var anchor = k === 0 ? 'start' : (k === n - 1 ? 'end' : 'middle');
      var lab = svg('text', { x: x(k), y: H - 7, 'text-anchor': anchor, 'class': 'axis' });
      lab.textContent = str(items[k].label, 16);
      s.appendChild(lab);
    });
    host.appendChild(s);
    try {
      var len = line.getTotalLength();
      line.style.strokeDasharray = String(len);
      line.style.strokeDashoffset = animate ? String(len) : '0';
      if (!animate) { line.style.animation = 'none'; }
    } catch (e) { /* no geometry API: the line just appears */ }
  }

  function countUp() {
    var nodes = app.querySelectorAll('.stat .n[data-to]');
    Array.prototype.forEach.call(nodes, function (node, k) {
      var to = Number(node.getAttribute('data-to')), d = Math.min(2, decimals(to)), t0 = null, dur = 900;
      if (!isFinite(to) || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) { return; }
      function frame(ts) {
        if (t0 === null) { t0 = ts + k * 70; }
        var p = Math.min(1, Math.max(0, (ts - t0) / dur)), e = 1 - Math.pow(1 - p, 3);
        node.textContent = fmt(to * e, d);
        if (p < 1) { window.requestAnimationFrame(frame); }
      }
      node.textContent = fmt(0, d);
      window.requestAnimationFrame(frame);
    });
  }

  // ------------------------------------------------------------------------------------------------ page
  function render(spec) {
    app.textContent = '';
    S.charts = [];
    if (!TG.inTelegram) { app.appendChild(el('div', 'chip-preview rise', S.nonce ? 'Preview · open it from Telegram to send' : 'Demo · nothing is sent')); }
    var blocks = spec.blocks || [];
    var k = 1;
    if (!blocks.length || !blocks[0] || blocks[0].type !== 'hero') {
      var head = el('header', 'page-head rise');
      head.appendChild(el('h1', 'grad-text', str(spec.title, 80)));
      if (spec.subtitle) { head.appendChild(el('p', '', str(spec.subtitle, 160))); }
      app.appendChild(head);
    }
    var list = blocks.slice(0, 80), paper = isPaper();
    function usable(b) {
      if (!b || typeof b !== 'object' || typeof b.type !== 'string' || !Object.prototype.hasOwnProperty.call(R, b.type)) { return false; }
      if (INPUT_TYPES.indexOf(b.type) >= 0 && !(b.id in S.answers)) { return false; }
      return !(paper && b.type === 'note' && PAPER_FOOT_RE.test(str(b.text, 400)));
    }
    function add(node) {
      if (!node) { return; }
      node.classList.add('rise');
      node.style.setProperty('--i', String(Math.min(k++, 14)));
      app.appendChild(node);
    }
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      if (!usable(b)) { continue; }
      if (paper && b.type === 'section') {          // a section of parked proposals only: one small folded list
        var j = i + 1, rows = [];
        while (j < list.length && !(list[j] && list[j].type === 'section')) { rows.push(list[j]); j++; }
        rows = rows.filter(usable);
        if (rows.length && rows.every(function (g) { return restOf(g) === 'parked'; })) {
          add(foldGroup(b, rows));
          i = j - 1;
          continue;
        }
      }
      add(R[b.type](b));
    }
    renderBar(spec);
    window.requestAnimationFrame(function () {
      S.width = app.clientWidth;
      S.charts.forEach(function (draw) { draw(true); });
      countUp();
    });
  }

  function foldGroup(sec, rows) {
    var d = el('details', 'glass fold');
    var s = el('summary');
    s.appendChild(el('span', 'ft', str(sec.title, 60)));
    s.appendChild(el('span', 'fc', String(rows.length)));
    s.appendChild(el('span', 'chev'));
    d.appendChild(s);
    var body = el('div', 'fold-body');
    rows.forEach(function (g) { var n = R.choice(g); if (n) { body.appendChild(n); } });
    d.appendChild(body);
    if (rows.some(function (g) { return !equal(S.answers[g.id], S.initial[g.id]); })) { d.open = true; }
    s.addEventListener('click', function () { TG.haptic('selection'); });
    return d;
  }

  // ------------------------------------------------------------------------------------------------ the paper's Save
  // No Close (Telegram has its own at the top) and no help notes: one Save that appears once something changed and
  // says how much ("Save 2 changes"). In Telegram it is Telegram's own bottom button; elsewhere one sticky button.
  function saveLabel(n) { return 'Save ' + n + (n === 1 ? ' change' : ' changes'); }
  function paperBar(acts) {
    var a = acts.filter(function (x) { return !x.close && x.id !== 'cancel'; })[0];
    bar.textContent = '';
    if (!a) { bar.hidden = true; app.classList.add('no-bar'); S.save = null; return; }
    S.save = { act: a, btn: null, native: false };
    // the private iCloud host has no main button (no TG.mainButton): it gets the page's own Save
    if (TG.inTelegram && S.nonce && typeof TG.mainButton === 'function' && TG.mainButton({ visible: false, text: 'Save' })) {
      S.save.native = true;
      S.save.btn = el('button');                      // detached: send() keeps its busy state here
      TG.on('main_button_pressed', function () {
        if (S.save && S.save.native && !S.busy && !S.sheet && changedCount()) { onAction(S.save.act, S.save.btn); }
      });
      bar.hidden = true;
      app.classList.add('no-bar');
    } else {
      var inner = el('div', 'inner');
      var bt = el('button', 'btn primary', 'Save');
      bt.type = 'button';
      bt.addEventListener('click', function () { onAction(a, bt); });
      inner.appendChild(bt);
      bar.appendChild(inner);
      S.save.btn = bt;
      app.classList.remove('no-bar');
    }
    updateSave();
  }
  function updateSave() {
    if (!S.save || S.busy) { return; }
    var n = changedCount();
    if (S.save.native) {
      TG.mainButton({ visible: n > 0 && !S.sheet, text: saveLabel(n), color: S.accentHex, textColor: '#ffffff', shine: true });
      return;
    }
    S.save.btn.textContent = saveLabel(n);
    bar.hidden = n === 0;
  }

  var STYLE_ORDER = { ghost: 0, secondary: 1, danger: 2, primary: 3 };
  function renderBar(spec) {
    bar.textContent = '';
    var acts = (Array.isArray(spec.actions) && spec.actions.length ? spec.actions : [{ id: 'done', label: 'Done', style: 'primary', close: true }]).slice(0, 3);
    if (isPaper()) { paperBar(acts); return; }
    var inner = el('div', 'inner');
    acts.slice().sort(function (a, b) { return (STYLE_ORDER[a.style] || 0) - (STYLE_ORDER[b.style] || 0); }).forEach(function (a) {
      var st = STYLE_ORDER.hasOwnProperty(a.style) ? a.style : 'primary';
      var bt = el('button', 'btn ' + st, str(a.label, 24) || 'OK');
      bt.type = 'button';
      bt.addEventListener('click', function () { onAction(a, bt); });
      inner.appendChild(bt);
    });
    bar.appendChild(inner);
    bar.hidden = false;
    app.classList.remove('no-bar');
  }

  function onAction(a, bt) {
    if (S.busy) { return; }
    TG.haptic('impact', 'light');
    if (a.close) {
      TG.closingConfirmation(false);
      if (!TG.close()) { toast('Closed (preview).'); }
      return;
    }
    if (a.id === 'cancel') { send(a, bt, {}); return; }
    if (a.confirm) { confirmSheet(a, bt); return; }
    send(a, bt, S.answers);
  }

  function summary() {
    var on = [], rows = [];
    S.fields.forEach(function (b) {
      var v = S.answers[b.id], changed = !equal(v, S.initial[b.id]), say;
      if (b.type === 'toggle' || b.type === 'check') {
        if (v && !b.disabled) { on.push(b.label); }
        say = b.type === 'toggle' ? (v ? 'On' : 'Off') : (v ? 'Done' : '—');
      } else if (b.type === 'choice') {
        var o = (b.options || []).filter(function (x) { return x.value === v; })[0];
        say = o ? o.label : 'Nothing picked';
      } else if (b.type === 'slider') {
        say = fmt(v) + (b.unit ? ' ' + b.unit : '');
      } else {
        say = v ? (v.length > 60 ? v.slice(0, 59) + '…' : v) : '—';
      }
      if (isPaper() && !changed) { return; }          // the paper lists only what the reader touched
      rows.push({ label: str(b.label, 90), say: say, changed: changed });
    });
    return { on: on, rows: rows };
  }

  function confirmSheet(a, bt) {
    var sm = summary();
    var proposals = S.spec.kind === 'proposals';
    var scrim = el('div', 'scrim'), sheet = el('div', 'sheet');
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.appendChild(el('div', 'grab'));
    var title = typeof a.confirm === 'string' ? a.confirm :
      (proposals ? (sm.on.length ? 'Switch on ' + sm.on.length + (sm.on.length === 1 ? ' idea?' : ' ideas?') : 'Switch nothing on?') : 'Send this to Melvin?');
    sheet.appendChild(el('h2', '', title));
    sheet.appendChild(el('p', 'sub', proposals ? 'Everything else stays waiting. Nothing is turned down.' : 'Here’s what goes back.'));
    var ul = el('ul');
    if (proposals) {
      sm.on.slice(0, 30).forEach(function (label) {
        var li = el('li');
        li.appendChild(el('span', 'k changed', label));
        li.appendChild(el('span', 'v on', 'On'));
        ul.appendChild(li);
      });
    } else {
      sm.rows.slice(0, 30).forEach(function (r) {
        var li = el('li');
        li.appendChild(el('span', 'k' + (r.changed ? ' changed' : ''), r.label));
        li.appendChild(el('span', 'v', r.say));
        ul.appendChild(li);
      });
    }
    if (ul.childNodes.length) { sheet.appendChild(ul); }
    var acts = el('div', 'acts');
    var back = el('button', 'btn ghost', 'Back');
    var go = el('button', 'btn primary', a.label && a.label !== 'Save' ? str(a.label, 24) : 'Confirm');
    back.type = go.type = 'button';
    acts.appendChild(back);
    acts.appendChild(go);
    sheet.appendChild(acts);
    doc.body.appendChild(scrim);
    doc.body.appendChild(sheet);
    S.sheet = true;
    updateSave();                                     // Telegram's Save button steps aside while the sheet is up
    window.requestAnimationFrame(function () { scrim.classList.add('open'); sheet.classList.add('open'); });
    TG.haptic('impact', 'medium');
    function close() {
      S.sheet = false;
      updateSave();
      scrim.classList.remove('open');
      sheet.classList.remove('open');
      setTimeout(function () { scrim.remove(); sheet.remove(); }, 420);
    }
    scrim.addEventListener('click', close);
    back.addEventListener('click', function () { TG.haptic('impact', 'light'); close(); });
    go.addEventListener('click', function () { close(); send(a, bt, S.answers); });
  }

  function burst() {
    var b = el('div', 'burst');
    for (var i = 0; i < 16; i++) {
      var p = el('i');
      var ang = (Math.PI * 2 * i) / 16 + Math.random() * 0.4, dist = 60 + Math.random() * 70;
      p.style.setProperty('--dx', Math.cos(ang) * dist + 'px');
      p.style.setProperty('--dy', Math.sin(ang) * dist - 30 + 'px');
      b.appendChild(p);
    }
    doc.body.appendChild(b);
    setTimeout(function () { b.remove(); }, 900);
  }

  function send(a, bt, data) {
    var payload = JSON.stringify({ v: 1, nonce: S.nonce || 'demo-demo-demo-1', act: a.id, data: data });
    var bytes = window.TextEncoder ? new TextEncoder().encode(payload).length : unescape(encodeURIComponent(payload)).length;
    if (bytes > 4096) {
      TG.haptic('notification', 'error');
      toast('That’s a bit too much text to send. Shorten it a little.');
      return;
    }
    S.busy = true;
    if (S.save && S.save.native) {
      TG.mainButton({ visible: true, active: false, progress: true, text: 'Saving…', color: S.accentHex, textColor: '#ffffff' });
    }
    var label = bt.textContent;
    bt.disabled = true;
    bt.textContent = '';
    bt.appendChild(el('span', 'spin'));
    TG.closingConfirmation(false);
    setTimeout(function () {
      bt.textContent = a.id === 'cancel' ? '✓' : '✓ Sent';
      if (a.id !== 'cancel') { burst(); }
      TG.haptic('notification', 'success');
    }, 240);
    setTimeout(function () {
      if (S.nonce) { session('melvin-canvas:a:' + S.nonce, null); }
      var posted = TG.inTelegram && S.nonce ? TG.sendData(payload) : false;
      if (!posted) {
        showPayload(payload);
        reset();
        return;
      }
      // a host that stays open after sending (the private iCloud route) reports back itself; reset() allows a retry
      if (typeof TG.afterSend === 'function') { TG.afterSend(a.id, reset); return; }
      // the Mini App closes itself after sendData; still here means this launch mode cannot send
      setTimeout(function () {
        TG.haptic('notification', 'error');
        toast('This page couldn’t send from here. Tell Melvin in chat instead.');
        reset();
      }, 2500);
    }, 620);
    function reset() { S.busy = false; bt.disabled = false; bt.textContent = label; updateSave(); }
  }

  function showPayload(payload) {
    var scrim = el('div', 'scrim open'), sheet = el('div', 'sheet');
    sheet.appendChild(el('div', 'grab'));
    sheet.appendChild(el('h2', '', S.nonce ? 'Open this from Telegram to send' : 'Demo: this is what would go back'));
    sheet.appendChild(el('p', 'sub', 'Telegram carries it back to Melvin. Nothing is sent from a browser.'));
    var pre = el('pre');
    try { pre.textContent = JSON.stringify(JSON.parse(payload), null, 2); } catch (e) { pre.textContent = payload; }
    sheet.appendChild(pre);
    var ok = el('button', 'btn primary', 'OK');
    ok.type = 'button';
    var acts = el('div', 'acts');
    acts.appendChild(ok);
    sheet.appendChild(acts);
    doc.body.appendChild(scrim);
    doc.body.appendChild(sheet);
    window.requestAnimationFrame(function () { sheet.classList.add('open'); });
    function close() { scrim.remove(); sheet.remove(); }
    ok.addEventListener('click', close);
    scrim.addEventListener('click', close);
  }

  var toastTimer = null;
  function toast(text) {
    var t = doc.querySelector('.toast') || doc.body.appendChild(el('div', 'toast'));
    t.textContent = text;
    window.requestAnimationFrame(function () { t.classList.add('show'); });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2600);
  }

  function fail(code) {
    var M = {
      no_token: ['\u{0001F9E9}', 'This page arrived empty', 'Telegram didn’t pass its contents along. Ask Melvin to send it again, or answer him in chat.'],
      no_decompression: ['\u{0001F4F1}', 'Telegram needs an update', 'This phone can’t unpack Melvin’s page. Update Telegram (or iOS), or answer him in chat.'],
      bad_spec: ['\u{0001F9E9}', 'This page didn’t load', 'Ask Melvin to send it again, or answer him in chat.']
    };
    var m = M[code] || M.bad_spec;
    app.textContent = '';
    bar.hidden = true;
    app.classList.add('no-bar');
    var c = el('section', 'glass state rise');
    c.appendChild(el('div', 'big', m[0]));
    c.appendChild(el('h1', '', m[1]));
    c.appendChild(el('p', '', m[2]));
    c.appendChild(el('code', '', code));
    app.appendChild(c);
    TG.ready();
  }

  // ------------------------------------------------------------------------------------------------ demo (generic, no one's data)
  var DEMO = {
    canvas: 'melvin-canvas/1', kind: 'demo', title: 'Canvas demo', accent: 'violet',
    blocks: [
      { type: 'hero', emoji: '✨', title: 'Melvin’s canvas', text: 'A demo of every building block. Nothing here is real and nothing is sent.' },
      { type: 'stats', items: [
        { label: 'Energy today', value: 14.2, unit: 'kWh', delta: '−8% vs avg', tone: 'good' },
        { label: 'Indoor', value: 70, unit: '°F', delta: 'steady', tone: 'neutral' },
        { label: 'Steps', value: 8412, delta: '+1.2k', tone: 'good' },
        { label: 'Open tasks', value: 3, delta: '1 due today', tone: 'warn' }] },
      { type: 'bars', title: 'Energy this week', unit: 'kWh', items: [
        { label: 'Mon', value: 12 }, { label: 'Tue', value: 15.5 }, { label: 'Wed', value: 11 }, { label: 'Thu', value: 18 },
        { label: 'Fri', value: 13.2 }, { label: 'Sat', value: 9.4 }, { label: 'Sun', value: 14.2 }] },
      { type: 'line', title: 'Temperature', unit: '°F', items: [
        { label: '6a', value: 61 }, { label: '8a', value: 63 }, { label: '10a', value: 67 }, { label: '12p', value: 71 },
        { label: '2p', value: 73 }, { label: '4p', value: 72 }, { label: '6p', value: 68 }, { label: '8p', value: 65 }] },
      { type: 'note', tone: 'info', text: 'On = do it. Off = leave it for later.' },
      { type: 'section', title: 'Ideas' },
      { type: 'toggle', id: 'a', label: 'Heads-up before deadlines', badge: '✓ I’d say yes', tone: 'good', value: true },
      { type: 'toggle', id: 'b', label: 'Morning note when a bill arrives', badge: '? your call', tone: 'warn', hint: 'reads one mailbox' },
      { type: 'toggle', id: 'c', label: 'Something that needs setup first', badge: '⏸ blocked', tone: 'neutral', hint: 'needs a sign-in', disabled: true },
      { type: 'section', title: 'Checklist' },
      { type: 'check', id: 's1', label: 'Pack the cooler', value: true },
      { type: 'check', id: 's2', label: 'Charge the car', hint: 'by 9 PM' },
      { type: 'choice', id: 'when', label: 'When?', options: [{ value: 'sat', label: 'Saturday' }, { value: 'sun', label: 'Sunday' }, { value: 'both', label: 'Both' }], value: 'sat', style: 'segmented' },
      { type: 'choice', id: 'where', label: 'Where to?', style: 'list', value: 'lake', options: [
        { value: 'lake', label: 'The lake', hint: '35 min · sunny', emoji: '\u{0001F3D6}️' },
        { value: 'park', label: 'The big park', hint: '10 min · playground', emoji: '\u{0001F333}' },
        { value: 'home', label: 'Stay home', hint: 'movie + pizza', emoji: '\u{0001F3E0}' }] },
      { type: 'slider', id: 'temp', label: 'Thermostat', min: 64, max: 76, step: 1, value: 70, unit: '°F' },
      { type: 'input', id: 'note', label: 'Anything else?', placeholder: 'Optional', max: 200, multiline: true },
      { type: 'card', emoji: '\u{0001F37D}️', title: 'Dinner idea', meta: '25 min', text: 'Sheet-pan chicken with lemon and potatoes.\n+ one pan\n− needs the oven at 425°', badge: 'My pick', tone: 'good' },
      { type: 'list', title: 'Today', items: [
        { title: 'School pickup', meta: '3:10 PM', emoji: '\u{0001F68C}' },
        { title: 'Trash night', text: 'Bins to the curb', meta: '8 PM', emoji: '\u{0001F5D1}️' }] }
    ],
    actions: [{ id: 'save', label: 'Save', style: 'primary', confirm: true }, { id: 'cancel', label: 'Cancel', style: 'ghost' }]
  };
  // ------------------------------------------------------------------------------------------------ boot
  function boot() {
    applyTheme();
    TG.on('theme_changed', applyTheme);
    TG.on('viewport_changed', function (d) {
      if (d && typeof d.height === 'number' && d.height > 0) { doc.documentElement.style.setProperty('--tg-vh', d.height + 'px'); }
    });
    TG.on('safe_area_changed', function (d) { insets('--tg-safe-', d); });
    TG.on('content_safe_area_changed', function (d) { if (d && typeof d.top === 'number') { doc.documentElement.style.setProperty('--tg-content-top', d.top + 'px'); } });
    app.appendChild(el('div', 'loader'));
    TG.expand();
    TG.disableVerticalSwipes();
    TG.requestSafeArea();
    TG.requestViewport();
    loadSpec(TG.token).then(function (r) {
      S.spec = r.spec;
      S.nonce = r.nonce;
      S.fields = (r.spec.blocks || []).filter(function (b) {
        return b && INPUT_TYPES.indexOf(b.type) >= 0 && typeof b.id === 'string' && /^[a-z][a-z0-9_]{0,23}$/.test(b.id);
      });
      S.fields.forEach(function (b) { S.initial[b.id] = initialValue(b); });
      S.answers = JSON.parse(JSON.stringify(S.initial));
      restoreDraft();
      applyTheme();
      doc.title = str(r.spec.title, 80) || 'Melvin';
      render(r.spec);
      TG.ready();
    }).catch(function (e) {
      fail(e && e.message ? e.message : 'bad_spec');
    });
    var rt = null;
    window.addEventListener('resize', function () {
      clearTimeout(rt);
      rt = setTimeout(function () {
        if (Math.abs(app.clientWidth - S.width) > 8) {
          S.width = app.clientWidth;
          S.charts.forEach(function (draw) { draw(false); });
        }
      }, 160);
    });
  }

  boot();
})();
