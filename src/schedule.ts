// 節目表引擎:把「一天的節目表 + 曲庫」展開成一條逐片段的時間軸,
// 再依現在時間算出 live playlist 的視窗。純函式、無 Worker 依賴,方便單獨測試。

export interface Segment {
  file: string;
  duration: number;
}
export interface Track {
  id: string;
  kind?: "music" | "show"; // 沒填視為 music
  title?: string;
  artist?: string;
  url?: string; // 創作者 / 主持人頁面
  podcast?: { name?: string; feed?: string; url?: string };
  tags?: Record<string, string>; // 這首歌的特色(速度、主奏、場景…),來自生成時的提示詞各軸選項;播放器顯示用
  segments: Segment[];
  totalDuration: number;
}
export interface Slot {
  start: string; // 當地時間 "HH:MM"
  type: "music" | "show";
  tracks?: string[]; // type=show 時,依序播放的節目 id
}
export interface Schedule {
  utcOffsetMinutes: number; // 台灣 = 480
  slots: Slot[];
}

export interface TimelineEntry {
  trackId: string;
  file: string;
  duration: number;
  start: number; // 當天 0 點起算的秒數
  discBefore: number; // 當天第 0 段到這一段之間,曲目切換(discontinuity)的累計次數
  discontinuity: boolean; // 這一段前面是否要插 #EXT-X-DISCONTINUITY
}
export interface DayTimeline {
  entries: TimelineEntry[];
  duration: number;
}
export interface WindowItem {
  trackId: string;
  file: string;
  duration: number;
  discontinuity: boolean;
}
export interface LiveWindow {
  mediaSequence: number;
  discontinuitySequence: number;
  items: WindowItem[];
}

export const SECONDS_PER_DAY = 86400;
// 每天的 sequence 號碼區間。跨日時 sequence 會跳號(見 README「已知限制」)。
const SEQ_PER_DAY = 100000;
// sequence 以 2026-01-01 起算天數,避免數字大到超過 32 位元
const SEQ_EPOCH_DAY = Math.floor(Date.parse("2026-01-01T00:00:00Z") / 1000 / SECONDS_PER_DAY);

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], rand: () => number): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function parseClock(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) throw new Error(`schedule.json 的時間格式錯誤: ${hhmm}(應為 HH:MM)`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60;
}

/** 展開某一天(以「當地日」編號)的完整時間軸。同一天、同一份資料永遠得到相同結果。 */
export function buildDayTimeline(day: number, tracks: Track[], schedule: Schedule): DayTimeline {
  const byId = new Map(tracks.map((t) => [t.id, t]));
  const music = tracks.filter((t) => (t.kind ?? "music") === "music" && t.segments.length > 0);
  const rand = mulberry32(day * 2654435761 + 12345);

  // 音樂:每天用不同亂數種子洗牌,整副牌播完才重洗,所以同一首歌至少隔「曲庫總長」才會重播
  let queue: Track[] = [];
  let lastMusicId: string | undefined;
  const nextMusic = (): Track | undefined => {
    if (music.length === 0) return undefined;
    if (queue.length === 0) {
      queue = shuffle(music, rand);
      if (queue.length > 1 && queue[queue.length - 1].id === lastMusicId) {
        [queue[0], queue[queue.length - 1]] = [queue[queue.length - 1], queue[0]];
      }
    }
    const t = queue.pop()!;
    lastMusicId = t.id;
    return t;
  };

  const slots = (schedule.slots.length ? schedule.slots : [{ start: "00:00", type: "music" as const }])
    .map((s) => ({ ...s, startSec: parseClock(s.start) }))
    .sort((a, b) => a.startSec - b.startSec);

  const entries: TimelineEntry[] = [];
  let cursor = 0;
  let disc = 0;
  let prevTrackId: string | undefined;

  // until:到這個時間就停(只用在當天最後一個時段,避免跨日);沒給就整首播完
  const pushTrack = (t: Track, until?: number): void => {
    for (let i = 0; i < t.segments.length; i++) {
      if (until !== undefined && cursor >= until) return;
      const seg = t.segments[i];
      const discontinuity = prevTrackId !== undefined && prevTrackId !== t.id;
      if (discontinuity) disc++;
      entries.push({
        trackId: t.id,
        file: seg.file,
        duration: seg.duration,
        start: cursor,
        discBefore: disc,
        discontinuity,
      });
      prevTrackId = t.id;
      cursor += seg.duration;
    }
  };

  slots.forEach((slot, i) => {
    const isLast = i === slots.length - 1;
    const end = isLast ? SECONDS_PER_DAY : slots[i + 1].startSec;
    if (slot.type === "show") {
      for (const id of slot.tracks ?? []) {
        const t = byId.get(id);
        if (t && t.segments.length) pushTrack(t);
      }
    }
    // 節目沒占滿的時間、以及一般音樂時段,用音樂補到下一個時段開始。
    // 非最後時段:正在播的歌會完整播完,所以下一個節目可能晚幾分鐘開始(不會累積,下個時段又以表定時間為準)
    while (cursor < end) {
      const t = nextMusic();
      if (!t) break;
      pushTrack(t, isLast ? end : undefined);
    }
  });

  return { entries, duration: cursor };
}

export function createScheduler(tracks: Track[], schedule: Schedule) {
  const cache = new Map<number, DayTimeline>();
  const timeline = (day: number): DayTimeline => {
    let tl = cache.get(day);
    if (!tl) {
      tl = buildDayTimeline(day, tracks, schedule);
      cache.set(day, tl);
      if (cache.size > 4) cache.delete(cache.keys().next().value as number);
    }
    return tl;
  };

  function locate(local: number): { day: number; idx: number } | null {
    let day = Math.floor(local / SECONDS_PER_DAY);
    let offset = local - day * SECONDS_PER_DAY;
    let tl = timeline(day);
    if (offset >= tl.duration) {
      day++;
      offset = 0;
      tl = timeline(day);
    }
    if (tl.entries.length === 0) return null;
    let lo = 0;
    let hi = tl.entries.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (tl.entries[mid].start <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { day, idx: lo };
  }

  /** nowUnix:現在的 Unix 秒數。count:視窗要帶幾段。 */
  function windowAt(nowUnix: number, count: number): LiveWindow | null {
    const pos = locate(nowUnix + schedule.utcOffsetMinutes * 60);
    if (!pos) return null;
    let { day, idx } = pos;
    let tl = timeline(day);
    const first = tl.entries[idx];
    const items: WindowItem[] = [];
    let crossedDay = false; // 跨日後的第一段一定要標 discontinuity
    for (let n = 0; n < count; n++) {
      const e = tl.entries[idx];
      // 視窗第一段不插 DISCONTINUITY(它的 cc 已經算在 discontinuitySequence 裡)
      items.push({ trackId: e.trackId, file: e.file, duration: e.duration, discontinuity: n > 0 && (e.discontinuity || crossedDay) });
      crossedDay = false;
      idx++;
      if (idx >= tl.entries.length) {
        day++;
        idx = 0;
        tl = timeline(day);
        if (tl.entries.length === 0) break;
        crossedDay = true;
      }
    }
    return {
      mediaSequence: (pos.day - SEQ_EPOCH_DAY) * SEQ_PER_DAY + pos.idx,
      discontinuitySequence: (pos.day - SEQ_EPOCH_DAY) * SEQ_PER_DAY + first.discBefore,
      items,
    };
  }

  /** 這個時間點正在播的是哪一首的哪一段、這一段已經播了幾秒。不用有人在聽,伺服器就算得出來。 */
  function current(nowUnix: number): { trackId: string; file: string; offsetInSeg: number } | null {
    const local = nowUnix + schedule.utcOffsetMinutes * 60;
    const pos = locate(local);
    if (!pos) return null;
    const e = timeline(pos.day).entries[pos.idx];
    const offset = pos.day === Math.floor(local / SECONDS_PER_DAY) ? local - pos.day * SECONDS_PER_DAY : 0;
    return { trackId: e.trackId, file: e.file, offsetInSeg: Math.max(0, Math.min(offset - e.start, e.duration)) };
  }

  return { windowAt, current, timeline };
}
