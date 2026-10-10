(function () {
  const $ = (id) => document.getElementById(id);
  const audio = new Audio();
  audio.preload = 'none';
  const reduceMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  const state = { me: null, channels: [], channel: null, genre: '', started: false };

  // ---------- 小工具 ----------
  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (const kid of kids) n.append(kid);
    return n;
  }
  async function api(path, opts) {
    const r = await fetch(path, opts);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'HTTP ' + r.status);
    return data;
  }
  const post = (path, body) => api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  const entitled = () => state.me && state.me.entitled;
  const setStatus = (t, isErr) => { const s = $('status'); s.textContent = t; s.classList.toggle('err', !!isErr); };

  // ---------- 播放器 ----------
  const player = RadioPlayer(audio, {
    onStatus: (t) => {
      setStatus(t, /中斷|不支援|失敗/.test(t));
      $('play').classList.toggle('loading', /連線中|載入中/.test(t));
    },
    onTrack: (info) => {
      $('title').textContent = info.title;
      $('artist').textContent = info.artist;
      if ('mediaSession' in navigator) navigator.mediaSession.metadata = new MediaMetadata({ title: info.title, artist: info.artist || '測試電台' });
    },
    onDenied: () => { refreshMe().then(renderGate); },
  });
  audio.addEventListener('playing', () => $('play').classList.remove('loading'));
  audio.addEventListener('play', () => { $('play').classList.add('playing'); $('play').setAttribute('aria-label', '暫停'); $('live').classList.add('on'); });
  audio.addEventListener('pause', () => { $('play').classList.remove('playing', 'loading'); $('play').setAttribute('aria-label', '播放'); $('live').classList.remove('on'); });

  // ---------- 動畫(小小的音量條,可在上方選單關閉) ----------
  const vis = new Visualizer($('vis'), audio);
  vis.setLight(true);
  vis.setBassTargets([]); // 白底版面沒有用到 --bass
  const styleSel = $('vis-style');
  for (const [k, name] of Object.entries(vis.styles)) styleSel.append(el('option', { value: k }, name));
  let saved = null;
  try { saved = localStorage.getItem('vis'); } catch (e) { /* 無痕模式 */ }
  styleSel.value = vis.styles[saved] ? saved : reduceMotion ? 'off' : 'bars';
  function applyStyle() {
    vis.setStyle(styleSel.value);
    $('vis').classList.toggle('hidden', styleSel.value === 'off');
  }
  applyStyle();
  vis.start();
  styleSel.addEventListener('change', () => {
    applyStyle();
    try { localStorage.setItem('vis', styleSel.value); } catch (e) { /* ignore */ }
  });

  // ---------- 頻道與曲風 ----------
  const genreName = (ch, gid) => { const g = gid && ch.genres.find((x) => x.id === gid); return g ? g.name : ''; };

  function renderWhere() {
    const ch = state.channel;
    if (!ch) return;
    const g = genreName(ch, state.genre);
    $('where').textContent = ch.name + (g ? ' ・ ' + g : '');
    document.title = ch.name + (g ? ' ・ ' + g : '') + ' | 測試電台';
  }

  function renderMenus() {
    $('channels').replaceChildren(...state.channels.map((c) =>
      el('button', { class: 'channel' + (state.channel && state.channel.id === c.id ? ' active' : ''), onclick: () => selectChannel(c, '') },
        el('span', { class: 'name' }, c.name),
        el('span', { class: 'meta' }, c.trackCount + ' 首 ・ 約 ' + c.minutes + ' 分鐘'))));

    const ch = state.channel;
    $('genres').replaceChildren(...(ch && ch.genres.length ? [
      el('button', { class: 'chip' + (!state.genre ? ' active' : ''), onclick: () => selectChannel(ch, '') }, '全部曲風'),
      ...ch.genres.map((g) => el('button', { class: 'chip' + (state.genre === g.id ? ' active' : ''), onclick: () => selectChannel(ch, g.id) }, g.name, el('span', { class: 'n' }, g.count))),
    ] : []));
  }

  function selectChannel(ch, genre) {
    state.channel = ch;
    state.genre = genre || '';
    try { localStorage.setItem('last', ch.id + '/' + state.genre); } catch (e) { /* ignore */ }
    history.replaceState(null, '', '#' + ch.id + (state.genre ? '/' + state.genre : ''));
    renderWhere();
    renderMenus();
    if (entitled()) { tune(); player.play(); } else renderGate();
  }

  // ---------- 播放控制 ----------
  $('vol').addEventListener('input', (e) => (audio.volume = e.target.value));
  $('play').addEventListener('click', togglePlay);
  function togglePlay() {
    if (!state.channel) return setStatus('先選一個頻道');
    if (!entitled()) return renderGate();
    if (!audio.paused) return player.pause();
    if (!state.started) tune();
    player.play();
  }
  function tune() {
    state.started = true;
    $('title').textContent = '載入中…';
    $('artist').textContent = '';
    player.tune(state.channel.id, state.genre);
  }
  const dlg = $('embed-dialog');
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || dlg.open || /^(INPUT|SELECT|TEXTAREA|BUTTON|A)$/.test(document.activeElement.tagName)) return;
    e.preventDefault();
    togglePlay();
  });

  // ---------- 登入 / 付款 ----------
  async function refreshMe() { state.me = await api('/api/me'); return state.me; }

  function renderHeader() {
    const me = state.me;
    $('who').textContent = me.loggedIn ? me.name || me.email : '';
    $('btn-login').classList.toggle('hidden', me.loggedIn || !me.googleEnabled);
    $('btn-logout').classList.toggle('hidden', !me.loggedIn);
    $('btn-admin').classList.toggle('hidden', !me.isAdmin);
    $('btn-embed').classList.toggle('hidden', !me.entitled);
    $('btn-billing').classList.toggle('hidden', !(me.loggedIn && me.hasBillingPortal));
  }

  function renderGate() {
    renderHeader();
    const me = state.me;
    const gate = $('gate');
    if (me.entitled) return gate.classList.add('hidden');
    gate.classList.remove('hidden');
    $('gate-login').classList.toggle('hidden', me.loggedIn || !me.googleEnabled);
    $('dev-form').classList.toggle('hidden', me.loggedIn || !me.devLogin);
    $('gate-subscribe').classList.toggle('hidden', !(me.loggedIn && me.billingEnabled));
    if (!me.loggedIn) {
      $('gate-title').textContent = '登入後收聽';
      $('gate-text').textContent = '請先用 Google 帳號登入。';
    } else {
      $('gate-title').textContent = '尚未開通';
      $('gate-text').textContent = me.billingEnabled
        ? '訂閱後即可收聽全部頻道,也可以取得嵌入網站的金鑰。已付款但沒開通?請聯絡管理員。(' + me.email + ')'
        : '你的帳號(' + me.email + ')尚未開通,請聯絡管理員啟用。';
    }
  }

  $('gate-subscribe').addEventListener('click', async () => {
    try { location.href = (await post('/billing/checkout')).url; } catch (e) { setStatus(e.message, true); }
  });
  $('btn-billing').addEventListener('click', async () => {
    try { location.href = (await post('/billing/portal')).url; } catch (e) { setStatus(e.message, true); }
  });
  $('btn-logout').addEventListener('click', async () => {
    await fetch('/auth/logout', { method: 'POST' });
    player.pause(); player.teardown();
    state.started = false;
    await refreshMe(); renderGate();
  });
  $('dev-form').addEventListener('submit', (e) => {
    e.preventDefault();
    location.href = '/auth/dev?email=' + encodeURIComponent($('dev-email').value);
  });

  // ---------- 嵌入金鑰 ----------
  async function renderKeys() {
    const { keys } = await api('/api/keys');
    const ch = state.channel ? state.channel.id : 'all';
    const path = '/embed/' + ch + (state.genre ? '/' + state.genre : '');
    $('key-list').replaceChildren(...(keys.length ? keys.map((k) => {
      const iframe = '<iframe src="' + location.origin + path + '?key=' + k.key + '" width="100%" height="96" style="border:0" allow="autoplay"></iframe>';
      const stream = location.origin + '/live/' + ch + (state.genre ? '/' + state.genre : '') + '/playlist.m3u8?key=' + k.key;
      return el('div', { class: 'keyitem' },
        el('div', { class: 'row' }, el('strong', {}, k.label), el('span', { class: 'muted' }, k.origins.length ? k.origins.join(', ') : '不限網站'),
          el('button', { class: 'btn small danger', onclick: async () => { if (confirm('刪除後使用這把金鑰的網站會立刻停止播放,確定?')) { await api('/api/keys/' + k.key, { method: 'DELETE' }); renderKeys(); } } }, '刪除')),
        el('div', { class: 'muted' }, '目前所選頻道的 iframe 嵌入碼:'),
        el('pre', { class: 'code' }, iframe),
        el('div', { class: 'muted' }, '串流網址(自訂播放器 / App 用,HLS):'),
        el('pre', { class: 'code' }, stream));
    }) : [el('p', { class: 'muted' }, '還沒有金鑰。')]));
  }
  $('btn-embed').addEventListener('click', async () => { await renderKeys(); dlg.showModal(); });
  $('embed-close').addEventListener('click', () => dlg.close());
  $('key-create').addEventListener('click', async () => {
    try {
      await post('/api/keys', { label: $('key-label').value, origins: $('key-origins').value.split('\n').map((s) => s.trim()).filter(Boolean) });
      $('key-label').value = ''; $('key-origins').value = ''; $('key-msg').textContent = '';
      renderKeys();
    } catch (e) { $('key-msg').textContent = e.message; }
  });

  // ---------- 啟動 ----------
  async function init() {
    const [dir] = await Promise.all([api('/api/channels'), refreshMe()]);
    state.channels = dir.channels;
    renderHeader();
    renderGate();
    if (!state.channels.length) { $('channels').textContent = '目前還沒有頻道。請先放入歌曲並執行 npm run convert。'; return; }

    let want = location.hash.slice(1);
    try { want = want || localStorage.getItem('last') || ''; } catch (e) { /* ignore */ }
    const [cid, gid] = want.split('/');
    const found = state.channels.find((c) => c.id === cid) || state.channels[0];
    state.channel = found;
    state.genre = found.genres.some((g) => g.id === gid) ? gid : '';
    renderWhere();
    renderMenus();
    if (new URLSearchParams(location.search).get('billing') === 'success') setStatus('付款完成,開通可能需要幾秒鐘,稍後請重新整理。');
  }
  init().catch((e) => setStatus('載入失敗:' + e.message, true));
})();
