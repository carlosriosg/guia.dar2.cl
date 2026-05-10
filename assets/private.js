// private.js — Acceso privado: login + visor de canales M3U + admin panel.
//
// Sistema de auth: tokens HMAC firmados (proxy.php los emite tras POST a
// ?action=login). El sitio público no contiene URLs de las listas: viajan
// solo después de auth válida. Streams pasan por proxy.php?action=stream
// para resolver mixed content (HTTP→HTTPS).
//
// Storage:
//   sessionStorage:
//     guia_private_token  → JWT-like token (8h)
//     guia_private_user   → {username, name, role}
//   localStorage:
//     guia_priv_favs_<USER> → array de canales favoritos por user
//
// Expone window.openPrivateAccess() y window.hasPrivateSession().
(function () {
  'use strict';

  const TOKEN_KEY = 'guia_private_token';
  const USER_KEY  = 'guia_private_user';
  const PROXY = './proxy.php';
  const FAVS_KEY = (u) => 'guia_priv_favs_' + (u || 'anon');

  // ─── Estado del módulo ──────────────────────────────────────────────────
  const pstate = {
    user: null,
    lists: [],
    activeListId: null,    // 'favorites' es un valor especial
    channelsByList: {},
    query: '',
    view: 'viewer',        // 'viewer' | 'admin'
    adminTab: 'users',     // 'users' | 'lists'
  };

  // ─── Auth helpers ───────────────────────────────────────────────────────
  function getToken() { return sessionStorage.getItem(TOKEN_KEY); }
  function setSession(token, user) {
    sessionStorage.setItem(TOKEN_KEY, token);
    sessionStorage.setItem(USER_KEY, JSON.stringify(user));
    pstate.user = user;
    updateQuickButton();
  }
  function loadSession() {
    const token = sessionStorage.getItem(TOKEN_KEY);
    const userJson = sessionStorage.getItem(USER_KEY);
    if (token && userJson) {
      try { pstate.user = JSON.parse(userJson); updateQuickButton(); return true; } catch {}
    }
    return false;
  }
  function clearAuth() {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(USER_KEY);
    pstate.user = null;
    pstate.lists = [];
    pstate.channelsByList = {};
    updateQuickButton();
  }
  // Marca el botón ".tv-private-quick" con clase 'active' si hay sesión.
  function updateQuickButton() {
    const b = document.querySelector('.tv-private-quick');
    if (b) b.classList.toggle('active', !!sessionStorage.getItem(TOKEN_KEY));
  }
  window.hasPrivateSession = () => !!sessionStorage.getItem(TOKEN_KEY);

  async function loginRequest(username, password) {
    const r = await fetch(PROXY + '?action=login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error || 'Login failed (HTTP ' + r.status + ')');
    }
    return r.json();
  }

  async function authedFetch(url, opts) {
    const token = getToken();
    if (!token) throw new Error('No token');
    const sep = url.includes('?') ? '&' : '?';
    const r = await fetch(url + sep + 'token=' + encodeURIComponent(token), opts);
    if (r.status === 401) {
      clearAuth();
      throw new Error('Unauthorized — token expirado o inválido');
    }
    return r;
  }

  // ─── Utils ──────────────────────────────────────────────────────────────
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]
    ));
  }
  function escapeAttr(s) { return escapeHtml(s); }
  function $$(sel, root) { return (root || document).querySelector(sel); }
  function hashHue(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h % 360;
  }
  // Codifica string a base64url (RFC 4648 §5) — soporta UTF-8.
  function b64urlEncode(s) {
    const utf8 = new TextEncoder().encode(s);
    let bin = '';
    for (let i = 0; i < utf8.length; i++) bin += String.fromCharCode(utf8[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  // Genera un archivo .m3u a partir de un array de canales y dispara la
  // descarga. Cuando el user abre el .m3u con doble click, Windows/Mac/Linux
  // se lo entrega a VLC (típica asociación). Esto sortea el problema del
  // protocolo vlc:// que muchos browsers bloquean.
  function downloadM3u(channels, filename) {
    let content = '#EXTM3U\n';
    channels.forEach(ch => {
      let attrs = '';
      if (ch.tvgId)   attrs += ` tvg-id="${(ch.tvgId).replace(/"/g,'')}"`;
      if (ch.tvgName) attrs += ` tvg-name="${(ch.tvgName).replace(/"/g,'')}"`;
      if (ch.logo)    attrs += ` tvg-logo="${(ch.logo).replace(/"/g,'')}"`;
      if (ch.group)   attrs += ` group-title="${(ch.group).replace(/"/g,'')}"`;
      content += `#EXTINF:-1${attrs},${ch.name}\n${ch.url}\n`;
    });
    triggerDownload(content, filename || 'lista.m3u', 'application/vnd.apple.mpegurl');
  }
  function downloadJson(data, filename) {
    triggerDownload(JSON.stringify(data, null, 2), filename, 'application/json');
  }
  // XSPF (XML Shareable Playlist Format) — usado en Mac porque .m3u allí
  // se asocia con Music.app por default, no con VLC. .xspf es un formato
  // que solo VLC maneja, así que doble click → VLC sin importar config.
  function downloadXspf(channels, filename) {
    const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const tracks = channels.map(c => {
      let xt = '  <track>\n';
      xt += '    <title>' + esc(c.name || 'Sin nombre') + '</title>\n';
      xt += '    <location>' + esc(c.url || '') + '</location>\n';
      if (c.logo) xt += '    <image>' + esc(c.logo) + '</image>\n';
      if (c.group) xt += '    <annotation>' + esc(c.group) + '</annotation>\n';
      xt += '  </track>';
      return xt;
    }).join('\n');
    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<playlist version="1" xmlns="http://xspf.org/ns/0/">\n' +
      '  <trackList>\n' + tracks + '\n  </trackList>\n' +
      '</playlist>\n';
    triggerDownload(xml, filename, 'application/xspf+xml');
  }
  function triggerDownload(content, filename, mime) {
    const blob = new Blob([content], { type: mime + ';charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 200);
  }
  // Detección de plataforma — exportada para reuso en el dialog de help.
  function getOS() {
    const ua = navigator.userAgent;
    const isIOS = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
    const isAndroid = /Android/.test(ua);
    const isMac = /Macintosh|Mac OS X/.test(ua) && !isIOS;
    const isWin = /Windows/.test(ua);
    const isMobile = isIOS || isAndroid;
    return { isIOS, isAndroid, isMac, isWin, isMobile, ua };
  }

  // Toast notification — popup transitorio en la parte inferior. Util para
  // confirmar acciones (descarga lista) sin abrir un dialog.
  function showToast(msg, duration) {
    let toast = document.getElementById('priv-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'priv-toast';
      toast.className = 'priv-toast';
      document.body.appendChild(toast);
    }
    toast.innerHTML = msg;
    toast.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => toast.classList.remove('show'), duration || 5500);
  }

  // Estrategia unificada por OS:
  //   • iOS:     vlc-x-callback://x-callback-url/stream?url=URL
  //   • Android: intent: URL con package=org.videolan.vlc — más confiable
  //              que vlc:// porque Android usa Intent system, y especifica
  //              el package fuerza que abra VLC (no otra app de video)
  //   • Windows: vlc:b64,BASE64URL — bug de URL anidada
  //   • Mac/Linux: vlc://URL directo
  // Dispara el handler de VLC + muestra toast "Abriendo..." con fallback de
  // descarga por si no abre. El user no tiene que buscar otro botón.
  function openInVlc(streamUrl, channelName) {
    const { isIOS, isAndroid, isMac, isWin } = getOS();
    // Mac: vlc:// NO está registrado confiablemente (bug de VLC para Mac
    // en muchas versiones, incluyendo 3.x). Saltamos directo a descargar
    // .xspf — el user hace UN click sobre el archivo descargado y VLC abre.
    // Si activa "Always open" de Chrome, las siguientes son automáticas.
    if (isMac) {
      const safe = (channelName || 'canal').replace(/[^\w\-]+/g, '_').slice(0, 40) || 'canal';
      const filename = safe + '.xspf';
      downloadXspf([{ name: channelName || 'Canal', url: streamUrl }], filename);
      showToast(
        '📥 <strong>' + filename + '</strong> descargado' +
        '<div class="priv-toast-tip">' +
          '👇 <strong>1 click sobre el archivo</strong> en la barra inferior y VLC abre. ' +
          '<button class="priv-toast-link" id="priv-toast-help-mac">¿Auto cada vez?</button>' +
        '</div>',
        9000
      );
      setTimeout(() => {
        const lnk = document.getElementById('priv-toast-help-mac');
        if (lnk) lnk.onclick = () => dlgVlcHelp();
      }, 50);
      return;
    }
    let scheme;
    if (isIOS) {
      scheme = 'vlc-x-callback://x-callback-url/stream?url=' + encodeURIComponent(streamUrl);
    } else if (isAndroid) {
      // Intent URL con action=VIEW explícito y package=org.videolan.vlc.
      // Sin fallback URL para evitar que Android lleve al Play Store cuando
      // VLC sí está instalado (caso reportado por Carlos).
      const cleanUrl = streamUrl.replace(/^https?:\/\//, '');
      const proto = streamUrl.startsWith('https') ? 'https' : 'http';
      scheme = 'intent://' + cleanUrl +
               '#Intent' +
               ';action=android.intent.action.VIEW' +
               ';scheme=' + proto +
               ';package=org.videolan.vlc' +
               ';end';
    } else if (isWin) {
      scheme = 'vlc:b64,' + b64urlEncode(streamUrl);
    } else {
      scheme = 'vlc://' + streamUrl;
    }
    const a = document.createElement('a');
    a.href = scheme;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => a.remove(), 100);

    // Toast con fallback: si VLC no abrió (no instalado / handler roto),
    // el user click "Descargar archivo" y baja el .xspf como rescate.
    const safe = (channelName || 'canal').replace(/[^\w\-]+/g, '_').slice(0, 40) || 'canal';
    const fbId = 'priv-toast-fb-' + Date.now();
    showToast(
      '🎬 <strong>Abriendo VLC...</strong>' +
      '<div class="priv-toast-tip">' +
        '¿No se abrió? <button class="priv-toast-link" id="' + fbId + '">Descargar el archivo</button>' +
      '</div>',
      8000
    );
    setTimeout(() => {
      const btn = document.getElementById(fbId);
      if (btn) btn.onclick = () => {
        downloadXspf([{ name: channelName || 'Canal', url: streamUrl }], safe + '.xspf');
        showToast('📥 <strong>' + safe + '.xspf descargado</strong> — Doble click sobre el archivo para abrir VLC.', 6000);
      };
    }, 50);
  }

  function openListInVlc(channels, listId, displayName) {
    const { isIOS, isAndroid, isMac, isWin } = getOS();

    // Mac: descarga directa la lista entera como .xspf con todos los canales
    // dentro. Saltamos el vlc:// que no funciona en Mac.
    if (isMac) {
      const safe = (listId || displayName || 'lista').replace(/[^\w\-]+/g, '_').slice(0, 40);
      const filename = `${safe}-${new Date().toISOString().slice(0,10)}.xspf`;
      downloadXspf(channels, filename);
      showToast(
        '📥 <strong>' + filename + '</strong> · ' + channels.length + ' canales' +
        '<div class="priv-toast-tip">' +
          '👇 <strong>1 click sobre el archivo</strong> en la barra inferior y VLC abre con la lista. ' +
          '<button class="priv-toast-link" id="priv-toast-help-mac2">¿Auto cada vez?</button>' +
        '</div>',
        10000
      );
      setTimeout(() => {
        const lnk = document.getElementById('priv-toast-help-mac2');
        if (lnk) lnk.onclick = () => dlgVlcHelp();
      }, 50);
      return;
    }

    let url, name;
    if (listId && listId !== 'favorites') {
      const token = getToken();
      if (!token) return;
      url = location.origin + location.pathname.replace(/\/[^/]*$/, '/')
          + 'proxy.php?action=m3u_raw&id=' + encodeURIComponent(listId)
          + '&token=' + encodeURIComponent(token);
      name = displayName || 'lista';
    } else if (channels.length > 0) {
      url = channels[0].url;
      name = channels[0].name;
    } else {
      return;
    }

    // Disparar el handler (igual que openInVlc) — solo no-Mac llega acá
    let scheme;
    if (isIOS) {
      scheme = 'vlc-x-callback://x-callback-url/stream?url=' + encodeURIComponent(url);
    } else if (isAndroid) {
      const cleanUrl = url.replace(/^https?:\/\//, '');
      const proto = url.startsWith('https') ? 'https' : 'http';
      scheme = 'intent://' + cleanUrl + '#Intent;action=android.intent.action.VIEW;scheme=' + proto + ';package=org.videolan.vlc;end';
    } else if (isWin) {
      scheme = 'vlc:b64,' + b64urlEncode(url);
    } else {
      scheme = 'vlc://' + url;
    }
    const a = document.createElement('a');
    a.href = scheme;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => a.remove(), 100);

    // Toast con fallback: descarga la lista entera como .xspf si VLC no abre
    const safe = (listId || displayName || 'lista').replace(/[^\w\-]+/g, '_').slice(0, 40);
    const filename = `${safe}-${new Date().toISOString().slice(0,10)}.xspf`;
    const fbId = 'priv-toast-fb-' + Date.now();
    showToast(
      '🎬 <strong>Abriendo VLC...</strong> (' + channels.length + ' canales)' +
      '<div class="priv-toast-tip">' +
        '¿No se abrió? <button class="priv-toast-link" id="' + fbId + '">Descargar la lista</button>' +
      '</div>',
      8000
    );
    setTimeout(() => {
      const btn = document.getElementById(fbId);
      if (btn) btn.onclick = () => {
        downloadXspf(channels, filename);
        showToast('📥 <strong>' + filename + '</strong> descargado — Doble click para abrir en VLC.', 6000);
      };
    }, 50);
  }

  // ─── Favoritos ──────────────────────────────────────────────────────────
  // Se guardan completos (no solo IDs) para sobrevivir a cambios de URL en
  // las listas pirata: el ID viene del hash(name+url), si la URL cambia el
  // ID también. Para preservar favs, almacenamos {id,name,url,logo,group}.
  function loadFavs() {
    if (!pstate.user) return [];
    try { return JSON.parse(localStorage.getItem(FAVS_KEY(pstate.user.username)) || '[]'); }
    catch { return []; }
  }
  function saveFavs(favs) {
    if (!pstate.user) return;
    localStorage.setItem(FAVS_KEY(pstate.user.username), JSON.stringify(favs));
  }
  function isFav(channelId) {
    return loadFavs().some(f => f.id === channelId);
  }
  function toggleFav(ch) {
    const favs = loadFavs();
    const idx = favs.findIndex(f => f.id === ch.id);
    if (idx >= 0) favs.splice(idx, 1);
    else favs.push({ id: ch.id, name: ch.name, url: ch.url, logo: ch.logo, group: ch.group });
    saveFavs(favs);
  }

  // ─── Modal genérico ─────────────────────────────────────────────────────
  function openModal(html, onMount, opts) {
    const dlg = document.getElementById('dlg');
    const large = opts && opts.large;
    dlg.innerHTML = '<div class="body priv-modal' + (large ? ' priv-modal-large' : '') + '">' + html + '</div>';
    dlg.classList.add('priv-dialog');
    if (large) dlg.classList.add('priv-dialog-large');
    if (!dlg.open) dlg.showModal();
    if (onMount) onMount(dlg);
  }
  function closeModal() {
    const dlg = document.getElementById('dlg');
    dlg.classList.remove('priv-dialog', 'priv-dialog-large');
    try { dlg.close(); } catch {}
    dlg.innerHTML = '';
    document.removeEventListener('keydown', searchHotkey, { capture: true });
  }

  // ─── Login dialog ───────────────────────────────────────────────────────
  function dlgLogin(onSuccess) {
    openModal(`
      <div class="priv-login">
        <div class="priv-logo-mark">
          <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2"/>
            <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
          </svg>
        </div>
        <h2 class="priv-title">Acceso privado</h2>
        <p class="priv-sub">Ingresa tus credenciales para ver tus canales.</p>
        <form id="priv-login-form" class="priv-form">
          <label class="priv-field">
            <span>Usuario</span>
            <input id="pl-user" type="text" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" required>
          </label>
          <label class="priv-field">
            <span>Contraseña</span>
            <input id="pl-pass" type="password" autocomplete="current-password" required>
          </label>
          <div id="pl-err" class="priv-err" hidden></div>
          <div class="priv-actions">
            <button type="button" class="priv-btn ghost" id="pl-cancel">Cancelar</button>
            <button type="submit" class="priv-btn primary" id="pl-submit">
              <span class="priv-btn-label">Entrar</span>
              <span class="priv-spinner" hidden></span>
            </button>
          </div>
        </form>
        <button type="button" class="priv-restore-link" id="pl-restore">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:5px"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          Restaurar configuración desde archivo
        </button>
      </div>
    `, (root) => {
      $$('#pl-restore', root).onclick = () => {
        closeModal();
        dlgImport({ isBootstrap: true });
      };
      const form = $$('#priv-login-form', root);
      const errEl = $$('#pl-err', root);
      const submitBtn = $$('#pl-submit', root);
      const labelEl = $$('.priv-btn-label', submitBtn);
      const spinner = $$('.priv-spinner', submitBtn);
      const userInput = $$('#pl-user', root);
      setTimeout(() => userInput.focus(), 80);
      $$('#pl-cancel', root).onclick = closeModal;
      form.onsubmit = async (e) => {
        e.preventDefault();
        errEl.hidden = true;
        const u = userInput.value.trim();
        const p = $$('#pl-pass', root).value;
        if (!u || !p) return;
        submitBtn.disabled = true;
        labelEl.hidden = true;
        spinner.hidden = false;
        try {
          const data = await loginRequest(u, p);
          if (!data.token || !data.user) throw new Error('Bad response');
          setSession(data.token, data.user);
          if (onSuccess) onSuccess(data.user);
        } catch (err) {
          clearAuth();
          errEl.textContent = (err && /credentials/i.test(err.message))
            ? 'Usuario o contraseña incorrectos.'
            : 'Error: ' + (err && err.message ? err.message : 'no se pudo conectar.');
          errEl.hidden = false;
          submitBtn.disabled = false;
          labelEl.hidden = false;
          spinner.hidden = true;
        }
      };
    });
  }

  // ─── Visor: header + tabs + content ─────────────────────────────────────
  async function dlgViewer() {
    pstate.view = 'viewer';
    openModal(viewerHtml(), bindViewer, { large: true });
    await loadLists();
  }

  function viewerHtml() {
    return `
      <div class="priv-viewer" id="priv-viewer">
        <header class="priv-header">
          <div class="priv-header-left">
            <h2>${pstate.view === 'admin' ? 'Administración' : 'Mis canales'}</h2>
            <span class="priv-user-chip" id="priv-user-chip"></span>
          </div>
          <div class="priv-header-right">
            ${pstate.view === 'viewer' ? `
              <div class="priv-search">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
                <input id="priv-search-input" type="search" placeholder="Buscar canal…" autocomplete="off" spellcheck="false">
                <kbd class="priv-kbd">/</kbd>
              </div>
            ` : ''}
            ${pstate.user && pstate.user.role === 'admin' ? `
              <button class="priv-icon-btn ${pstate.view === 'admin' ? 'active' : ''}" id="priv-toggle-admin" title="${pstate.view === 'admin' ? 'Volver a canales' : 'Administración'}">
                ${pstate.view === 'admin'
                  ? '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="13" rx="2"/><polyline points="17 2 12 7 7 2"/></svg>'
                  : '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>'}
              </button>
            ` : ''}
            <button class="priv-icon-btn" id="priv-logout" title="Cerrar sesión">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
            </button>
            <button class="priv-icon-btn" id="priv-close" title="Cerrar">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        </header>
        <nav class="priv-tabs" id="priv-tabs"></nav>
        <main class="priv-content" id="priv-content">
          ${pstate.view === 'admin' ? '' : skeletonHtml()}
        </main>
      </div>
    `;
  }

  function skeletonHtml() {
    let rows = '';
    for (let i = 0; i < 3; i++) {
      let cards = '';
      for (let j = 0; j < 8; j++) cards += '<div class="priv-skel-card"></div>';
      rows += '<div class="priv-skel-row"><div class="priv-skel-title"></div><div class="priv-skel-cards">' + cards + '</div></div>';
    }
    return '<div class="priv-skel">' + rows + '</div>';
  }

  function bindViewer() {
    const root = document.getElementById('priv-viewer');
    if (!root) return;
    if (pstate.user) {
      const chip = $$('#priv-user-chip', root);
      chip.textContent = pstate.user.name || pstate.user.username;
      chip.style.cursor = 'pointer';
      chip.title = 'Click para cambiar contraseña';
      chip.onclick = (e) => {
        e.stopPropagation();
        dlgChangePassword();
      };
    }
    $$('#priv-close', root).onclick = closeModal;
    $$('#priv-logout', root).onclick = () => {
      if (!confirm('¿Cerrar sesión privada?')) return;
      clearAuth();
      closeModal();
    };
    const adminBtn = $$('#priv-toggle-admin', root);
    if (adminBtn) {
      adminBtn.onclick = () => {
        pstate.view = (pstate.view === 'admin') ? 'viewer' : 'admin';
        // Re-render del modal completo
        openModal(viewerHtml(), bindViewer, { large: true });
        if (pstate.view === 'admin') {
          renderAdminTabs();
          renderAdminContent();
        } else {
          loadLists();
        }
      };
    }
    const search = $$('#priv-search-input', root);
    if (search) {
      search.oninput = () => {
        pstate.query = search.value.trim().toLowerCase();
        renderChannels();
      };
    }
    document.addEventListener('keydown', searchHotkey, { capture: true });
  }

  function searchHotkey(e) {
    const dlg = document.getElementById('dlg');
    if (!dlg.classList.contains('priv-dialog-large')) {
      document.removeEventListener('keydown', searchHotkey, { capture: true });
      return;
    }
    if (e.key === '/' && !/^(input|textarea)$/i.test((document.activeElement || {}).tagName)) {
      e.preventDefault();
      const inp = document.getElementById('priv-search-input');
      if (inp) inp.focus();
    } else if (e.key === 'Escape') {
      const inp = document.getElementById('priv-search-input');
      if (inp && document.activeElement === inp && inp.value) {
        inp.value = ''; pstate.query = ''; renderChannels();
      }
    }
  }

  // ─── Carga de listas + favoritos ────────────────────────────────────────
  async function loadLists() {
    try {
      const r = await authedFetch(PROXY + '?action=lists');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();
      pstate.lists = (data.lists || []);
      renderTabs();
      const favs = loadFavs();
      // Si hay favoritos, abrimos en esa pestaña por default. Si no, primera lista.
      if (favs.length) await selectList('favorites');
      else if (pstate.lists.length) await selectList(pstate.lists[0].id);
      else showEmpty('No hay listas configuradas. Edita <code>private/lists.json</code> en el servidor.');
    } catch (err) {
      console.error('[priv] loadLists', err);
      showError('No se pudieron cargar las listas. Reintenta o verifica que <code>proxy.php</code> esté accesible.');
    }
  }

  function renderTabs() {
    const tabs = document.getElementById('priv-tabs');
    if (!tabs) return;
    const favsCount = loadFavs().length;
    let html = '';
    // Tab de favoritos siempre visible (aunque vacía).
    html += `<button class="priv-tab ${pstate.activeListId === 'favorites' ? 'active' : ''}" data-id="favorites">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" style="vertical-align:-2px;margin-right:4px"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
      Favoritos${favsCount ? ` <span class="priv-tab-count">${favsCount}</span>` : ''}
    </button>`;
    pstate.lists.forEach(l => {
      html += `<button class="priv-tab ${l.id === pstate.activeListId ? 'active' : ''}" data-id="${escapeAttr(l.id)}">
        ${escapeHtml(l.name)}
      </button>`;
    });
    tabs.innerHTML = html;
    tabs.querySelectorAll('.priv-tab').forEach(b => {
      b.onclick = () => selectList(b.dataset.id);
    });
  }

  async function selectList(id) {
    pstate.activeListId = id;
    renderTabs();
    const content = document.getElementById('priv-content');
    if (!content) return;

    if (id === 'favorites') {
      renderChannels();
      return;
    }

    if (!pstate.channelsByList[id]) {
      content.innerHTML = skeletonHtml();
      try {
        const r = await authedFetch(PROXY + '?action=m3u&id=' + encodeURIComponent(id));
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const data = await r.json();
        pstate.channelsByList[id] = data.channels || [];
      } catch (err) {
        console.error('[priv] m3u', err);
        showError('No se pudo cargar esta lista. La URL puede haber expirado — edita <code>private/lists.json</code>.');
        return;
      }
    }
    renderChannels();
  }

  function renderChannels() {
    const content = document.getElementById('priv-content');
    if (!content) return;

    let all;
    let isFavView = pstate.activeListId === 'favorites';
    if (isFavView) all = loadFavs();
    else all = pstate.channelsByList[pstate.activeListId] || [];

    const q = pstate.query;
    const filtered = q
      ? all.filter(c => (c.name || '').toLowerCase().includes(q) || (c.group || '').toLowerCase().includes(q))
      : all;

    const groups = new Map();
    for (const ch of filtered) {
      const g = ch.group || (isFavView ? 'Mis favoritos' : 'Otros');
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(ch);
    }

    if (groups.size === 0) {
      if (isFavView && !q) {
        showEmpty('Aún no marcaste favoritos. Click en la <strong>⭐ estrella</strong> de cualquier canal para guardarlo aquí.');
      } else {
        showEmpty(q ? `Sin resultados para "${escapeHtml(q)}".` : 'Esta lista no tiene canales.');
      }
      return;
    }

    // Dos botones: "Abrir en VLC" intenta vlc://... + descarga el .m3u
    // como fallback. "Descargar" solo descarga (sin intent).
    let html = `<div class="priv-meta">
      <span>${filtered.length} ${filtered.length === 1 ? 'canal' : 'canales'} · ${groups.size} ${groups.size === 1 ? 'categoría' : 'categorías'}</span>
      ${all.length ? `<div class="priv-meta-btns">
        <button class="priv-meta-btn priv-meta-btn-primary" id="priv-open-vlc" title="Abre VLC automáticamente con todos los canales (requiere VLC instalado y registrado para vlc://)">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:5px"><polygon points="11.5 7 16 12 11.5 17"/><circle cx="12" cy="12" r="10"/></svg>
          Abrir en VLC
        </button>
        <button class="priv-meta-btn" id="priv-dl-list" title="Descarga el archivo .m3u sin abrir VLC">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        </button>
        <button class="priv-meta-btn-help" id="priv-vlc-help" title="¿VLC no se abre automáticamente?">?</button>
      </div>` : ''}
    </div>`;
    for (const [groupName, chans] of groups) {
      html += `
        <section class="priv-row">
          <h3 class="priv-row-title">${escapeHtml(groupName)} <span class="priv-row-count">${chans.length}</span></h3>
          <div class="priv-row-cards">${chans.map(channelCardHtml).join('')}</div>
        </section>
      `;
    }
    content.innerHTML = html;

    // Bind del botón "Descargar" (solo guarda el .m3u)
    const dlBtn = content.querySelector('#priv-dl-list');
    if (dlBtn) dlBtn.onclick = () => {
      const isFav = pstate.activeListId === 'favorites';
      const listObj = pstate.lists.find(l => l.id === pstate.activeListId);
      const baseName = isFav ? 'favoritos' : (listObj ? listObj.id : pstate.activeListId);
      const filename = `${baseName}-${new Date().toISOString().slice(0,10)}.m3u`;
      downloadM3u(all, filename);
    };
    // Bind del botón "Abrir en VLC" (intenta vlc:// + descarga fallback)
    const openVlcBtn = content.querySelector('#priv-open-vlc');
    if (openVlcBtn) openVlcBtn.onclick = () => {
      const listObj = pstate.lists.find(l => l.id === pstate.activeListId);
      const displayName = listObj ? listObj.name : pstate.activeListId;
      openListInVlc(all, pstate.activeListId, displayName);
    };
    // Bind del botón "?" — abre dialog con instrucciones para registrar vlc://
    const helpBtn = content.querySelector('#priv-vlc-help');
    if (helpBtn) helpBtn.onclick = () => dlgVlcHelp();

    // Bind clicks. Card → reproduce, estrella → toggle fav (sin propagar).
    content.querySelectorAll('.priv-card').forEach(card => {
      const cid = card.dataset.id;
      card.onclick = (e) => {
        if (e.target.closest('.priv-fav-star')) return;
        playPrivateChannel(cid);
      };
    });
    content.querySelectorAll('.priv-fav-star').forEach(star => {
      star.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const cid = star.dataset.id;
        // Buscamos el canal en la lista activa o en favoritos
        const ch = (pstate.channelsByList[pstate.activeListId] || []).find(c => c.id === cid)
                || loadFavs().find(c => c.id === cid);
        if (!ch) return;
        toggleFav(ch);
        if (pstate.activeListId === 'favorites') {
          // Re-render porque el canal probablemente desaparece del view
          renderTabs();
          renderChannels();
        } else {
          star.classList.toggle('on');
          renderTabs(); // actualiza el contador del tab
        }
      };
    });
  }

  function channelCardHtml(c) {
    const initial = (c.name || '?')[0].toUpperCase();
    const hue = hashHue(c.name || '');
    const fallbackBg = `background:linear-gradient(135deg, hsl(${hue} 70% 45%), hsl(${(hue + 60) % 360} 70% 32%))`;
    const fav = isFav(c.id);
    return `
      <div class="priv-card-wrap">
        <button class="priv-card" data-id="${escapeAttr(c.id)}" title="${escapeAttr(c.name)}">
          <div class="priv-card-art" style="${fallbackBg}">
            <span class="priv-card-initial">${escapeHtml(initial)}</span>
            ${c.logo ? `<img class="priv-card-logo" src="${escapeAttr(c.logo)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}
            <span class="priv-card-live">● EN VIVO</span>
          </div>
          <div class="priv-card-name">${escapeHtml(c.name)}</div>
        </button>
        <button class="priv-fav-star ${fav ? 'on' : ''}" data-id="${escapeAttr(c.id)}" title="${fav ? 'Quitar de favoritos' : 'Agregar a favoritos'}" aria-label="Favorito">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
        </button>
      </div>
    `;
  }

  function playPrivateChannel(channelId) {
    let ch;
    if (pstate.activeListId === 'favorites') {
      ch = loadFavs().find(c => c.id === channelId);
    } else {
      const all = pstate.channelsByList[pstate.activeListId] || [];
      ch = all.find(c => c.id === channelId);
    }
    if (!ch) return;
    const token = getToken();
    if (!token) {
      alert('Sesión expirada — vuelve a entrar.');
      clearAuth();
      return;
    }

    // ⭐ Estrategia direct-first con fallback automático:
    //   1. Siempre intentar URL DIRECTA primero (tu IP, sin geo-block)
    //   2. Si falla, app.js retry automático con proxy
    //   3. Si proxy también falla, mostrar dialog de error
    //
    // Para HTTPS: ya funciona directo casi siempre.
    // Para HTTP: solo funciona directo si habilitaste "Contenido mixto" en
    // el candado del browser. Si no, falla rápido y va al proxy → geo-block
    // del server pirata → dialog con instructions para habilitar mixed.
    const proxyUrl = PROXY + '?action=stream&token=' + encodeURIComponent(token)
                   + '&u=' + b64urlEncode(ch.url);

    const fakeChannel = {
      id: 'priv_' + ch.id,
      kind: 'tv',
      name: ch.name,
      // PRIMER intento: URL directa (HTTPS o HTTP — el browser puede bloquear
      // el HTTP por mixed content, en cuyo caso disparamos el fallback abajo).
      url: ch.url,
      // FALLBACK: si la URL directa falla (mixed content / CORS / DNS),
      // app.js retry con esta URL via proxy de Bluehost.
      _proxyFallback: proxyUrl,
      _triedProxy: false,
      _originalUrl: ch.url,
      _isHttp: /^http:\/\//i.test(ch.url),
    };
    if (typeof window.playExternalChannel === 'function') {
      window.playExternalChannel(fakeChannel);
    }
    closeModal();
  }

  function showEmpty(msg) {
    const content = document.getElementById('priv-content');
    if (!content) return;
    content.innerHTML = `<div class="priv-empty">${msg}</div>`;
  }
  function showError(msg) {
    const content = document.getElementById('priv-content');
    if (!content) return;
    content.innerHTML = `<div class="priv-empty priv-empty-err">${msg}</div>`;
  }

  // ════════════════════════════════════════════════════════════════════════
  // PANEL ADMIN (solo role=admin) — gestión de usuarios y listas M3U.
  // ════════════════════════════════════════════════════════════════════════
  function renderAdminTabs() {
    const tabs = document.getElementById('priv-tabs');
    if (!tabs) return;
    tabs.innerHTML = `
      <button class="priv-tab ${pstate.adminTab === 'users' ? 'active' : ''}" data-tab="users">Usuarios</button>
      <button class="priv-tab ${pstate.adminTab === 'lists' ? 'active' : ''}" data-tab="lists">Listas M3U</button>
    `;
    tabs.querySelectorAll('.priv-tab').forEach(b => {
      b.onclick = () => { pstate.adminTab = b.dataset.tab; renderAdminTabs(); renderAdminContent(); };
    });
  }

  async function adminApi(type, op, body, queryExtra) {
    let url = PROXY + '?action=admin&type=' + encodeURIComponent(type) + '&op=' + encodeURIComponent(op);
    if (queryExtra) for (const k in queryExtra) url += '&' + k + '=' + encodeURIComponent(queryExtra[k]);
    const opts = body
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : { method: 'GET' };
    const r = await authedFetch(url, opts);
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error || ('HTTP ' + r.status));
    }
    return r.json();
  }

  async function renderAdminContent() {
    const content = document.getElementById('priv-content');
    if (!content) return;
    content.innerHTML = '<div class="priv-empty">Cargando…</div>';
    try {
      const data = await adminApi(pstate.adminTab, 'list');
      if (pstate.adminTab === 'users') renderUsersAdmin(data.users || []);
      else renderListsAdmin(data.lists || []);
    } catch (err) {
      showError('Error: ' + err.message);
    }
  }

  function renderUsersAdmin(users) {
    const content = document.getElementById('priv-content');
    if (!content) return;
    content.innerHTML = `
      <div class="priv-admin">
        <div class="priv-admin-actions">
          <button class="priv-btn primary" id="adm-new">+ Nuevo usuario</button>
          <button class="priv-btn ghost" id="adm-export" title="Descarga un JSON con todos los usuarios y listas (incluye password_hash)">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:5px"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Exportar
          </button>
          <button class="priv-btn ghost" id="adm-import" title="Subir un JSON exportado para restaurar usuarios y listas">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:5px"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            Importar
          </button>
          <span class="priv-admin-hint">${users.length} ${users.length === 1 ? 'usuario' : 'usuarios'}</span>
        </div>
        <div class="priv-admin-list">
          ${users.map(u => `
            <div class="priv-admin-card">
              <div class="priv-admin-avatar" style="background:linear-gradient(135deg, hsl(${hashHue(u.username)} 70% 45%), hsl(${(hashHue(u.username)+50)%360} 70% 32%))">
                ${escapeHtml((u.name || u.username)[0].toUpperCase())}
              </div>
              <div class="priv-admin-meta">
                <div class="priv-admin-name">${escapeHtml(u.name || u.username)}
                  ${u.role === 'admin' ? '<span class="priv-admin-badge">ADMIN</span>' : ''}
                </div>
                <div class="priv-admin-sub">@${escapeHtml(u.username)}</div>
              </div>
              <div class="priv-admin-buttons">
                <button class="priv-icon-btn" data-edit="${escapeAttr(u.username)}" title="Editar">
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                </button>
                <button class="priv-icon-btn priv-danger" data-del="${escapeAttr(u.username)}" title="Eliminar">
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>
                </button>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
    $$('#adm-new').onclick = () => dlgUserForm();
    bindExportButton(content);
    content.querySelectorAll('[data-edit]').forEach(b => {
      b.onclick = () => {
        const u = users.find(x => x.username === b.dataset.edit);
        if (u) dlgUserForm(u);
      };
    });
    content.querySelectorAll('[data-del]').forEach(b => {
      b.onclick = async () => {
        const username = b.dataset.del;
        if (!confirm(`¿Eliminar al usuario "${username}"?`)) return;
        try {
          await adminApi('users', 'delete', null, { id: username });
          renderAdminContent();
        } catch (err) {
          alert('Error: ' + err.message);
        }
      };
    });
  }

  // Bind compartido de los botones "Exportar" e "Importar" del panel admin.
  function bindExportButton(root) {
    const btnExp = root.querySelector('#adm-export');
    if (btnExp) btnExp.onclick = async () => {
      if (!confirm('Vas a descargar un JSON con TODOS los usuarios (incluyendo password_hash) y listas. Guardalo en lugar seguro.\n\n¿Continuar?')) return;
      try {
        const token = getToken();
        const r = await fetch(PROXY + '?action=admin&type=export&op=full&token=' + encodeURIComponent(token));
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const blob = await r.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'guia-private-export-' + new Date().toISOString().slice(0,10) + '.json';
        document.body.appendChild(a); a.click();
        setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 200);
      } catch (err) {
        alert('Error al exportar: ' + err.message);
      }
    };
    const btnImp = root.querySelector('#adm-import');
    if (btnImp) btnImp.onclick = () => dlgImport();
  }

  // Dialog de import: drag-drop o file picker, preview, confirmar.
  // opts.isBootstrap=true → llama al endpoint público ?action=bootstrap
  // (sin auth, solo si no hay admin existente — usado al restaurar desde
  // el dialog de login cuando perdiste credenciales).
  function dlgImport(opts) {
    const bootstrap = opts && opts.isBootstrap;
    openModal(`
      <div class="priv-form-modal">
        <h2>${bootstrap ? 'Restaurar desde backup' : 'Importar usuarios y listas'}</h2>
        <p class="priv-sub" style="text-align:left">${bootstrap
          ? 'Si perdiste la contraseña o estás restaurando una instalación nueva, subí acá el JSON exportado. <strong>Solo funciona si no hay un admin configurado todavía.</strong> Una vez restaurado, vas a poder iniciar sesión con las credenciales del backup.'
          : 'Subí un JSON descargado con "Exportar". Va a <strong>reemplazar</strong> todos los usuarios y listas actuales (tu cuenta de admin se preserva automáticamente si no está en el JSON).'}</p>
        <div class="priv-import-zone" id="priv-import-zone">
          <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          <p>Arrastrá tu archivo <code>.json</code> aquí<br>o <strong>click para buscar</strong></p>
          <input type="file" id="priv-import-file" accept="application/json,.json" hidden>
        </div>
        <div id="priv-import-preview" hidden></div>
        <div id="priv-import-err" class="priv-err" hidden></div>
        <div class="priv-actions">
          <button type="button" class="priv-btn ghost" id="priv-import-cancel">Cancelar</button>
          <button type="button" class="priv-btn primary" id="priv-import-confirm" disabled>${bootstrap ? 'Restaurar' : 'Importar'}</button>
        </div>
      </div>
    `, (root) => {
      const fileInput = $$('#priv-import-file', root);
      const zone      = $$('#priv-import-zone', root);
      const preview   = $$('#priv-import-preview', root);
      const errEl     = $$('#priv-import-err', root);
      const confirmBtn = $$('#priv-import-confirm', root);
      let importedData = null;

      zone.onclick = () => fileInput.click();
      zone.ondragover = (e) => { e.preventDefault(); zone.classList.add('drag-over'); };
      zone.ondragleave = () => zone.classList.remove('drag-over');
      zone.ondrop = (e) => {
        e.preventDefault();
        zone.classList.remove('drag-over');
        if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
      };
      fileInput.onchange = () => { if (fileInput.files[0]) handleFile(fileInput.files[0]); };

      async function handleFile(file) {
        errEl.hidden = true;
        preview.hidden = true;
        confirmBtn.disabled = true;
        try {
          const text = await file.text();
          const data = JSON.parse(text);
          if ((!data.users || !Array.isArray(data.users)) && (!data.lists || !Array.isArray(data.lists))) {
            throw new Error('JSON sin "users" ni "lists" válidos');
          }
          importedData = {
            users: Array.isArray(data.users) ? data.users : [],
            lists: Array.isArray(data.lists) ? data.lists : [],
          };
          const meta = data.exported_at
            ? `<div class="priv-import-meta">Exportado: <strong>${escapeHtml(data.exported_at)}</strong>${data.exported_from ? ` · desde <strong>${escapeHtml(data.exported_from)}</strong>` : ''}</div>`
            : '';
          preview.innerHTML = `
            ${meta}
            <div class="priv-import-preview-grid">
              <div><strong>${importedData.users.length}</strong><span>usuarios</span></div>
              <div><strong>${importedData.lists.length}</strong><span>listas</span></div>
            </div>
            ${importedData.users.length ? `<div class="priv-import-list"><strong>Usuarios:</strong> ${importedData.users.map(u => escapeHtml(u.username)).join(', ')}</div>` : ''}
            ${importedData.lists.length ? `<div class="priv-import-list"><strong>Listas:</strong> ${importedData.lists.map(l => escapeHtml(l.name || l.id)).join(', ')}</div>` : ''}
          `;
          preview.hidden = false;
          confirmBtn.disabled = false;
        } catch (err) {
          errEl.textContent = 'Archivo inválido: ' + err.message;
          errEl.hidden = false;
          importedData = null;
        }
      }

      $$('#priv-import-cancel', root).onclick = () => {
        if (bootstrap) { closeModal(); dlgLogin(() => dlgViewer()); }
        else returnToAdmin();
      };
      confirmBtn.onclick = async () => {
        if (!importedData) return;
        const msg = bootstrap
          ? 'Esto va a SOBREESCRIBIR users.json y lists.json con el contenido del archivo.\n\n¿Continuar?'
          : 'Esto va a REEMPLAZAR todos los usuarios y listas actuales con los del archivo.\n\n¿Continuar?';
        if (!confirm(msg)) return;
        confirmBtn.disabled = true;
        confirmBtn.textContent = bootstrap ? 'Restaurando…' : 'Importando…';
        try {
          let result;
          if (bootstrap) {
            // Endpoint público — sin token. Solo funciona si no hay admin.
            const r = await fetch(PROXY + '?action=bootstrap', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(importedData),
            });
            if (!r.ok) {
              const err = await r.json().catch(() => ({}));
              throw new Error(err.error || ('HTTP ' + r.status));
            }
            result = await r.json();
          } else {
            result = await adminApi('import', 'replace', importedData);
          }
          let txt = bootstrap ? 'Restauración completa. ' : 'Listo. ';
          if (result.users_imported) txt += `${result.users_imported} usuarios. `;
          if (result.lists_imported) txt += `${result.lists_imported} listas.`;
          alert(txt + (bootstrap ? '\n\nAhora podés iniciar sesión con las credenciales del backup.' : ''));
          if (bootstrap) {
            closeModal();
            dlgLogin(() => dlgViewer());
          } else {
            returnToAdmin();
          }
        } catch (err) {
          errEl.textContent = err.message;
          errEl.hidden = false;
          confirmBtn.disabled = false;
          confirmBtn.textContent = bootstrap ? 'Restaurar' : 'Importar';
        }
      };
    });
  }

  function dlgUserForm(user) {
    const editing = !!user;
    openModal(`
      <div class="priv-form-modal">
        <h2>${editing ? 'Editar usuario' : 'Nuevo usuario'}</h2>
        <form id="adm-user-form" class="priv-form">
          <label class="priv-field">
            <span>Usuario (login)</span>
            <input id="au-user" type="text" autocapitalize="none" autocorrect="off" spellcheck="false" value="${editing ? escapeAttr(user.username) : ''}" ${editing ? 'readonly' : 'required'}>
          </label>
          <label class="priv-field">
            <span>Contraseña ${editing ? '(dejar vacío = no cambiar)' : ''}</span>
            <input id="au-pass" type="password" ${editing ? '' : 'required'}>
          </label>
          <label class="priv-field">
            <span>Nombre visible</span>
            <input id="au-name" type="text" value="${editing ? escapeAttr(user.name || '') : ''}">
          </label>
          <label class="priv-field">
            <span>Rol</span>
            <select id="au-role">
              <option value="user" ${(!editing || user.role !== 'admin') ? 'selected' : ''}>Usuario</option>
              <option value="admin" ${(editing && user.role === 'admin') ? 'selected' : ''}>Admin</option>
            </select>
          </label>
          <div id="au-err" class="priv-err" hidden></div>
          <div class="priv-actions">
            <button type="button" class="priv-btn ghost" id="au-cancel">Cancelar</button>
            <button type="submit" class="priv-btn primary" id="au-save">Guardar</button>
          </div>
        </form>
      </div>
    `, (root) => {
      $$('#au-cancel', root).onclick = () => returnToAdmin();
      $$('#adm-user-form', root).onsubmit = async (e) => {
        e.preventDefault();
        const errEl = $$('#au-err', root);
        errEl.hidden = true;
        const username = $$('#au-user', root).value.trim();
        const password = $$('#au-pass', root).value;
        const name = $$('#au-name', root).value.trim();
        const role = $$('#au-role', root).value;
        if (!editing && (!username || !password)) {
          errEl.textContent = 'Usuario y contraseña son obligatorios.';
          errEl.hidden = false; return;
        }
        try {
          if (editing) {
            const body = { name, role };
            if (password) body.password = password;
            await adminApi('users', 'update', body, { id: user.username });
          } else {
            await adminApi('users', 'create', { username, password, name, role });
          }
          returnToAdmin();
        } catch (err) {
          errEl.textContent = err.message;
          errEl.hidden = false;
        }
      };
    });
  }

  function renderListsAdmin(lists) {
    const content = document.getElementById('priv-content');
    if (!content) return;
    content.innerHTML = `
      <div class="priv-admin">
        <div class="priv-admin-actions">
          <button class="priv-btn primary" id="adm-new-list">+ Nueva lista</button>
          <button class="priv-btn ghost" id="adm-export" title="Descarga un JSON con todos los usuarios y listas">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:5px"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Exportar todo
          </button>
          <span class="priv-admin-hint">${lists.length} ${lists.length === 1 ? 'lista' : 'listas'}</span>
        </div>
        <div class="priv-admin-list">
          ${lists.map(l => `
            <div class="priv-admin-card">
              <div class="priv-admin-avatar" style="background:linear-gradient(135deg, hsl(${hashHue(l.id)} 60% 45%), hsl(${(hashHue(l.id)+40)%360} 60% 32%))">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>
              </div>
              <div class="priv-admin-meta">
                <div class="priv-admin-name">${escapeHtml(l.name)}</div>
                <div class="priv-admin-sub" title="${escapeAttr(l.url)}">${escapeHtml(l.url)}</div>
                ${l.description ? `<div class="priv-admin-sub priv-admin-desc">${escapeHtml(l.description)}</div>` : ''}
              </div>
              <div class="priv-admin-buttons">
                <button class="priv-icon-btn" data-edit="${escapeAttr(l.id)}" title="Editar">
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                </button>
                <button class="priv-icon-btn priv-danger" data-del="${escapeAttr(l.id)}" title="Eliminar">
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/></svg>
                </button>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
    $$('#adm-new-list').onclick = () => dlgListForm();
    bindExportButton(content);
    content.querySelectorAll('[data-edit]').forEach(b => {
      b.onclick = () => {
        const l = lists.find(x => x.id === b.dataset.edit);
        if (l) dlgListForm(l);
      };
    });
    content.querySelectorAll('[data-del]').forEach(b => {
      b.onclick = async () => {
        const id = b.dataset.del;
        if (!confirm(`¿Eliminar la lista "${id}"?`)) return;
        try {
          await adminApi('lists', 'delete', null, { id });
          renderAdminContent();
          // Limpia cache local de canales por si era una lista cargada
          delete pstate.channelsByList[id];
        } catch (err) {
          alert('Error: ' + err.message);
        }
      };
    });
  }

  function dlgListForm(list) {
    const editing = !!list;
    openModal(`
      <div class="priv-form-modal">
        <h2>${editing ? 'Editar lista' : 'Nueva lista'}</h2>
        <form id="adm-list-form" class="priv-form">
          <label class="priv-field">
            <span>ID (sin espacios)</span>
            <input id="al-id" type="text" autocapitalize="none" autocorrect="off" spellcheck="false" value="${editing ? escapeAttr(list.id) : ''}" ${editing ? 'readonly' : 'required'} pattern="[a-zA-Z0-9\\-_]+">
          </label>
          <label class="priv-field">
            <span>Nombre visible</span>
            <input id="al-name" type="text" value="${editing ? escapeAttr(list.name || '') : ''}" required>
          </label>
          <label class="priv-field">
            <span>URL del .m3u</span>
            <input id="al-url" type="url" value="${editing ? escapeAttr(list.url || '') : ''}" required placeholder="http://... o https://...">
          </label>
          <label class="priv-field">
            <span>Descripción (opcional)</span>
            <input id="al-desc" type="text" value="${editing ? escapeAttr(list.description || '') : ''}">
          </label>
          <div id="al-err" class="priv-err" hidden></div>
          <div class="priv-actions">
            <button type="button" class="priv-btn ghost" id="al-cancel">Cancelar</button>
            <button type="submit" class="priv-btn primary" id="al-save">Guardar</button>
          </div>
        </form>
      </div>
    `, (root) => {
      $$('#al-cancel', root).onclick = () => returnToAdmin();
      $$('#adm-list-form', root).onsubmit = async (e) => {
        e.preventDefault();
        const errEl = $$('#al-err', root);
        errEl.hidden = true;
        const body = {
          id: $$('#al-id', root).value.trim(),
          name: $$('#al-name', root).value.trim(),
          url: $$('#al-url', root).value.trim(),
          description: $$('#al-desc', root).value.trim(),
        };
        if (!body.id || !body.name || !body.url) {
          errEl.textContent = 'ID, nombre y URL son obligatorios.';
          errEl.hidden = false; return;
        }
        try {
          if (editing) {
            await adminApi('lists', 'update', body, { id: list.id });
          } else {
            await adminApi('lists', 'create', body);
          }
          returnToAdmin();
        } catch (err) {
          errEl.textContent = err.message;
          errEl.hidden = false;
        }
      };
    });
  }

  function returnToAdmin() {
    pstate.view = 'admin';
    openModal(viewerHtml(), bindViewer, { large: true });
    renderAdminTabs();
    renderAdminContent();
  }

  // ─── Dialog: cómo configurar un VPS LatAm con proxy.php ──────────────
  // La solución técnica definitiva para canales IPTV con HTTP/IP literal
  // que Chrome bloquea en <video>. Un VPS chico en Argentina/Chile corriendo
  // el mismo proxy.php devuelve los streams sobre HTTPS (mismo origen del
  // sitio del user, así Chrome no aplica mixed-content blocking).
  function dlgVpsSetupHelp() {
    openModal(`
      <div class="priv-form-modal priv-vlc-help">
        <h2>📡 VPS LatAm — solución definitiva</h2>
        <p class="priv-sub" style="text-align:left">Un VPS chico en Argentina/Chile (~$3-5 USD/mes) corriendo el mismo <code>proxy.php</code> resuelve los 3 problemas que vimos: geo-block de Bluehost, mixed content blocking, y CORS.</p>

        <div class="priv-help-section">
          <div class="priv-help-platform">🎯 Por qué funciona</div>
          <ul class="priv-help-steps" style="list-style:disc">
            <li><strong>IP residencial-friendly</strong>: los servers IPTV no bloquean LatAm.</li>
            <li><strong>HTTPS propio</strong>: con un dominio + Let's Encrypt, los streams pasan por <code>https://tu-vps.com/proxy.php</code> → no hay mixed content.</li>
            <li><strong>CORS controlado</strong>: el proxy envía los headers correctos.</li>
            <li><strong>Reproductor in-page</strong>: <code>&lt;video&gt;</code> + HLS.js funcionan sin extensiones ni VLC.</li>
          </ul>
        </div>

        <div class="priv-help-section">
          <div class="priv-help-platform">💰 Hostings recomendados</div>
          <ul class="priv-help-steps" style="list-style:none;padding-left:0">
            <li style="margin-bottom:6px">• <a href="https://www.vultr.com/products/cloud-compute/" target="_blank" rel="noopener noreferrer"><strong>Vultr</strong></a> — $3.50/mes, datacenter en Santiago de Chile y Buenos Aires</li>
            <li style="margin-bottom:6px">• <a href="https://www.digitalocean.com/pricing/droplets" target="_blank" rel="noopener noreferrer"><strong>DigitalOcean</strong></a> — $4/mes, sin LatAm pero NYC funciona OK para IPTV ARG</li>
            <li style="margin-bottom:6px">• <a href="https://www.hetzner.com/cloud" target="_blank" rel="noopener noreferrer"><strong>Hetzner Cloud</strong></a> — €4.50/mes, Europa (mejor para IPTV España)</li>
            <li>• <a href="https://www.contabo.com/en/vps/" target="_blank" rel="noopener noreferrer"><strong>Contabo</strong></a> — €4.50/mes, Europa, mucho RAM</li>
          </ul>
        </div>

        <div class="priv-help-section">
          <div class="priv-help-platform">📋 Setup en 30 minutos</div>
          <ol class="priv-help-steps">
            <li>Creá VM Ubuntu 22.04 en Vultr (Santiago) — el más chico (1GB RAM) alcanza.</li>
            <li>SSH al VPS: <code>ssh root@TU_IP</code></li>
            <li>Instalá Apache + PHP: <code>apt update && apt install -y apache2 php php-curl certbot python3-certbot-apache</code></li>
            <li>Subí <code>proxy.php</code> a <code>/var/www/html/</code>, creá <code>/var/www/html/private/</code> con <code>users.json</code> y <code>lists.json</code> (mismo formato que en Bluehost — podés usar el JSON de "Exportar todo").</li>
            <li>Apuntá un (sub)dominio al VPS, ej. <code>iptv.dar2.cl</code> → A record a la IP del VPS.</li>
            <li>Generá HTTPS: <code>certbot --apache -d iptv.dar2.cl</code></li>
            <li>En el frontend, cambiá <code>const PROXY = './proxy.php'</code> por <code>const PROXY = 'https://iptv.dar2.cl/proxy.php'</code> en <code>private.js</code>.</li>
            <li>Recargá → todos los canales reproducen in-page con la IP del VPS (chilena).</li>
          </ol>
          <p class="priv-help-note">El <code>guia.dar2.cl</code> sigue donde está (Bluehost). Solo el <strong>visor privado</strong> usa el VPS para los streams. Costo total: solo el VPS (~$3-5/mes).</p>
        </div>

        <div class="priv-help-section">
          <div class="priv-help-platform">💡 Quiero ayudarte con esto</div>
          <p class="priv-help-note">Si decidís ir por el VPS, decime y te paso comandos exactos para tu caso (incluyendo subir el <code>proxy.php</code> al VPS, configurar Apache y certbot, ajustar el frontend). El setup es simple si seguís los pasos.</p>
        </div>

        <div class="priv-actions">
          <button type="button" class="priv-btn primary" id="priv-vps-close">Entendido</button>
        </div>
      </div>
    `, (root) => {
      $$('#priv-vps-close', root).onclick = closeModal;
    });
  }

  // ─── Dialog: cambiar contraseña del user actual ────────────────────────
  // Cualquier user logueado puede cambiar su propia password. Requiere la
  // contraseña actual para evitar que un atacante con sesión activa la cambie.
  function dlgChangePassword() {
    if (!pstate.user) return;
    openModal(`
      <div class="priv-form-modal">
        <div class="priv-logo-mark">
          <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2"/>
            <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
          </svg>
        </div>
        <h2 class="priv-title">Cambiar contraseña</h2>
        <p class="priv-sub">Estás logueado como <strong>${escapeHtml(pstate.user.name || pstate.user.username)}</strong></p>
        <form id="cp-form" class="priv-form">
          <label class="priv-field">
            <span>Contraseña actual</span>
            <input id="cp-current" type="password" autocomplete="current-password" required>
          </label>
          <label class="priv-field">
            <span>Nueva contraseña</span>
            <input id="cp-new" type="password" autocomplete="new-password" required minlength="4">
          </label>
          <label class="priv-field">
            <span>Confirmar nueva contraseña</span>
            <input id="cp-new2" type="password" autocomplete="new-password" required minlength="4">
          </label>
          <div id="cp-err" class="priv-err" hidden></div>
          <div id="cp-ok" class="priv-ok" hidden></div>
          <div class="priv-actions">
            <button type="button" class="priv-btn ghost" id="cp-cancel">Cancelar</button>
            <button type="submit" class="priv-btn primary" id="cp-submit">
              <span class="priv-btn-label">Cambiar</span>
              <span class="priv-spinner" hidden></span>
            </button>
          </div>
        </form>
      </div>
    `, (root) => {
      $$('#cp-cancel', root).onclick = closeModal;
      const form = $$('#cp-form', root);
      const errEl = $$('#cp-err', root);
      const okEl = $$('#cp-ok', root);
      const submitBtn = $$('#cp-submit', root);
      const labelEl = $$('.priv-btn-label', submitBtn);
      const spinner = $$('.priv-spinner', submitBtn);
      setTimeout(() => $$('#cp-current', root).focus(), 80);
      form.onsubmit = async (e) => {
        e.preventDefault();
        errEl.hidden = true;
        okEl.hidden = true;
        const current = $$('#cp-current', root).value;
        const newPass = $$('#cp-new', root).value;
        const confirm = $$('#cp-new2', root).value;
        if (newPass !== confirm) {
          errEl.textContent = 'Las contraseñas nuevas no coinciden.';
          errEl.hidden = false;
          return;
        }
        if (newPass.length < 4) {
          errEl.textContent = 'La nueva contraseña debe tener al menos 4 caracteres.';
          errEl.hidden = false;
          return;
        }
        if (newPass === current) {
          errEl.textContent = 'La nueva contraseña debe ser distinta de la actual.';
          errEl.hidden = false;
          return;
        }
        submitBtn.disabled = true;
        labelEl.hidden = true;
        spinner.hidden = false;
        try {
          const token = getToken();
          const r = await fetch(PROXY + '?action=change_password&token=' + encodeURIComponent(token), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ current, new: newPass }),
          });
          const data = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
          okEl.textContent = '✓ Contraseña actualizada. Tu sesión sigue activa.';
          okEl.hidden = false;
          // Vaciar inputs
          form.reset();
          submitBtn.disabled = false;
          labelEl.hidden = false;
          spinner.hidden = true;
          setTimeout(closeModal, 2200);
        } catch (err) {
          errEl.textContent = err.message;
          errEl.hidden = false;
          submitBtn.disabled = false;
          labelEl.hidden = false;
          spinner.hidden = true;
        }
      };
    });
  }

  // ─── Dialog: cómo instalar extensión de CORS para Chrome ──────────────
  // Muchos servers IPTV permiten que el browser CONECTE (TCP/HTTP) pero no
  // envían Access-Control-Allow-Origin. HLS.js requiere CORS para leer el
  // playlist .m3u8. La extensión inyecta el header CORS al response, lo
  // que permite a HLS.js trabajar normalmente.
  function dlgCorsExtensionHelp() {
    openModal(`
      <div class="priv-form-modal priv-vlc-help">
        <h2>Reproducir canales sin CORS</h2>
        <p class="priv-sub">Algunos servers IPTV no envían los headers CORS que el browser necesita. Una extensión los inyecta y desbloquea la reproducción in-page.</p>

        <div class="priv-help-section">
          <div class="priv-help-platform">📦 Extensiones recomendadas (Chrome)</div>
          <ul class="priv-help-steps" style="list-style:none;padding-left:0">
            <li style="margin-bottom:10px"><a href="https://chromewebstore.google.com/detail/cors-unblock/lfhmikememgdcahcdlaciloancbhjino" target="_blank" rel="noopener noreferrer"><strong>CORS Unblock</strong></a> — la más simple, toggle on/off, gratuita.</li>
            <li style="margin-bottom:10px"><a href="https://chromewebstore.google.com/detail/allow-cors-access-control/lhobafahddgcelffkeicbaginigeejlf" target="_blank" rel="noopener noreferrer"><strong>Allow CORS: Access-Control-Allow-Origin</strong></a> — alternativa popular.</li>
            <li><a href="https://chromewebstore.google.com/detail/moesif-origins-cors-chang/digfbfaphojjndkpccljibejjbppifbc" target="_blank" rel="noopener noreferrer"><strong>Moesif Origin & CORS Changer</strong></a> — más opciones avanzadas.</li>
          </ul>
        </div>

        <div class="priv-help-section">
          <div class="priv-help-platform">📋 Pasos</div>
          <ol class="priv-help-steps">
            <li>Click en uno de los links de arriba → <strong>"Añadir a Chrome"</strong> → confirmá.</li>
            <li>Una vez instalada, vas a ver un nuevo ícono en la barra (arriba a la derecha).</li>
            <li><strong>Activá la extensión</strong> (click + toggle ON).</li>
            <li>Recargá <code>guia.dar2.cl</code> (Ctrl+R) y reintentá el canal.</li>
            <li>Cuando termines, podés desactivarla — solo es necesaria mientras ves IPTV.</li>
          </ol>
        </div>

        <div class="priv-help-section">
          <div class="priv-help-platform">⚠️ Sobre seguridad</div>
          <p class="priv-help-note">Estas extensiones desactivan CORS <strong>en todas las páginas que visitas</strong> mientras estén activas. Eso baja un nivel de seguridad para sitios sensibles (banco, mail). <strong>Activala solo cuando vas a ver IPTV y desactivala después</strong>. La mayoría tiene un toggle rápido en la barra del browser.</p>
        </div>

        <div class="priv-help-section">
          <div class="priv-help-platform">🌐 Solución sin extensión</div>
          <p class="priv-help-note">La alternativa "limpia" es un VPS chico en Chile/Argentina con el mismo <code>proxy.php</code>. El proxy devuelve los headers CORS que necesita HLS.js, y como el VPS está en LatAm, no hay geo-block. ~$3-5 USD/mes (Vultr, DigitalOcean). Si querés explorar este camino, decime y armamos los pasos juntos.</p>
        </div>

        <div class="priv-actions">
          <button type="button" class="priv-btn primary" id="priv-cors-close">Entendido</button>
        </div>
      </div>
    `, (root) => {
      $$('#priv-cors-close', root).onclick = closeModal;
    });
  }

  // ─── Dialog: cómo permitir contenido mixto en Chrome ───────────────────
  // Muchas listas IPTV usan http://. Como el sitio es https://, Chrome
  // bloquea cargar streams http (mixed content). Habilitarlo manualmente
  // para guia.dar2.cl resuelve el problema permanente: el browser carga
  // los .m3u8 directo desde tu IP (chilena) sin pasar por Bluehost.
  function dlgMixedContentHelp() {
    openModal(`
      <div class="priv-form-modal priv-vlc-help">
        <h2>Permitir contenido mixto</h2>
        <p class="priv-sub">Esto permite que el reproductor in-page cargue streams <code>http://</code> directo desde tu IP. <strong>Solo aplica a guia.dar2.cl</strong>, no afecta otros sitios.</p>

        <div class="priv-help-section">
          <div class="priv-help-platform">📌 Pasos en Chrome / Edge / Brave</div>
          <ol class="priv-help-steps">
            <li>Click en el ícono del candado 🔒 (a la izquierda de la URL en la barra del browser).</li>
            <li>Click en <strong>"Configuración del sitio"</strong> (o "Site settings").</li>
            <li>Buscá <strong>"Contenido inseguro"</strong> (o "Insecure content").</li>
            <li>Cambialo a <strong>"Permitir"</strong>.</li>
            <li>Volvé al sitio y recargá (Ctrl+R).</li>
          </ol>
        </div>

        <div class="priv-help-section">
          <div class="priv-help-platform">⚡ Lo que cambia después</div>
          <ul class="priv-help-steps" style="list-style:disc">
            <li>Los streams <code>http://</code> reproducen directo en el reproductor de la página.</li>
            <li><strong>Tu IP</strong> hace la conexión al server IPTV — sortea cualquier geo-block que tenga Bluehost.</li>
            <li>Sin descargas ni VLC externo.</li>
            <li>Tu sitio sigue siendo HTTPS para todo lo demás.</li>
          </ul>
        </div>

        <div class="priv-help-section">
          <div class="priv-help-platform">🔒 ¿Es seguro?</div>
          <p class="priv-help-note">El "contenido mixto" baja el nivel de seguridad SOLO para los assets que cargás del sitio (en este caso, los streams de video). Los formularios, cookies y tokens siguen protegidos por HTTPS. Para una herramienta personal como guia.dar2.cl es un trade-off razonable.</p>
        </div>

        <div class="priv-actions">
          <button type="button" class="priv-btn primary" id="priv-mixed-close">Entendido</button>
        </div>
      </div>
    `, (root) => {
      $$('#priv-mixed-close', root).onclick = closeModal;
    });
  }

  // ─── Dialog: ayuda para registrar vlc:// en Windows/Mac/Linux ──────────
  // El protocolo vlc:// no viene activo por defecto. Este dialog explica
  // cómo activarlo y permite descargar un .reg con un click (Windows).
  function dlgVlcHelp() {
    const ua = navigator.userAgent;
    const isWin = /Windows/.test(ua);
    const isMac = /Macintosh|Mac OS X/.test(ua) && !/iPad|iPhone|iPod/.test(ua);
    const isLinux = /Linux/.test(ua) && !/Android/.test(ua);
    const isAndroid = /Android/.test(ua);
    const isIOS = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
    const isMobile = isAndroid || isIOS;

    openModal(`
      <div class="priv-form-modal priv-vlc-help">
        <h2>Activar "Abrir en VLC"</h2>
        <p class="priv-sub">El protocolo <code>vlc://</code> no viene activo por defecto. Si nada se abrió, configurálo así (1 sola vez):</p>

        <div class="priv-help-section priv-help-download" style="background:linear-gradient(135deg,color-mix(in srgb,var(--accent) 12%,transparent),color-mix(in srgb,#6366f1 8%,transparent));border-color:color-mix(in srgb,var(--accent) 30%,transparent)">
          <div class="priv-help-platform">📥 ¿No tenés VLC instalado?</div>
          <p style="margin:0 0 8px;font-size:13px">Descargalo gratis desde el sitio oficial:</p>
          <a class="priv-btn primary" href="https://www.videolan.org/vlc/" target="_blank" rel="noopener noreferrer" style="text-decoration:none">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Descargar VLC (videolan.org)
          </a>
          <p class="priv-help-note">VLC es gratis, open-source y reproduce todo. Disponible para Windows, Mac, Linux, iOS y Android.</p>
        </div>


        ${isWin ? `
          <div class="priv-help-section">
            <div class="priv-help-platform">🪟 Windows</div>
            <ol class="priv-help-steps">
              <li>Click en <strong>Descargar instalador</strong> (abajo).</li>
              <li>Doble click en <code>vlc-protocol-installer.cmd</code>. Si Windows muestra "SmartScreen", click en "Más información" → "Ejecutar de todos modos".</li>
              <li>El .cmd crea un wrapper en <code>%APPDATA%\\guia\\</code> y registra <code>vlc://</code> en tu usuario (no requiere admin).</li>
              <li>Volvé al sitio y probá <strong>"Abrir en VLC"</strong>. Chrome pregunta "¿Abrir VLC?", marcá "Recordar" y abrís automático para siempre.</li>
            </ol>
            <button class="priv-btn primary" id="priv-dl-reg" style="margin-top:12px">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              Descargar instalador (.cmd)
            </button>
            <p class="priv-help-note">El instalador asume VLC en <code>C:\\Program Files\\VideoLAN\\VLC\\</code> (default). Si lo tenés en otra ruta, editá el archivo <code>%APPDATA%\\guia\\vlc-launcher.vbs</code> después de instalar.</p>
          </div>
        ` : ''}

        ${isMac ? `
          <div class="priv-help-section">
            <div class="priv-help-platform">🍎 macOS — Hacelo automático (one-time setup, 15 segundos)</div>
            <p>En Mac, "Abrir en VLC" descarga un <code>.xspf</code>. Por defecto Chrome solo lo guarda — pero podés decirle a Chrome que <strong>siempre abra .xspf con la app default</strong> (que es VLC). Después de eso, todo se abre solo:</p>
            <ol class="priv-help-steps">
              <li>Click en <strong>"Abrir en VLC"</strong> de cualquier canal o lista.</li>
              <li>Mirá la <strong>barra de descargas</strong> abajo del browser — vas a ver el archivo <code>X.xspf</code>.</li>
              <li>Click en la <strong>flecha ▼</strong> al lado del archivo (botón derecho también funciona).</li>
              <li>Marcá <strong>"Abrir siempre archivos de este tipo"</strong> (en inglés: "Always open files of this type").</li>
              <li>Click una vez en el archivo. <strong>VLC abre con la lista cargada.</strong></li>
            </ol>
            <p class="priv-help-note">A partir de ahora, cada click en "Abrir en VLC" descarga el .xspf y <strong>VLC se abre solo</strong>. Cero clicks extra.</p>
          </div>

          <div class="priv-help-section">
            <div class="priv-help-platform">🤔 ¿Por qué no abre solo desde el principio?</div>
            <p class="priv-help-note">VLC para Mac <em>debería</em> registrar el protocolo <code>vlc://</code> al instalarse para abrir directo, pero hay un bug conocido en VLC 3.x donde el registro no se aplica. Mientras VideoLAN no lo arregle, este flujo de descarga + "Always open" es lo más cerca que se puede llegar a "automático" en Mac sin Terminal.</p>
          </div>

          <div class="priv-help-section">
            <div class="priv-help-platform">🎬 ¿No tenés VLC?</div>
            <ol class="priv-help-steps">
              <li>Descargalo gratis desde <a href="https://www.videolan.org/vlc/download-macosx.html" target="_blank" rel="noreferrer noopener"><strong>videolan.org</strong></a>.</li>
              <li>Arrastralo a Aplicaciones y abrílo una vez (Mac puede pedir confirmar: <em>Sistema → Privacidad y Seguridad → Permitir</em>).</li>
              <li>Listo, podés volver al sitio.</li>
            </ol>
          </div>
        ` : ''}

        ${isLinux ? `
          <div class="priv-help-section">
            <div class="priv-help-platform">🐧 Linux</div>
            <ol class="priv-help-steps">
              <li>Crea <code>~/.local/share/applications/vlc-protocol.desktop</code> con:</li>
            </ol>
            <pre class="priv-help-code">[Desktop Entry]
Type=Application
Name=VLC Protocol
Exec=vlc %u
StartupNotify=false
MimeType=x-scheme-handler/vlc;
NoDisplay=true</pre>
            <ol class="priv-help-steps" start="2">
              <li>Ejecutá: <code>xdg-mime default vlc-protocol.desktop x-scheme-handler/vlc</code></li>
            </ol>
          </div>
        ` : ''}

        ${isAndroid ? `
          <div class="priv-help-section">
            <div class="priv-help-platform">🤖 Android</div>
            <p>Usamos <strong>Intent URLs</strong> que fuerzan abrir VLC directamente (sin que Android pregunte qué app usar).</p>
            <ol class="priv-help-steps">
              <li>Si no tenés VLC, instalalo desde <a href="https://play.google.com/store/apps/details?id=org.videolan.vlc" target="_blank" rel="noopener noreferrer"><strong>Play Store</strong></a> (gratis, "VLC for Android" oficial).</li>
              <li>Volvé al sitio y click en <strong>"Abrir en VLC"</strong>.</li>
              <li>VLC se abre automáticamente con la lista cargada. La primera vez Android puede preguntar "Permitir que el navegador abra VLC" — confirmá.</li>
            </ol>
            <p class="priv-help-note">Si VLC no está instalado, el browser te lleva al Play Store para que lo instales (browser_fallback_url). Como alternativa: el botón <strong>"Descargar"</strong> guarda el .m3u y podés abrirlo desde Files → VLC.</p>
          </div>
        ` : ''}

        ${isIOS ? `
          <div class="priv-help-section">
            <div class="priv-help-platform">📱 iOS</div>
            <p>Usamos el protocolo <code>vlc-x-callback://</code> oficial de VLC iOS.</p>
            <ol class="priv-help-steps">
              <li>Si no tenés VLC, instalalo desde el <a href="https://apps.apple.com/app/vlc-for-mobile/id650377962" target="_blank" rel="noopener noreferrer"><strong>App Store</strong></a> (gratis, "VLC for Mobile" oficial).</li>
              <li>Volvé al sitio y click en <strong>"Abrir en VLC"</strong>.</li>
              <li>iOS pregunta "¿Permitir abrir VLC?" — confirmá. VLC abre con el canal/lista.</li>
            </ol>
            <p class="priv-help-note">Si tu browser bloquea el prompt, probá desde Safari (mejor compatibilidad con URL handlers que Chrome iOS).</p>
          </div>
        ` : ''}

        <div class="priv-help-section">
          <div class="priv-help-platform">💡 Alternativa siempre funciona</div>
          <p>Si no querés tocar el sistema, usá el botón <strong>"Descargar"</strong>: te baja el archivo <code>.m3u</code> y al hacer doble click sobre él Windows/Mac lo abre con VLC sin necesidad de configurar nada.</p>
        </div>

        <div class="priv-actions">
          <button type="button" class="priv-btn primary" id="priv-help-close">Entendido</button>
        </div>
      </div>
    `, (root) => {
      $$('#priv-help-close', root).onclick = closeModal;
      const regBtn = $$('#priv-dl-reg', root);
      if (regBtn) regBtn.onclick = () => {
        // Instalador .cmd que crea un .vbs en %APPDATA%\guia\ y registra
        // el protocolo "vlc:" en HKCU (sin admin). El VBS soporta dos
        // formatos:
        //   • vlc:b64,BASE64URL  → decodifica y pasa la URL real a vlc.exe
        //   • vlc://URL          → strippea el prefijo (legacy fallback)
        // El formato base64 es necesario porque Windows normaliza dobles
        // slashes y rompe "vlc://https://..." → "vlc://https//...".
        // El instalador es self-contained: no require descargar archivos
        // separados, todo el VBS se inyecta línea por línea.
        // VBS válido — la concatenación en VBScript es "&" (no "^&"). El "^"
        // se agrega DESPUÉS al hacer escape para cmd echo. Bug previo: tenía
        // ^& en el VBS final y eso es sintaxis inválida (^ es power operator
        // en VBS, requiere operandos numéricos).
        const vbsLines = [
          '\' guia.dar2.cl — VLC URL launcher',
          '\' Recibe vlc:b64,XXX (Windows) o vlc://URL, decodifica, y abre VLC.',
          '\' Si la URL es a /proxy.php?action=m3u_raw, descarga el .m3u a temp file',
          '\' antes (VLC abre el archivo local en lugar de pegarle a una URL HTTPS',
          '\' con tokens, que VLC no maneja siempre bien).',
          '',
          'Function Base64Decode(s)',
          '  Dim x',
          '  x = Replace(s, "-", "+")',
          '  x = Replace(x, "_", "/")',
          '  Do While Len(x) Mod 4 <> 0',
          '    x = x & "="',
          '  Loop',
          '  Dim doc, node, bytes, st',
          '  Set doc = CreateObject("Microsoft.XMLDOM")',
          '  Set node = doc.createElement("b")',
          '  node.dataType = "bin.base64"',
          '  node.text = x',
          '  bytes = node.nodeTypedValue',
          '  Set st = CreateObject("ADODB.Stream")',
          '  st.Type = 1',
          '  st.Open',
          '  st.Write bytes',
          '  st.Position = 0',
          '  st.Type = 2',
          '  st.Charset = "utf-8"',
          '  Base64Decode = st.ReadText',
          '  st.Close',
          'End Function',
          '',
          'Function Pad2(n)',
          '  If n < 10 Then',
          '    Pad2 = "0" & n',
          '  Else',
          '    Pad2 = "" & n',
          '  End If',
          'End Function',
          '',
          'Function Timestamp()',
          '  Timestamp = Year(Now) & Pad2(Month(Now)) & Pad2(Day(Now)) & Pad2(Hour(Now)) & Pad2(Minute(Now)) & Pad2(Second(Now))',
          'End Function',
          '',
          '\' Crea HTTP client probando varias versiones para máxima compat.',
          'Function MakeHttp()',
          '  On Error Resume Next',
          '  Dim h',
          '  Set h = CreateObject("MSXML2.ServerXMLHTTP.6.0")',
          '  If Err.Number = 0 Then Set MakeHttp = h : Exit Function',
          '  Err.Clear',
          '  Set h = CreateObject("MSXML2.ServerXMLHTTP")',
          '  If Err.Number = 0 Then Set MakeHttp = h : Exit Function',
          '  Err.Clear',
          '  Set h = CreateObject("MSXML2.XMLHTTP.6.0")',
          '  If Err.Number = 0 Then Set MakeHttp = h : Exit Function',
          '  Err.Clear',
          '  Set h = CreateObject("MSXML2.XMLHTTP")',
          '  If Err.Number = 0 Then Set MakeHttp = h : Exit Function',
          '  Set MakeHttp = Nothing',
          'End Function',
          '',
          '\' Descarga URL al disco. Devuelve path local o "" si falla.',
          'Function FetchToTempFile(url, errorMsg)',
          '  Dim http, fso, tempDir, tempPath, st',
          '  errorMsg = ""',
          '  Set http = MakeHttp()',
          '  If http Is Nothing Then',
          '    errorMsg = "MSXML no disponible"',
          '    FetchToTempFile = ""',
          '    Exit Function',
          '  End If',
          '  On Error Resume Next',
          '  http.Open "GET", url, False',
          '  http.setRequestHeader "Accept", "*/*"',
          '  http.Send',
          '  If Err.Number <> 0 Then',
          '    errorMsg = "Fetch falló: " & Err.Description',
          '    FetchToTempFile = ""',
          '    Exit Function',
          '  End If',
          '  If http.Status <> 200 Then',
          '    errorMsg = "HTTP " & http.Status & " del server"',
          '    FetchToTempFile = ""',
          '    Exit Function',
          '  End If',
          '  Set fso = CreateObject("Scripting.FileSystemObject")',
          '  tempDir = fso.GetSpecialFolder(2).Path',
          '  tempPath = tempDir & "\\guia-list-" & Timestamp() & ".m3u"',
          '  Set st = CreateObject("ADODB.Stream")',
          '  st.Type = 1',
          '  st.Open',
          '  st.Write http.responseBody',
          '  st.SaveToFile tempPath, 2',
          '  st.Close',
          '  If Err.Number <> 0 Then',
          '    errorMsg = "No se pudo guardar archivo temporal"',
          '    FetchToTempFile = ""',
          '    Exit Function',
          '  End If',
          '  FetchToTempFile = tempPath',
          'End Function',
          '',
          '\' ─── Main ─────────────────────────────────────────────────────',
          'Set shell = CreateObject("WScript.Shell")',
          'arg = WScript.Arguments(0)',
          'url = ""',
          '',
          'If InStr(arg, "vlc:b64,") = 1 Then',
          '  url = Base64Decode(Mid(arg, 9))',
          'ElseIf InStr(arg, "vlc://") = 1 Then',
          '  url = Mid(arg, 7)',
          '  If InStr(url, "https//") = 1 Then url = "https://" & Mid(url, 8)',
          '  If InStr(url, "http//") = 1 Then url = "http://" & Mid(url, 7)',
          'ElseIf InStr(arg, "vlc:") = 1 Then',
          '  url = Mid(arg, 5)',
          'Else',
          '  url = arg',
          'End If',
          '',
          'If Len(url) = 0 Then',
          '  MsgBox "URL vacía después de decodificar.", 16, "guia.dar2.cl"',
          '  WScript.Quit',
          'End If',
          '',
          '\' Detectar VLC',
          'Dim vlcPath, fsoMain',
          'Set fsoMain = CreateObject("Scripting.FileSystemObject")',
          'vlcPath = "C:\\Program Files\\VideoLAN\\VLC\\vlc.exe"',
          'If Not fsoMain.FileExists(vlcPath) Then',
          '  vlcPath = "C:\\Program Files (x86)\\VideoLAN\\VLC\\vlc.exe"',
          '  If Not fsoMain.FileExists(vlcPath) Then',
          '    MsgBox "VLC no encontrado en C:\\Program Files\\VideoLAN\\VLC\\." & vbCrLf & vbCrLf & "Descargá VLC desde https://www.videolan.org/vlc/", 16, "guia.dar2.cl"',
          '    WScript.Quit',
          '  End If',
          'End If',
          '',
          '\' Si es lista del proxy, descargar a temp file primero',
          'Dim finalArg, fetchErr',
          'finalArg = url',
          'If InStr(url, "action=m3u_raw") > 0 Then',
          '  fetchErr = ""',
          '  Dim tempPath',
          '  tempPath = FetchToTempFile(url, fetchErr)',
          '  If Len(tempPath) > 0 Then',
          '    finalArg = tempPath',
          '  Else',
          '    MsgBox "No se pudo descargar la lista." & vbCrLf & vbCrLf & "Detalle: " & fetchErr & vbCrLf & vbCrLf & "URL: " & url, 16, "guia.dar2.cl"',
          '    WScript.Quit',
          '  End If',
          'End If',
          '',
          '\' Abrir VLC con argumento (path local o URL stream)',
          'shell.Run """" & vlcPath & """ """ & finalArg & """", 1, False',
        ];
        // Approach a prueba de bugs: el VBS completo se codifica en base64
        // (sin caracteres problemáticos para cmd) y PowerShell lo decodifica
        // y escribe al archivo. Cmd nunca tiene que escapar `&`, `<`, `>`, etc.
        const vbsContent = vbsLines.join('\r\n');
        // base64 estándar (no url-safe)
        const utf8 = new TextEncoder().encode(vbsContent);
        let bin = '';
        for (let i = 0; i < utf8.length; i++) bin += String.fromCharCode(utf8[i]);
        const b64 = btoa(bin);
        const cmd = `@echo off\r
title Guia.dar2.cl - Instalar handler vlc://\r
echo.\r
echo ============================================\r
echo  Guia.dar2.cl - Setup vlc:// (sin admin)\r
echo ============================================\r
echo.\r
\r
set "TARGET_DIR=%APPDATA%\\guia"\r
set "TARGET=%TARGET_DIR%\\vlc-launcher.vbs"\r
if not exist "%TARGET_DIR%" mkdir "%TARGET_DIR%"\r
\r
REM El VBS va embebido como base64. PowerShell lo decodifica y escribe.\r
REM Esto evita todos los problemas de escape de cmd echo.\r
set "VBSB64=${b64}"\r
\r
echo [1/3] Escribiendo wrapper VBS en %TARGET% ...\r
powershell -NoProfile -Command "[IO.File]::WriteAllText('%TARGET%', [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:VBSB64)))"\r
if not exist "%TARGET%" (\r
  echo X Error: no se pudo crear el VBS. Tenes PowerShell?\r
  pause\r
  exit /b 1\r
)\r
\r
echo [2/3] Registrando protocolo vlc:// en HKCU ...\r
reg add "HKCU\\Software\\Classes\\vlc" /f /ve /d "URL:VLC Protocol" >nul\r
reg add "HKCU\\Software\\Classes\\vlc" /f /v "URL Protocol" /d "" >nul\r
reg add "HKCU\\Software\\Classes\\vlc\\shell\\open\\command" /f /ve /d "wscript.exe \\"%TARGET%\\" \\"%%1\\"" >nul\r
\r
echo [3/3] Verificando ...\r
where vlc.exe >nul 2>&1\r
if errorlevel 1 (\r
  if not exist "C:\\Program Files\\VideoLAN\\VLC\\vlc.exe" (\r
    if not exist "C:\\Program Files (x86)\\VideoLAN\\VLC\\vlc.exe" (\r
      echo.\r
      echo ATENCION: VLC no esta en su ruta default.\r
      echo Edita "%TARGET%" y cambia el path de vlc.exe.\r
      echo.\r
    )\r
  )\r
)\r
\r
echo.\r
echo ============================================\r
echo  OK Listo. vlc:// queda registrado.\r
echo ============================================\r
echo.\r
echo Probalo desde guia.dar2.cl - boton "Abrir en VLC".\r
echo Chrome te pregunta la primera vez - marca "Recordar".\r
echo.\r
pause\r
`;
        triggerDownload(cmd, 'vlc-protocol-installer.cmd', 'application/octet-stream');
      };
    });
  }

  // ─── Diálogo de error de stream + diagnóstico + alternativas ───────────
  // Llamado desde app.js cuando el <video> falla con un canal privado.
  // Hace teststream contra el server y muestra un mensaje legible al user
  // con sugerencias (otro canal, abrir en VLC, etc).
  // Test desde el browser del cliente. Hace DOS fetches:
  //   1. no-cors → ¿llega TCP/HTTP al server? (independiente de CORS)
  //   2. cors    → ¿el server envía Access-Control-Allow-Origin? Necesario
  //                para que HLS.js pueda LEER el playlist (no solo cargarlo).
  //
  // 4 estados posibles:
  //   • canConnect=T, canCors=T → debería reproducir in-page sin problema
  //   • canConnect=T, canCors=F → server llega pero sin CORS → solo VLC/extensión
  //   • canConnect=F             → mixed content / DNS / firewall del cliente
  async function clientReachTest(url) {
    const result = { canConnect: false, canCors: false, err: null, time_ms: 0 };
    const t0 = performance.now();

    // Test 1: no-cors (solo verificar conectividad)
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 6000);
      await fetch(url, { method: 'GET', mode: 'no-cors', signal: ctrl.signal, cache: 'no-store' });
      clearTimeout(timer);
      result.canConnect = true;
    } catch (err) {
      result.err = err.name + (err.message ? ': ' + err.message : '');
      result.time_ms = Math.round(performance.now() - t0);
      return result; // si no-cors fallo, no tiene sentido probar cors
    }

    // Test 2: cors (verificar que HLS.js pueda leer el playlist)
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 6000);
      await fetch(url, { method: 'GET', mode: 'cors', signal: ctrl.signal, cache: 'no-store' });
      clearTimeout(timer);
      result.canCors = true;
    } catch (err) {
      // no-cors funcionó pero cors falló = el server no envía CORS headers.
      // Eso es exactamente por qué HLS.js falla aunque la URL sea alcanzable.
      result.corsErr = err.name + (err.message ? ': ' + err.message.substring(0, 80) : '');
    }

    result.time_ms = Math.round(performance.now() - t0);
    return result;
  }

  window.showPrivateStreamError = async function (originalUrl, channelName, opts) {
    if (!originalUrl) return;
    const token = getToken();
    const isHttp = opts && opts.isHttp;
    // Detectar caso especial: HTTP + IP literal (sin DNS). Chrome bloquea
    // esto en <video> sin importar el setting de "Contenido inseguro".
    // Es el caso típico de IPTV pirata: http://181.78.201.70:8000/...
    const isHttpIp = isHttp && /^http:\/\/(\d{1,3}\.){3}\d{1,3}(:\d+)?\//i.test(originalUrl);

    // ⚡ Para HTTP+IP: dialog SIMPLE (sin diagnóstico, sin banner extenso).
    // Chrome bloquea hard, no hay nada que diagnosticar — solo ofrecer VLC.
    if (isHttpIp) {
      openModal(`
        <div class="priv-form-modal">
          <div class="priv-stream-err">
            <div class="priv-stream-err-icon" style="background:color-mix(in srgb, #f59e0b 14%, transparent);color:#f59e0b;border-color:color-mix(in srgb, #f59e0b 35%, transparent)">
              <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
            </div>
            <h2>${escapeHtml(channelName || 'Canal')}</h2>
            <p style="margin:6px 0 14px;color:var(--muted);font-size:14px;line-height:1.5;text-align:center">
              Chrome no permite reproducir este tipo de canal in-page<br>
              (URL <code>http://</code> con IP numérica).
            </p>
            <p style="margin:0 0 18px;font-size:13px;line-height:1.5;text-align:center;color:var(--text)">
              <strong>VLC sí puede</strong> — abrelo con un click:
            </p>
            <div class="priv-stream-actions">
              <button class="priv-btn primary" id="priv-open-vlc">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px"><polygon points="11.5 7 16 12 11.5 17"/><circle cx="12" cy="12" r="10"/></svg>
                Abrir en VLC
              </button>
              <button class="priv-btn ghost" id="priv-download-m3u">Descargar .m3u</button>
              <button class="priv-btn ghost" id="priv-stream-close">Cerrar</button>
            </div>
            <div style="margin-top:12px;display:flex;justify-content:center;gap:14px;font-size:12px">
              <a href="https://www.videolan.org/vlc/" target="_blank" rel="noopener noreferrer" style="color:var(--muted);text-decoration:underline;text-decoration-style:dotted">📥 Descargar VLC</a>
              <span style="color:var(--muted)">·</span>
              <button class="priv-stream-help" id="priv-stream-help" style="display:inline;margin:0;padding:0">¿VLC no se abre? Configurarlo</button>
            </div>
          </div>
        </div>
      `, (root) => {
        $$('#priv-stream-close', root).onclick = closeModal;
        $$('#priv-open-vlc', root).onclick = () => {
          // Solo dispara vlc://, sin descargar archivo. El user que quiera
          // el .m3u tiene el botón aparte.
          openInVlc(originalUrl);
        };
        $$('#priv-download-m3u', root).onclick = () => {
          const safe = (channelName || 'canal').replace(/[^\w\-]+/g, '_').slice(0, 40);
          downloadM3u([{ name: channelName || 'Canal', url: originalUrl }], safe + '.m3u');
        };
        $$('#priv-stream-help', root).onclick = () => dlgVlcHelp();
      });
      return;
    }

    let banner = '';
    if (isHttpIp) {
      // Caso más común y problemático — mensaje claro y solución directa.
      banner = `
        <div class="priv-mixed-banner priv-banner-blocked">
          <div class="priv-mixed-banner-icon">🛡️</div>
          <div class="priv-mixed-banner-body">
            <strong>Chrome bloqueó este video por seguridad</strong>
            <p>La URL es <code>http://</code> con una IP numérica (no dominio). Chrome <strong>siempre</strong> bloquea esto en elementos <code>&lt;video&gt;</code>, sin importar el setting de "Contenido inseguro" que activaste. <strong>No hay fix desde el browser</strong> para esta combinación.</p>
            <p style="margin-top:8px"><strong>Soluciones que sí funcionan:</strong></p>
            <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
              <button class="priv-btn primary" id="priv-vps-help">📡 VPS LatAm (definitivo)</button>
              <button class="priv-btn ghost" id="priv-vlc-info">🎬 Abrir en VLC (ahora)</button>
            </div>
          </div>
        </div>
      `;
    } else if (isHttp) {
      banner = `
        <div class="priv-mixed-banner">
          <div class="priv-mixed-banner-icon">⚡</div>
          <div class="priv-mixed-banner-body">
            <strong>Solución más simple</strong>
            <p>Esta lista usa <code>http://</code>. Habilita "contenido mixto" para guia.dar2.cl y los canales reproducirán <strong>directo desde tu IP</strong>, sortando el geo-block de Bluehost.</p>
            <button class="priv-btn primary" id="priv-mixed-btn">Cómo habilitarlo →</button>
          </div>
        </div>
      `;
    }
    const httpBanner = banner;
    openModal(`
      <div class="priv-form-modal">
        <div class="priv-stream-err">
          <div class="priv-stream-err-icon">
            <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          </div>
          <h2>${escapeHtml(channelName || 'Canal')} no se reprodujo</h2>
          ${httpBanner}
          <div class="priv-stream-diag" id="priv-stream-diag">
            <span class="priv-spinner-inline"></span> Diagnosticando desde tu PC y desde el server…
          </div>
          <div class="priv-stream-actions">
            <button class="priv-btn primary" id="priv-open-vlc">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px"><polygon points="11.5 7 16 12 11.5 17"/><circle cx="12" cy="12" r="10"/></svg>
              Abrir en VLC
            </button>
            <button class="priv-btn ghost" id="priv-download-m3u">Descargar .m3u</button>
            <button class="priv-btn ghost" id="priv-copy-url">Copiar URL</button>
            <button class="priv-btn ghost" id="priv-stream-close">Cerrar</button>
          </div>
          <button class="priv-stream-help" id="priv-stream-help">¿VLC no se abre automáticamente?</button>
        </div>
      </div>
    `, (root) => {
      $$('#priv-stream-close', root).onclick = closeModal;
      $$('#priv-open-vlc', root).onclick = () => {
        // Solo dispara vlc://. El "Descargar .m3u" tiene su botón aparte.
        openInVlc(originalUrl);
      };
      $$('#priv-download-m3u', root).onclick = () => {
        const safe = (channelName || 'canal').replace(/[^\w\-]+/g, '_').slice(0, 40);
        downloadM3u([{ name: channelName || 'Canal', url: originalUrl }], safe + '.m3u');
      };
      $$('#priv-copy-url', root).onclick = async () => {
        try {
          await navigator.clipboard.writeText(originalUrl);
          $$('#priv-copy-url', root).textContent = 'Copiado ✓';
          setTimeout(() => { const b = $$('#priv-copy-url', root); if (b) b.textContent = 'Copiar URL'; }, 1500);
        } catch {
          alert('URL: ' + originalUrl);
        }
      };
      $$('#priv-stream-help', root).onclick = () => dlgVlcHelp();
      const mixedBtn = $$('#priv-mixed-btn', root);
      if (mixedBtn) mixedBtn.onclick = () => dlgMixedContentHelp();
      const vpsBtn = $$('#priv-vps-help', root);
      if (vpsBtn) vpsBtn.onclick = () => dlgVpsSetupHelp();
      const vlcInfoBtn = $$('#priv-vlc-info', root);
      if (vlcInfoBtn) vlcInfoBtn.onclick = () => {
        // Trigger el botón "Abrir en VLC" del mismo dialog
        const realBtn = document.getElementById('priv-open-vlc');
        if (realBtn) realBtn.click();
      };
    });

    // Hacer DOS tests en paralelo:
    // 1. Server (Bluehost) → ¿llega al canal? (teststream)
    // 2. Cliente (tu PC) → ¿llega al canal con tu IP?
    if (!token) {
      const diag = document.getElementById('priv-stream-diag');
      if (diag) diag.innerHTML = '<strong>Sin sesión activa.</strong> Volvé a entrar al acceso privado para diagnosticar.';
      return;
    }
    try {
      const u64 = b64urlEncode(originalUrl);
      const [serverResult, clientResult] = await Promise.all([
        fetch(PROXY + '?action=teststream&token=' + encodeURIComponent(token) + '&u=' + u64).then(r => r.json()).catch(e => ({ works: false, error: e.message })),
        clientReachTest(originalUrl),
      ]);
      const data = serverResult;
      const diag = document.getElementById('priv-stream-diag');
      if (!diag) return;

      // Render del bloque "Tu PC" — distingue 3 estados:
      //   • OK + CORS → todo bien (raro que falle el video acá)
      //   • OK pero sin CORS → el server llega pero no autoriza al browser
      //   • No conecta → mixed content / DNS / firewall
      let clientStatusIcon, clientStatusClass, clientHint;
      if (clientResult.canConnect && clientResult.canCors) {
        clientStatusIcon = '✓';
        clientStatusClass = 'ok-row';
        clientHint = `Conectó al server en ${clientResult.time_ms}ms con CORS OK. Si el video no reprodujo es por un detalle del HLS playlist — probá otro canal.`;
      } else if (clientResult.canConnect && !clientResult.canCors) {
        clientStatusIcon = '⚠';
        clientStatusClass = 'warn-row';
        clientHint = `Conectó al server en ${clientResult.time_ms}ms <strong>pero el server no permite CORS</strong>. El browser puede llegar pero HLS.js no puede leer el playlist. <strong>Para reproducir in-page necesitás una extensión de Chrome que parchee CORS</strong> (ver botón abajo). Como alternativa: el botón "Abrir en VLC" de abajo funciona perfecto.`;
      } else {
        clientStatusIcon = '✗';
        clientStatusClass = 'err-row';
        const e = clientResult.err || '';
        clientHint = e.includes('Failed to fetch') || e.includes('NetworkError')
          ? (isHttp
              ? `<strong>Tu browser bloqueó la conexión http://</strong> (mixed content). Verificá que en el candado 🔒 → "Contenido inseguro" esté en "Permitir" y hacé hard refresh (Ctrl+Shift+R).`
              : 'Error de red. Server caído, IP en blocklist del browser, o algún firewall del cliente.')
          : e.substring(0, 120);
      }
      const clientBlock = `
        <div class="priv-diag-row priv-diag-${clientStatusClass}">
          <div class="priv-diag-icon">${clientStatusIcon}</div>
          <div class="priv-diag-text">
            <strong>Tu PC</strong>
            <span class="priv-diag-hint">${clientHint}</span>
          </div>
        </div>`;

      // Render del bloque "Server (Bluehost)"
      let serverBlock;

      if (data.works) {
        serverBlock = `
          <div class="priv-diag-row priv-diag-ok-row">
            <div class="priv-diag-icon">✓</div>
            <div class="priv-diag-text">
              <strong>Server (Bluehost)</strong>
              <span class="priv-diag-hint">Llega al canal sin problema.</span>
            </div>
          </div>`;
      } else {
        const errs = (data.all_attempts || []).map(a => a.error).filter(Boolean);
        const isRefused  = errs.some(e => /refused/i.test(e));
        const isTimeout  = errs.some(e => /timeout|timed out/i.test(e));
        const isDNS      = errs.some(e => /resolve|dns|name/i.test(e));
        const isCert     = errs.some(e => /cert|ssl/i.test(e));
        const status403  = (data.all_attempts || []).some(a => a.http_code === 403 || a.http_code === 401);

        let serverHint;
        if (isRefused)        serverHint = '<strong>Bloqueado por firewall del server</strong>. Connection refused desde Bluehost (US). El server solo acepta IPs específicas (probablemente Argentina/Chile residenciales).';
        else if (status403)   serverHint = 'Acceso denegado (HTTP 403). Geo-block del server.';
        else if (isTimeout)   serverHint = 'Timeout. El server está caído o el firewall descarta paquetes.';
        else if (isDNS)       serverHint = 'DNS no resuelve. Host posiblemente desaparecido.';
        else if (isCert)      serverHint = 'Certificado SSL inválido.';
        else                  serverHint = 'Error desconocido.';

        serverBlock = `
          <div class="priv-diag-row priv-diag-err-row">
            <div class="priv-diag-icon">✗</div>
            <div class="priv-diag-text">
              <strong>Server (Bluehost)</strong>
              <span class="priv-diag-hint">${serverHint}</span>
            </div>
          </div>`;
      }

      // Conclusión global — basada en la combinación cliente × server.
      // Distingue ahora el caso "client conecta pero sin CORS" que es muy
      // común con servers IPTV pirata.
      let conclusion;
      let actionHtml = '';
      const clientWorks = clientResult.canConnect && clientResult.canCors;
      const clientPartial = clientResult.canConnect && !clientResult.canCors;

      if (clientWorks) {
        conclusion = '<strong>Tu PC llega y CORS está OK</strong>. El error fue otro detalle del playlist HLS — probá otro canal o reintentá.';
      } else if (clientPartial) {
        conclusion = '<strong>El server existe y responde, pero no permite CORS</strong>. El browser puede conectar pero HLS.js no puede leer el playlist. Tenés 3 opciones:';
        actionHtml = `
          <div class="priv-diag-actions">
            <button class="priv-btn primary" id="priv-cors-ext-help">Instalar extensión de CORS (Chrome)</button>
            <span class="priv-diag-or">o</span>
            <span style="font-size:12.5px;color:var(--muted)">usá el botón <strong>"Abrir en VLC"</strong> abajo</span>
          </div>
          <p class="priv-diag-or-note">Para una solución sin extensión: VPS chico en LatAm con <code>proxy.php</code> (devuelve CORS). ~$3/mes.</p>
        `;
      } else if (data.works) {
        conclusion = '<strong>Bluehost sí llega pero tu browser no</strong>. El proxy debería estar funcionando entonces — si igual ves este dialog, hacé <strong>Ctrl+Shift+R</strong> y reintentá. Si persiste: verificá "Contenido inseguro" en el candado 🔒.';
      } else {
        conclusion = '<strong>Ni tu PC ni Bluehost llegan al server del canal</strong>. El server probablemente está caído o cambió de IP. Si la lista era de tecnotv.club: actualizá la URL en el panel admin (suele cambiar mes a mes <code>/may02/</code> → <code>/jun02/</code>).';
      }

      diag.innerHTML = `
        ${clientBlock}
        ${serverBlock}
        <div class="priv-diag-conclusion">${conclusion}</div>
        ${actionHtml}
        <details class="priv-diag-details">
          <summary>Detalle técnico</summary>
          <pre>${escapeHtml(JSON.stringify({ client: clientResult, server: data }, null, 2))}</pre>
        </details>
      `;
      const mh = document.getElementById('priv-mixed-help');
      if (mh) mh.onclick = () => dlgMixedContentHelp();
      const corsBtn = document.getElementById('priv-cors-ext-help');
      if (corsBtn) corsBtn.onclick = () => dlgCorsExtensionHelp();
    } catch (err) {
      const diag = document.getElementById('priv-stream-diag');
      if (diag) diag.innerHTML = '<strong>No se pudo diagnosticar.</strong> ' + escapeHtml(err.message || 'Error de red.');
    }
  };

  // Expone para que app.js pueda saber la URL original de un canal privado.
  // Soporta ambos casos:
  //   • URL proxied: /proxy.php?action=stream&u=BASE64URL → decodifica
  //   • URL directa (HTTPS): la URL original es la misma que se está cargando
  window.getPrivateOriginalUrl = function (urlOrProxiedUrl, channelObj) {
    // Si nos pasaron el objeto del canal con _originalUrl, usá ese.
    if (channelObj && channelObj._originalUrl) return channelObj._originalUrl;
    if (!urlOrProxiedUrl) return null;
    // ¿Es una URL proxied? Decodificar.
    if (urlOrProxiedUrl.indexOf('action=stream') !== -1) {
      try {
        const u = new URL(urlOrProxiedUrl, location.origin);
        const enc = u.searchParams.get('u');
        if (!enc) return null;
        let s = enc.replace(/-/g, '+').replace(/_/g, '/');
        while (s.length % 4) s += '=';
        const bin = atob(s);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new TextDecoder().decode(bytes);
      } catch { return null; }
    }
    // Es URL directa (HTTPS), la original es la misma.
    return urlOrProxiedUrl;
  };

  // ─── Entry point ────────────────────────────────────────────────────────
  window.openPrivateAccess = function () {
    if (loadSession()) { dlgViewer(); return; }
    dlgLogin(() => dlgViewer());
  };

  // Al cargar, sincroniza el botón quick.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', updateQuickButton);
  } else {
    updateQuickButton();
  }
})();
