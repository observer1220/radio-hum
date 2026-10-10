// 播放核心:包裝 hls.js,播放器頁與嵌入頁共用。
// RadioPlayer(audio, { key, onTrack(info), onStatus(text), onDenied() })
(function () {
  const trackCache = {};
  async function trackInfo(id) {
    if (!trackCache[id]) {
      trackCache[id] = fetch('/api/track/' + encodeURIComponent(id))
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
    }
    return trackCache[id];
  }

  function RadioPlayer(audio, opts) {
    let hls = null;
    let retryTimer = null;
    let tuneSeq = 0;

    function streamUrl(channel, genre) {
      const q = opts.key ? '?key=' + encodeURIComponent(opts.key) : '';
      return '/live/' + encodeURIComponent(channel) + (genre ? '/' + encodeURIComponent(genre) : '') + '/playlist.m3u8' + q;
    }

    function teardown() {
      clearTimeout(retryTimer);
      if (hls) { hls.destroy(); hls = null; }
    }

    function status(t) { if (opts.onStatus) opts.onStatus(t); }

    // 回到直播最前端(暫停太久或剛換頻道時用)
    function goLive() {
      if (hls && hls.liveSyncPosition) audio.currentTime = hls.liveSyncPosition;
    }

    function tune(channel, genre) {
      const seq = ++tuneSeq;
      teardown();
      const url = streamUrl(channel, genre);
      status('連線中…');

      if (window.Hls && Hls.isSupported()) {
        hls = new Hls({
          liveSyncDurationCount: 3,
          manifestLoadingTimeOut: 20000,
          levelLoadingTimeOut: 20000,
          manifestLoadingMaxRetry: 4,
          levelLoadingMaxRetry: 6,
        });
        hls.loadSource(url);
        hls.attachMedia(audio);
        hls.on(Hls.Events.MANIFEST_PARSED, () => status(''));
        hls.on(Hls.Events.FRAG_CHANGED, async (_e, data) => {
          const m = (data.frag.url || '').split('/live/segments/')[1];
          const info = m && (await trackInfo(m.split('/')[0].split('?')[0]));
          if (info && seq === tuneSeq && opts.onTrack) opts.onTrack(info);
        });
        hls.on(Hls.Events.ERROR, (_e, data) => {
          const code = data.response && data.response.code;
          if (code === 401 || code === 403) {
            teardown();
            if (opts.onDenied) opts.onDenied();
            return;
          }
          if (!data.fatal) return;
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            hls.recoverMediaError();
          } else {
            // 網路中斷(店家網路不穩很常見):幾秒後自動重連
            status('連線中斷,重新連線…');
            retryTimer = setTimeout(() => { if (seq === tuneSeq) tune(channel, genre); }, 3000);
          }
        });
      } else if (audio.canPlayType('application/vnd.apple.mpegurl')) {
        audio.src = url; // Safari / iOS 原生 HLS
        status('');
      } else {
        status('此瀏覽器不支援 HLS 播放');
      }
    }

    function play() {
      goLive();
      return audio.play().catch((e) => status('請再按一次播放(' + e.name + ')'));
    }

    return { tune, play, pause: () => audio.pause(), goLive, teardown };
  }

  window.RadioPlayer = RadioPlayer;
})();
