(function () {
  const $ = (id) => document.getElementById(id);
  const audio = new Audio();
  audio.preload = 'none';
  const reduceMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  // 收聽免費、不用登入。登入與付款只用來開通「嵌入到自己網站」的進階功能。
  const state = { me: null, channels: [], channel: null, genre: '', started: false };

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
      if ('mediaSession' in navigator) navigator.mediaSession.metadata = new MediaMetadata({ title: info.title, artist: info.artist || 'Radio Hum' });
    },
    onDenied: () => { setStatus('無法連線到這個頻道,請重新整理頁面', true); $('play').classList.remove('loading'); },
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
    document.title = ch.name + (g ? ' ・ ' + g : '') + ' | Radio Hum';
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
    tune();
    player.play();
  }

  // ---------- 播放控制 ----------
  $('vol').addEventListener('input', (e) => (audio.volume = e.target.value));
  $('play').addEventListener('click', togglePlay);
  function togglePlay() {
    if (!state.channel) return setStatus('先選一個頻道');
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

  // ---------- 帳號(只為了嵌入功能) ----------
  async function refreshMe() { state.me = await api('/api/me'); return state.me; }

  function renderHeader() {
    const me = state.me;
    $('who').textContent = me.loggedIn ? me.name || me.email : '';
    $('btn-login').classList.toggle('hidden', me.loggedIn); // 沒登入就一定看得到登入按鈕
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
  async function renderKeys() {
    const { keys } = await api('/api/keys');
    const ch = state.channel ? state.channel.id : 'all';
    const path = '/embed/' + ch + (state.genre ? '/' + state.genre : '');
    $('key-list').replaceChildren(...(keys.length ? keys.map((k) => {
      const iframe = '<iframe src="' + location.origin + path + '?key=' + k.key + '" width="100%" height="96" style="border:0" allow="autoplay"></iframe>';
      const stream = location.origin + '/live/' + ch + (state.genre ? '/' + state.genre : '') + '/playlist.m3u8?key=' + k.key;
      return el('div', { class: 'keyitem' },
        el('div', { class: 'row' }, el('strong', {}, k.label), el('span', { class: 'muted' }, k.origins.length ? k.origins.join(', ') : '不限網站'),
          el('span', { class: 'muted' }, state.me.isAdmin ? '不會過期' : '有效至 ' + new Date(k.entitledUntil).toLocaleDateString() + '(登入時自動延長)'),
          el('button', { class: 'btn small danger', onclick: async () => { if (confirm('刪除後使用這把金鑰的網站會立刻停止播放,確定?')) { await api('/api/keys/' + k.key, { method: 'DELETE' }); renderKeys(); } } }, '刪除')),
        el('div', { class: 'muted' }, '目前所選頻道的 iframe 嵌入碼:'),
        el('pre', { class: 'code' }, iframe),
        el('div', { class: 'muted' }, '串流網址(自訂播放器 / App 用,HLS):'),
        el('pre', { class: 'code' }, stream));
    }) : [el('p', { class: 'muted' }, '還沒有金鑰。')]));
  }

  async function openEmbed() {
    try { await refreshMe(); } catch (e) { setStatus('讀取帳號狀態失敗:' + e.message, true); return; }
    renderHeader();
    const me = state.me;
    const box = $('embed-state');
    box.replaceChildren();
    $('embed-keys').classList.add('hidden');

    if (!me.loggedIn) {
      box.append(el('p', {}, '第一步:登入你的帳號。'));
      box.append(el('a', { class: 'btn primary', href: '/auth/login?next=/' }, '用 Google 登入'));
      if (me.devLogin) {
        const input = el('input', { type: 'email', placeholder: '開發測試:輸入 email' });
        box.append(el('form', { class: 'row', onsubmit: (e) => { e.preventDefault(); location.href = '/auth/dev?email=' + encodeURIComponent(input.value); } }, input, el('button', { class: 'btn small' }, '登入')));
      }
    } else if (!me.entitled) {
      box.append(el('p', {}, '你已登入(' + me.email + '),但尚未開通嵌入功能。'));
      if (me.subscribeUrl) box.append(el('a', { class: 'btn primary', href: me.subscribeUrl, target: '_blank', rel: 'noopener' }, '前往訂閱'));
      box.append(el('p', { class: 'muted' }, '已付款但還沒開通?請聯絡管理員,在 auth-hub 後台開通這個帳號的「radio-hum / embed」。開通後重新按一次「登入」就會生效。'));
      box.append(el('button', { class: 'btn small', onclick: () => { location.href = '/auth/login?next=/'; } }, '我已開通,重新確認'));
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
    if (!state.channels.length) { $('channels').textContent = '目前還沒有頻道。請先放入歌曲並執行 npm run convert。'; return; }

    let want = location.hash.slice(1);
    try { want = want || localStorage.getItem('last') || ''; } catch (e) { /* ignore */ }
    const [cid, gid] = want.split('/');
    const found = state.channels.find((c) => c.id === cid) || state.channels[0];
    state.channel = found;
    state.genre = found.genres.some((g) => g.id === gid) ? gid : '';
    renderWhere();
    renderMenus();
  }
  init().catch((e) => setStatus('載入失敗:' + e.message, true));
})();
