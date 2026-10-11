(function () {
  const $ = (id) => document.getElementById(id);
  const root = document.documentElement;
  const audio = new Audio();
  audio.preload = 'none';
  const reduceMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  // 收聽免費、不用登入。登入與付費只用來開通「嵌入到自己網站」的進階功能。
  const state = { me: null, channels: [], channel: null, genre: '', started: false, track: null };

  // ---------- 小工具 ----------
  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (const kid of kids) if (kid != null) n.append(kid);
    return n;
  }
  async function api(path, opts) {
    const r = await fetch(path, opts);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'HTTP ' + r.status);
    return data;
  }
  const post = (path, body) => api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  const setStatus = (msg, isErr) => { const s = $('status'); s.textContent = msg; s.classList.toggle('err', !!isErr); };
  const fmt = (s) => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');

  // ---------- 黑 / 白主題 ----------
  const barColor = () => getComputedStyle(root).getPropertyValue('--bar').trim() || '#fff';
  $('btn-theme').addEventListener('click', () => {
    const next = root.classList.contains('dark') ? 'light' : 'dark';
    root.className = next;
    try { localStorage.setItem('theme', next); } catch (e) { /* 無痕模式 */ }
    vis.setColor(barColor());
  });

  // ---------- 播放 ----------
  const player = RadioPlayer(audio, {
    onStatus: (msg) => {
      setStatus(msg, /lost|not support|again/i.test(msg));
      $('play').classList.toggle('loading', /connecting|loading/i.test(msg));
    },
    onTrack: (info, frag) => {
      // 記下正在播的是這首歌的第幾段,之後每半秒就能算出「這首歌播到哪」
      const cum = []; let acc = 0;
      for (const [, d] of info.segments || []) { cum.push(acc); acc += d; }
      const idx = (info.segments || []).findIndex((s) => s[0] === frag.file);
      state.track = { info, cum, idx: Math.max(0, idx), start: frag.start };
      renderTrack();
      if ('mediaSession' in navigator) navigator.mediaSession.metadata = new MediaMetadata({ title: state.channel ? state.channel.name : 'Radio Hum', artist: tagLine(info) || info.title });
    },
    onDenied: () => { setStatus(t('cannotConnect'), true); $('play').classList.remove('loading'); },
  });
  audio.addEventListener('playing', () => $('play').classList.remove('loading'));
  audio.addEventListener('play', () => { $('play').classList.add('playing'); $('play').setAttribute('aria-label', t('pause')); $('card').classList.remove('paused'); });
  audio.addEventListener('pause', () => { $('play').classList.remove('playing', 'loading'); $('play').setAttribute('aria-label', t('play')); $('card').classList.add('paused'); });

  // 這首歌播到哪:已播段落的總長 + 目前這一段播了多久
  setInterval(() => {
    const tr = state.track;
    if (!tr || !tr.info.seconds || audio.paused) return;
    const segDur = (tr.info.segments[tr.idx] || [0, 10])[1];
    const within = Math.min(Math.max(audio.currentTime - tr.start, 0), segDur);
    const elapsed = Math.min((tr.cum[tr.idx] || 0) + within, tr.info.seconds);
    $('prog').style.width = (elapsed / tr.info.seconds) * 100 + '%';
    $('t-el').textContent = fmt(elapsed);
    $('t-rem').textContent = '-' + fmt(Math.max(tr.info.seconds - elapsed, 0));
  }, 500);

  // ---------- 動畫(置中直條;偏好「減少動態」的人不畫) ----------
  const vis = new Visualizer($('vis'), audio);
  vis.setBassTargets([]); // 黑白版面沒有用到 --bass
  vis.setLight(root.classList.contains('light'));
  vis.setColor(barColor());
  vis.setStyle(reduceMotion ? 'off' : 'center');
  vis.start();

  // ---------- 這首歌的「特色」 ----------
  // tags 是生成這首歌時的提示詞各軸選項(例如 速度:72 bpm、場景:rainy window)。沒有的話就顯示曲名。
  const AXIS = { '速度': 'Tempo', '主奏': 'Lead', '風格偏向': 'Style', '場景': 'Scene', '點綴音': 'Texture', '質感': 'Texture', '結構': 'Structure', '調性氣質': 'Mood', '情緒': 'Mood' };
  const tagLine = (info) => (info && info.tags ? Object.values(info.tags).filter((v) => v && v !== '—').slice(0, 3).join(' · ') : '');
  function renderTrack() {
    const tr = state.track;
    if (!tr) return;
    const line = tagLine(tr.info);
    $('sub').textContent = line || [tr.info.title, tr.info.artist].filter(Boolean).join(' · ');
    const hasRecipe = !!tr.info.tags;
    $('btn-recipe').classList.toggle('hidden', !hasRecipe);
    if (hasRecipe) {
      $('recipe').replaceChildren(
        ...Object.entries(tr.info.tags).map(([k, v]) => el('div', {}, el('span', {}, AXIS[k] || k), el('span', {}, v))),
        el('small', {}, t('recipeNote')));
    } else {
      $('recipe').classList.remove('on'); $('btn-recipe').classList.remove('on');
    }
  }
  $('btn-recipe').addEventListener('click', () => {
    const on = $('recipe').classList.toggle('on');
    $('btn-recipe').classList.toggle('on', on);
  });

  // ---------- 頻道與曲風 ----------
  const genreName = (ch, gid) => { const g = gid && ch.genres.find((x) => x.id === gid); return g ? g.name : ''; };

  function renderStage() {
    const ch = state.channel;
    if (!ch) return;
    $('title').textContent = ch.name;
    const g = genreName(ch, state.genre);
    document.title = ch.name + (g ? ' · ' + g : '') + ' · Radio Hum';
  }
  function renderPills() {
    $('channels').replaceChildren(...state.channels.map((c) =>
      el('button', { class: 'pill', type: 'button', 'aria-pressed': String(!!state.channel && state.channel.id === c.id), onclick: () => selectChannel(c, '') }, c.name)));
    const ch = state.channel;
    $('genres').replaceChildren(...(ch && ch.genres.length ? [
      el('button', { class: 'pill', type: 'button', 'aria-pressed': String(!state.genre), onclick: () => selectChannel(ch, '') }, t('anyGenre')),
      ...ch.genres.map((g) => el('button', { class: 'pill', type: 'button', 'aria-pressed': String(state.genre === g.id), onclick: () => selectChannel(ch, g.id) }, g.name)),
    ] : []));
    const active = $('channels').querySelector('[aria-pressed="true"]');
    if (active && active.scrollIntoView) active.scrollIntoView({ inline: 'center', block: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' });
  }

  function selectChannel(ch, genre) {
    state.channel = ch;
    state.genre = genre || '';
    state.track = null;
    try { localStorage.setItem('last', ch.id + '/' + state.genre); } catch (e) { /* ignore */ }
    history.replaceState(null, '', '#' + ch.id + (state.genre ? '/' + state.genre : ''));
    renderStage();
    renderPills();
    $('sub').textContent = t('tuning');
    $('btn-recipe').classList.add('hidden'); $('recipe').classList.remove('on');
    $('prog').style.width = '0'; $('t-el').textContent = ''; $('t-rem').textContent = '';
    tune();
    player.play();
  }
  function stepChannel(dir) {
    const list = state.channels;
    if (!list.length) return;
    const i = Math.max(0, list.findIndex((c) => state.channel && c.id === state.channel.id));
    selectChannel(list[(i + dir + list.length) % list.length], '');
  }
  $('btn-prev').addEventListener('click', () => stepChannel(-1));
  $('btn-next').addEventListener('click', () => stepChannel(1));

  // ---------- 播放控制 ----------
  $('vol').addEventListener('input', (e) => (audio.volume = e.target.value));
  $('play').addEventListener('click', togglePlay);
  function togglePlay() {
    if (!state.channel) return;
    if (!audio.paused) return player.pause();
    if (!state.started) tune();
    player.play();
  }
  function tune() {
    state.started = true;
    player.tune(state.channel.id, state.genre);
  }
  const dlg = $('embed-dialog');
  document.addEventListener('keydown', (e) => {
    if (dlg.open || /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) return;
    if (e.code === 'Space' && !/^(BUTTON|A)$/.test(document.activeElement.tagName)) { e.preventDefault(); togglePlay(); }
    else if (e.key === 'ArrowRight') stepChannel(1);
    else if (e.key === 'ArrowLeft') stepChannel(-1);
    else if (e.key === 'm' || e.key === 'M') { audio.muted = !audio.muted; setStatus(audio.muted ? t('muted') : ''); }
  });

  // ---------- 帳號(只為了嵌入功能) ----------
  async function refreshMe() { state.me = await api('/api/me'); return state.me; }
  function renderHeader() {
    const me = state.me;
    $('who').textContent = me.loggedIn ? me.name || me.email : '';
    $('btn-login').classList.toggle('hidden', me.loggedIn); // 沒登入就一定看得到登入連結
    $('btn-logout').classList.toggle('hidden', !me.loggedIn);
    $('btn-admin').classList.toggle('hidden', !me.isAdmin);
    if (me.adminConsoleUrl) $('btn-admin').href = me.adminConsoleUrl; // 開通 / 關閉使用者在 auth-hub 後台做
    $('btn-tracker').classList.toggle('hidden', !me.isAdmin);
  }
  $('btn-logout').addEventListener('click', async () => {
    await fetch('/auth/logout', { method: 'POST' }); // 只登出 Radio Hum,不影響其他共用 auth-hub 的站
    await refreshMe(); renderHeader();
  });

  // ---------- 嵌入功能對話框:依狀態顯示「登入」/「訂閱」/「金鑰管理」 ----------
  // 對話框的固定文字
  $('d-title').textContent = t('embedTitle');
  $('d-intro').textContent = t('embedIntro');
  $('d-keyshelp').textContent = t('keysHelp');
  $('d-newkey').textContent = t('newKey');
  $('key-label').placeholder = t('keyName');
  $('key-origins').placeholder = t('keyOrigins');
  $('key-create').textContent = t('createKey');
  $('embed-close').textContent = t('close');

  async function renderKeys() {
    const { keys } = await api('/api/keys');
    const ch = state.channel ? state.channel.id : 'all';
    const path = '/embed/' + ch + (state.genre ? '/' + state.genre : '');
    $('key-list').replaceChildren(...(keys.length ? keys.map((k) => {
      const iframe = '<iframe src="' + location.origin + path + '?key=' + k.key + '" width="100%" height="76" style="border:0;border-radius:18px" allow="autoplay"></iframe>';
      const stream = location.origin + '/live/' + ch + (state.genre ? '/' + state.genre : '') + '/playlist.m3u8?key=' + k.key;
      const validity = state.me.isAdmin ? t('neverExpires') : t('validUntil', { date: new Date(k.entitledUntil).toLocaleDateString() });
      return el('div', { class: 'keyitem' },
        el('div', { class: 'row' }, el('strong', {}, k.label), el('span', { class: 'muted' }, k.origins.length ? k.origins.join(', ') : t('anySite')), el('span', { class: 'muted' }, validity),
          el('button', { class: 'btn small danger', type: 'button', onclick: async () => { if (confirm(t('confirmDelete'))) { await api('/api/keys/' + k.key, { method: 'DELETE' }); renderKeys(); } } }, t('del'))),
        el('div', { class: 'muted' }, t('iframeLabel')),
        el('pre', { class: 'code' }, iframe),
        el('div', { class: 'muted' }, t('streamLabel')),
        el('pre', { class: 'code' }, stream));
    }) : [el('p', { class: 'muted' }, t('noKeys'))]));
  }

  async function openEmbed() {
    try { await refreshMe(); } catch (e) { setStatus(t('loadFailed', { msg: e.message }), true); return; }
    renderHeader();
    const me = state.me;
    const box = $('embed-state');
    box.replaceChildren();
    $('embed-keys').classList.add('hidden');

    if (!me.loggedIn) {
      box.append(el('p', {}, t('step1')));
      box.append(el('a', { class: 'btn primary', href: '/auth/login?next=/' }, t('signInGoogle')));
      if (me.devLogin) {
        const input = el('input', { type: 'email', placeholder: t('devEmail') });
        box.append(el('form', { class: 'row', onsubmit: (e) => { e.preventDefault(); location.href = '/auth/dev?email=' + encodeURIComponent(input.value); } }, input, el('button', { class: 'btn small' }, t('signIn'))));
      }
    } else if (!me.entitled) {
      box.append(el('p', {}, t('signedInNotEnabled', { email: me.email })));
      if (me.subscribeUrl) box.append(el('a', { class: 'btn primary', href: me.subscribeUrl, target: '_blank', rel: 'noopener' }, t('subscribe')));
      box.append(el('p', { class: 'muted' }, t('enableHelp')));
      box.append(el('button', { class: 'btn small', type: 'button', onclick: () => { location.href = '/auth/login?next=/'; } }, t('checkAgain')));
    } else {
      $('embed-keys').classList.remove('hidden');
      await renderKeys();
    }
    dlg.showModal();
  }
  $('btn-embed').addEventListener('click', openEmbed);
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
    const [dir] = await Promise.all([api('/api/channels'), refreshMe().catch(() => null)]);
    state.channels = dir.channels;
    if (state.me) renderHeader();
    if (!state.channels.length) { $('title').textContent = t('noChannels'); return; }

    let want = location.hash.slice(1);
    try { want = want || localStorage.getItem('last') || ''; } catch (e) { /* ignore */ }
    const [cid, gid] = want.split('/');
    const found = state.channels.find((c) => c.id === cid) || state.channels[0];
    state.channel = found;
    state.genre = found.genres.some((g) => g.id === gid) ? gid : '';
    renderStage();
    renderPills();
    $('sub').textContent = found.description || '';
  }
  init().catch((e) => setStatus(t('loadFailed', { msg: e.message }), true));
})();
