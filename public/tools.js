// 播放器的小工具:均衡器、睡眠定時、鬧鐘收音機(各是一個彈窗),以及資訊面板的開關。
// 由 player.js 在啟動時呼叫:PlayerTools({ audio, $, el, t, state, selectChannel, setStatus, stop })
(function () {
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 無痕模式 */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };
  const mmss = (s) => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
  const SLEEP_STEPS = [0, 15, 30, 45, 60]; // 分鐘;0 = 關閉
  const FADE_OUT_MS = 8000;   // 睡眠定時:最後 8 秒慢慢變小聲
  const FADE_IN_MS = 20000;   // 鬧鐘:20 秒慢慢變大聲

  window.PlayerTools = function (api) {
    const { audio, $, el, t, state, selectChannel, setStatus, stop } = api;
    const RA = window.RadioAudio;
    const baseVol = () => Number($('vol').value);

    // ---------- 彈窗 ----------
    function makeDialog(id, title, ...body) {
      const dlg = el('dialog', { id, class: 'small' },
        el('h3', {}, title), ...body,
        el('div', { class: 'row' }, el('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, t('close'))));
      dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }); // 點彈窗外面的暗處也能關
      document.body.append(dlg);
      return dlg;
    }
    const chip = (label, pressed, onclick) => el('button', { class: 'pill', type: 'button', 'aria-pressed': String(!!pressed), onclick }, label);

    // ---------- 資訊面板(動畫區上的覆蓋層) ----------
    const recipe = $('recipe'), recipeBtn = $('btn-recipe'), viz = document.querySelector('.viz');
    recipeBtn.addEventListener('click', () => {
      const on = recipe.classList.toggle('on');
      recipeBtn.classList.toggle('on', on);
    });
    // 換頻道時別的程式碼會直接關掉資訊面板,所以用觀察的來同步動畫區高度
    new MutationObserver(() => viz.classList.toggle('open', recipe.classList.contains('on'))).observe(recipe, { attributes: true, attributeFilter: ['class'] });

    // ---------- 均衡器 ----------
    const eqChips = el('div', { class: 'chips' });
    const sliders = {};
    const saveEq = (cur) => store.set('eq', { preset: cur.preset, bass: cur.bass, mid: cur.mid, treble: cur.treble });
    function slider(key, label) {
      const input = el('input', { type: 'range', min: '-10', max: '10', step: '1', value: '0', 'aria-label': label });
      input.addEventListener('input', () => {
        RA.ensure(audio);
        const cur = RA.setEq({ bass: Number(sliders.bass.value), mid: Number(sliders.mid.value), treble: Number(sliders.treble.value) });
        saveEq(cur); renderEq(cur);
      });
      sliders[key] = input;
      return el('label', { class: 'sl' }, el('span', { class: 'lbl' }, label), input);
    }
    function renderEq(cur) {
      eqChips.replaceChildren(...Object.keys(RA.presets).map((k) => chip(t('eq_' + k), cur.preset === k, () => {
        RA.ensure(audio);
        const now = RA.setEq(k);
        saveEq(now); renderEq(now);
      })));
      for (const k of ['bass', 'mid', 'treble']) sliders[k].value = String(cur[k]);
    }
    let eqDialog = null;
    if (RA) {
      const saved = store.get('eq');
      if (saved && RA.presets[saved.preset]) RA.setEq(saved.preset);
      else if (saved && saved.preset === 'custom') RA.setEq({ bass: saved.bass | 0, mid: saved.mid | 0, treble: saved.treble | 0 });
      eqDialog = makeDialog('eq-dialog', t('eqTitle'), eqChips, slider('bass', t('eqBass')), slider('mid', t('eqMid')), slider('treble', t('eqTreble')));
      renderEq(RA.eq);
      $('btn-eq').addEventListener('click', () => { RA.ensure(audio); eqDialog.showModal(); }); // 使用者剛點了按鈕,正好可以啟動音訊(瀏覽器要求要有操作才能開)
    } else {
      $('btn-eq').classList.add('hidden'); // 這個瀏覽器沒有 Web Audio
    }

    // ---------- 睡眠定時 ----------
    let sleepEnd = null; // { at: 結束時間(毫秒), min: 分鐘 }
    const sleepChips = el('div', { class: 'chips' });
    function renderSleep() {
      const active = sleepEnd ? sleepEnd.min : 0;
      sleepChips.replaceChildren(...SLEEP_STEPS.map((m) => chip(m ? m + ' ' + t('min') : t('off'), active === m, () => setSleep(m))));
    }
    function setSleep(min) {
      sleepEnd = min ? { at: Date.now() + min * 60000, min } : null;
      audio.volume = baseVol(); // 取消、或重新計時時,如果正在淡出,把音量還原
      renderSleep(); tick();
    }

    // ---------- 鬧鐘收音機(頁面要保持開著) ----------
    let alarm = store.get('alarm'); // { time: 'HH:MM', ch: 'chill' }
    let alarmAt = null;
    const nextOccurrence = (hhmm) => {
      const [h, m] = hhmm.split(':').map(Number);
      const d = new Date(); d.setHours(h, m, 0, 0);
      if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
      return d.getTime();
    };
    const timeIn = el('input', { type: 'time', value: (alarm && alarm.time) || '07:00', 'aria-label': t('alarm') });
    const chSel = el('select', { 'aria-label': t('alarmChannel') });
    const alarmBtn = el('button', { class: 'btn small', type: 'button' });
    function fillChannels() {
      chSel.replaceChildren(...state.channels.map((c) => el('option', { value: c.id }, c.name)));
      if (alarm && state.channels.some((c) => c.id === alarm.ch)) chSel.value = alarm.ch;
    }
    function renderAlarm() { alarmBtn.textContent = alarmAt ? t('clear') : t('set'); }
    alarmBtn.addEventListener('click', () => {
      if (alarmAt) { alarmAt = null; alarm = null; store.del('alarm'); }
      else if (timeIn.value && chSel.value) {
        if (RA) RA.ensure(audio); // 設定鬧鐘時順便解鎖音訊,時間到了才能自動播放
        alarm = { time: timeIn.value, ch: chSel.value };
        alarmAt = nextOccurrence(alarm.time);
        store.set('alarm', alarm);
        setStatus(t('alarmSet', { time: alarm.time }));
      }
      renderAlarm(); tick();
    });
    function fireAlarm() {
      const ch = state.channels.find((c) => c.id === alarm.ch);
      alarmAt = null; alarm = null; store.del('alarm'); renderAlarm();
      if (!ch) return;
      const target = baseVol(), t0 = Date.now();
      audio.volume = 0; // 從無聲開始,慢慢變大
      selectChannel(ch, '');
      setStatus(t('alarmFired'));
      const ramp = setInterval(() => {
        const p = Math.max(0, Math.min(1, (Date.now() - t0) / FADE_IN_MS)); // 夾在 0~1:電腦時鐘被往回調時不會算出負的音量
        audio.volume = target * p;
        if (p >= 1) clearInterval(ramp);
      }, 250);
    }

    // 每秒一次:更新卡片上方的倒數、睡眠淡出、檢查鬧鐘
    const badge = $('badge');
    function tick() {
      const now = Date.now(), parts = [];
      if (sleepEnd) {
        const left = sleepEnd.at - now;
        if (left <= 0) {
          sleepEnd = null; stop(); audio.volume = baseVol(); renderSleep(); setStatus(t('sleepEnded'));
        } else {
          parts.push(t('sleepShort') + ' ' + mmss(left / 1000));
          if (left < FADE_OUT_MS && !audio.paused) audio.volume = baseVol() * (left / FADE_OUT_MS);
        }
      }
      if (alarmAt) {
        if (now >= alarmAt) fireAlarm();
        else parts.push(t('alarmShort') + ' ' + alarm.time);
      }
      badge.textContent = parts.join(' · ');
    }
    setInterval(tick, 1000);

    const timerDialog = makeDialog('timer-dialog', t('timerTitle'),
      el('div', { class: 'line' }, el('span', { class: 'lbl' }, t('sleep')), sleepChips),
      el('div', { class: 'line' }, el('span', { class: 'lbl' }, t('alarm')), timeIn, chSel, alarmBtn),
      el('p', { class: 'muted' }, t('keepOpen')));
    $('btn-timer').addEventListener('click', () => { if (RA) RA.ensure(audio); timerDialog.showModal(); });

    renderSleep(); renderAlarm();
    if (alarm) alarmAt = nextOccurrence(alarm.time); // 重新整理頁面後還原鬧鐘(頁面要開著才會響)

    return {
      /** 頻道列表載入完成後,填入鬧鐘可選的頻道 */
      channelsReady() { fillChannels(); tick(); },
    };
  };
})();
