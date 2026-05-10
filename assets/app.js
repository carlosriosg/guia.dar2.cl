(() => {
  'use strict';

  const STORAGE_KEY = 'guia.dar2.v1';
  const $ = (sel, root = document) => root.querySelector(sel);
  const app = $('#app');
  const dlg = $('#dlg');
  const fileInput = $('#file-import');

  const state = {
    profiles: [],
    currentId: null,
    editing: false,
    query: '',
    menuOpen: false,
    installPrompt: null,
    news: { items: [], cursor: 0 },
    tv: {
      currentId: null,
      // Migración: si había volumen guardado de la versión "radio" (v14 ↓), lo reusamos.
      volume: parseFloat(localStorage.getItem('guia.tv.vol') || localStorage.getItem('guia.radio.vol') || '0.7'),
    },
  };

  // Captura el evento de Chrome/Edge para ofrecer "Instalar" en el menú.
  // En iOS Safari no existe; ahí el usuario instala desde Compartir → Añadir a inicio.
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.installPrompt = e;
    if (state.currentId) render();
  });
  window.addEventListener('appinstalled', () => {
    state.installPrompt = null;
    if (state.currentId) render();
  });

  // Registra el service worker para arranque offline e instalación PWA.
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    });
  }

  // ─── Cache (widgets) ──────────────────────────────────────────────────────
  const CACHE_KEY = 'guia.dar2.cache.v1';
  function getCacheAll() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); } catch { return {}; }
  }
  function getCached(key) {
    const c = getCacheAll();
    const e = c[key];
    if (e && e.exp > Date.now()) return e.v;
    return null;
  }
  function setCached(key, value, ttlMs) {
    const c = getCacheAll();
    c[key] = { v: value, exp: Date.now() + ttlMs };
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch {}
  }

  async function fetchJSON(url, timeoutMs = 6000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { signal: ctrl.signal, credentials: 'omit' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } finally { clearTimeout(t); }
  }

  async function loadWeather(city) {
    const key = `wx2-${city.lat},${city.lon}`;
    const cached = getCached(key);
    if (cached) return cached;
    const params = [
      'current=temperature_2m,weather_code,apparent_temperature,wind_speed_10m,relative_humidity_2m',
      'daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max',
      'forecast_days=7',
      'timezone=auto',
    ].join('&');
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}&${params}`;
    const data = await fetchJSON(url);
    const cur = data?.current || {};
    const dly = data?.daily || {};
    const round = (n) => (typeof n === 'number') ? Math.round(n) : null;
    const out = {
      temp: round(cur.temperature_2m),
      code: cur.weather_code,
      feels: round(cur.apparent_temperature),
      wind: round(cur.wind_speed_10m),
      humidity: cur.relative_humidity_2m ?? null,
      daily: (dly.time || []).map((t, i) => ({
        date: t,
        max: round(dly.temperature_2m_max?.[i]),
        min: round(dly.temperature_2m_min?.[i]),
        code: dly.weather_code?.[i],
        precip: dly.precipitation_probability_max?.[i] ?? 0,
      })),
    };
    if (out.temp !== null) setCached(key, out, 30 * 60 * 1000);
    return out;
  }

  // Iconos SVG inline para condiciones de clima. Pequeños, monocromáticos
  // donde corresponde, color natural donde aporta (sol amarillo, lluvia azul).
  const WX_ICONS = {
    sun: `<svg viewBox="0 0 24 24" class="wx-icon" aria-hidden="true"><circle cx="12" cy="12" r="5" fill="#fbbf24"/><g stroke="#fbbf24" stroke-width="2" stroke-linecap="round"><line x1="12" y1="2" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22"/><line x1="2" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22" y2="12"/><line x1="4.93" y1="4.93" x2="6.34" y2="6.34"/><line x1="17.66" y1="17.66" x2="19.07" y2="19.07"/><line x1="4.93" y1="19.07" x2="6.34" y2="17.66"/><line x1="17.66" y1="6.34" x2="19.07" y2="4.93"/></g></svg>`,
    partlyCloudy: `<svg viewBox="0 0 24 24" class="wx-icon" aria-hidden="true"><circle cx="9" cy="8" r="3.5" fill="#fbbf24"/><path d="M18 19a4 4 0 0 0 .56-7.96A6 6 0 0 0 7.16 9.34 4.5 4.5 0 1 0 6.5 19z" fill="#94a3b8"/></svg>`,
    cloud: `<svg viewBox="0 0 24 24" class="wx-icon" aria-hidden="true"><path d="M18 18a4 4 0 0 0 .56-7.96A6 6 0 0 0 7.16 8.34 4.5 4.5 0 1 0 6.5 18z" fill="#94a3b8"/></svg>`,
    rain: `<svg viewBox="0 0 24 24" class="wx-icon" aria-hidden="true"><path d="M18 14a4 4 0 0 0 .56-7.96A6 6 0 0 0 7.16 4.34 4.5 4.5 0 1 0 6.5 14z" fill="#94a3b8"/><g stroke="#3b82f6" stroke-width="2" stroke-linecap="round"><line x1="8" y1="17" x2="7" y2="20"/><line x1="12" y1="17" x2="11" y2="20"/><line x1="16" y1="17" x2="15" y2="20"/></g></svg>`,
    snow: `<svg viewBox="0 0 24 24" class="wx-icon" aria-hidden="true"><path d="M18 14a4 4 0 0 0 .56-7.96A6 6 0 0 0 7.16 4.34 4.5 4.5 0 1 0 6.5 14z" fill="#94a3b8"/><g fill="#e5e7eb"><circle cx="8" cy="19" r="1.3"/><circle cx="12" cy="19" r="1.3"/><circle cx="16" cy="19" r="1.3"/></g></svg>`,
    storm: `<svg viewBox="0 0 24 24" class="wx-icon" aria-hidden="true"><path d="M18 13a4 4 0 0 0 .56-7.96A6 6 0 0 0 7.16 3.34 4.5 4.5 0 1 0 6.5 13z" fill="#64748b"/><path d="M13 13l-3 6h2l-1 4 4-7h-2l1-3z" fill="#fbbf24"/></svg>`,
    fog: `<svg viewBox="0 0 24 24" class="wx-icon" aria-hidden="true"><g stroke="#94a3b8" stroke-width="2" stroke-linecap="round"><line x1="3" y1="8" x2="21" y2="8"/><line x1="5" y1="12" x2="19" y2="12"/><line x1="3" y1="16" x2="21" y2="16"/><line x1="6" y1="20" x2="18" y2="20"/></g></svg>`,
  };
  function wxIcon(code) {
    if (code === 0) return WX_ICONS.sun;
    if (code === 1 || code === 2) return WX_ICONS.partlyCloudy;
    if (code === 3) return WX_ICONS.cloud;
    if (code === 45 || code === 48) return WX_ICONS.fog;
    if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return WX_ICONS.rain;
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return WX_ICONS.snow;
    if (code >= 95) return WX_ICONS.storm;
    return WX_ICONS.cloud;
  }

  function wxDesc(code) {
    if (code === 0) return 'Despejado';
    if (code === 1) return 'Mayormente despejado';
    if (code === 2) return 'Parcialmente nublado';
    if (code === 3) return 'Nublado';
    if (code === 45 || code === 48) return 'Niebla';
    if (code === 51) return 'Llovizna ligera';
    if (code === 53) return 'Llovizna moderada';
    if (code === 55) return 'Llovizna intensa';
    if (code === 56 || code === 57) return 'Llovizna helada';
    if (code === 61) return 'Lluvia ligera';
    if (code === 63) return 'Lluvia moderada';
    if (code === 65) return 'Lluvia fuerte';
    if (code === 66 || code === 67) return 'Lluvia helada';
    if (code === 71) return 'Nieve ligera';
    if (code === 73) return 'Nieve moderada';
    if (code === 75) return 'Nieve fuerte';
    if (code === 77) return 'Granos de nieve';
    if (code >= 80 && code <= 82) return 'Chubascos';
    if (code === 85 || code === 86) return 'Chubascos de nieve';
    if (code === 95) return 'Tormenta';
    if (code === 96 || code === 99) return 'Tormenta con granizo';
    return '—';
  }

  // ─── TV en vivo y radios ──────────────────────────────────────────────────
  // El elemento <video> reproduce tanto video (HLS) como audio (.aac/.audio
  // directos). Cuando una entrada es kind:'radio' (audio-only) mantenemos el
  // badge LIVE visible en lugar del frame negro.
  // Canales TV: lista curada de https://github.com/Alplox/json-teles.
  // Radios: listado del XLSX de Carlos (chilenas, ordenadas alfabéticamente).
  const TV_DEFAULTS = [
    // Canales TV (con video)
    { id: 'coopetv',      kind: 'tv', name: 'Cooperativa TV',     url: 'https://unlimited1-cl-isp.dps.live/coopetv/coopetv.smil/playlist.m3u8' },
    { id: 'biobiotv',     kind: 'tv', name: 'BioBío TV',          url: 'https://redirector.rudo.video/hls-video/339f69c6122f6d8f4574732c235f09b7683e31a5/bbtv/bbtv.smil/playlist.m3u8' },
    { id: 'adntv',        kind: 'tv', name: 'ADN TV',             url: 'https://redirector.rudo.video/hls-video/931b584451fa6dd1313ee66efbfd5802e3f3bcea/adntv/adntv.smil/playlist.m3u8' },
    { id: 't13radiotv',   kind: 'tv', name: 'Tele13 Radio TV',    url: 'https://unlimited1-cl-isp.dps.live/t13radio/t13radio.smil/playlist.m3u8' },
    { id: 'agriculturatv',kind: 'tv', name: 'Agricultura TV',     url: 'https://unlimited2-cl-isp.dps.live/921tv/921tv.smil/playlist.m3u8' },
    // Duna TV: el endpoint dunatv.smil dejó de existir (404) en mayo 2026.
    // Queda solo Radio Duna (audio) abajo.
    { id: 'infinitatv',   kind: 'tv', name: 'Infinita TV',        url: 'https://mdstrm.com/live-stream-playlist/63a066e54ed536087960b550.m3u8' },
    { id: 'laclavetv',    kind: 'tv', name: 'La Clave TV',        url: 'https://unlimited1-cl-isp.dps.live/laclavetv/laclavetv.smil/playlist.m3u8' },
    { id: 'conquistadortv', kind: 'tv', name: 'El Conquistador TV', url: 'https://redirector.rudo.video/hls-video/931b584451fa6dd1313ee66efbfd5802e3f3bcea/elconquistadortv/elconquistadortv.smil/playlist.m3u8' },
    { id: 'metrofmtv',    kind: 'tv', name: 'La Metro FM TV',     url: 'https://redirector.rudo.video/hls-video/931b584451fa6dd1313ee66efbfd5802e3f3bcea/metropolitanatv/metropolitanatv.smil/playlist.m3u8' },
    { id: 'pautatv',      kind: 'tv', name: 'Pauta TV',           url: 'https://redirector.rudo.video/hls-video/ey6283je82983je9823je8jowowiekldk9838274/pautatv/pautatv.smil/playlist.m3u8' },
    { id: 'carolinatv',   kind: 'tv', name: 'Carolina TV',        url: 'https://mdstrm.com/live-stream-playlist/63a06468117f42713374addd.m3u8' },
    { id: 'romanticatv',  kind: 'tv', name: 'Romántica TV',       url: 'https://mdstrm.com/live-stream-playlist/63a0674c1137d408b45d4821.m3u8' },
    { id: 'subelatv',     kind: 'tv', name: 'Súbela Radio TV',    url: 'https://mdstrm.com/live-stream-playlist/6580414b99f9d36397019551.m3u8' },
    // ── TV chilena adicional (m3u8 verificados desde Chile, fuente: iptv-org) ──
    // Señales TVN
    { id: 'tvchile',      kind: 'tv', name: 'TV Chile (TVN intl.)', url: 'https://mdstrm.com/live-stream-playlist/533adcc949386ce765657d7c.m3u8' },
    { id: 'tvn3',         kind: 'tv', name: 'TVN 3',                url: 'https://mdstrm.com/live-stream-playlist/5653641561b4eba30a7e4929.m3u8' },
    // La Red
    { id: 'laredtv',      kind: 'tv', name: 'La Red',               url: 'https://alba-cl-lared-lared.stream.mediatiquestream.com/index.m3u8' },
    // Familia Canal 13 (señales temáticas cable)
    { id: '13c',          kind: 'tv', name: '13C',                  url: 'https://origin.dpsgo.com/ssai/event/GI-9cp_bT8KcerLpZwkuhw/master.m3u8' },
    { id: '13e',          kind: 'tv', name: '13E',                  url: 'https://origin.dpsgo.com/ssai/event/BBp0VeP6QtOOlH8nu3bWTg/master.m3u8' },
    { id: '13festival',   kind: 'tv', name: '13 Festival',          url: 'https://origin.dpsgo.com/ssai/event/Nftd0fM2SXasfDlRphvUsg/master.m3u8' },
    { id: '13humor',      kind: 'tv', name: '13 Humor',             url: 'https://origin.dpsgo.com/ssai/event/cKWySXKgSK-SzlJmESkOWw/master.m3u8' },
    { id: '13kids',       kind: 'tv', name: '13 Kids',              url: 'https://origin.dpsgo.com/ssai/event/LhHrVtyeQkKZ-Ye_xEU75g/master.m3u8' },
    { id: '13p',          kind: 'tv', name: '13P',                  url: 'https://origin.dpsgo.com/ssai/event/p4mmBxEzSmKAxY1GusOHrw/master.m3u8' },
    { id: '13realities',  kind: 'tv', name: '13 Realities',         url: 'https://origin.dpsgo.com/ssai/event/g7_JOM0ORki9SR5RKHe-Kw/master.m3u8' },
    { id: '13t',          kind: 'tv', name: '13T',                  url: 'https://origin.dpsgo.com/ssai/event/f4TrySe8SoiGF8Lu3EIq1g/master.m3u8' },
    // Universitarias
    { id: 'ucvtv',        kind: 'tv', name: 'UCV TV',               url: 'https://unlimited2-cl-isp.dps.live/ucvtv2/ucvtv2.smil/playlist.m3u8' },
    { id: 'tvu',          kind: 'tv', name: 'TVU (U. de Concepción)', url: 'https://unlimited1-cl-isp.dps.live/tvu/tvu.smil/playlist.m3u8' },
    { id: 'uatv',         kind: 'tv', name: 'UATV (U. de Antofagasta)', url: 'https://unlimited1-us.dps.live/uatv/uatv.smil/playlist.m3u8' },
    { id: 'canal9bbtv',   kind: 'tv', name: 'Canal 9 BioBío Concepción', url: 'https://unlimited6-cl.dps.live/c9/c9.smil/playlist.m3u8' },
    // Públicas / institucionales
    { id: 'tvsenado',     kind: 'tv', name: 'TV Senado',            url: 'https://janus-tv-ply.senado.cl/playlist/playlist.m3u8' },
    // Regionales
    { id: 'antofagastatv',kind: 'tv', name: 'Antofagasta TV',       url: 'https://unlimited6-cl.dps.live/atv/atv.smil/playlist.m3u8' },
    { id: 'atacamatv',    kind: 'tv', name: 'Atacama TV',           url: 'https://v2.tustreaming.cl/atacamatv/index.m3u8' },
    { id: 'aysentv',      kind: 'tv', name: 'Aysén TV',             url: 'https://v1.tustreaming.cl/aysentv/index.m3u8' },
    { id: 'decimatv',     kind: 'tv', name: 'Décima TV (Los Lagos)', url: 'https://unlimited2-cl-isp.dps.live/decimatv/decimatv.smil/playlist.m3u8' },
    { id: 'nctv',         kind: 'tv', name: 'NCTV (Ñuble)',         url: 'https://pantera1-100gb-cl-movistar.dps.live/nctv/nctv.smil/playlist.m3u8' },
    { id: 'pichilemutv',  kind: 'tv', name: 'Pichilemu TV',         url: 'https://5ff3d9babae13.streamlock.net/8028/8028/playlist.m3u8' },
    { id: 'pucontv',      kind: 'tv', name: 'Pucón TV',             url: 'https://pantera1-100gb-cl-movistar.dps.live/pucontv/pucontv.smil/playlist.m3u8' },
    { id: 'puranoticiatv',kind: 'tv', name: 'Puranoticia TV',       url: 'https://pnt.janusmedia.tv/hls/pnt.m3u8' },
    { id: 'surtv',        kind: 'tv', name: 'SUR TV (Aysén)',       url: 'https://redirector.rudo.video/hls-video/ey6283je82983je9823je8jowowiekldk9838274/surtv/surtv.smil/playlist.m3u8' },
    { id: 'tnetv',        kind: 'tv', name: 'TNE',                  url: 'https://v2.tustreaming.cl/tnetv/index.m3u8' },
    { id: 'tvr',          kind: 'tv', name: 'TVR (Rancagua)',       url: 'https://unlimited1-us.dps.live/tvr/tvr.smil/playlist.m3u8' },
    // Música y temáticos
    { id: 'dancefmtv',    kind: 'tv', name: 'Dance FM TV',          url: 'https://5eaccbab48461.streamlock.net:1936/dancefm_1/dancefm_1/playlist.m3u8' },
    { id: 'solobailalo',  kind: 'tv', name: 'Solo Bailalo',         url: 'https://5ff3d9babae13.streamlock.net/8000/8000/playlist.m3u8' },
    { id: 'teletraktv',   kind: 'tv', name: 'Tele Trak (hípica)',   url: 'https://unlimited6-cl.dps.live/sportinghd/sportinghd.smil/playlist.m3u8' },
    // ── Canales chilenos por YouTube Live (kind: 'youtube' usa <iframe>) ──
    // Algunos transmiten 24/7 (24 Horas, T13, CNN Chile); el resto solo durante
    // noticieros o eventos. Cuando el canal no está broadcasting, YouTube
    // muestra "Transmisión en vivo no disponible" en el reproductor.
    // ⭐ Live 24/7 permanente:
    { id: 'yt_24horas',   kind: 'youtube', name: '24 Horas (TVN) ⭐', url: 'https://www.youtube.com/embed/live_stream?channel=UCTXNz3gjAypWp3EhlIATEJQ' },
    { id: 'yt_t13',       kind: 'youtube', name: 'T13 ⭐',            url: 'https://www.youtube.com/embed/live_stream?channel=UCsRnhjcUCR78Q3Ud6OXCTNg' },
    { id: 'yt_cnnchile',  kind: 'youtube', name: 'CNN Chile ⭐',      url: 'https://www.youtube.com/embed/live_stream?channel=UCpOAcjJNAp0Y0fhznRrXIJQ' },
    // Live por horario (noticieros/eventos):
    { id: 'yt_chvnews',   kind: 'youtube', name: 'CHV Noticias',     url: 'https://www.youtube.com/embed/live_stream?channel=UCFXNWE_J-7Y8t0rCTnWxkDw' },
    { id: 'yt_meganews',  kind: 'youtube', name: 'Mega Noticias',    url: 'https://www.youtube.com/embed/live_stream?channel=UCkccyEbqhhM3uKOI6Shm-4Q' },
    { id: 'yt_chv',       kind: 'youtube', name: 'Chilevisión',      url: 'https://www.youtube.com/embed/live_stream?channel=UC8EdTmyUaFIfZvVttJ9lgIA' },
    { id: 'yt_mega',      kind: 'youtube', name: 'Mega',             url: 'https://www.youtube.com/embed/live_stream?channel=UCEpId-jtRABuZyX6D2z6FZQ' },
    { id: 'yt_canal13',   kind: 'youtube', name: 'Canal 13',         url: 'https://www.youtube.com/embed/live_stream?channel=UCd4D3LfXC_9MY2zSv_3gMgw' },
    { id: 'yt_tvn',       kind: 'youtube', name: 'TVN',              url: 'https://www.youtube.com/embed/live_stream?channel=UCaVaCaiG6qRzDiJDuEGKOhQ' },
    { id: 'yt_tvmas',     kind: 'youtube', name: 'TV+',              url: 'https://www.youtube.com/embed/live_stream?channel=UCZnboDa_k5jxFCGp6jVhpUQ' },
    { id: 'yt_tntsports', kind: 'youtube', name: 'TNT Sports (CDF)', url: 'https://www.youtube.com/embed/live_stream?channel=UChCovZlgNh2x6Z57MJ5fhFw' },
    { id: 'yt_telecanal', kind: 'youtube', name: 'Telecanal',        url: 'https://www.youtube.com/embed/live_stream?channel=UCvbC4gOxSWPSkCp6A9m0P_A' },
    { id: 'yt_lared',     kind: 'youtube', name: 'La Red (YouTube)', url: 'https://www.youtube.com/embed/live_stream?channel=UCO_X-fuUzKLzm-AAVjU5nrA' },
    // Radios (solo audio) — orden alfabético: número primero, luego letras
    { id: 'r-13c',          kind: 'radio', name: '13c Radio',                  url: 'https://mdstrm.com/audio/5c915497c6fd7c085b29169d/icecast.audio' },
    { id: 'r-coopciencia',  kind: 'radio', name: 'Cooperativa Ciencia',        url: 'https://unlimited5-us.dps.live/cooperativaciencia/aac/icecast.audio' },
    { id: 'r-fmdos',        kind: 'radio', name: 'FMDOS',                      url: 'https://playerservices.streamtheworld.com/api/livestream-redirect/FMDOSAAC.aac' },
    { id: 'r-los40',        kind: 'radio', name: 'LOS40 Chile',                url: 'https://playerservices.streamtheworld.com/api/livestream-redirect/LOS40_CHILEAAC.aac' },
    { id: 'r-playfm',       kind: 'radio', name: 'Play FM',                    url: 'https://mdstrm.com/audio/5c8d6406f98fbf269f57c82c/icecast.audio' },
    { id: 'r-activa',       kind: 'radio', name: 'Radio Activa',               url: 'https://playerservices.streamtheworld.com/api/livestream-redirect/ACTIVAAAC.aac' },
    { id: 'r-adn',          kind: 'radio', name: 'Radio ADN',                  url: 'https://playerservices.streamtheworld.com/api/livestream-redirect/ADNAAC.aac' },
    { id: 'r-agricultura',  kind: 'radio', name: 'Radio Agricultura',          url: 'https://unlimited5-us.dps.live/agricultura/gotardis/audio/now/livestream1.m3u8' },
    { id: 'r-biobio',       kind: 'radio', name: 'Radio Bio Bio',              url: 'https://redirector.dps.live/biobiosantiago/aac/icecast.audio' },
    { id: 'r-carabineros',  kind: 'radio', name: 'Radio Carabineros de Chile', url: 'https://streaming.prositel.cl/8374/stream' },
    { id: 'r-carolina',     kind: 'radio', name: 'Radio Carolina',             url: 'https://mdstrm.com/audio/637f68ddce4b1208597d8a86/icecast.audio' },
    { id: 'r-concierto',    kind: 'radio', name: 'Radio Concierto',            url: 'https://playerservices.streamtheworld.com/api/livestream-redirect/CONCIERTOAAC.aac' },
    { id: 'r-cooperativa',  kind: 'radio', name: 'Radio Cooperativa',          url: 'https://redirector.dps.live/cooperativafm/aac/icecast.audio' },
    { id: 'r-corazon',      kind: 'radio', name: 'Radio Corazón',              url: 'https://playerservices.streamtheworld.com/api/livestream-redirect/CORAZON_SC' },
    { id: 'r-disney',       kind: 'radio', name: 'Radio Disney',               url: 'https://mdstrm.com/audio/67fe714d82a1ac0e129ae3cc/icecast.audio' },
    { id: 'r-duna',         kind: 'radio', name: 'Radio Duna',                 url: 'https://mdstrm.com/audio/67f42f96e464d19a6eda3c7d/icecast.audio' },
    { id: 'r-conquistador', kind: 'radio', name: 'Radio El Conquistador',      url: 'https://stream10.usastreams.com/9314/stream' },
    { id: 'r-futuro',       kind: 'radio', name: 'Radio Futuro',               url: 'https://playerservices.streamtheworld.com/api/livestream-redirect/FUTUROAAC.aac' },
    { id: 'r-imagina',      kind: 'radio', name: 'Radio Imagina',              url: 'https://playerservices.streamtheworld.com/api/livestream-redirect/IMAGINAAAC.aac' },
    { id: 'r-infinita',     kind: 'radio', name: 'Radio Infinita',             url: 'https://mdstrm.com/audio/639b791cea22540890cd1d8b/icecast.audio' },
    { id: 'r-laclave',      kind: 'radio', name: 'Radio La Clave',             url: 'https://redirector.dps.live/laclave/aac/icecast.audio' },
    { id: 'r-pudahuel',     kind: 'radio', name: 'Radio Pudahuel',             url: 'https://playerservices.streamtheworld.com/api/livestream-redirect/PUDAHUELAAC.aac' },
    { id: 'r-romantica',    kind: 'radio', name: 'Radio Romántica',            url: 'https://mdstrm.com/audio/639b78f7ff35df084fa7f964/icecast.audio' },
    { id: 'r-rockpop',      kind: 'radio', name: 'Rock & Pop',                 url: 'https://playerservices.streamtheworld.com/api/livestream-redirect/ROCK_AND_POPAAC.aac' },
    { id: 'r-sonar',        kind: 'radio', name: 'Sonar FM',                   url: 'https://mdstrm.com/audio/5c915724519bce27671c4d15/icecast.audio' },
    { id: 'r-tele13',       kind: 'radio', name: 'Tele13 Radio',               url: 'https://mdstrm.com/audio/5c915613519bce27671c4caa/icecast.audio' },
  ];

  function getChannels(profile) {
    const base = (profile?.tvChannels && profile.tvChannels.length) ? profile.tvChannels : TV_DEFAULTS;
    // Mezclamos canales externos efímeros (inyectados por private.js) sin
    // persistir. Solo sirven para resolver state.tv.currentId en pauseTv,
    // playChannel, etc. durante la sesión.
    const ext = state.tv && state.tv.external ? Object.values(state.tv.external) : [];
    return ext.length ? base.concat(ext) : base;
  }

  let tvVideo = null;
  let tvIframe = null; // iframe para canales kind:'youtube' (HLS no funciona ahí)
  let tvHls = null; // instancia activa de HLS.js si el stream actual es .m3u8
  let tvSleepTimer = null;
  let tvSleepEndTime = null;
  let tvSleepUiTimer = null;
  // Tanto el <video> como el <iframe> se preservan entre re-renders: si ya
  // existen, los movemos al slot nuevo en lugar de recrearlos, así no se
  // interrumpe el stream cuando se abre/cierra el menú u otra acción que
  // gatilla render().
  function tvEl() {
    const slot = document.querySelector('.tv-video-slot');
    if (!tvVideo) {
      tvVideo = document.createElement('video');
      tvVideo.className = 'tv-video';
      tvVideo.playsInline = true;
      tvVideo.preload = 'none';
    }
    if (slot && tvVideo.parentNode !== slot) slot.appendChild(tvVideo);
    return tvVideo;
  }
  function tvIframeEl() {
    const slot = document.querySelector('.tv-video-slot');
    if (!tvIframe) {
      tvIframe = document.createElement('iframe');
      tvIframe.className = 'tv-iframe';
      tvIframe.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
      tvIframe.allowFullscreen = true;
      tvIframe.frameBorder = '0';
    }
    if (slot && tvIframe.parentNode !== slot) slot.appendChild(tvIframe);
    return tvIframe;
  }
  function showVideo() {
    if (tvVideo) tvVideo.style.display = '';
    if (tvIframe) tvIframe.style.display = 'none';
  }
  function showIframe() {
    if (tvVideo) tvVideo.style.display = 'none';
    if (tvIframe) tvIframe.style.display = '';
  }
  function stopIframe() {
    // Asignar about:blank detiene el reproductor de YouTube (no hay JS API
    // sin cargar youtube.com/iframe_api).
    if (tvIframe) tvIframe.src = 'about:blank';
  }
  function destroyTvHls() {
    if (tvHls) { try { tvHls.destroy(); } catch {} tvHls = null; }
  }

  function setTvStatus(text, kind) {
    const el = document.querySelector('.tv-status');
    if (!el) return;
    el.textContent = text;
    el.className = 'tv-status' + (kind ? ' ' + kind : '');
  }
  function setTvPlayBtn(playing) {
    const btn = document.querySelector('.tv-play');
    if (!btn) return;
    btn.classList.toggle('playing', playing);
    btn.innerHTML = playing
      ? '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>'
      : '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
  }
  function setTvLiveLabel(name) {
    const el = document.querySelector('.tv-live-name');
    if (el) el.textContent = name || '';
  }

  function playChannel(id) {
    const p = currentProfile();
    const channels = getChannels(p);
    const ch = channels.find(c => c.id === id);
    if (!ch) return;

    // Rama YouTube: usamos <iframe> con embed/live_stream. No tenemos control
    // de play/pause/volumen sin cargar la IFrame API, así que el botón local
    // de pausa simplemente vacía el iframe (stopIframe).
    if (ch.kind === 'youtube') {
      destroyTvHls();
      if (tvVideo) { try { tvVideo.pause(); } catch {} tvVideo.removeAttribute('src'); tvVideo.load && tvVideo.load(); }
      const iframe = tvIframeEl();
      // autoplay=1 + mute=1 maximiza la chance de que el navegador lo permita
      // sin click. El usuario puede des-mutear desde el control de YouTube.
      const sep = ch.url.includes('?') ? '&' : '?';
      iframe.src = ch.url + sep + 'autoplay=1&mute=1&playsinline=1';
      showIframe();
      state.tv.currentId = id;
      if (p) { p.lastTv = id; saveStorage(); }
      setTvLiveLabel(ch.name);
      setTvStatus(`En vivo: ${ch.name} (YouTube)`);
      setTvPlayBtn(true);
      const preview = document.querySelector('.tv-preview');
      preview?.classList.add('playing', 'youtube');
      preview?.classList.remove('audio-only');
      return;
    }

    // Rama HLS / audio directo (radios): usa <video>.
    document.querySelector('.tv-preview')?.classList.remove('youtube');
    showVideo();
    stopIframe();
    const video = tvEl();
    video.volume = state.tv.volume;
    destroyTvHls();

    const isHls = /\.m3u8(\?|$)/i.test(ch.url);
    const nativeHls = video.canPlayType('application/vnd.apple.mpegurl') !== '';

    if (isHls && !nativeHls && window.Hls && window.Hls.isSupported()) {
      // Config permisivo de HLS.js + buffer más amplio para evitar trancones.
      // Defaults de HLS.js son conservadores; subimos el buffer y los retries
      // para que el reproductor aguante mejor red intermitente.
      tvHls = new window.Hls({
        xhrSetup: (xhr) => { xhr.withCredentials = false; },
        debug: false,
        // Buffer 60s en lugar de 30s default — más margen contra cortes.
        maxBufferLength: 60,
        maxMaxBufferLength: 600,
        // 100MB de buffer en lugar de 60MB default.
        maxBufferSize: 100 * 1000 * 1000,
        // Hole en buffer? aceptar saltos de hasta 0.5s sin re-buffer.
        maxBufferHole: 0.5,
        // Retries más generosos cuando hay timeout/error transitorio.
        manifestLoadingMaxRetry: 6,
        levelLoadingMaxRetry: 6,
        fragLoadingMaxRetry: 6,
        manifestLoadingTimeOut: 15000,
        levelLoadingTimeOut: 15000,
        fragLoadingTimeOut: 20000,
        manifestLoadingRetryDelay: 500,
        levelLoadingRetryDelay: 500,
        fragLoadingRetryDelay: 500,
        // Pre-fetch del primer fragment para arranque más rápido.
        startFragPrefetch: true,
        // Live streams: 5 chunks de buffer en lugar de 3 (más estable).
        liveSyncDurationCount: 5,
        liveMaxLatencyDurationCount: 10,
        // ABR (adaptive bitrate): no bajar calidad inmediatamente con
        // buffer underrun, dar chance a recuperar primero.
        abrEwmaDefaultEstimate: 1000000,  // 1Mbps default si no hay data
        abrBandWidthFactor: 0.95,
        abrBandWidthUpFactor: 0.7,
        // Recuperación automática de errores fatales.
        startLevel: -1,                    // auto-select calidad inicial
      });
      tvHls.loadSource(ch.url);
      tvHls.attachMedia(video);
      tvHls.on(window.Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(err => {
          console.warn('[tv] HLS no se pudo reproducir', id, err);
          setTvStatus('No se pudo reproducir. La URL puede estar caída.', 'error');
        });
      });
      tvHls.on(window.Hls.Events.ERROR, (_, data) => {
        if (!data.fatal) return; // Ignorar errores no-fatales (HLS.js retry solo)
        console.warn('[tv] HLS fatal:', data.type, '/', data.details);
        // Intento de recuperación automática antes de rendirse:
        //   networkError → re-cargar el playlist
        //   mediaError   → recover media engine y restart
        // Si la recuperación falla, ahí sí mostramos el dialog de error.
        if (data.type === 'networkError' && !tvHls._tryingRecover) {
          tvHls._tryingRecover = true;
          setTvStatus('Reconectando…', 'error');
          try { tvHls.startLoad(); } catch {}
          setTimeout(() => { tvHls && (tvHls._tryingRecover = false); }, 5000);
          return;
        }
        if (data.type === 'mediaError' && !tvHls._tryingRecover) {
          tvHls._tryingRecover = true;
          setTvStatus('Recuperando…', 'error');
          try { tvHls.recoverMediaError(); } catch {}
          setTimeout(() => { tvHls && (tvHls._tryingRecover = false); }, 5000);
          return;
        }
        setTvStatus('Stream no se puede reproducir', 'error');
        setTvPreviewState('error');
        maybeReportPrivateError();
      });
    } else {
      video.src = ch.url;
      video.play().catch(err => {
        console.warn('[tv] no se pudo reproducir', id, err);
        setTvStatus('No se pudo reproducir. La URL puede estar caída.', 'error');
      });
    }
    state.tv.currentId = id;
    if (p) { p.lastTv = id; saveStorage(); }
    setTvLiveLabel(ch.name);
    setTvStatus('Cargando…');
    setTvPreviewState('loading');
    // Para radios (audio-only) mantenemos el badge LIVE encendido en vez del frame negro.
    document.querySelector('.tv-preview')?.classList.toggle('audio-only', ch.kind === 'radio');
  }

  // Helper: ¿el canal actual es YouTube? Lo usamos para enrutar pause/toggle.
  function currentIsYoutube() {
    const ch = getChannels(currentProfile()).find(x => x.id === state.tv.currentId);
    return ch && ch.kind === 'youtube';
  }
  function pauseTv() {
    if (currentIsYoutube()) {
      stopIframe();
      setTvPlayBtn(false);
      setTvStatus('Detenido');
      document.querySelector('.tv-preview')?.classList.remove('playing');
      return;
    }
    if (tvVideo) tvVideo.pause();
  }
  function toggleTv() {
    if (currentIsYoutube()) {
      // Si el iframe está vacío (about:blank), reanudar = volver a reproducir.
      const isStopped = !tvIframe || tvIframe.src === 'about:blank' || tvIframe.src === '';
      if (isStopped) playChannel(state.tv.currentId);
      else pauseTv();
      return;
    }
    const video = tvEl();
    if (video.paused) {
      const id = state.tv.currentId
        || currentProfile()?.lastTv
        || getChannels(currentProfile())[0]?.id;
      if (id) playChannel(id);
    } else {
      pauseTv();
    }
  }

  // Expone una función para que módulos externos (private.js) inyecten un
  // canal "ad-hoc" que no vive en TV_DEFAULTS. Lo agregamos al state runtime
  // sin persistir en localStorage. Reusa playChannel para todo el flujo.
  window.playExternalChannel = function (ch) {
    if (!ch || !ch.url || !ch.id) return;
    // Mete el canal en una lista runtime que getChannels detecta vía override.
    if (!state.tv.external) state.tv.external = {};
    state.tv.external[ch.id] = ch;
    playChannel(ch.id);
  };

  // Helper: marca el preview con un estado visual (loading/error/clear).
  // Estos estados pintan un overlay con spinner o icono de error sobre el
  // video, además del texto del status que ya teníamos abajo.
  function setTvPreviewState(state) {
    const preview = document.querySelector('.tv-preview');
    if (!preview) return;
    preview.classList.remove('loading', 'error');
    if (state) preview.classList.add(state);
  }

  function bindTvVideoEvents() {
    const video = tvEl();
    if (video._bound) return;
    video._bound = true;
    video.addEventListener('loadstart',     () => setTvPreviewState('loading'));
    video.addEventListener('canplay',       () => setTvPreviewState(null));
    video.addEventListener('playing', () => {
      setTvPlayBtn(true);
      setTvPreviewState(null);
      _lastReportedError = null; // reset al reproducir OK
      // Si reprodujo OK con URL directa, dejamos `_triedProxy=true` aunque
      // no lo hayamos usado, para no retrylear si después se interrumpe.
      const cur = state.tv && state.tv.external && state.tv.currentId
                  ? state.tv.external[state.tv.currentId] : null;
      if (cur) cur._triedProxy = true;
      const ch = getChannels(currentProfile()).find(x => x.id === state.tv.currentId);
      setTvStatus(ch ? `En vivo: ${ch.name}` : 'En vivo');
      // Cuando ya hay frames, ocultamos el placeholder LIVE.
      document.querySelector('.tv-preview')?.classList.add('playing');
    });
    video.addEventListener('pause', () => {
      setTvPlayBtn(false);
      setTvStatus('Detenido');
      setTvPreviewState(null);
      document.querySelector('.tv-preview')?.classList.remove('playing');
    });
    video.addEventListener('waiting', () => {
      setTvStatus('Buffering…');
      setTvPreviewState('loading');
    });
    video.addEventListener('error', () => {
      setTvPlayBtn(false);
      setTvStatus('Stream caído — prueba otro canal', 'error');
      setTvPreviewState('error');
      document.querySelector('.tv-preview')?.classList.remove('playing');
      maybeReportPrivateError();
    });
  }

  // Si el canal actual viene del visor privado (id 'priv_xxx'):
  //   1. Si todavía no probamos el proxy fallback (viene de URL directa),
  //      automáticamente reintentamos con el proxy. Esto cubre el caso
  //      de mixed content blocking — el browser bloquea silencioso el HTTP,
  //      caemos al proxy.
  //   2. Si el proxy también falla, mostramos el dialog de diagnóstico.
  let _lastReportedError = null;
  function maybeReportPrivateError() {
    const cur = state.tv && state.tv.external && state.tv.currentId
                ? state.tv.external[state.tv.currentId] : null;
    if (!cur || !cur.id || cur.id.indexOf('priv_') !== 0) return;

    // Retry automático con proxy si todavía no lo intentamos
    if (cur._proxyFallback && !cur._triedProxy) {
      cur._triedProxy = true;
      cur.url = cur._proxyFallback;
      setTimeout(() => playChannel(cur.id), 100);
      return;
    }

    if (typeof window.showPrivateStreamError !== 'function') return;
    if (typeof window.getPrivateOriginalUrl !== 'function') return;
    if (_lastReportedError === cur.id) return;
    _lastReportedError = cur.id;
    const original = window.getPrivateOriginalUrl(cur.url, cur);
    if (!original) return;
    requestAnimationFrame(() => {
      try {
        // Pasamos `cur` para que el dialog sepa si era HTTP (mixed content)
        window.showPrivateStreamError(original, cur.name, { isHttp: cur._isHttp });
      } catch (e) { console.warn(e); }
    });
  }
  // Reset del guard cuando se cambia exitosamente de canal.
  window.addEventListener('beforeunload', () => { _lastReportedError = null; });

  // ─── Sleep timer ──────────────────────────────────────────────────────────
  // Apaga la TV automáticamente después de N minutos. Útil para dejarla
  // sonando antes de dormir. Se refresca el title del botón cada 30s para
  // mostrar minutos restantes.
  function startSleepTimer(minutes) {
    cancelSleepTimer();
    if (!minutes) return;
    tvSleepEndTime = Date.now() + minutes * 60 * 1000;
    tvSleepTimer = setTimeout(() => {
      pauseTv();
      cancelSleepTimer();
    }, minutes * 60 * 1000);
    // Refresca cada segundo para mostrar la cuenta regresiva mm:ss en vivo.
    tvSleepUiTimer = setInterval(updateSleepTimerUI, 1000);
    updateSleepTimerUI();
  }
  function cancelSleepTimer() {
    if (tvSleepTimer) clearTimeout(tvSleepTimer);
    if (tvSleepUiTimer) clearInterval(tvSleepUiTimer);
    tvSleepTimer = null; tvSleepEndTime = null; tvSleepUiTimer = null;
    updateSleepTimerUI();
  }
  // Renderiza el badge "⏰ MM:SS" sobre el preview y actualiza el tooltip
  // del botón de timer. Se llama cada segundo cuando el timer está activo.
  function updateSleepTimerUI() {
    const btn = document.querySelector('.tv-timer');
    const preview = document.querySelector('.tv-preview');
    let badge = document.querySelector('.tv-timer-badge');

    if (tvSleepEndTime) {
      const msLeft = Math.max(0, tvSleepEndTime - Date.now());
      const totalSec = Math.ceil(msLeft / 1000);
      const min = Math.floor(totalSec / 60);
      const sec = totalSec % 60;
      const text = `${min}:${String(sec).padStart(2, '0')}`;

      if (preview && !badge) {
        badge = document.createElement('div');
        badge.className = 'tv-timer-badge';
        preview.appendChild(badge);
      }
      if (badge) badge.innerHTML =
        `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:4px"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>${text}`;
      if (btn) {
        btn.classList.add('active');
        btn.title = `Apagar en ${text} (clic para cambiar)`;
      }
    } else {
      if (badge) badge.remove();
      if (btn) {
        btn.classList.remove('active');
        btn.title = 'Programar apagado';
      }
    }
  }
  function dlgTvTimer() {
    const isActive = !!tvSleepEndTime;
    const minLeft = isActive ? Math.ceil((tvSleepEndTime - Date.now()) / 60000) : 0;
    openDialog(`
      <h2>Programar apagado</h2>
      <p>${isActive
        ? `La TV se apagará en <b>${minLeft} min</b>.`
        : 'Selecciona en cuánto tiempo se debe apagar la TV.'}</p>
      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin:12px 0">
        ${[5,10,15,20,30].map(m => `<button class="ghost" data-min="${m}">En ${m} min</button>`).join('')}
      </div>
      <div class="row">
        ${isActive ? '<button class="ghost danger" id="cancel-timer" style="margin-right:auto">Cancelar timer</button>' : ''}
        <button class="ghost" id="close-timer">Cerrar</button>
      </div>
    `, (root) => {
      root.querySelectorAll('[data-min]').forEach(btn => {
        btn.onclick = () => { startSleepTimer(+btn.dataset.min); closeDialog(); };
      });
      const cancelBtn = $('#cancel-timer', root);
      if (cancelBtn) cancelBtn.onclick = () => { cancelSleepTimer(); closeDialog(); };
      $('#close-timer', root).onclick = closeDialog;
    });
  }

  // ─── Alarmas ──────────────────────────────────────────────────────────────
  // Programa el reproductor para encender un canal a una hora específica,
  // opcionalmente repetido en ciertos días de la semana. Persiste por perfil
  // (se incluye en el JSON exportado). Limitación inherente del browser:
  // solo dispara si la pestaña/PWA está abierta a esa hora. Si el equipo
  // se duerme o el navegador suspende el timer, al volver a foreground el
  // sistema chequea alarmas atrasadas y dispara las que debieron sonar
  // dentro de los últimos 5 minutos.
  const DAYS_SHORT = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
  let alarmTimers = {}; // alarmId → setTimeout id
  let alarmFiringId = null; // alarma actualmente sonando (banner visible)

  function getAlarms() {
    const p = currentProfile();
    return (p?.alarms || []).slice();
  }
  function saveAlarms(list) {
    const p = currentProfile();
    if (!p) return;
    p.alarms = list;
    saveStorage();
    scheduleAlarms();
  }

  // Devuelve milisegundos hasta el próximo disparo, o null si no aplica.
  // days es array de números 0..6; vacío significa "una sola vez" (la
  // próxima ocurrencia futura, sin repetir).
  function msUntilNextFire(alarm, fromNow) {
    if (!alarm.enabled) return null;
    const now = fromNow || new Date();
    const [h, m] = (alarm.time || '00:00').split(':').map(Number);
    for (let i = 0; i < 8; i++) {
      const candidate = new Date(now);
      candidate.setDate(now.getDate() + i);
      candidate.setHours(h, m, 0, 0);
      if (candidate.getTime() <= now.getTime()) continue;
      const dow = candidate.getDay();
      const days = alarm.days || [];
      if (days.length === 0) {
        // Una sola vez: la primera ocurrencia futura sirve.
        if (i === 0 || (i > 0 && now.getHours() * 60 + now.getMinutes() >= h * 60 + m)) {
          return candidate.getTime() - now.getTime();
        }
        // Si el día es hoy y ya pasó la hora, salta a mañana.
        return candidate.getTime() - now.getTime();
      }
      if (days.includes(dow)) return candidate.getTime() - now.getTime();
    }
    return null;
  }

  function scheduleAlarms() {
    Object.values(alarmTimers).forEach(t => clearTimeout(t));
    alarmTimers = {};
    const list = getAlarms();
    const now = new Date();
    list.forEach(alarm => {
      if (!alarm.enabled) return;
      // Chequea alarmas atrasadas (PC dormido, etc): si debió sonar hasta
      // 5 minutos atrás, la disparamos igual.
      const [h, m] = (alarm.time || '00:00').split(':').map(Number);
      const todayAt = new Date(now);
      todayAt.setHours(h, m, 0, 0);
      const lateMs = now.getTime() - todayAt.getTime();
      const dow = now.getDay();
      const days = alarm.days || [];
      const matchesToday = days.length === 0 || days.includes(dow);
      if (matchesToday && lateMs >= 0 && lateMs <= 5 * 60 * 1000) {
        const lastFireKey = `alarmLastFire-${alarm.id}-${todayAt.toDateString()}`;
        if (!localStorage.getItem(lastFireKey)) {
          localStorage.setItem(lastFireKey, '1');
          fireAlarm(alarm);
          return; // ya programa la siguiente al final de fireAlarm
        }
      }
      const ms = msUntilNextFire(alarm);
      if (ms === null) return;
      // setTimeout máximo en JS: ~24.8 días. Para alarmas más lejanas, OK.
      alarmTimers[alarm.id] = setTimeout(() => {
        const lastFireKey = `alarmLastFire-${alarm.id}-${new Date().toDateString()}`;
        localStorage.setItem(lastFireKey, '1');
        fireAlarm(alarm);
      }, ms);
    });
  }

  function fireAlarm(alarm) {
    console.log('[alarma] disparando', alarm);
    if (alarm.channelId) playChannel(alarm.channelId);
    showAlarmBanner(alarm);
    // Si era una sola vez (sin días), la deshabilitamos.
    if ((alarm.days || []).length === 0) {
      const list = getAlarms().map(a => a.id === alarm.id ? { ...a, enabled: false } : a);
      saveAlarms(list);
    } else {
      scheduleAlarms(); // reprogramar para la próxima semana
    }
  }

  function showAlarmBanner(alarm) {
    alarmFiringId = alarm.id;
    let banner = document.getElementById('alarm-banner');
    if (banner) banner.remove();
    banner = document.createElement('div');
    banner.id = 'alarm-banner';
    const ch = getChannels(currentProfile()).find(c => c.id === alarm.channelId);
    banner.innerHTML = `
      <div class="alarm-banner-icon">
        <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>
      </div>
      <div class="alarm-banner-text">
        <div class="alarm-banner-title">⏰ ${escapeHtml(alarm.name || 'Alarma')}</div>
        <div class="alarm-banner-sub">${ch ? 'Reproduciendo: ' + escapeHtml(ch.name) : 'Sin canal'} · ${escapeHtml(alarm.time || '')}</div>
      </div>
      <button class="alarm-banner-stop">Apagar</button>
    `;
    document.body.appendChild(banner);
    banner.querySelector('.alarm-banner-stop').onclick = () => {
      pauseTv();
      banner.remove();
      alarmFiringId = null;
    };
  }

  function dlgAlarms() {
    const list = getAlarms();
    const channels = getChannels(currentProfile());
    const chMap = Object.fromEntries(channels.map(c => [c.id, c.name]));
    const dayLabel = (days) => {
      if (!days || days.length === 0) return 'Una sola vez';
      if (days.length === 7) return 'Todos los días';
      // Lun-Vie / Sáb-Dom shortcuts
      const sorted = [...days].sort();
      if (sorted.join(',') === '1,2,3,4,5') return 'Lun a Vie';
      if (sorted.join(',') === '0,6') return 'Fin de semana';
      return sorted.map(d => DAYS_SHORT[d]).join(' · ');
    };
    const rows = list.map(a => `
      <div class="alarm-row" data-id="${escapeAttr(a.id)}">
        <label class="alarm-toggle" title="Activar/desactivar">
          <input type="checkbox" data-act="toggle" data-id="${escapeAttr(a.id)}" ${a.enabled ? 'checked' : ''}>
          <span class="alarm-switch"></span>
        </label>
        <button class="alarm-info" data-act="edit" data-id="${escapeAttr(a.id)}">
          <div class="alarm-time">${escapeHtml(a.time || '--:--')}</div>
          <div class="alarm-meta">
            <span class="alarm-name">${escapeHtml(a.name || 'Alarma')}</span>
            <span class="alarm-sep">·</span>
            <span>${escapeHtml(dayLabel(a.days))}</span>
            <span class="alarm-sep">·</span>
            <span>${escapeHtml(chMap[a.channelId] || '(sin canal)')}</span>
          </div>
        </button>
        <button class="alarm-del" data-act="del" data-id="${escapeAttr(a.id)}" title="Eliminar">×</button>
      </div>
    `).join('');
    openDialog(`
      <h2>Alarmas</h2>
      <p style="font-size:13px;color:var(--muted)">
        Enciende una radio o canal a la hora programada. <b>Importante:</b>
        la pestaña debe estar abierta a esa hora; sirve sobre todo si dejas
        la PWA instalada o el navegador siempre abierto.
      </p>
      <div class="alarm-list">
        ${list.length ? rows : '<p style="text-align:center;color:var(--muted);padding:18px 0">No tienes alarmas. Toca "Nueva alarma" para empezar.</p>'}
      </div>
      <div class="row">
        <button class="primary" id="add-alarm" style="margin-right:auto">+ Nueva alarma</button>
        <button class="ghost" id="close-alarms">Cerrar</button>
      </div>
    `, (root) => {
      $('#close-alarms', root).onclick = closeDialog;
      $('#add-alarm', root).onclick = () => dlgEditAlarm(null);
      root.querySelectorAll('[data-act="toggle"]').forEach(inp => {
        inp.onchange = () => {
          const id = inp.dataset.id;
          const newList = getAlarms().map(a => a.id === id ? { ...a, enabled: inp.checked } : a);
          saveAlarms(newList);
        };
      });
      root.querySelectorAll('[data-act="edit"]').forEach(btn => {
        btn.onclick = () => dlgEditAlarm(btn.dataset.id);
      });
      root.querySelectorAll('[data-act="del"]').forEach(btn => {
        btn.onclick = () => {
          if (!confirm('¿Eliminar esta alarma?')) return;
          saveAlarms(getAlarms().filter(a => a.id !== btn.dataset.id));
          dlgAlarms();
        };
      });
    });
  }

  function dlgEditAlarm(alarmId) {
    const channels = getChannels(currentProfile());
    const existing = alarmId ? getAlarms().find(a => a.id === alarmId) : null;
    const a = existing || {
      id: 'al' + uid(),
      name: 'Alarma',
      time: '07:30',
      days: [1, 2, 3, 4, 5],
      channelId: channels[0]?.id || '',
      enabled: true,
    };
    const dayBtns = DAYS_SHORT.map((label, i) => `
      <button type="button" class="day-btn ${a.days.includes(i) ? 'active' : ''}" data-day="${i}">${label}</button>
    `).join('');
    const chOpts = channels.map(c => `<option value="${escapeAttr(c.id)}" ${c.id === a.channelId ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('');
    openDialog(`
      <h2>${existing ? 'Editar alarma' : 'Nueva alarma'}</h2>
      <label style="display:block;margin-bottom:10px">
        <div style="font-size:12px;color:var(--muted);margin-bottom:4px">Nombre</div>
        <input id="al-name" type="text" value="${escapeAttr(a.name)}" maxlength="40" style="width:100%;padding:8px 10px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:8px;font-size:14px">
      </label>
      <label style="display:block;margin-bottom:10px">
        <div style="font-size:12px;color:var(--muted);margin-bottom:4px">Hora</div>
        <input id="al-time" type="time" value="${escapeAttr(a.time)}" style="padding:8px 10px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:8px;font-size:16px">
      </label>
      <div style="margin-bottom:10px">
        <div style="font-size:12px;color:var(--muted);margin-bottom:6px">Repetir</div>
        <div class="day-row">${dayBtns}</div>
        <div style="font-size:11px;color:var(--muted);margin-top:4px">Sin días seleccionados = una sola vez.</div>
      </div>
      <label style="display:block;margin-bottom:10px">
        <div style="font-size:12px;color:var(--muted);margin-bottom:4px">Reproducir</div>
        <select id="al-ch" style="width:100%;padding:8px 10px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:8px;font-size:14px">${chOpts}</select>
      </label>
      <div class="row">
        ${existing ? '<button class="ghost danger" id="al-del" style="margin-right:auto">Eliminar</button>' : ''}
        <button class="ghost" id="al-cancel">Cancelar</button>
        <button class="primary" id="al-save">Guardar</button>
      </div>
    `, (root) => {
      const selectedDays = new Set(a.days);
      root.querySelectorAll('.day-btn').forEach(btn => {
        btn.onclick = () => {
          const d = +btn.dataset.day;
          if (selectedDays.has(d)) selectedDays.delete(d); else selectedDays.add(d);
          btn.classList.toggle('active');
        };
      });
      $('#al-cancel', root).onclick = () => dlgAlarms();
      $('#al-save', root).onclick = () => {
        const updated = {
          ...a,
          name: $('#al-name', root).value.trim() || 'Alarma',
          time: $('#al-time', root).value || '07:30',
          days: [...selectedDays].sort(),
          channelId: $('#al-ch', root).value,
          enabled: true,
        };
        const list = getAlarms();
        const idx = list.findIndex(x => x.id === updated.id);
        if (idx >= 0) list[idx] = updated; else list.push(updated);
        saveAlarms(list);
        dlgAlarms();
      };
      const delBtn = $('#al-del', root);
      if (delBtn) delBtn.onclick = () => {
        if (!confirm('¿Eliminar esta alarma?')) return;
        saveAlarms(getAlarms().filter(x => x.id !== a.id));
        dlgAlarms();
      };
    });
  }

  function tvBarHtml() {
    const p = currentProfile();
    const channels = getChannels(p);
    const current = state.tv.currentId || p?.lastTv || '';
    const initialName = channels.find(c => c.id === current)?.name || channels[0]?.name || '';
    // Agrupamos TVs y radios en optgroups separados. Si una entrada no tiene
    // kind (perfiles antiguos / canales custom) la metemos en "Canales TV".
    const tvOpts = channels
      .filter(c => (c.kind || 'tv') === 'tv')
      .map(c => `<option value="${escapeAttr(c.id)}" ${c.id === current ? 'selected' : ''}>${escapeHtml(c.name)}</option>`)
      .join('');
    const radioOpts = channels
      .filter(c => c.kind === 'radio')
      .map(c => `<option value="${escapeAttr(c.id)}" ${c.id === current ? 'selected' : ''}>${escapeHtml(c.name)}</option>`)
      .join('');
    const opts = `<option value="">— Elegir canal —</option>`
      + (tvOpts ? `<optgroup label="Canales TV">${tvOpts}</optgroup>` : '')
      + (radioOpts ? `<optgroup label="Radios">${radioOpts}</optgroup>` : '');
    return `
      <div class="tv-bar">
        <div class="tv-preview">
          <div class="tv-video-slot"></div>
          <div class="tv-overlay">
            <div class="tv-live-badge"><span class="tv-live-dot"></span>LIVE</div>
            <div class="tv-live-name">${escapeHtml(initialName)}</div>
          </div>
        </div>
        <div class="tv-controls">
          <button class="tv-play" title="Reproducir/Pausar">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
          </button>
          <select class="tv-select" title="Canal">${opts}</select>
          <span class="tv-status">Detenido</span>
          <input type="range" class="tv-volume" min="0" max="1" step="0.05" value="${state.tv.volume}" title="Volumen">
          <button class="tv-timer" title="Programar apagado">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          </button>
          <button class="tv-config" title="Configurar canales">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
          </button>
          <button class="tv-private-quick" title="Mis canales privados">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="13" rx="2"/><polyline points="17 2 12 7 7 2"/></svg>
          </button>
          <button class="tv-size" title="Cambiar tamaño (chico/mediano)">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="8" height="14" rx="1"/><rect x="13" y="5" width="8" height="14" rx="1"/></svg>
          </button>
          <button class="tv-fullscreen" title="Pantalla completa">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9V3h6"/><path d="M21 9V3h-6"/><path d="M3 15v6h6"/><path d="M21 15v6h-6"/></svg>
          </button>
        </div>
      </div>
    `;
  }

  function bindTvBar() {
    const playBtn = document.querySelector('.tv-play');
    const select = document.querySelector('.tv-select');
    const vol = document.querySelector('.tv-volume');
    const cfgBtn = document.querySelector('.tv-config');
    const timerBtn = document.querySelector('.tv-timer');
    const sizeBtn = document.querySelector('.tv-size');
    const fullBtn = document.querySelector('.tv-fullscreen');
    const preview = document.querySelector('.tv-preview');
    const mediaRow = document.querySelector('.media-row');
    // Aplicamos el modo guardado: 'medium' = TV + noticias al lado;
    // ausente o 'small' = layout chico (TV arriba, fila de noticias abajo).
    const savedSize = localStorage.getItem('guia.tv.size');
    if (mediaRow && savedSize === 'medium') mediaRow.classList.add('expanded');
    if (sizeBtn) sizeBtn.classList.toggle('active', savedSize === 'medium');
    if (!playBtn) return;
    // El <video> se mantiene vivo entre renders (ver tvEl()): solo lo
    // re-asociamos al slot nuevo para no perder el stream en curso.
    bindTvVideoEvents();
    playBtn.onclick = toggleTv;
    if (preview) preview.onclick = (e) => {
      // click directo sobre el preview también alterna play/pausa
      if (e.target.closest('.tv-controls')) return;
      toggleTv();
    };
    select.onchange = () => { if (select.value) playChannel(select.value); else pauseTv(); };
    vol.oninput = () => {
      state.tv.volume = parseFloat(vol.value);
      tvEl().volume = state.tv.volume;
      try { localStorage.setItem('guia.tv.vol', String(state.tv.volume)); } catch {}
    };
    cfgBtn.onclick = dlgTvConfig;
    const privQuickBtn = document.querySelector('.tv-private-quick');
    if (privQuickBtn) privQuickBtn.onclick = () => {
      if (typeof window.openPrivateAccess === 'function') window.openPrivateAccess();
    };
    if (timerBtn) timerBtn.onclick = dlgTvTimer;
    updateSleepTimerUI(); // re-engancha el estado visual del timer tras render
    if (sizeBtn) sizeBtn.onclick = () => {
      if (!mediaRow) return;
      mediaRow.classList.toggle('expanded');
      const expanded = mediaRow.classList.contains('expanded');
      sizeBtn.classList.toggle('active', expanded);
      sizeBtn.title = expanded ? 'Volver a tamaño chico' : 'Cambiar a tamaño mediano (TV + noticias al lado)';
      try { localStorage.setItem('guia.tv.size', expanded ? 'medium' : 'small'); } catch {}
      // Re-render de cards: en mediano caben 4 (apiladas), en chico 3 (en fila).
      renderNewsCards();
    };
    if (fullBtn) fullBtn.onclick = () => {
      const v = tvEl();
      if (document.fullscreenElement) {
        document.exitFullscreen?.();
      } else {
        // En iOS Safari el elemento <video> tiene su propia API.
        if (v.webkitEnterFullscreen) v.webkitEnterFullscreen();
        else if (v.requestFullscreen) {
          v.controls = true; // controles nativos para poder salir
          v.requestFullscreen().catch(() => {});
        }
      }
    };
    // Sincroniza el estado visual del preview tras un re-render: si el
    // video sigue reproduciendo, mantenemos las clases playing/audio-only
    // y el label LIVE — antes se perdían porque el DOM se reescribía.
    const v = tvEl();
    const isPlaying = !v.paused;
    setTvPlayBtn(isPlaying);
    if (isPlaying) preview?.classList.add('playing');
    const currentCh = getChannels(currentProfile()).find(c => c.id === state.tv.currentId);
    if (currentCh) {
      setTvLiveLabel(currentCh.name);
      if (currentCh.kind === 'radio') preview?.classList.add('audio-only');
      if (isPlaying) setTvStatus(`En vivo: ${currentCh.name}`);
    }
  }
  // Al salir de fullscreen quitamos los controles nativos para volver al diseño custom.
  if (!window._tvFsBound) {
    window._tvFsBound = true;
    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement && tvVideo) tvVideo.controls = false;
    });
  }

  function dlgTvConfig() {
    const p = currentProfile();
    const channels = getChannels(p).slice();
    const rows = () => channels.map((c, i) => `
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px">
        <input type="text" data-i="${i}" data-k="name" value="${escapeAttr(c.name)}" placeholder="Nombre" style="flex:0 0 130px;padding:7px 10px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px;font-size:13px">
        <input type="url" data-i="${i}" data-k="url" value="${escapeAttr(c.url)}" placeholder="https://...m3u8" style="flex:1;padding:7px 10px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px;font-size:13px">
        <button class="ghost" data-rm="${i}" style="padding:6px 10px">×</button>
      </div>
    `).join('');
    openDialog(`
      <h2>Configurar canales</h2>
      <p>Edita el nombre y la URL del stream HLS (.m3u8) de cada canal. Si uno no reproduce, abre el sitio del medio, F12 → pestaña Red → filtra por <code>m3u8</code>, dale play y copia la URL del playlist maestro aquí.</p>
      <div id="rd-list">${rows()}</div>
      <button class="ghost" id="add" style="margin-top:6px">+ Agregar canal</button>
      <div class="row">
        <button class="ghost danger" id="reset" style="margin-right:auto">Restablecer</button>
        <button class="ghost" id="cancel">Cancelar</button>
        <button class="primary" id="ok">Guardar</button>
      </div>
    `, (root) => {
      const list = $('#rd-list', root);
      const rerender = () => { list.innerHTML = rows(); bindRows(); };
      const bindRows = () => {
        list.querySelectorAll('input').forEach(inp => {
          inp.oninput = () => {
            const i = +inp.dataset.i;
            const k = inp.dataset.k;
            channels[i][k] = inp.value;
          };
        });
        list.querySelectorAll('[data-rm]').forEach(btn => {
          btn.onclick = (e) => { e.preventDefault(); channels.splice(+btn.dataset.rm, 1); rerender(); };
        });
      };
      bindRows();
      $('#add', root).onclick = (e) => {
        e.preventDefault();
        channels.push({ id: 't' + uid(), name: 'Nuevo canal', url: '' });
        rerender();
      };
      $('#reset', root).onclick = () => {
        if (!confirm('¿Volver al listado de canales por defecto?')) return;
        delete p.tvChannels;
        saveStorage();
        closeDialog();
        render();
      };
      $('#ok', root).onclick = () => {
        p.tvChannels = channels.filter(c => c.name && c.url);
        saveStorage();
        closeDialog();
        render();
      };
      $('#cancel', root).onclick = closeDialog;
    });
  }

  // ─── Noticias ─────────────────────────────────────────────────────────────
  // Google News RSS por tema (más estable que los RSS individuales de cada
  // medio chileno, que cambian de URL/plataforma seguido). Cada item trae
  // su fuente original (Emol, La Tercera, T13, BioBío, BBC, etc.) extraída
  // del título por el parser, así igual ves variedad de medios.
  const GN = (topic) => `https://news.google.com/rss${topic ? '/headlines/section/topic/' + topic : ''}?hl=es-419&gl=CL&ceid=CL:es-419`;
  const NEWS_SOURCES = {
    chile:      { name: 'Chile',       urls: [GN('')] },
    economia:   { name: 'Economía',    urls: [GN('BUSINESS')] },
    deportes:   { name: 'Deportes',    urls: [GN('SPORTS')] },
    mundo:      { name: 'Mundo',       urls: [GN('WORLD')] },
    tecnologia: { name: 'Tecnología',  urls: [GN('TECHNOLOGY')] },
    espectaculos:{ name: 'Espectáculos', urls: [GN('ENTERTAINMENT')] },
    latercera:  { name: 'La Tercera',  urls: ['https://www.latercera.com/arc/outboundfeeds/rss/?outputType=xml'] },
  };
  // Por defecto: 3 fuentes con variedad. El usuario puede ampliar/reducir desde el menú.
  const DEFAULT_NEWS_SOURCES = ['chile', 'deportes', 'mundo'];
  // Cada tema tiene su color para el badge en la tarjeta. Latercera no tiene
  // tema (es una fuente directa), cae al accent por defecto.
  const TOPIC_COLORS = {
    chile:        '#3b82f6', // azul
    economia:     '#10b981', // verde
    deportes:     '#f59e0b', // ámbar
    mundo:        '#8b5cf6', // púrpura
    tecnologia:   '#06b6d4', // cian
    espectaculos: '#ec4899', // rosa
  };
  function profileNewsSources(profile) {
    return profile?.newsSources || DEFAULT_NEWS_SOURCES;
  }

  // Parser tolerante de RSS 2.0. Extrae imagen de media:content, media:thumbnail,
  // enclosure o el primer <img> dentro de <description>. Para feeds de Google
  // News, intenta sacar la fuente real (Emol, La Tercera, etc.) de tres formas:
  // 1) elemento <source>, 2) sufijo " - Source" en el título.
  function parseRSS(xmlText, defaultSource, topicId, topicName) {
    const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
    if (doc.querySelector('parsererror')) return [];
    const items = Array.from(doc.querySelectorAll('item'));
    const norm = s => (s || '').toLowerCase().replace(/[\s.]/g, '');
    return items.map(item => {
      let title = (item.querySelector('title')?.textContent || '').trim();
      const link = (item.querySelector('link')?.textContent || '').trim();
      const pubDate = item.querySelector('pubDate')?.textContent || '';

      // Fuente: <source> primero, luego sufijo " - X" del título (Google News).
      let source = item.querySelector('source')?.textContent?.trim() || '';
      // Siempre intentamos quitar el sufijo " - {fuente}" del título: Google
      // News lo agrega aunque ya venga el <source> en el XML, lo que dejaba
      // títulos repetidos como "...- La Tercera - La Tercera".
      const m = title.match(/^(.+) - ([^-]{1,40})$/);
      if (m) {
        const tail = m[2].trim();
        if (!source) {
          title = m[1].trim();
          source = tail;
        } else if (norm(tail) === norm(source)) {
          title = m[1].trim();
        }
      }
      if (!source) source = defaultSource;

      let img = null;
      const mc = item.getElementsByTagName('media:content')[0];
      if (mc) img = mc.getAttribute('url');
      if (!img) {
        const mt = item.getElementsByTagName('media:thumbnail')[0];
        if (mt) img = mt.getAttribute('url');
      }
      if (!img) {
        const enc = item.querySelector('enclosure');
        if (enc && (enc.getAttribute('type') || '').startsWith('image/')) img = enc.getAttribute('url');
      }
      if (!img) {
        const desc = item.querySelector('description')?.textContent || '';
        const m = desc.match(/<img[^>]+src=['"]([^'"]+)['"]/i);
        if (m) img = m[1];
      }
      return { title, link, pubDate, image: img, source, topic: topicId, topicName };
    }).filter(x => x.title && x.link);
  }

  async function loadNews(profile) {
    const sources = profileNewsSources(profile);
    if (!sources.length) return [];
    // v2: agregamos topic/topicName al item, invalidamos caches anteriores.
    const cacheKey = 'news-v2-' + sources.slice().sort().join(',');
    const cached = getCached(cacheKey);
    if (cached) return cached;

    // Cadena de proxies CORS: nuestro PHP propio primero (más confiable),
    // luego públicos como respaldo si la app corre local sin PHP.
    // La URL va base64-URL-safe encoded para que el WAF de Bluehost
    // (mod_security) no la detecte como SSRF y la deje pasar.
    const b64url = (s) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const fetchVia = async (url) => {
      const proxies = [
        u => `./proxy.php?u=${b64url(u)}`,
        u => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`,
        u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
      ];
      for (const proxify of proxies) {
        try {
          const ctrl = new AbortController();
          const tid = setTimeout(() => ctrl.abort(), 12000);
          const r = await fetch(proxify(url), { signal: ctrl.signal });
          clearTimeout(tid);
          if (!r.ok) continue;
          const text = await r.text();
          // Si el servidor no tiene PHP, sirve el archivo como texto plano.
          if (text.startsWith('<?php') || text.length < 100) continue;
          return text;
        } catch {}
      }
      return null;
    };

    const bySource = {};
    await Promise.all(sources.map(async id => {
      const src = NEWS_SOURCES[id];
      if (!src) return;
      bySource[id] = [];
      const urls = src.urls || (src.url ? [src.url] : []);
      for (const url of urls) {
        const text = await fetchVia(url);
        if (!text) continue;
        const items = parseRSS(text, src.name, id, src.name);
        if (items.length > 0) {
          console.log(`[noticias] ${src.name}: ${items.length} items desde ${url}`);
          bySource[id] = items.slice(0, 8);
          break;
        }
      }
      if (bySource[id].length === 0) {
        console.warn(`[noticias] ${src.name}: ninguna URL funcionó. URLs probadas:`, urls);
      }
    }));

    // Round-robin: intercala una de cada medio en orden, así no domina ninguno
    const all = [];
    for (let i = 0; i < 8; i++) {
      for (const id of sources) {
        if (bySource[id] && bySource[id][i]) all.push(bySource[id][i]);
      }
    }
    if (all.length) setCached(cacheKey, all, 30 * 60 * 1000);
    return all;
  }

  let newsTimer = null;
  function stopNewsAutoRotate() { if (newsTimer) { clearInterval(newsTimer); newsTimer = null; } }
  function startNewsAutoRotate() {
    stopNewsAutoRotate();
    newsTimer = setInterval(() => {
      if (!state.news.items.length) return;
      state.news.cursor = (state.news.cursor + 1) % state.news.items.length;
      renderNewsCards();
    }, 10000);
  }
  function newsAdvance(delta) {
    if (!state.news.items.length) return;
    const len = state.news.items.length;
    state.news.cursor = ((state.news.cursor + delta) % len + len) % len;
    renderNewsCards();
    startNewsAutoRotate();
  }

  // "Hace X" amigable a partir de un pubDate RSS. Devuelve '' si no parsea.
  function relativeTime(pubDate) {
    if (!pubDate) return '';
    const d = new Date(pubDate);
    if (isNaN(d.getTime())) return '';
    const diffMs = Date.now() - d.getTime();
    if (diffMs < 0) return 'Recién publicado';
    const min = Math.floor(diffMs / 60000);
    if (min < 1) return 'Recién publicado';
    if (min < 60) return `Hace ${min} min`;
    const h = Math.floor(diffMs / 3600000);
    if (h < 24) return `Hace ${h} ${h === 1 ? 'hora' : 'horas'}`;
    const days = Math.floor(diffMs / 86400000);
    if (days < 7) return `Hace ${days} ${days === 1 ? 'día' : 'días'}`;
    return d.toLocaleDateString('es-CL', { day: 'numeric', month: 'short' });
  }

  function newsCardHtml(item) {
    const safeTitle = escapeHtml(item.title);
    const safeSrc = escapeHtml(item.source);
    const safeLink = escapeAttr(item.link);
    const topicColor = TOPIC_COLORS[item.topic] || '';
    const topicHtml = item.topicName
      ? `<span class="news-topic"${topicColor ? ` style="color:${topicColor}"` : ''}>${escapeHtml(item.topicName)}</span>`
      : '';
    const ago = relativeTime(item.pubDate);
    const agoHtml = ago ? `<div class="news-ago">${escapeHtml(ago)}</div>` : '';
    return `
      <a class="news-card" href="${safeLink}" target="_blank" rel="noopener noreferrer">
        <div class="news-body">
          <div class="news-source"><span class="news-src-name">${safeSrc}</span>${topicHtml}</div>
          <h3 class="news-title">${safeTitle}</h3>
          ${agoHtml}
        </div>
      </a>
    `;
  }

  function renderNewsCards() {
    const wrap = document.getElementById('news-widget');
    if (!wrap) return;
    const { items, cursor } = state.news;
    if (!items.length) { wrap.hidden = true; return; }
    // En modo mediano caben 4 cards apiladas; en chico, 3 en fila.
    const expanded = document.querySelector('.media-row')?.classList.contains('expanded');
    const count = expanded ? 4 : 3;
    const visible = [];
    for (let i = 0; i < count && i < items.length; i++) {
      visible.push(items[(cursor + i) % items.length]);
    }
    const cardsEl = wrap.querySelector('.news-cards');
    const statusEl = wrap.querySelector('.news-status');
    if (cardsEl) cardsEl.innerHTML = visible.map(newsCardHtml).join('');
    if (statusEl) {
      const start = cursor + 1;
      const end = cursor + visible.length;
      statusEl.textContent = items.length > count ? `${start}–${end} de ${items.length}` : '';
    }
    wrap.hidden = false;
  }

  async function refreshNews() {
    const p = currentProfile();
    if (!p) return;
    const sources = profileNewsSources(p);
    if (!sources.length) {
      state.news.items = [];
      const wrap = document.getElementById('news-widget');
      if (wrap) wrap.hidden = true;
      stopNewsAutoRotate();
      return;
    }
    try {
      const items = await loadNews(p);
      state.news.items = items;
      state.news.cursor = 0;
      renderNewsCards();
      if (items.length > 3) startNewsAutoRotate();
    } catch (e) {
      console.warn('news error', e);
    }
  }

  function dlgNewsSources() {
    const p = currentProfile();
    const active = new Set(profileNewsSources(p));
    const items = Object.entries(NEWS_SOURCES).map(([id, src]) => `
      <label style="display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--border);border-radius:10px;background:var(--bg);cursor:pointer">
        <input type="checkbox" data-id="${escapeAttr(id)}" ${active.has(id) ? 'checked' : ''}>
        <span style="font-weight:500">${escapeHtml(src.name)}</span>
      </label>
    `).join('');
    openDialog(`
      <h2>Fuentes de noticias</h2>
      <p>Elige los medios que aparecen en el dashboard.</p>
      <div style="display:flex;flex-direction:column;gap:8px">${items}</div>
      <div class="row">
        <button class="ghost" id="cancel">Cancelar</button>
        <button class="primary" id="ok">Guardar</button>
      </div>
    `, (root) => {
      $('#ok', root).onclick = () => {
        const checked = Array.from(root.querySelectorAll('input[type=checkbox]'))
          .filter(c => c.checked).map(c => c.dataset.id);
        p.newsSources = checked;
        // invalidar cache para refetchear con la nueva combinación
        const c = getCacheAll();
        Object.keys(c).forEach(k => { if (k.startsWith('news-')) delete c[k]; });
        try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch {}
        saveStorage();
        closeDialog();
        refreshNews();
      };
      $('#cancel', root).onclick = closeDialog;
    });
  }

  async function geocodeCity(name) {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=5&language=es`;
    const data = await fetchJSON(url);
    return data?.results || [];
  }

  // Catálogo compartido: shared.json en la raíz del sitio. Si no existe (404),
  // cada perfil arranca con DEFAULT_CATALOG. Cache 1 hora para evitar consultas
  // en cada apertura.
  async function loadSharedCatalog() {
    const cached = getCached('shared-cat');
    if (cached !== null) return cached === 'NONE' ? null : cached;
    try {
      // ?t= evita que el service worker o el navegador devuelvan una versión vieja
      const r = await fetch('./shared.json?t=' + Date.now(), { cache: 'no-cache' });
      if (!r.ok) { setCached('shared-cat', 'NONE', 60 * 60 * 1000); return null; }
      const data = await r.json();
      if (!Array.isArray(data)) { setCached('shared-cat', 'NONE', 60 * 60 * 1000); return null; }
      setCached('shared-cat', data, 60 * 60 * 1000);
      return data;
    } catch {
      setCached('shared-cat', 'NONE', 10 * 60 * 1000);
      return null;
    }
  }

  async function loadIndicadores() {
    const cached = getCached('ind');
    if (cached) return cached;
    const data = await fetchJSON('https://mindicador.cl/api');
    const out = {
      usd: data?.dolar?.valor || null,
      uf: data?.uf?.valor || null,
    };
    if (out.usd || out.uf) setCached('ind', out, 6 * 60 * 60 * 1000);
    return out;
  }

  // Serie histórica de mindicador.cl para un indicador y año dado.
  // Devuelve los últimos `days` registros ordenados cronológicamente.
  // Guarda las fechas como ISO string (no Date) para que el cache en
  // localStorage sobreviva al JSON.stringify/parse sin perder el tipo.
  async function loadSerieIndicador(kind, days = 60) {
    const cacheKey = `serie2-${kind}`;
    const cached = getCached(cacheKey);
    if (cached) return cached;
    const year = new Date().getFullYear();
    let raw;
    try {
      raw = await fetchJSON(`https://mindicador.cl/api/${kind}/${year}`, 12000);
    } catch (e) {
      console.warn('[indicador]', kind, 'fetch falló:', e);
      return null;
    }
    if (!Array.isArray(raw?.serie) || raw.serie.length === 0) return null;
    // mindicador devuelve la serie de más reciente a más antigua → la
    // invertimos para que vaya cronológicamente al graficar. Filtramos
    // valores no positivos por si vienen como ceros placeholder.
    const serie = raw.serie
      .slice(0, days)
      .filter(p => typeof p.valor === 'number' && p.valor > 0 && p.fecha)
      .reverse()
      .map(p => ({ date: p.fecha, value: p.valor }));
    if (serie.length) setCached(cacheKey, serie, 6 * 60 * 60 * 1000);
    return serie;
  }

  // Pinta un sparkline SVG simple con eje Y, line + área, último valor
  // destacado y labels mín/máx. Self-contained, sin librerías.
  function sparklineSvg(serie, label, fmt) {
    if (!serie || !serie.length) return '<p>Sin datos.</p>';
    const W = 600, H = 220, padL = 56, padR = 12, padT = 16, padB = 28;
    const innerW = W - padL - padR, innerH = H - padT - padB;
    const values = serie.map(p => p.value);
    const min = Math.min(...values), max = Math.max(...values);
    const range = max - min || 1;
    const x = i => padL + (i / (serie.length - 1)) * innerW;
    const y = v => padT + innerH - ((v - min) / range) * innerH;
    const linePoints = serie.map((p, i) => `${x(i)},${y(p.value)}`).join(' ');
    const areaPath = `M ${x(0)} ${padT + innerH} L ${linePoints.split(' ').join(' L ')} L ${x(serie.length - 1)} ${padT + innerH} Z`;
    const last = serie[serie.length - 1];
    const first = serie[0];
    const delta = last.value - first.value;
    const deltaPct = (delta / first.value) * 100;
    const deltaColor = delta >= 0 ? '#10b981' : '#ef4444';
    // p.date viene como ISO string (sobrevive al cache JSON). Convertimos
    // a Date acá para formatearlo, así da igual si viene de fetch o cache.
    const fmtDate = iso => new Date(iso).toLocaleDateString('es-CL', { day: 'numeric', month: 'short' });
    // Líneas de cuadrícula horizontales (3 niveles: max, mid, min)
    const grid = [0, 0.5, 1].map(t => {
      const v = max - t * range;
      const yy = padT + t * innerH;
      return `<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" stroke="var(--border)" stroke-width="1"/>
              <text x="${padL - 6}" y="${yy + 4}" text-anchor="end" font-size="11" fill="var(--muted)">${fmt(v)}</text>`;
    }).join('');
    // Datos para que el JS interactivo del tooltip pueda calcular puntos sin
    // re-derivar nada. Los publicamos como atributo data-* del contenedor.
    const tooltipData = JSON.stringify({
      W, H, padL, padR, padT, padB,
      points: serie.map(p => ({ d: p.date, v: p.value })),
    });
    return `
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
        <div>
          <div style="font-size:24px;font-weight:700">${fmt(last.value)}</div>
          <div style="font-size:12px;color:var(--muted)">${label} · ${fmtDate(last.date)}</div>
        </div>
        <div style="text-align:right;color:${deltaColor};font-size:13px;font-weight:600">
          ${delta >= 0 ? '▲' : '▼'} ${fmt(Math.abs(delta))} (${delta >= 0 ? '+' : ''}${deltaPct.toFixed(2)}%)
          <div style="font-size:11px;color:var(--muted);font-weight:400">vs ${fmtDate(first.date)}</div>
        </div>
      </div>
      <div class="spark-wrap" style="position:relative" data-spark='${escapeAttr(tooltipData)}'>
        <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block" class="spark-svg">
          ${grid}
          <path d="${areaPath}" fill="var(--accent)" fill-opacity="0.12"/>
          <polyline points="${linePoints}" fill="none" stroke="var(--accent)" stroke-width="2"/>
          <circle cx="${x(serie.length - 1)}" cy="${y(last.value)}" r="4" fill="var(--accent)"/>
          <text x="${padL}" y="${H - 8}" font-size="11" fill="var(--muted)">${fmtDate(first.date)}</text>
          <text x="${W - padR}" y="${H - 8}" text-anchor="end" font-size="11" fill="var(--muted)">${fmtDate(last.date)}</text>
          <line class="spark-cursor" x1="0" y1="${padT}" x2="0" y2="${padT + innerH}" stroke="var(--muted)" stroke-width="1" stroke-dasharray="3 3" style="display:none"/>
          <circle class="spark-dot" r="5" fill="var(--accent)" stroke="var(--bg-elev)" stroke-width="2" style="display:none"/>
        </svg>
        <div class="spark-tooltip" style="display:none"></div>
      </div>
    `;
  }

  // Hookea el tooltip de hover/touch sobre un .spark-wrap. Calcula el punto
  // más cercano según la posición del mouse y muestra fecha + valor.
  function bindSparkTooltip(root, fmt) {
    const wrap = root.querySelector('.spark-wrap');
    if (!wrap) return;
    const data = JSON.parse(wrap.dataset.spark);
    const svg = wrap.querySelector('.spark-svg');
    const cursor = wrap.querySelector('.spark-cursor');
    const dot = wrap.querySelector('.spark-dot');
    const tip = wrap.querySelector('.spark-tooltip');
    const fmtDate = iso => new Date(iso).toLocaleDateString('es-CL', { day: 'numeric', month: 'short', year: 'numeric' });
    const innerW = data.W - data.padL - data.padR;
    const innerH = data.H - data.padT - data.padB;
    const values = data.points.map(p => p.v);
    const minV = Math.min(...values), maxV = Math.max(...values);
    const range = maxV - minV || 1;

    function show(clientX) {
      const rect = svg.getBoundingClientRect();
      // Convertir clientX al espacio del viewBox
      const xInSvg = ((clientX - rect.left) / rect.width) * data.W;
      const innerX = Math.max(0, Math.min(innerW, xInSvg - data.padL));
      const idx = Math.round((innerX / innerW) * (data.points.length - 1));
      const p = data.points[idx];
      if (!p) return;
      const cx = data.padL + (idx / (data.points.length - 1)) * innerW;
      const cy = data.padT + innerH - ((p.v - minV) / range) * innerH;
      cursor.setAttribute('x1', cx); cursor.setAttribute('x2', cx);
      cursor.style.display = '';
      dot.setAttribute('cx', cx); dot.setAttribute('cy', cy);
      dot.style.display = '';
      // Posicionar tooltip en pixeles del wrap (no del viewBox)
      const pxX = (cx / data.W) * rect.width;
      const pxY = (cy / data.H) * rect.height;
      tip.innerHTML = `<div class="spark-tip-date">${fmtDate(p.d)}</div><div class="spark-tip-val">${fmt(p.v)}</div>`;
      tip.style.display = 'block';
      // Centrar tooltip horizontalmente, evitando que se salga por los lados
      const tipW = tip.offsetWidth;
      let leftPx = pxX - tipW / 2;
      leftPx = Math.max(4, Math.min(rect.width - tipW - 4, leftPx));
      tip.style.left = leftPx + 'px';
      tip.style.top = Math.max(0, pxY - 56) + 'px';
    }
    function hide() {
      cursor.style.display = 'none';
      dot.style.display = 'none';
      tip.style.display = 'none';
    }
    svg.addEventListener('mousemove', e => show(e.clientX));
    svg.addEventListener('mouseleave', hide);
    svg.addEventListener('touchstart', e => { if (e.touches[0]) show(e.touches[0].clientX); });
    svg.addEventListener('touchmove', e => { if (e.touches[0]) show(e.touches[0].clientX); });
    svg.addEventListener('touchend', hide);
  }

  async function dlgIndicador(kind) {
    const titles = { dolar: 'Dólar observado', uf: 'UF (Unidad de Fomento)' };
    openDialog(`<h2>${titles[kind]}</h2><p>Cargando últimos 60 días…</p>`);
    const serie = await loadSerieIndicador(kind, 60);
    const fmt = v => '$' + Math.round(v).toLocaleString('es-CL');
    const body = serie
      ? sparklineSvg(serie, titles[kind], fmt)
      : '<p>No se pudieron cargar los datos. Intenta de nuevo más tarde.</p>';
    openDialog(`
      <h2>${titles[kind]}</h2>
      ${body}
      <p style="font-size:12px;color:var(--muted);margin-top:12px">
        Datos: <a href="https://mindicador.cl" target="_blank" rel="noopener">mindicador.cl</a>
        · pasa el mouse sobre el gráfico para ver el valor de cada día.
      </p>
      <div class="row"><button class="primary" id="ok-ind">Cerrar</button></div>
    `, (root) => {
      $('#ok-ind', root).onclick = closeDialog;
      if (serie) bindSparkTooltip(root, fmt);
    });
  }

  function dlgSantosProximos() {
    const today = new Date();
    const items = [];
    for (let i = 0; i < 30; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() + i);
      const k = String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      const santo = window.SANTORAL?.[k];
      if (!santo) continue;
      const label = i === 0 ? 'Hoy'
        : i === 1 ? 'Mañana'
        : d.toLocaleDateString('es-CL', { weekday: 'long', day: 'numeric', month: 'long' });
      items.push({ label: label.charAt(0).toUpperCase() + label.slice(1), santo, isToday: i === 0 });
    }
    openDialog(`
      <h2>Próximos santos</h2>
      <div style="max-height:50vh;overflow:auto;margin:8px 0">
        ${items.map(it => `
          <div style="display:flex;justify-content:space-between;gap:12px;padding:8px 4px;border-bottom:1px solid var(--border)${it.isToday ? ';background:color-mix(in srgb,var(--accent) 10%,transparent);border-radius:6px;padding:8px' : ''}">
            <span style="color:${it.isToday ? 'var(--accent)' : 'var(--muted)'};font-size:13px;font-weight:${it.isToday ? '700' : '500'};flex-shrink:0">${escapeHtml(it.label)}</span>
            <span style="text-align:right;font-size:13.5px">${escapeHtml(it.santo)}</span>
          </div>
        `).join('')}
      </div>
      <div class="row"><button class="primary" id="ok-santos">Cerrar</button></div>
    `, (root) => {
      $('#ok-santos', root).onclick = closeDialog;
    });
  }

  async function refreshWidgets() {
    // ejecutadas en paralelo, fallos silenciosos
    const tEl = document.querySelector('.m-temp');
    const usdEl = document.querySelector('.m-usd');
    const ufEl = document.querySelector('.m-uf');
    const city = getCity(currentProfile());

    loadWeather(city).then(wx => {
      if (!tEl) return;
      if (wx && wx.temp !== null) {
        tEl.classList.remove('m-loading');
        tEl.title = `${wxDesc(wx.code)} en ${city.name} — clic para ver el pronóstico`;
        tEl.innerHTML = `${wxIcon(wx.code)}${wx.temp}°C`;
      } else {
        tEl.classList.add('m-error');
        tEl.textContent = '—°C';
      }
    }).catch(() => { if (tEl) { tEl.classList.add('m-error'); tEl.textContent = '—°C'; } });

    loadIndicadores().then(({ usd, uf }) => {
      if (usdEl) {
        if (usd) { usdEl.classList.remove('m-loading'); usdEl.innerHTML = `USD <b>${fmtCLP(usd)}</b>`; }
        else { usdEl.classList.add('m-error'); usdEl.textContent = 'USD —'; }
      }
      if (ufEl) {
        if (uf) { ufEl.classList.remove('m-loading'); ufEl.innerHTML = `UF <b>${fmtCLP(uf)}</b>`; }
        else { ufEl.classList.add('m-error'); ufEl.textContent = 'UF —'; }
      }
    }).catch(() => {
      if (usdEl) { usdEl.classList.add('m-error'); usdEl.textContent = 'USD —'; }
      if (ufEl)  { ufEl.classList.add('m-error');  ufEl.textContent  = 'UF —';  }
    });
  }

  // ─── Storage ──────────────────────────────────────────────────────────────
  function loadStorage() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      state.profiles = data.profiles || [];
      state.currentId = data.currentId || null;
    } catch (e) {
      console.warn('No se pudo leer almacenamiento', e);
    }
  }
  function saveStorage() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      profiles: state.profiles,
      currentId: state.currentId,
    }));
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────
  const uid = () => Math.random().toString(36).slice(2, 10);
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
    { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]
  ));
  const escapeAttr = escapeHtml;

  function hostnameOf(url) {
    try { return new URL(url).hostname; } catch { return ''; }
  }
  function apexOf(host) {
    const parts = host.split('.');
    if (parts.length < 2) return host;
    let apex = parts.slice(-2).join('.');
    // Manejo de TLDs compuestos: .co.uk, .com.ar, .gov.cl, etc.
    if (parts.length >= 3) {
      const second = parts[parts.length - 2];
      if (second.length <= 3 && ['co','com','gov','org','net','edu','ac'].includes(second)) {
        apex = parts.slice(-3).join('.');
      }
    }
    return apex;
  }
  // Cadena de fuentes de icono ordenada de mejor a peor.
  // No usamos icon.horse: su tier gratuito devuelve un placeholder "W" con
  // status 200 cuando se queda sin cuota o no encuentra el icono, y eso rompe
  // la cascada (la imagen carga "exitosamente" con basura). Mejor confiar en
  // Google faviconV2, DDG y rutas estándar del propio sitio, que devuelven 404
  // o un globo de 16px detectable cuando no hay icono real.
  function faviconChain(url) {
    const h = hostnameOf(url);
    if (!h) return [];
    const apex = apexOf(h);
    const fv2 = (host) => `https://t1.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=${encodeURIComponent('https://' + host + '/')}&size=128`;
    const list = [];

    list.push(fv2(h));
    list.push(`https://${h}/apple-touch-icon.png`);
    list.push(`https://icons.duckduckgo.com/ip3/${h}.ico`);

    if (h !== apex) {
      list.push(fv2(apex));
      list.push(`https://${apex}/apple-touch-icon.png`);
      list.push(`https://icons.duckduckgo.com/ip3/${apex}.ico`);
    }

    list.push(`https://${h}/favicon.ico`);
    return list;
  }
  function colorFor(s) {
    let n = 0;
    for (let i = 0; i < s.length; i++) n = (n * 31 + s.charCodeAt(i)) >>> 0;
    const palette = ['#3b82f6','#8b5cf6','#ec4899','#f97316','#10b981','#0ea5e9','#ef4444','#eab308','#14b8a6','#a855f7'];
    return palette[n % palette.length];
  }

  function greeting(name) {
    const h = new Date().getHours();
    let g = 'Buenas noches';
    if (h >= 6 && h < 12) g = 'Buenos días';
    else if (h >= 12 && h < 20) g = 'Buenas tardes';
    return `${g}, ${name}`;
  }
  function todayString() {
    const s = new Date().toLocaleDateString('es-CL', { weekday: 'long', day: 'numeric', month: 'long' });
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  function nowTime() {
    return new Date().toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  function santoToday() {
    const d = new Date();
    const k = String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    return (window.SANTORAL && window.SANTORAL[k]) || '';
  }
  function fmtCLP(n) {
    if (typeof n !== 'number') return '—';
    return '$' + Math.round(n).toLocaleString('es-CL');
  }

  function currentProfile() {
    return state.profiles.find(p => p.id === state.currentId) || null;
  }
  const DEFAULT_CITY = { name: 'Santiago', lat: -33.45, lon: -70.66 };
  function getCity(profile) {
    return profile?.city || DEFAULT_CITY;
  }
  function buildCategoriesFrom(catalog) {
    return (catalog || []).map(c => ({
      id: uid(),
      name: c.name,
      links: (c.links || []).map(l => {
        const link = { id: uid(), name: l.name, url: l.url };
        if (l.iconUrl) link.iconUrl = l.iconUrl;
        return link;
      }),
    }));
  }
  async function makeProfile(name) {
    // Si el admin publicó un shared.json, lo usamos como base. Si no, defaults bundled.
    const shared = await loadSharedCatalog();
    const baseCatalog = shared && shared.length ? shared : (window.DEFAULT_CATALOG || []);
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    return {
      id: uid(),
      name,
      theme: prefersDark ? 'dark' : 'light',
      city: { ...DEFAULT_CITY },
      categories: buildCategoriesFrom(baseCatalog),
    };
  }

  // ─── Dialogs ──────────────────────────────────────────────────────────────
  function openDialog(html, onMount) {
    dlg.innerHTML = `<div class="body">${html}</div>`;
    dlg.showModal();
    if (onMount) onMount(dlg);
  }
  function closeDialog() { try { dlg.close(); } catch {} dlg.innerHTML = ''; }

  function dlgWelcome() {
    openDialog(`
      <h2>Bienvenido</h2>
      <p>Esta es tu página de inicio personal. ¿Cómo te llamas?</p>
      <input id="name-in" type="text" autocomplete="given-name" placeholder="Tu nombre" maxlength="40">
      <div class="row">
        <button class="primary" id="ok">Empezar</button>
      </div>
    `, (root) => {
      const inp = $('#name-in', root);
      inp.focus();
      const submit = async () => {
        const name = inp.value.trim();
        if (!name) { inp.focus(); return; }
        const ok = $('#ok', root);
        if (ok) ok.disabled = true;
        const p = await makeProfile(name);
        state.profiles.push(p);
        state.currentId = p.id;
        saveStorage();
        closeDialog();
        applyTheme();
        render();
      };
      $('#ok', root).onclick = submit;
      inp.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
    });
  }

  function dlgProfilePicker() {
    const items = state.profiles.map(p => `
      <button data-id="${escapeAttr(p.id)}">
        <span class="avatar" style="background:${colorFor(p.name)}">${escapeHtml(p.name[0].toUpperCase())}</span>
        <span>${escapeHtml(p.name)}</span>
      </button>
    `).join('');
    openDialog(`
      <h2>¿Quién eres?</h2>
      <p>Selecciona tu perfil o crea uno nuevo.</p>
      <div class="profiles">${items}</div>
      <div class="row">
        <button class="ghost" id="new">+ Nuevo perfil</button>
      </div>
    `, (root) => {
      root.querySelectorAll('.profiles button').forEach(b => {
        b.onclick = () => {
          state.currentId = b.dataset.id;
          saveStorage();
          closeDialog();
          applyTheme();
          render();
        };
      });
      $('#new', root).onclick = () => { closeDialog(); dlgNewProfile(); };
    });
  }

  function dlgNewProfile() {
    openDialog(`
      <h2>Nuevo perfil</h2>
      <p>Cada perfil tiene sus propios enlaces.</p>
      <input id="name-in" type="text" placeholder="Nombre" maxlength="40">
      <div class="row">
        <button class="ghost" id="cancel">Cancelar</button>
        <button class="primary" id="ok">Crear</button>
      </div>
    `, (root) => {
      const inp = $('#name-in', root);
      inp.focus();
      const submit = async () => {
        const name = inp.value.trim();
        if (!name) { inp.focus(); return; }
        const ok = $('#ok', root);
        if (ok) ok.disabled = true;
        const p = await makeProfile(name);
        state.profiles.push(p);
        state.currentId = p.id;
        saveStorage();
        closeDialog();
        render();
      };
      $('#ok', root).onclick = submit;
      $('#cancel', root).onclick = closeDialog;
      inp.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
    });
  }

  function dlgRenameProfile() {
    const p = currentProfile();
    openDialog(`
      <h2>Editar perfil</h2>
      <label>Nombre</label>
      <input id="name-in" type="text" value="${escapeAttr(p.name)}" maxlength="40">
      <div class="row">
        <button class="ghost danger" id="delete">Eliminar perfil</button>
        <button class="primary" id="ok" style="margin-left:auto">Guardar</button>
      </div>
    `, (root) => {
      const inp = $('#name-in', root);
      inp.focus(); inp.select();
      $('#ok', root).onclick = () => {
        const v = inp.value.trim();
        if (!v) return;
        p.name = v;
        saveStorage();
        closeDialog();
        render();
      };
      $('#delete', root).onclick = () => {
        if (!confirm(`¿Eliminar el perfil de ${p.name}? Sus enlaces se perderán.`)) return;
        state.profiles = state.profiles.filter(x => x.id !== p.id);
        state.currentId = state.profiles[0]?.id || null;
        saveStorage();
        closeDialog();
        if (!state.currentId) dlgWelcome();
        else render();
      };
      inp.onkeydown = (e) => { if (e.key === 'Enter') $('#ok', root).click(); };
    });
  }

  function dlgBackground() {
    const p = currentProfile();
    const def = getDefaultBg(p) || { color1: '#f6f7fb', color2: '#dbeafe', dir: 180 };
    const bg = p.bg || def;
    const c1 = bg.color1 || def.color1;
    const c2 = bg.color2 || def.color2;
    const dir = bg.dir != null ? bg.dir : def.dir;
    // Si el perfil ya tiene bg guardado, respetamos su elección sólido vs
    // degradado. Si no, el default es degradado.
    const useGrad = p.bg ? !!bg.color2 : !!def.color2;
    openDialog(`
      <h2>Personalizar fondo</h2>
      <p>Cambia el color de fondo de tu perfil. Queda fijo al hacer scroll.</p>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
        <div>
          <label style="margin-top:0">Color principal</label>
          <input id="bg-c1" type="color" value="${escapeAttr(c1)}" style="width:100%;height:42px;border:1px solid var(--border);border-radius:8px;cursor:pointer;background:transparent;padding:2px">
        </div>
        <div>
          <label style="margin-top:0">Color secundario</label>
          <input id="bg-c2" type="color" value="${escapeAttr(c2)}" style="width:100%;height:42px;border:1px solid var(--border);border-radius:8px;cursor:pointer;background:transparent;padding:2px">
        </div>
      </div>
      <label style="display:flex;align-items:center;gap:8px;margin-top:14px;cursor:pointer">
        <input id="bg-grad" type="checkbox" ${useGrad ? 'checked' : ''}>
        <span>Usar degradado entre ambos colores</span>
      </label>
      <div id="bg-grad-opts" style="display:${useGrad ? 'block' : 'none'}">
        <label>Dirección</label>
        <select id="bg-dir" style="width:100%;padding:9px 10px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:8px;font-size:14px">
          <option value="180" ${dir === 180 ? 'selected' : ''}>De arriba a abajo</option>
          <option value="0" ${dir === 0 ? 'selected' : ''}>De abajo a arriba</option>
          <option value="135" ${dir === 135 ? 'selected' : ''}>Diagonal ↘</option>
          <option value="225" ${dir === 225 ? 'selected' : ''}>Diagonal ↙</option>
          <option value="90" ${dir === 90 ? 'selected' : ''}>De izquierda a derecha</option>
        </select>
      </div>
      <div id="bg-preview" style="margin-top:14px;height:60px;border:1px solid var(--border);border-radius:10px"></div>
      <div class="row">
        <button class="ghost" id="reset" style="margin-right:auto">Restablecer</button>
        <button class="ghost" id="cancel">Cancelar</button>
        <button class="primary" id="ok">Aplicar</button>
      </div>
    `, (root) => {
      const c1In = $('#bg-c1', root);
      const c2In = $('#bg-c2', root);
      const gradIn = $('#bg-grad', root);
      const dirIn = $('#bg-dir', root);
      const opts = $('#bg-grad-opts', root);
      const preview = $('#bg-preview', root);
      const refresh = () => {
        if (gradIn.checked) {
          preview.style.background = `linear-gradient(${dirIn.value}deg, ${c1In.value}, ${c2In.value})`;
        } else {
          preview.style.background = c1In.value;
        }
      };
      [c1In, c2In, dirIn].forEach(el => el.oninput = refresh);
      gradIn.onchange = () => { opts.style.display = gradIn.checked ? 'block' : 'none'; refresh(); };
      refresh();
      $('#ok', root).onclick = () => {
        p.bg = gradIn.checked
          ? { color1: c1In.value, color2: c2In.value, dir: parseInt(dirIn.value, 10) }
          : { color1: c1In.value };
        saveStorage();
        applyBackground(p);
        closeDialog();
      };
      $('#reset', root).onclick = () => {
        delete p.bg;
        saveStorage();
        applyBackground(p);
        closeDialog();
      };
      $('#cancel', root).onclick = closeDialog;
    });
  }

  async function dlgForecast() {
    const p = currentProfile();
    const city = getCity(p);
    openDialog(`
      <h2 style="margin-bottom:14px">Clima en ${escapeHtml(city.name)}</h2>
      <div id="fc-body"><div style="color:var(--muted);padding:8px 0">Cargando…</div></div>
      <div class="row">
        <button class="ghost" id="city" style="margin-right:auto">Cambiar ciudad</button>
        <button class="primary" id="close">Cerrar</button>
      </div>
    `, (root) => {
      $('#close', root).onclick = closeDialog;
      $('#city', root).onclick = () => { closeDialog(); dlgCity(); };
    });
    let wx;
    try { wx = await loadWeather(city); }
    catch { wx = null; }
    const body = document.querySelector('#fc-body');
    if (!body) return;
    if (!wx || wx.temp === null) {
      body.innerHTML = '<div style="color:var(--muted);padding:8px 0">No se pudo cargar el pronóstico. Intenta de nuevo más tarde.</div>';
      return;
    }
    const dayRow = (d, isToday) => {
      const dt = new Date(d.date + 'T00:00:00');
      const wd = dt.toLocaleDateString('es-CL', { weekday: 'short' }).replace('.', '');
      const md = dt.toLocaleDateString('es-CL', { day: 'numeric', month: 'short' }).replace('.', '');
      const label = isToday ? 'Hoy' : (wd.charAt(0).toUpperCase() + wd.slice(1));
      return `
        <div style="display:flex;align-items:center;gap:10px;padding:9px 12px;border:1px solid var(--border);border-radius:10px;background:var(--bg)">
          <div style="flex:0 0 64px"><b>${escapeHtml(label)}</b><div style="color:var(--muted);font-size:11.5px">${escapeHtml(md)}</div></div>
          <div style="flex:0 0 22px;display:flex;align-items:center">${wxIcon(d.code)}</div>
          <div style="flex:1;color:var(--muted);font-size:13px">${escapeHtml(wxDesc(d.code))}</div>
          <div style="flex:0 0 60px;color:var(--muted);font-size:12px;text-align:right" title="Probabilidad de lluvia">${d.precip || 0}% lluv</div>
          <div style="flex:0 0 80px;text-align:right;font-variant-numeric:tabular-nums"><b>${d.max}°</b><span style="color:var(--muted)"> / ${d.min}°</span></div>
        </div>
      `;
    };
    const detail = [
      wx.feels !== null ? `sensación ${wx.feels}°` : null,
      wx.wind !== null ? `viento ${wx.wind} km/h` : null,
      wx.humidity !== null ? `humedad ${wx.humidity}%` : null,
    ].filter(Boolean).join(' · ');
    body.innerHTML = `
      <div style="display:flex;align-items:center;gap:14px;margin-bottom:6px">
        <div style="font-size:42px;line-height:1;display:flex;align-items:center">${wxIcon(wx.code).replace('class="wx-icon"', 'class="wx-icon-lg"')}</div>
        <div style="font-size:46px;font-weight:700;line-height:1;font-variant-numeric:tabular-nums">${wx.temp}°</div>
        <div style="padding-top:4px;flex:1">
          <div style="font-weight:500">${escapeHtml(wxDesc(wx.code))}</div>
          <div style="color:var(--muted);font-size:13px">${escapeHtml(detail)}</div>
        </div>
      </div>
      <div style="color:var(--muted);font-size:12px;margin:14px 0 8px">Próximos 7 días</div>
      <div style="display:flex;flex-direction:column;gap:5px;max-height:320px;overflow-y:auto">
        ${wx.daily.map((d, i) => dayRow(d, i === 0)).join('')}
      </div>
    `;
  }

  function dlgCity() {
    const p = currentProfile();
    const city = getCity(p);
    openDialog(`
      <h2>Cambiar ciudad</h2>
      <p>Define qué ciudad usar para el clima. La hora y fecha siguen el reloj de tu dispositivo.</p>
      <label>Buscar ciudad</label>
      <input id="city-in" type="text" placeholder="Miami, Concepción, Buenos Aires…" value="${escapeAttr(city.name)}" maxlength="60">
      <div id="city-results" style="margin-top:10px;max-height:240px;overflow-y:auto"></div>
      <div class="row">
        <button class="ghost" id="cancel">Cerrar</button>
        <button class="primary" id="search">Buscar</button>
      </div>
    `, (root) => {
      const inp = $('#city-in', root);
      const results = $('#city-results', root);
      const search = async () => {
        const q = inp.value.trim();
        if (!q) return;
        results.innerHTML = '<div style="color:var(--muted);padding:8px">Buscando…</div>';
        try {
          const list = await geocodeCity(q);
          if (!list.length) {
            results.innerHTML = '<div style="color:var(--muted);padding:8px">Sin resultados. Prueba con otro nombre.</div>';
            return;
          }
          results.innerHTML = list.map((r, i) => {
            const sub = [r.admin1, r.country].filter(Boolean).join(', ');
            return `
              <button data-idx="${i}" style="display:block;width:100%;text-align:left;padding:10px 12px;background:var(--bg);border:1px solid var(--border);border-radius:8px;margin-bottom:6px;color:var(--text);cursor:pointer">
                <div style="font-weight:600">${escapeHtml(r.name)}</div>
                <div style="opacity:.6;font-size:12.5px">${escapeHtml(sub)}</div>
              </button>
            `;
          }).join('');
          results.querySelectorAll('button').forEach(btn => {
            btn.onclick = () => {
              const r = list[Number(btn.dataset.idx)];
              const display = [r.name, r.admin1].filter(Boolean).join(', ');
              p.city = { name: display, lat: r.latitude, lon: r.longitude };
              // limpia cache de clima viejo de cualquier ciudad
              const c = getCacheAll();
              Object.keys(c).forEach(k => { if (k.startsWith('wx-')) delete c[k]; });
              try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch {}
              saveStorage();
              closeDialog();
              render();
            };
          });
        } catch (e) {
          results.innerHTML = '<div style="color:var(--muted);padding:8px">Error de búsqueda. Intenta de nuevo.</div>';
        }
      };
      $('#search', root).onclick = search;
      $('#cancel', root).onclick = closeDialog;
      inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); search(); } };
      inp.focus(); inp.select();
    });
  }

  function dlgAddLink(catId) {
    openDialog(`
      <h2>Nuevo acceso</h2>
      <label>Nombre</label>
      <input id="lnk-name" type="text" placeholder="Banco de Chile" maxlength="40">
      <label>URL</label>
      <input id="lnk-url" type="url" placeholder="https://...">
      <label>URL del icono <span style="opacity:.6;font-weight:400">(opcional)</span></label>
      <input id="lnk-icon" type="url" placeholder="https://... (vacío = automático)">
      <div class="row">
        <button class="ghost" id="cancel">Cancelar</button>
        <button class="primary" id="ok">Agregar</button>
      </div>
    `, (root) => {
      const nameIn = $('#lnk-name', root);
      const urlIn = $('#lnk-url', root);
      const iconIn = $('#lnk-icon', root);
      nameIn.focus();
      const submit = () => {
        let name = nameIn.value.trim();
        let url = urlIn.value.trim();
        const icon = iconIn.value.trim();
        if (!url) { urlIn.focus(); return; }
        if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
        if (!name) name = hostnameOf(url).replace(/^www\./, '');
        const p = currentProfile();
        const cat = p.categories.find(c => c.id === catId);
        if (!cat) return;
        const link = { id: uid(), name, url };
        if (icon) link.iconUrl = icon;
        cat.links.push(link);
        saveStorage();
        closeDialog();
        render();
      };
      $('#ok', root).onclick = submit;
      $('#cancel', root).onclick = closeDialog;
      [nameIn, urlIn, iconIn].forEach(i => i.onkeydown = (e) => { if (e.key === 'Enter') submit(); });
    });
  }

  function dlgEditLink(catId, linkId) {
    const p = currentProfile();
    const cat = p.categories.find(c => c.id === catId);
    const link = cat?.links.find(l => l.id === linkId);
    if (!link) return;
    openDialog(`
      <h2>Editar acceso</h2>
      <label>Nombre</label>
      <input id="lnk-name" type="text" value="${escapeAttr(link.name)}" maxlength="40">
      <label>URL</label>
      <input id="lnk-url" type="url" value="${escapeAttr(link.url)}">
      <label>URL del icono <span style="opacity:.6;font-weight:400">(opcional)</span></label>
      <input id="lnk-icon" type="url" value="${escapeAttr(link.iconUrl || '')}" placeholder="https://... (vacío = automático)">
      <div class="row">
        <button class="ghost" id="cancel">Cancelar</button>
        <button class="primary" id="ok">Guardar</button>
      </div>
    `, (root) => {
      const nameIn = $('#lnk-name', root);
      const urlIn = $('#lnk-url', root);
      const iconIn = $('#lnk-icon', root);
      nameIn.focus(); nameIn.select();
      const submit = () => {
        const name = nameIn.value.trim();
        let url = urlIn.value.trim();
        const icon = iconIn.value.trim();
        if (!name || !url) return;
        if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
        link.name = name;
        link.url = url;
        if (icon) link.iconUrl = icon; else delete link.iconUrl;
        saveStorage();
        closeDialog();
        render();
      };
      $('#ok', root).onclick = submit;
      $('#cancel', root).onclick = closeDialog;
      [nameIn, urlIn, iconIn].forEach(i => i.onkeydown = (e) => { if (e.key === 'Enter') submit(); });
    });
  }

  // ─── CRUD ─────────────────────────────────────────────────────────────────
  function removeLink(catId, linkId) {
    const p = currentProfile();
    const cat = p.categories.find(c => c.id === catId);
    if (!cat) return;
    cat.links = cat.links.filter(l => l.id !== linkId);
    saveStorage();
    render();
  }
  function addCategory() {
    const name = (prompt('Nombre de la nueva categoría:') || '').trim();
    if (!name) return;
    const p = currentProfile();
    p.categories.push({ id: uid(), name, links: [] });
    saveStorage();
    render();
  }
  function renameCategory(catId, newName) {
    const p = currentProfile();
    const cat = p.categories.find(c => c.id === catId);
    if (!cat) return;
    cat.name = newName.trim() || cat.name;
    saveStorage();
  }
  function removeCategory(catId) {
    const p = currentProfile();
    const cat = p.categories.find(c => c.id === catId);
    if (!cat) return;
    if (cat.links.length && !confirm(`Eliminar "${cat.name}" con ${cat.links.length} enlaces?`)) return;
    p.categories = p.categories.filter(c => c.id !== catId);
    saveStorage();
    render();
  }

  // ─── Drag & drop ──────────────────────────────────────────────────────────
  // Soporta dos tipos de arrastre: tiles (enlaces) entre categorías y categorías
  // completas para reordenarlas verticalmente. dragInfo.type discrimina.
  let dragInfo = null;

  function onDragStart(e) {
    if (!state.editing) return;
    const tile = e.target.closest('.tile');
    if (tile && !tile.classList.contains('add')) {
      dragInfo = { type: 'tile', catId: tile.dataset.cat, linkId: tile.dataset.id };
      tile.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', tile.dataset.id); } catch {}
      return;
    }
    const grip = e.target.closest('.cat-grip');
    if (grip) {
      const cat = grip.closest('.cat');
      if (!cat) return;
      dragInfo = { type: 'cat', catId: cat.dataset.id };
      cat.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', cat.dataset.id); } catch {}
    }
  }
  function onDragEnd() {
    document.querySelectorAll('.tile, .cat').forEach(el => el.classList.remove('dragging','drop-before','drop-after'));
    dragInfo = null;
  }
  function onDragOver(e) {
    if (!dragInfo) return;
    if (dragInfo.type === 'tile') {
      if (!e.target.closest('.tiles')) return;
      const tile = e.target.closest('.tile');
      e.preventDefault();
      document.querySelectorAll('.tile.drop-before, .tile.drop-after').forEach(t => t.classList.remove('drop-before','drop-after'));
      if (tile && !tile.classList.contains('add')) {
        const r = tile.getBoundingClientRect();
        const before = e.clientX < r.left + r.width / 2;
        tile.classList.add(before ? 'drop-before' : 'drop-after');
      }
    } else if (dragInfo.type === 'cat') {
      const cat = e.target.closest('.cat');
      if (!cat) return;
      e.preventDefault();
      document.querySelectorAll('.cat.drop-before, .cat.drop-after').forEach(c => c.classList.remove('drop-before','drop-after'));
      if (cat.dataset.id === dragInfo.catId) return;
      const r = cat.getBoundingClientRect();
      const before = e.clientY < r.top + r.height / 2;
      cat.classList.add(before ? 'drop-before' : 'drop-after');
    }
  }
  function onDrop(e) {
    if (!dragInfo) return;
    e.preventDefault();
    const p = currentProfile();
    if (dragInfo.type === 'tile') {
      const tiles = e.target.closest('.tiles');
      if (!tiles) { onDragEnd(); return; }
      const targetCat = tiles.dataset.cat;
      const tile = e.target.closest('.tile');
      const fromCat = p.categories.find(c => c.id === dragInfo.catId);
      const toCat = p.categories.find(c => c.id === targetCat);
      if (!fromCat || !toCat) { onDragEnd(); return; }
      const linkIdx = fromCat.links.findIndex(l => l.id === dragInfo.linkId);
      if (linkIdx === -1) { onDragEnd(); return; }
      const [link] = fromCat.links.splice(linkIdx, 1);
      let insertAt = toCat.links.length;
      if (tile && !tile.classList.contains('add')) {
        const targetId = tile.dataset.id;
        const r = tile.getBoundingClientRect();
        const before = e.clientX < r.left + r.width / 2;
        const idx = toCat.links.findIndex(l => l.id === targetId);
        insertAt = before ? idx : idx + 1;
      }
      toCat.links.splice(insertAt, 0, link);
    } else if (dragInfo.type === 'cat') {
      const target = e.target.closest('.cat');
      if (!target) { onDragEnd(); return; }
      const fromIdx = p.categories.findIndex(c => c.id === dragInfo.catId);
      const toIdx = p.categories.findIndex(c => c.id === target.dataset.id);
      if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) { onDragEnd(); return; }
      const r = target.getBoundingClientRect();
      const before = e.clientY < r.top + r.height / 2;
      const [moved] = p.categories.splice(fromIdx, 1);
      let insertAt = before ? toIdx : toIdx + 1;
      if (fromIdx < toIdx) insertAt--;
      p.categories.splice(insertAt, 0, moved);
    }
    saveStorage();
    onDragEnd();
    render();
  }

  // ─── Theme & background ───────────────────────────────────────────────────
  function prefersDark() {
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }
  function applyTheme() {
    const p = currentProfile();
    // Si todavía no hay perfil (primera visita, pantalla de bienvenida)
    // respetamos la preferencia del SO para que el diálogo no salga blanco
    // sobre el fondo claro por defecto.
    const t = p ? (p.theme || 'light') : (prefersDark() ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', t);
    applyBackground(p);
  }
  // Degradado por defecto cuando el perfil no tiene fondo personalizado.
  // Se aplica en tema oscuro (también en pantalla de bienvenida si el SO está
  // en oscuro). El tema claro usa el bg de CSS para no chocar con las cards.
  const DEFAULT_BG_DARK = { color1: '#0b1220', color2: '#1e293b', dir: 180 };
  function getDefaultBg(profile) {
    const isDark = profile
      ? (profile.theme || 'light') === 'dark'
      : prefersDark();
    return isDark ? DEFAULT_BG_DARK : null;
  }
  function applyBackground(profile) {
    const body = document.body;
    let bg = profile?.bg && profile.bg.color1 ? profile.bg : getDefaultBg(profile);
    if (!bg) {
      body.style.background = '';
      body.style.backgroundAttachment = '';
      return;
    }
    if (bg.color2) {
      body.style.background = `linear-gradient(${bg.dir != null ? bg.dir : 180}deg, ${bg.color1}, ${bg.color2})`;
    } else {
      body.style.background = bg.color1;
    }
    body.style.backgroundAttachment = 'fixed';
    body.style.minHeight = '100vh';
  }
  function toggleTheme() {
    const p = currentProfile();
    p.theme = p.theme === 'dark' ? 'light' : 'dark';
    saveStorage();
    applyTheme();
    render();
  }

  // ─── Export / import ──────────────────────────────────────────────────────
  function exportProfile() {
    const p = currentProfile();
    // Whitelist explícita: garantizamos que el JSON incluya configuración
    // de fuentes de noticias, canales TV e iconos personalizados (estos
    // últimos viven dentro de cada link.iconUrl en categories).
    const data = {
      name: p.name,
      theme: p.theme,
      city: p.city,
      bg: p.bg,
      categories: p.categories,        // incluye link.iconUrl de cada acceso
      newsSources: p.newsSources,      // fuentes seleccionadas (chile, deportes, etc.)
      tvChannels: p.tvChannels,        // canales TV personalizados
      lastTv: p.lastTv,
      alarms: p.alarms,                // alarmas programadas (hora, días, canal)
      exportedAt: new Date().toISOString(),
      exportVersion: 3,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `guia-${p.name.toLowerCase().replace(/\s+/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }
  function importProfile() {
    fileInput.value = '';
    fileInput.onchange = async () => {
      const f = fileInput.files?.[0];
      if (!f) return;
      try {
        const data = JSON.parse(await f.text());
        if (!data.name || !Array.isArray(data.categories)) throw new Error('formato inválido');
        data.id = uid();
        state.profiles.push(data);
        state.currentId = data.id;
        saveStorage();
        applyTheme();
        render();
      } catch (e) {
        alert('No se pudo importar: ' + e.message);
      }
    };
    fileInput.click();
  }

  async function triggerInstall() {
    const ev = state.installPrompt;
    if (!ev) return;
    try {
      ev.prompt();
      await ev.userChoice;
    } catch {}
    state.installPrompt = null;
    render();
  }

  function dlgIosInstall() {
    openDialog(`
      <h2>Instalar en iPhone</h2>
      <p>Safari en iOS no tiene un botón directo. Sigue estos pasos:</p>
      <ol style="margin:0 0 18px 18px;padding:0;color:var(--text);font-size:14px;line-height:1.7">
        <li>Toca el botón <b>Compartir</b> (cuadrado con flecha hacia arriba) abajo en Safari.</li>
        <li>Desliza y selecciona <b>Añadir a pantalla de inicio</b>.</li>
        <li>Confirma con <b>Añadir</b>.</li>
      </ol>
      <p style="font-size:13px">El icono aparecerá en tu pantalla y se abrirá como una app, sin barra de Safari.</p>
      <div class="row">
        <button class="primary" id="ok">Entendido</button>
      </div>
    `, (root) => {
      $('#ok', root).onclick = closeDialog;
    });
  }

  function dlgAndroidInstall() {
    openDialog(`
      <h2>Instalar en Android</h2>
      <p>Si tu navegador no mostró el botón automático, hazlo así:</p>
      <ol style="margin:0 0 18px 18px;padding:0;color:var(--text);font-size:14px;line-height:1.7">
        <li>Toca el menú del navegador (los <b>tres puntos ⋮</b> arriba a la derecha).</li>
        <li>Selecciona <b>Instalar app</b> o <b>Añadir a pantalla de inicio</b>.</li>
        <li>Confirma con <b>Instalar</b>.</li>
      </ol>
      <p style="font-size:13px">El ícono aparecerá en tu pantalla y se abrirá como app, sin barra del navegador. Funciona en Chrome, Edge y Samsung Internet.</p>
      <div class="row">
        <button class="primary" id="ok">Entendido</button>
      </div>
    `, (root) => {
      $('#ok', root).onclick = closeDialog;
    });
  }

  // Publica el catálogo del perfil actual como shared.json descargable.
  // El usuario lo sube a la raíz del sitio vía FTP y desde ahí los demás
  // perfiles pueden sincronizar para recibir nuevos enlaces.
  function publishCatalog() {
    const p = currentProfile();
    const data = p.categories.map(c => ({
      name: c.name,
      links: c.links.map(l => {
        const o = { name: l.name, url: l.url };
        if (l.iconUrl) o.iconUrl = l.iconUrl;
        return o;
      }),
    }));
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'shared.json';
    a.click();
    URL.revokeObjectURL(a.href);
    // invalida cache para que la próxima sincronización vea el nuevo
    const c = getCacheAll();
    delete c['shared-cat'];
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch {}
    openDialog(`
      <h2>Catálogo descargado</h2>
      <p>Sube <b>shared.json</b> a la raíz de tu sitio (junto a <code>index.html</code>) usando FTP.</p>
      <p>Cuando tus amigos abran la guía y elijan <b>Sincronizar con compartido</b>, verán los nuevos enlaces que añadiste sin perder sus cambios personales.</p>
      <div class="row"><button class="primary" id="ok">Entendido</button></div>
    `, (root) => { $('#ok', root).onclick = closeDialog; });
  }

  // Trae shared.json del servidor y agrega categorías/enlaces que el usuario
  // no tenga, por nombre de categoría (case-insensitive) y URL de enlace.
  // No elimina nada: si el admin quitó algo, el usuario lo tiene que quitar
  // manualmente. No sobreescribe nombres ni iconos que el usuario haya cambiado.
  async function syncFromShared() {
    // forzar re-fetch
    const c = getCacheAll();
    delete c['shared-cat'];
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch {}
    const shared = await loadSharedCatalog();
    if (!shared) {
      alert('No hay catálogo compartido en el servidor. Pídele a quien administra que lo publique.');
      return;
    }
    const p = currentProfile();
    let addedCats = 0, addedLinks = 0;
    for (const sc of shared) {
      const lcName = sc.name.toLowerCase().trim();
      let cat = p.categories.find(x => x.name.toLowerCase().trim() === lcName);
      if (!cat) {
        cat = { id: uid(), name: sc.name, links: [] };
        p.categories.push(cat);
        addedCats++;
      }
      for (const sl of (sc.links || [])) {
        if (!cat.links.find(l => l.url === sl.url)) {
          const link = { id: uid(), name: sl.name, url: sl.url };
          if (sl.iconUrl) link.iconUrl = sl.iconUrl;
          cat.links.push(link);
          addedLinks++;
        }
      }
    }
    saveStorage();
    render();
    const msg = (addedCats || addedLinks)
      ? `Listo: ${addedLinks} enlace${addedLinks === 1 ? '' : 's'} y ${addedCats} categoría${addedCats === 1 ? '' : 's'} agregadas.`
      : 'Tu perfil ya tiene todo lo que está en el catálogo compartido.';
    alert(msg);
  }

  function deleteCurrentProfile() {
    const p = currentProfile();
    if (!p) return;
    if (!confirm(`¿Eliminar el perfil de "${p.name}"? Sus enlaces personalizados se perderán.`)) return;
    state.profiles = state.profiles.filter(x => x.id !== p.id);
    state.currentId = state.profiles[0]?.id || null;
    saveStorage();
    if (!state.currentId) { dlgWelcome(); return; }
    applyTheme();
    render();
  }

  async function resetProfile() {
    if (!confirm('¿Restablecer este perfil al catálogo por defecto? Perderás tus cambios.')) return;
    const p = currentProfile();
    const fresh = await makeProfile(p.name);
    p.categories = fresh.categories;
    saveStorage();
    render();
  }

  // ─── Rendering ────────────────────────────────────────────────────────────
  const ICON_SEARCH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>`;
  const ICON_TRASH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;

  function tileHtml(cat, link) {
    const chain = faviconChain(link.url);
    const initial = (link.name || '?')[0].toUpperCase();
    const bg = colorFor(link.name + link.url);
    const first = link.iconUrl || chain[0];
    const fallbacks = link.iconUrl ? chain : chain.slice(1);
    const inner = first
      ? `<img src="${escapeAttr(first)}" alt="" loading="lazy" referrerpolicy="no-referrer"
              data-fb="${escapeAttr(JSON.stringify(fallbacks))}"
              data-initial="${escapeAttr(initial)}" data-bg="${escapeAttr(bg)}">`
      : `<span class="ico-fb" style="background:${bg}">${escapeHtml(initial)}</span>`;
    return `
      <a class="tile" href="${escapeAttr(link.url)}" target="_blank" rel="noopener noreferrer"
         draggable="true" data-id="${escapeAttr(link.id)}" data-cat="${escapeAttr(cat.id)}"
         data-name="${escapeAttr(link.name.toLowerCase())}">
        <span class="ico">${inner}</span>
        <span class="lbl">${escapeHtml(link.name)}</span>
        <button class="x" data-act="rm" aria-label="Quitar">×</button>
      </a>
    `;
  }

  function categoryHtml(cat) {
    const links = state.query
      ? cat.links.filter(l => l.name.toLowerCase().includes(state.query) || hostnameOf(l.url).includes(state.query))
      : cat.links;
    if (state.query && links.length === 0) return '';
    const nameEl = state.editing
      ? `<input class="cat-name" data-cat="${escapeAttr(cat.id)}" value="${escapeAttr(cat.name)}" maxlength="40">`
      : `<h2>${escapeHtml(cat.name)}</h2>`;
    const handle = state.editing
      ? `<span class="cat-grip" draggable="true" title="Arrastra para reordenar la categoría"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg></span>`
      : '';
    return `
      <section class="cat" data-id="${escapeAttr(cat.id)}">
        <div class="cat-head">
          ${handle}${nameEl}
          <span class="count">${cat.links.length}</span>
          <span class="cat-tools">
            <button class="iconbtn" data-act="cat-del" data-cat="${escapeAttr(cat.id)}" title="Eliminar categoría">${ICON_TRASH}</button>
          </span>
        </div>
        <div class="tiles" data-cat="${escapeAttr(cat.id)}">
          ${links.map(l => tileHtml(cat, l)).join('')}
          <button class="tile add" data-act="add-link" data-cat="${escapeAttr(cat.id)}" title="Agregar enlace"><span class="ico">+</span><span class="lbl">Agregar</span></button>
        </div>
      </section>
    `;
  }

  function render() {
    const p = currentProfile();
    if (!p) return;
    document.body.classList.toggle('editing-mode', state.editing);

    app.className = state.editing ? 'editing' : '';
    const santo = santoToday();
    const city = getCity(p);
    // Despegamos el <video> antes del innerHTML para que no se destruya
    // (mantiene el stream activo). tvEl() lo re-engancha al nuevo slot.
    if (tvVideo && tvVideo.parentNode) tvVideo.parentNode.removeChild(tvVideo);
    app.innerHTML = `
      <header class="header">
        <a class="brand" href="https://dar2.cl" target="_blank" rel="noopener noreferrer" title="dar2.cl">
          <img class="logo logo-light" src="assets/logo-light.png" alt="dar2.cl">
          <img class="logo logo-dark" src="assets/logo-dark.png" alt="dar2.cl">
        </a>
        <div class="greet">
          <h1>${escapeHtml(greeting(p.name))}</h1>
          <div class="meta meta-primary">
            <span class="m-time">${escapeHtml(nowTime())}</span>
            <span class="m-temp m-loading" role="button" title="Ver pronóstico">…°C</span>
          </div>
          <div class="meta meta-secondary">
            <span class="m-date">${escapeHtml(todayString())}</span>
            <span class="sep">·</span>
            <span class="m-city" role="button" title="Cambiar ciudad">${escapeHtml(city.name)}</span>
            <span class="sep">·</span>
            <span class="m-usd m-loading" role="button" title="Ver evolución del dólar">USD …</span>
            <span class="sep">·</span>
            <span class="m-uf m-loading" role="button" title="Ver evolución de la UF">UF …</span>
            ${santo ? `<span class="sep">·</span><span class="m-santo" role="button" title="Ver próximos santos">${escapeHtml(santo)}</span>` : ''}
          </div>
        </div>
        <div class="actions">
          <div class="user-menu">
            <button class="user-btn" id="btn-user">
              <span class="avatar" style="background:${colorFor(p.name)}">${escapeHtml(p.name[0].toUpperCase())}</span>
              <span class="user-name">${escapeHtml(p.name)}</span>
              <span class="user-chevron">▾</span>
            </button>
            ${state.menuOpen ? menuHtml() : ''}
          </div>
        </div>
      </header>
      ${state.menuOpen ? '<div class="menu-backdrop" id="menu-backdrop"></div>' : ''}
      <div class="search">
        ${ICON_SEARCH}
        <input type="search" id="search" placeholder="Buscar enlace..." value="${escapeAttr(state.query)}" autocomplete="off">
      </div>
      <div class="media-row">
        ${tvBarHtml()}
        <section class="news" id="news-widget" hidden>
          <div class="news-cards"></div>
          <div class="news-controls">
            <span class="news-status"></span>
            <button class="news-prev" title="Anterior">‹</button>
            <button class="news-next" title="Siguiente">›</button>
          </div>
        </section>
      </div>
      ${p.categories.map(categoryHtml).join('')}
      <button class="add-cat" id="btn-add-cat">+ Nueva categoría</button>
    `;

    bind();
  }

  function menuHtml() {
    const p = currentProfile();
    const others = state.profiles.filter(pp => pp.id !== state.currentId);
    const isDark = p ? (p.theme || 'light') === 'dark' : prefersDark();
    const editLabel = state.editing ? 'Salir de edición' : 'Modo edición';
    const themeLabel = isDark ? 'Tema claro' : 'Tema oscuro';
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches
      || window.navigator.standalone === true;
    const ua = navigator.userAgent;
    const isIOS = /iPhone|iPad|iPod/.test(ua);
    const isAndroid = /Android/.test(ua);
    // Si ya está instalado (standalone) no mostramos nada. Si Chrome/Edge
    // disparó beforeinstallprompt, usamos su prompt nativo. Si no, caemos
    // a instrucciones manuales según el SO (en Android Samsung Internet o
    // Chrome a veces no dispara el evento — ahí mostramos el paso a paso).
    const installAct = isStandalone ? null
      : state.installPrompt ? 'install'
      : isIOS ? 'ios-install'
      : isAndroid ? 'android-install'
      : null;
    const installLabel = installAct === 'ios-install' ? 'Instalar en iPhone'
      : installAct === 'android-install' ? 'Instalar en Android'
      : 'Instalar app';
    return `
      <div class="menu" id="menu">
        ${installAct ? `
          <button class="menu-cta" data-act="${installAct}">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            ${installLabel}
          </button>
          <div class="sep"></div>
        ` : ''}

        <small>Apariencia</small>
        <button data-act="edit-toggle">${editLabel}</button>
        <button data-act="theme-toggle">${themeLabel}</button>

        <div class="sep"></div>
        <small>Perfil</small>
        <button data-act="rename">Editar nombre</button>
        <button data-act="city">Cambiar ciudad</button>
        <button data-act="bg">Personalizar fondo</button>
        <button data-act="news-src">Fuentes de noticias</button>
        <button data-act="alarms">Alarmas</button>

        <div class="sep"></div>
        ${others.length ? `<small>Cambiar a</small>` : '<small>Perfiles</small>'}
        ${others.map(pp => `<button data-act="switch" data-id="${escapeAttr(pp.id)}"><span class="avatar" style="background:${colorFor(pp.name)};width:20px;height:20px;font-size:11px">${escapeHtml(pp.name[0].toUpperCase())}</span>${escapeHtml(pp.name)}</button>`).join('')}
        <button data-act="new-profile">+ Nuevo perfil</button>

        <div class="sep"></div>
        <button class="menu-private" data-act="private">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          Acceso privado
        </button>

        <div class="sep"></div>
        <details class="menu-more">
          <summary>Más opciones</summary>
          <button data-act="reset">Restablecer enlaces</button>
          <button data-act="export">Exportar perfil</button>
          <button data-act="import">Importar perfil</button>
          <button data-act="sync">Sincronizar compartido</button>
          <button data-act="publish">Publicar mi catálogo</button>
          <button data-act="delete" class="danger">Eliminar este perfil</button>
        </details>
      </div>
    `;
  }

  // ─── Event binding ────────────────────────────────────────────────────────
  function bind() {
    $('#btn-user').onclick = (e) => {
      e.stopPropagation();
      state.menuOpen = !state.menuOpen;
      render();
    };

    if (state.menuOpen) {
      // Backdrop captura cualquier click fuera del menú y lo cierra. Más
      // confiable que un event listener global del document, que puede ser
      // bloqueado por stopPropagation de otros handlers.
      const backdrop = $('#menu-backdrop');
      if (backdrop) backdrop.onclick = () => {
        state.menuOpen = false;
        render();
      };
      const menu = $('#menu');
      if (menu) {
        menu.onclick = (e) => {
          const btn = e.target.closest('button');
          if (!btn) return;
          const act = btn.dataset.act;
          state.menuOpen = false;
          if (act === 'edit-toggle') { state.editing = !state.editing; state.menuOpen = false; render(); }
          else if (act === 'theme-toggle') { state.menuOpen = false; toggleTheme(); }
          else if (act === 'rename') dlgRenameProfile();
          else if (act === 'city') dlgCity();
          else if (act === 'bg') dlgBackground();
          else if (act === 'news-src') dlgNewsSources();
          else if (act === 'alarms') dlgAlarms();
          else if (act === 'reset') resetProfile();
          else if (act === 'switch') { state.currentId = btn.dataset.id; saveStorage(); applyTheme(); render(); scheduleAlarms(); }
          else if (act === 'new-profile') dlgNewProfile();
          else if (act === 'export') exportProfile();
          else if (act === 'import') importProfile();
          else if (act === 'sync') syncFromShared();
          else if (act === 'publish') publishCatalog();
          else if (act === 'delete') deleteCurrentProfile();
          else if (act === 'install') triggerInstall();
          else if (act === 'ios-install') dlgIosInstall();
          else if (act === 'android-install') dlgAndroidInstall();
          else if (act === 'private') { if (typeof window.openPrivateAccess === 'function') window.openPrivateAccess(); }
          else render();
        };
      }
    }

    const search = $('#search');
    search.oninput = () => {
      state.query = search.value.trim().toLowerCase();
      // soft re-render to keep focus
      const scroll = window.scrollY;
      render();
      const s2 = $('#search');
      s2.focus();
      s2.setSelectionRange(state.query.length, state.query.length);
      window.scrollTo(0, scroll);
    };

    $('#btn-add-cat').onclick = addCategory;

    const cityChip = document.querySelector('.m-city');
    if (cityChip) cityChip.onclick = dlgCity;
    const tempChip = document.querySelector('.m-temp');
    if (tempChip) tempChip.onclick = dlgForecast;
    const usdChip = document.querySelector('.m-usd');
    if (usdChip) usdChip.onclick = () => dlgIndicador('dolar');
    const ufChip = document.querySelector('.m-uf');
    if (ufChip) ufChip.onclick = () => dlgIndicador('uf');
    const santoChip = document.querySelector('.m-santo');
    if (santoChip) santoChip.onclick = dlgSantosProximos;

    // category controls
    document.querySelectorAll('.cat-name').forEach(inp => {
      inp.onchange = () => renameCategory(inp.dataset.cat, inp.value);
      inp.onkeydown = (e) => { if (e.key === 'Enter') inp.blur(); };
    });
    document.querySelectorAll('[data-act="cat-del"]').forEach(b => {
      b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); removeCategory(b.dataset.cat); };
    });

    // tiles
    document.querySelectorAll('.tile').forEach(tile => {
      const isAdd = tile.classList.contains('add');
      if (isAdd) {
        tile.onclick = (e) => { e.preventDefault(); dlgAddLink(tile.dataset.cat); };
        return;
      }
      // edit-mode: prevent navigation, allow click-to-edit
      tile.addEventListener('click', (e) => {
        if (state.editing) {
          e.preventDefault();
          if (e.target.closest('[data-act="rm"]')) {
            removeLink(tile.dataset.cat, tile.dataset.id);
          } else {
            dlgEditLink(tile.dataset.cat, tile.dataset.id);
          }
        }
      });
      tile.addEventListener('dragstart', onDragStart);
      tile.addEventListener('dragend', onDragEnd);
    });
    document.querySelectorAll('.cat-grip').forEach(grip => {
      grip.addEventListener('dragstart', onDragStart);
      grip.addEventListener('dragend', onDragEnd);
    });
    document.querySelectorAll('.cat').forEach(cat => {
      cat.addEventListener('dragover', onDragOver);
      cat.addEventListener('drop', onDrop);
    });

    // dispara la carga de widgets (clima, USD, UF) en cada render
    refreshWidgets();

    // controles del widget de noticias
    const prevBtn = document.querySelector('.news-prev');
    const nextBtn = document.querySelector('.news-next');
    if (prevBtn) prevBtn.onclick = () => newsAdvance(-1);
    if (nextBtn) nextBtn.onclick = () => newsAdvance(1);
    // Pausa la auto-rotación mientras el mouse está sobre el widget para
    // que se alcance a leer; al salir, retoma. Solo se reanuda si hay
    // suficientes items para rotar (más que los visibles).
    const newsWidget = document.getElementById('news-widget');
    if (newsWidget) {
      newsWidget.addEventListener('mouseenter', stopNewsAutoRotate);
      newsWidget.addEventListener('mouseleave', () => {
        const visibleCount = document.querySelector('.media-row')?.classList.contains('expanded') ? 4 : 3;
        if (state.news.items.length > visibleCount) startNewsAutoRotate();
      });
    }
    // si ya tenemos noticias en memoria, las re-renderizamos; si no, las traemos
    if (state.news.items.length) renderNewsCards();
    refreshNews();

    // barra de TV
    bindTvBar();

    // cascada de iconos: si el primer src falla (404 o globo), pasa al siguiente
    const advanceToNextFallback = (img) => {
      let fb = [];
      try { fb = JSON.parse(img.dataset.fb || '[]'); } catch {}
      if (fb.length) {
        img.src = fb.shift();
        img.dataset.fb = JSON.stringify(fb);
        return true;
      }
      const ico = img.parentElement;
      if (!ico) return false;
      ico.style.background = img.dataset.bg || '#94a3b8';
      ico.innerHTML = `<span class="ico-fb" style="background:transparent">${escapeHtml(img.dataset.initial || '?')}</span>`;
      return false;
    };
    document.querySelectorAll('.tile .ico img').forEach(img => {
      img.addEventListener('error', () => advanceToNextFallback(img));
      img.addEventListener('load', () => {
        // Google s2 y faviconV2 devuelven 200 OK con un globo de 16x16
        // cuando no encuentran favicon real (en vez de error). Lo detectamos
        // por tamaño y forzamos el siguiente fallback.
        const src = img.src || '';
        const isGoogleApi = src.includes('google.com/s2/favicons') || src.includes('gstatic.com/faviconV2');
        if (isGoogleApi && img.naturalWidth > 0 && img.naturalWidth <= 16) {
          advanceToNextFallback(img);
        }
      });
    });
  }

  // ─── Init ─────────────────────────────────────────────────────────────────
  function init() {
    loadStorage();
    applyTheme();

    // single global handler closes the user menu when clicking outside
    document.addEventListener('click', (ev) => {
      if (!state.menuOpen) return;
      if (ev.target.closest('#menu') || ev.target.closest('#btn-user')) return;
      state.menuOpen = false;
      render();
    });

    // close dialogs by clicking the backdrop
    dlg.addEventListener('click', (ev) => {
      if (ev.target === dlg) closeDialog();
    });

    // actualiza saludo y hora cada minuto sin re-renderizar todo
    setInterval(() => {
      if (!state.currentId) return;
      const greetEl = document.querySelector('.greet h1');
      const timeEl = document.querySelector('.m-time');
      const dateEl = document.querySelector('.m-date');
      const p = currentProfile();
      if (greetEl && p) greetEl.textContent = greeting(p.name);
      if (timeEl) timeEl.textContent = nowTime();
      if (dateEl) dateEl.textContent = todayString();
    }, 30000);

    if (state.profiles.length === 0) {
      dlgWelcome();
    } else if (!state.currentId || !currentProfile()) {
      if (state.profiles.length === 1) {
        state.currentId = state.profiles[0].id;
        saveStorage();
        applyTheme();
        render();
      } else {
        dlgProfilePicker();
      }
    } else {
      render();
    }

    // Programa las alarmas del perfil al cargar y cada vez que la pestaña
    // vuelve a foreground (por si el sistema durmió y se perdieron timers).
    scheduleAlarms();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') scheduleAlarms();
    });
  }

  init();
})();
