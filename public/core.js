// 播放核心:包裝 hls.js,播放器頁與嵌入頁共用。
// RadioPlayer(audio, { key, onTrack(info), onStatus(text), onDenied() })
(function () {
  const trackCache = {};
  async function trackInfo(id) {
    if (!trackCache[id]) {
      // ?v=2:舊版把這支 API 的回應設成快取 24 小時;換個網址,已經載入過的訪客才不會拿到舊的(沒有標籤的)資料
      trackCache[id] = fetch('/api/track/' + encodeURIComponent(id) + '?v=2')
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
      status('Connecting…');

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
          const parts = m ? m.split('?')[0].split('/') : [];
          const info = parts[0] && (await trackInfo(parts[0]));
          // 第二個參數:正在播的是這首歌的哪一段、這一段在播放時間軸上的起點(用來算「這首歌播到哪」)
          if (info && seq === tuneSeq && opts.onTrack) opts.onTrack(info, { file: parts[1], start: data.frag.start });
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
            status('Connection lost, reconnecting…');
            retryTimer = setTimeout(() => { if (seq === tuneSeq) tune(channel, genre); }, 3000);
          }
        });
      } else if (audio.canPlayType('application/vnd.apple.mpegurl')) {
        audio.src = url; // Safari / iOS 原生 HLS
        status('');
      } else {
        status('This browser does not support HLS playback');
      }
    }

    function play() {
      goLive();
      return audio.play().catch((e) => status('Press play again (' + e.name + ')'));
    }

    return { tune, play, pause: () => audio.pause(), goLive, teardown };
  }

  window.RadioPlayer = RadioPlayer;
})();
