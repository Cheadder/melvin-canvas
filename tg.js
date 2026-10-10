/* Melvin canvas: a tiny Telegram Mini App bridge (no third-party script).
 *
 * Speaks Telegram's documented Mini App event protocol (core.telegram.org/api/web-events) directly:
 *   page -> client: TelegramWebviewProxy.postEvent(type, JSON) (iOS/Android/Desktop), external.notify (legacy),
 *                   parent.postMessage (web clients);
 *   client -> page: window.Telegram.WebView.receiveEvent(type, data) (+ postMessage for web clients).
 * Launch parameters (tgWebAppVersion, tgWebAppPlatform, tgWebAppThemeParams, ...) arrive in the URL fragment next to
 * the canvas token; they are cached in sessionStorage because a reload may lose the fragment.
 * Version gates follow the Bot API Mini App docs (main button 6.0, haptics 6.1, closing confirmation 6.2, header
 * colour 6.9, bottom bar colour and button shine 7.10, vertical swipes 7.7, fullscreen and safe areas 8.0).
 */
(function () {
  'use strict';
  var w = window;
  var CACHE = 'melvin-canvas:launch';
  var TOKEN_RE = /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/;
  var handlers = {};

  function store(key, value) {
    try {
      if (value === undefined) { return w.sessionStorage.getItem(key); }
      w.sessionStorage.setItem(key, value);
    } catch (e) { /* private mode / blocked storage: fine */ }
    return null;
  }

  function decodePart(s) {
    try { return decodeURIComponent(String(s).replace(/\+/g, '%20')); } catch (e) { return String(s); }
  }

  // '#v1.<nonce>.<payload>?tgWebAppData=&tgWebAppVersion=8.0&...' (any order; '?', '&' or a second '#' separated:
  // clients differ in how they append their launch parameters to a URL that already has a fragment)
  function parseLaunch() {
    var hash = (w.location.hash || '').replace(/^#/, '');
    var out = { token: null, params: {} };
    hash.split(/[?&#]/).forEach(function (part) {
      if (!part) { return; }
      if (TOKEN_RE.test(part)) { out.token = part; return; }
      if (part === 'demo') { out.token = 'demo'; return; }
      var eq = part.indexOf('=');
      if (eq > 0) { out.params[decodePart(part.slice(0, eq))] = decodePart(part.slice(eq + 1)); }
    });
    var cached = null;
    try { cached = JSON.parse(store(CACHE) || 'null'); } catch (e) { cached = null; }
    var hasParams = Object.keys(out.params).length > 0;
    if (out.token || hasParams) {
      if (!out.token && cached && cached.token) { out.token = cached.token; }
      if (!hasParams && cached && cached.params) { out.params = cached.params; }
      store(CACHE, JSON.stringify(out));
    } else if (cached) {
      out = cached;
    }
    out.params = out.params || {};
    return out;
  }

  var launch = parseLaunch();
  var P = launch.params;
  var theme = {};
  try { theme = P.tgWebAppThemeParams ? JSON.parse(P.tgWebAppThemeParams) : {}; } catch (e) { theme = {}; }
  var version = String(P.tgWebAppVersion || '6.0');
  var isIframe = false;
  try { isIframe = w.parent != null && w !== w.parent; } catch (e) { isIframe = true; }
  var inTelegram = !!(w.TelegramWebviewProxy || (w.external && 'notify' in w.external) ||
    (isIframe && P.tgWebAppVersion) || P.tgWebAppVersion);

  function atLeast(v) {
    var a = version.split('.'), b = String(v).split('.');
    for (var i = 0; i < Math.max(a.length, b.length); i++) {
      var x = parseInt(a[i] || '0', 10) || 0, y = parseInt(b[i] || '0', 10) || 0;
      if (x !== y) { return x > y; }
    }
    return true;
  }

  function post(type, data) {
    if (data === undefined) { data = ''; }
    try {
      if (w.TelegramWebviewProxy !== undefined) {
        w.TelegramWebviewProxy.postEvent(type, JSON.stringify(data));
      } else if (w.external && 'notify' in w.external) {
        w.external.notify(JSON.stringify({ eventType: type, eventData: data }));
      } else if (isIframe) {
        w.parent.postMessage(JSON.stringify({ eventType: type, eventData: data }), 'https://web.telegram.org');
      } else {
        return false;
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  function receive(type, data) {
    if (type === 'theme_changed' && data && data.theme_params) { theme = data.theme_params; }
    (handlers[type] || []).slice().forEach(function (fn) {
      try { fn(data || {}); } catch (e) { /* one bad listener never breaks the rest */ }
    });
  }

  w.Telegram = w.Telegram || {};
  if (!w.Telegram.WebApp) {                      // never fight an official script if one is ever added
    w.Telegram.WebView = w.Telegram.WebView || {};
    w.Telegram.WebView.receiveEvent = receive;
    w.TelegramGameProxy_receiveEvent = receive;
    w.TelegramGameProxy = { receiveEvent: receive };
  }
  if (isIframe) {
    w.addEventListener('message', function (ev) {
      if (ev.source !== w.parent) { return; }
      var msg = null;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg && msg.eventType) { receive(msg.eventType, msg.eventData); }
    });
  }

  function haptic(kind, style) {
    if (!inTelegram || !atLeast('6.1')) {
      if (kind === 'impact' && w.navigator && w.navigator.vibrate) { try { w.navigator.vibrate(8); } catch (e) { /* */ } }
      return;
    }
    if (kind === 'impact') { post('web_app_trigger_haptic_feedback', { type: 'impact', impact_style: style || 'light' }); }
    else if (kind === 'notification') { post('web_app_trigger_haptic_feedback', { type: 'notification', notification_type: style || 'success' }); }
    else { post('web_app_trigger_haptic_feedback', { type: 'selection_change' }); }
  }

  w.MelvinTG = {
    token: launch.token,
    params: P,
    version: version,
    platform: String(P.tgWebAppPlatform || 'unknown'),
    inTelegram: inTelegram,
    // keyboard-button launches carry no signed initData; inline/menu launches do (sendData only works for the former)
    keyboardLaunch: inTelegram && !P.tgWebAppData,
    theme: function () { return theme; },
    atLeast: atLeast,
    on: function (type, fn) { (handlers[type] = handlers[type] || []).push(fn); },
    post: post,
    ready: function () { post('web_app_ready'); },
    expand: function () { post('web_app_expand'); },
    requestTheme: function () { post('web_app_request_theme'); },
    requestViewport: function () { post('web_app_request_viewport'); },
    requestSafeArea: function () {
      if (atLeast('8.0')) { post('web_app_request_safe_area'); post('web_app_request_content_safe_area'); }
    },
    requestFullscreen: function () { if (atLeast('8.0')) { post('web_app_request_fullscreen'); } },
    disableVerticalSwipes: function () {
      if (atLeast('7.7')) { post('web_app_setup_swipe_behavior', { allow_vertical_swipe: false }); }
    },
    closingConfirmation: function (on) {
      if (atLeast('6.2')) { post('web_app_setup_closing_behavior', { need_confirmation: !!on }); }
    },
    colors: function (hex) {
      if (!/^#[0-9a-f]{6}$/i.test(hex || '')) { return; }
      if (atLeast('6.1')) { post('web_app_set_background_color', { color: hex }); }
      if (atLeast('6.9')) { post('web_app_set_header_color', { color: hex }); }
      if (atLeast('7.10')) { post('web_app_set_bottom_bar_color', { color: hex }); }
    },
    haptic: haptic,
    // Telegram's own bottom button (Bot API 6.0+): {visible, text, active, progress, color, textColor, shine};
    // its taps arrive as the 'main_button_pressed' event. false = not in Telegram (the page shows its own button).
    mainButton: function (o) {
      if (!inTelegram) { return false; }
      o = o || {};
      var p = { is_visible: !!o.visible, is_active: o.active !== false, is_progress_visible: !!o.progress,
        text: String(o.text || 'OK').slice(0, 64) };
      if (/^#[0-9a-f]{6}$/i.test(o.color || '')) { p.color = o.color; }
      if (/^#[0-9a-f]{6}$/i.test(o.textColor || '')) { p.text_color = o.textColor; }
      if (o.shine && atLeast('7.10')) { p.has_shine_effect = true; }
      return post('web_app_setup_main_button', p);
    },
    sendData: function (text) { return post('web_app_data_send', { data: String(text) }); },
    close: function () { return post('web_app_close', { return_back: false }); }
  };
})();
