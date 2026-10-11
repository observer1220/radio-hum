// 介面文字集中在這裡。目前只有英文(主要用戶跨國);以後要加語言,在 STR 裡新增一個語言物件即可,
// 其餘程式不用動。網址加 ?lang=xx 可以切換(沒有該語言就用英文)。
(function () {
  const STR = {
    en: {
      brand: 'RADIO HUM',
      live: 'LIVE',
      pickChannel: 'Pick a channel',
      tuning: 'Tuning in…',
      anyGenre: 'Any',
      play: 'Play',
      pause: 'Pause',
      prevChannel: 'Previous channel',
      nextChannel: 'Next channel',
      volume: 'Volume',
      recipe: 'Recipe',
      recipeNote: 'The direction the AI was given for this track. The actual sound may differ a little.',
      toggleTheme: 'Switch light / dark',
      embed: 'Embed',
      tracker: 'Tracker',
      users: 'Users',
      signIn: 'Sign in',
      signOut: 'Sign out',
      loadFailed: 'Failed to load: {msg}',
      noChannels: 'No channels yet.',
      cannotPlay: 'Unable to play',
      cannotPlayWhy: 'The key is invalid, this site is not authorised, or the subscription has expired.',
      missingKey: 'This embed URL is missing its key parameter.',
      cannotConnect: 'Could not connect to this channel. Please reload the page.',
      muted: 'Muted',
      // 嵌入功能對話框
      embedTitle: 'Embed on your website',
      embedIntro: 'Listening is free and needs no account. Putting the radio on your own website or in your shop is a paid feature, available by subscription or admin approval.',
      step1: 'Step 1: sign in to your account.',
      signInGoogle: 'Sign in with Google',
      devEmail: 'Dev only: enter an email',
      signedInNotEnabled: 'You are signed in as {email}, but embedding is not enabled for this account.',
      subscribe: 'Subscribe',
      enableHelp: 'Already paid? Ask the admin to enable "radio-hum / embed" for your account in auth-hub, then check again.',
      checkAgain: 'I have been enabled — check again',
      keysHelp: 'Each key can be limited to the websites you list. A key is equivalent to your paid licence, so do not publish it where you cannot control it. Optional URL parameters: theme=dark|light.',
      newKey: 'New key',
      keyName: 'Name (e.g. homepage, branch A)',
      keyOrigins: 'Websites allowed to embed (one per line, e.g. https://shop.example.com). Leave empty for no restriction.',
      createKey: 'Create key',
      close: 'Close',
      anySite: 'Any site',
      neverExpires: 'Never expires',
      validUntil: 'Valid until {date} (renews when you sign in)',
      del: 'Delete',
      confirmDelete: 'Sites using this key will stop playing immediately. Delete it?',
      iframeLabel: 'iframe embed code for the selected channel:',
      streamLabel: 'Stream URL (for custom players and apps, HLS):',
      noKeys: 'No keys yet.',
      // 均衡器、定時、鬧鐘
      eqTitle: 'Equalizer',
      eq_flat: 'Flat', eq_night: 'Night', eq_clarity: 'Clarity', eq_car: 'Car',
      eqBass: 'BASS', eqMid: 'MID', eqTreble: 'TREBLE',
      noise: 'Tuning noise', on: 'On', off: 'Off',
      timerTitle: 'Sleep timer and alarm',
      sleep: 'SLEEP', alarm: 'ALARM', min: 'min', set: 'Set', clear: 'Clear',
      sleepShort: 'SLEEP', alarmShort: 'ALARM',
      alarmChannel: 'Alarm channel',
      alarmSet: 'Alarm set for {time}. Keep this tab open.',
      alarmFired: 'Good morning. Fading in…',
      sleepEnded: 'Sleep timer ended.',
      keepOpen: 'The alarm only rings while this tab stays open.',
    },
  };
  const q = new URLSearchParams(location.search).get('lang');
  const lang = q && STR[q] ? q : 'en';
  window.t = (key, vars) => {
    let s = (STR[lang] && STR[lang][key]) || STR.en[key] || key;
    if (vars) for (const k of Object.keys(vars)) s = s.replace('{' + k + '}', vars[k]);
    return s;
  };
  document.documentElement.lang = lang;
})();
