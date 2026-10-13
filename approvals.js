/* Questions page: renders one "melvin-approvals/1" page from the URL fragment (pending yes/no questions), one tap per
 * question, and sends every answer back in ONE WebApp.sendData call: {"v":1,"nonce","act":"send","data":{"q1":"yes"}}.
 *
 * Privacy: the content lives only in the fragment (#v1.<nonce>.<deflate-raw, base64url>), which browsers never send
 * to the web host. This file holds no data of anyone's. Text is always set with textContent (never innerHTML); there
 * are no links, fonts or requests to anywhere (see the CSP in approvals.html). Needs tg.js (the Telegram bridge).
 */
(function () {
  'use strict';
  var TG = window.MelvinTG;
  var doc = document;
  var app = doc.getElementById('app');
  var bar = doc.getElementById('bar');
  var SCHEMA = 'melvin-approvals/1';
  var TOKEN_RE = /^v1\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]+)$/;
  var QID_RE = /^q[1-9]$/;
  var VAL_RE = /^[a-z][a-z0-9_]{0,23}$/;
  var GOOD = /^(yes|ok|okay|approve|allow|go|send|sure|do_it|accept)/;
  var BAD = /^(no|deny|decline|stop|skip|not_|don_t|never|reject)/;
  var S = { page: null, nonce: null, answers: {}, busy: false, nodes: {} };

  // ------------------------------------------------------------------------------------------------ helpers
  function el(tag, cls, text) {
    var e = doc.createElement(tag);
    if (cls) { e.className = cls; }
    if (text !== undefined && text !== null && text !== '') { e.textContent = String(text); }
    return e;
  }
  function str(v, max) {
    if (v === undefined || v === null) { return ''; }
    v = String(v);
    return max && v.length > max ? v.slice(0, max) : v;
  }
  function session(key, value) {
    try {
      if (value === undefined) { return window.sessionStorage.getItem(key); }
      if (value === null) { window.sessionStorage.removeItem(key); } else { window.sessionStorage.setItem(key, value); }
    } catch (e) { /* storage blocked: drafts are a convenience only */ }
    return null;
  }
  function tone(value) { return GOOD.test(value) ? 'good' : (BAD.test(value) ? 'bad' : 'pick'); }
  function hue(name) {
    var h = 0, s = String(name || '');
    for (var i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) % 360; }
    return h;
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
  function clean(page) {
    if (!page || page.canvas !== SCHEMA || !Array.isArray(page.q) || page.q.length < 1) { throw new Error('bad_page'); }
    var seen = {};
    var qs = page.q.slice(0, 8).map(function (q) {
      if (!q || !QID_RE.test(q.id) || seen[q.id] || typeof q.q !== 'string' || !Array.isArray(q.o)) { throw new Error('bad_page'); }
      seen[q.id] = true;
      var vals = {};
      var opts = q.o.slice(0, 4).map(function (o) {
        if (!Array.isArray(o) || !VAL_RE.test(o[0]) || vals[o[0]] || typeof o[1] !== 'string') { throw new Error('bad_page'); }
        vals[o[0]] = true;
        return { value: o[0], label: str(o[1], 24) };
      });
      if (opts.length < 2) { throw new Error('bad_page'); }
      return { id: q.id, asker: str(q.a, 24) || 'Someone', time: str(q.t, 24), question: str(q.q, 300),
        detail: str(q.d, 400), urgent: !!q.u, options: opts,
        textMax: Number.isInteger(q.m) && q.m > 0 && q.m <= 300 ? q.m : 0 };
    });
    return { title: str(page.title, 80) || 'Questions for you', sub: str(page.sub, 160), questions: qs,
      answerBudget: Number.isInteger(page.answer_budget_bytes) && page.answer_budget_bytes > 0 && page.answer_budget_bytes <= 3800 ? page.answer_budget_bytes : null };
  }
  function load(token) {
    if (token === 'demo') { return Promise.resolve({ nonce: null, page: clean(DEMO) }); }
    var m = TOKEN_RE.exec(token || '');
    if (!m) { return Promise.reject(new Error('no_token')); }
    var bytes;
    try { bytes = bytesFromB64url(m[2]); } catch (e) { return Promise.reject(new Error('bad_page')); }
    return inflate(bytes).then(function (text) {
      return { nonce: m[1], page: clean(JSON.parse(text)) };
    }, function (e) { throw new Error(e && e.message === 'no_decompression' ? 'no_decompression' : 'bad_page'); });
  }

  // ------------------------------------------------------------------------------------------------ answers
  function answeredCount() {
    return S.page.questions.filter(function (q) { return !!S.answers[q.id] || !!String(S.answers[q.id + '_text'] || '').trim(); }).length;
  }
  function saveDraft() {
    if (S.nonce) { session('melvin-approvals:a:' + S.nonce, JSON.stringify(S.answers)); }
    TG.closingConfirmation(answeredCount() > 0);
  }
  function restoreDraft() {
    if (!S.nonce) { return; }
    try {
      var d = JSON.parse(session('melvin-approvals:a:' + S.nonce) || 'null');
      if (!d) { return; }
      S.page.questions.forEach(function (q) {
        if (q.options.some(function (o) { return o.value === d[q.id]; })) { S.answers[q.id] = d[q.id]; }
        var text = d[q.id + '_text'];
        if (q.textMax && typeof text === 'string' && text.length <= q.textMax) { S.answers[q.id + '_text'] = text; }
      });
    } catch (e) { /* a broken draft is ignored */ }
  }
  function pick(q, value) {
    if (S.busy) { return; }
    S.answers[q.id] = S.answers[q.id] === value ? null : value;     // tapping the chosen answer again clears it
    if (!S.answers[q.id]) { delete S.answers[q.id]; }
    paint(q);
    paintBar();
    saveDraft();
    TG.haptic('selection');
  }
  function paint(q) {
    var n = S.nodes[q.id];
    if (!n) { return; }
    var v = S.answers[q.id];
    var hasText = !!String(S.answers[q.id + '_text'] || '').trim();
    n.card.classList.toggle('answered', !!v || hasText);
    n.card.classList.remove('tone-good', 'tone-bad', 'tone-pick');
    if (hasText) { n.card.classList.add('tone-pick'); }
    else if (v) { n.card.classList.add('tone-' + tone(v)); }
    n.buttons.forEach(function (b) { b.setAttribute('aria-checked', String(b.getAttribute('data-v') === v)); });
  }

  // ------------------------------------------------------------------------------------------------ page
  function tick() {
    var NS = 'http://www.w3.org/2000/svg';
    var s = doc.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 16 16');
    s.setAttribute('aria-hidden', 'true');
    var p = doc.createElementNS(NS, 'path');
    p.setAttribute('d', 'M3 8.6l3.1 3.1L13 4.9');
    s.appendChild(p);
    var t = el('span', 'tick');
    t.appendChild(s);
    return t;
  }
  function card(q, k) {
    var c = el('article', 'q rise');
    c.style.setProperty('--i', String(k + 1));
    var who = el('div', 'who');
    var av = el('span', 'avatar', q.asker.charAt(0).toUpperCase());
    av.style.setProperty('--h', String(hue(q.asker)));
    who.appendChild(av);
    var name = el('span', 'name', q.asker);
    name.appendChild(el('span', 'asks', ' asks'));
    who.appendChild(name);
    if (q.urgent) { who.appendChild(el('span', 'urgent', 'Urgent')); }
    if (q.time) { who.appendChild(el('span', 'time', q.time)); }
    c.appendChild(who);
    c.appendChild(el('h2', '', q.question));
    if (q.detail) { c.appendChild(el('p', 'detail', q.detail)); }
    var two = q.options.length === 2 && q.options.every(function (o) { return o.label.length <= 12; });
    var grid = el('div', 'opts' + (two ? ' two' : ''));
    grid.setAttribute('role', 'radiogroup');
    grid.setAttribute('aria-label', q.question);
    var buttons = [];
    q.options.forEach(function (o) {
      var b = el('button', 'opt tone-' + tone(o.value));
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('data-v', o.value);
      b.appendChild(tick());
      b.appendChild(el('span', '', o.label));
      b.addEventListener('click', function () { pick(q, o.value); });
      buttons.push(b);
      grid.appendChild(b);
    });
    c.appendChild(grid);
    if (q.textMax) {
      var label = el('label', 'custom-label', 'Your answer or clarification');
      var input = el('textarea', 'custom-answer');
      input.id = q.id + '_text';
      label.setAttribute('for', input.id);
      input.maxLength = q.textMax;
      input.rows = 2;
      input.placeholder = 'Optional. Typed clarification does not grant permission.';
      input.value = S.answers[input.id] || '';
      input.addEventListener('input', function () {
        S.answers[input.id] = input.value;
        paint(q); paintBar(); saveDraft();
      });
      c.appendChild(label); c.appendChild(input);
    }
    S.nodes[q.id] = { card: c, buttons: buttons };
    return c;
  }
  function render() {
    app.textContent = '';
    S.nodes = {};
    var P = S.page;
    if (!TG.inTelegram) { app.appendChild(el('div', 'preview', S.nonce ? 'Preview · open it from Telegram to send' : 'Demo · nothing is sent')); }
    var head = el('header', 'head rise');
    var eb = el('span', 'eyebrow');
    eb.appendChild(el('span', 'dot'));
    eb.appendChild(doc.createTextNode(P.questions.length === 1 ? '1 question' : P.questions.length + ' questions'));
    head.appendChild(eb);
    head.appendChild(el('h1', '', P.title));
    if (P.sub) { head.appendChild(el('p', '', P.sub)); }
    app.appendChild(head);
    P.questions.forEach(function (q, k) { app.appendChild(card(q, k)); paint(q); });
    if (P.questions.length > 1) { app.appendChild(el('p', 'foot', 'Anything you leave blank keeps waiting.')); }
    renderBar();
  }
  var sendBtn = null, stateLine = null;
  function renderBar() {
    bar.textContent = '';
    var inner = el('div', 'inner');
    stateLine = el('div', 'state');
    sendBtn = el('button', 'send');
    sendBtn.type = 'button';
    sendBtn.addEventListener('click', send);
    inner.appendChild(stateLine);
    inner.appendChild(sendBtn);
    bar.appendChild(inner);
    bar.hidden = false;
    paintBar();
  }
  function paintBar() {
    if (!sendBtn || S.busy) { return; }
    var total = S.page.questions.length, k = answeredCount();
    if (total === 1) {
      var q = S.page.questions[0], v = S.answers[q.id];
      var o = q.options.filter(function (x) { return x.value === v; })[0];
      var hasText = !!String(S.answers[q.id + '_text'] || '').trim();
      sendBtn.textContent = hasText ? 'Send clarification' : (o ? 'Send: ' + o.label : 'Choose or type an answer');
      stateLine.textContent = hasText ? 'Clarification is recorded without granting permission.' : (o ? 'Melvin records your selected answer.' : '');
    } else {
      sendBtn.textContent = k ? 'Send ' + k + (k === 1 ? ' answer' : ' answers') : 'Pick your answers';
      stateLine.textContent = k === 0 ? '' : (k === total ? 'All ' + total + ' answered.' : (total - k) + ' left blank — ' + (total - k === 1 ? 'it keeps' : 'they keep') + ' waiting.');
    }
    if (S.page.answerBudget) {
      var used = utf8Bytes(JSON.stringify(answerData())), left = S.page.answerBudget - used;
      stateLine.textContent += (stateLine.textContent ? ' ' : '') + (left >= 0 ? left + ' bytes left in total.' :
        'Shorten by at least ' + (-left) + ' bytes. Your text is kept.');
    }
    sendBtn.disabled = k === 0;
  }

  function utf8Bytes(text) {
    return window.TextEncoder ? new TextEncoder().encode(text).length : unescape(encodeURIComponent(text)).length;
  }
  function answerData() {
    var data = {};
    S.page.questions.forEach(function (q) {
      data[q.id] = S.answers[q.id] || null;
      if (q.textMax) { data[q.id + '_text'] = typeof S.answers[q.id + '_text'] === 'string' ? S.answers[q.id + '_text'] : ''; }
    });
    return data;
  }

  function send() {
    if (S.busy || answeredCount() === 0) { return; }
    var data = answerData();
    var payload = JSON.stringify({ v: 1, nonce: S.nonce || 'demo-demo-demo-1', act: 'send', data: data });
    if (S.page.answerBudget && utf8Bytes(JSON.stringify(data)) > S.page.answerBudget) {
      toast('That is too much to send at once. Shorten your answers; your draft is kept.'); return;
    }
    if (utf8Bytes(payload) > 4096) { toast('That is too much to send at once. Shorten your answers; your draft is kept.'); return; }
    S.busy = true;
    TG.haptic('impact', 'medium');
    var label = sendBtn.textContent;
    sendBtn.disabled = true;
    sendBtn.textContent = '';
    sendBtn.appendChild(el('span', 'spin'));
    TG.closingConfirmation(false);
    setTimeout(function () {
      var posted = TG.inTelegram && S.nonce ? TG.sendData(payload) : false;
      if (!posted) { showPayload(payload); reset(); return; }
      // Keep the draft until the server acknowledgement closes the app. A
      // local sendData acceptance is not proof that the answer was recorded.
      sendBtn.textContent = '✓ Sent';
      TG.haptic('notification', 'success');
      // the Mini App closes itself after sendData; still here means this launch mode cannot send
      setTimeout(function () {
        TG.haptic('notification', 'error');
        toast('This page couldn’t send from here. Tell Melvin in chat instead.');
        reset();
      }, 2500);
    }, 260);
    function reset() { S.busy = false; sendBtn.textContent = label; paintBar(); }
  }

  function showPayload(payload) {
    var scrim = el('div', 'scrim'), sheet = el('div', 'sheet');
    sheet.appendChild(el('h2', '', S.nonce ? 'Open this from Telegram to send' : 'Demo: this is what would go back'));
    sheet.appendChild(el('p', '', 'Telegram carries it back to Melvin. Nothing is sent from a browser.'));
    var pre = el('pre');
    try { pre.textContent = JSON.stringify(JSON.parse(payload), null, 2); } catch (e) { pre.textContent = payload; }
    sheet.appendChild(pre);
    var ok = el('button', 'send', 'OK');
    ok.type = 'button';
    sheet.appendChild(ok);
    doc.body.appendChild(scrim);
    doc.body.appendChild(sheet);
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
      no_token: ['\u{0001F9E9}', 'This page arrived empty', 'Telegram didn’t pass its contents along. Ask Melvin to send the questions again, or answer him in chat.'],
      no_decompression: ['\u{0001F4F1}', 'Telegram needs an update', 'This phone can’t unpack the page. Update Telegram (or iOS), or answer Melvin in chat.'],
      bad_page: ['\u{0001F9E9}', 'This page didn’t load', 'Ask Melvin to send the questions again, or answer him in chat.']
    };
    var m = M[code] || M.bad_page;
    app.textContent = '';
    bar.hidden = true;
    var c = el('section', 'q state-card rise');
    c.appendChild(el('div', 'big', m[0]));
    c.appendChild(el('h1', '', m[1]));
    c.appendChild(el('p', '', m[2]));
    c.appendChild(el('code', '', code));
    app.appendChild(c);
    TG.ready();
  }

  // ------------------------------------------------------------------------------------------------ demo (no one's data)
  var DEMO = {
    canvas: SCHEMA, title: 'Questions for you', sub: 'From Helper and Builder. Tap an answer for each, then Send. Anything left blank keeps waiting.',
    q: [
      { id: 'q1', a: 'Helper', t: '10:20 AM', q: 'May the helper try the new voice for a day?', d: 'It sounds warmer. You can switch back any time.', o: [['yes', 'Yes'], ['no', 'No']] },
      { id: 'q2', a: 'Builder', t: '10:24 AM', q: 'Which look for the wall screen?', o: [['calm', 'Calm'], ['bright', 'Bright'], ['later', 'Ask me later']] }
    ]
  };

  // ------------------------------------------------------------------------------------------------ boot
  function boot() {
    TG.colors('#0a0c16');
    TG.on('safe_area_changed', function (d) { insets('--tg-safe-', d); });
    TG.on('content_safe_area_changed', function (d) { if (d && typeof d.top === 'number') { doc.documentElement.style.setProperty('--tg-content-top', d.top + 'px'); } });
    TG.expand();
    TG.disableVerticalSwipes();
    TG.requestSafeArea();
    load(TG.token).then(function (r) {
      S.page = r.page;
      S.nonce = r.nonce;
      restoreDraft();
      doc.title = S.page.title;
      render();
      TG.ready();
    }).catch(function (e) {
      fail(e && e.message ? e.message : 'bad_page');
    });
  }

  boot();
})();
