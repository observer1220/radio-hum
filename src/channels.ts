import { createScheduler, type Schedule, type Track } from "./schedule";

export interface CatalogTrack extends Track {
  channel?: string;
  genre?: string;
}
export interface ChannelsConfig {
  categories: { id: string; name: string }[];
  channels: { id: string; name: string; category: string; description?: string; en?: string; freq?: string; tagline?: string }[];
  genres: Record<string, string>;
}

export const ALL_CHANNEL = "all";
const DAILY_MUSIC: Schedule = { utcOffsetMinutes: 0, slots: [{ start: "00:00", type: "music" }] };

const isMusic = (t: CatalogTrack) => (t.kind ?? "music") === "music" && t.segments.length > 0;
const trackChannel = (t: CatalogTrack) => t.channel ?? "demo";

/** 給前端選單用:只列出「真的有歌」的頻道與曲風。 */
export function buildDirectory(tracks: CatalogTrack[], cfg: ChannelsConfig) {
  const music = tracks.filter(isMusic);
  const genreName = (id: string) => cfg.genres[id] ?? id;

  const describe = (id: string, name: string, category: string, description: string | undefined, list: CatalogTrack[], extra: { en?: string; freq?: string; tagline?: string } = {}) => {
    const counts = new Map<string, number>();
    for (const t of list) if (t.genre) counts.set(t.genre, (counts.get(t.genre) ?? 0) + 1);
    return {
      id,
      name,
      category,
      description: description ?? "",
      en: extra.en ?? "",
      freq: extra.freq ?? "",
      tagline: extra.tagline ?? description ?? "",
      trackCount: list.length,
      minutes: Math.round(list.reduce((s, t) => s + t.totalDuration, 0) / 60),
      genres: [...counts].map(([gid, count]) => ({ id: gid, name: genreName(gid), count })).sort((a, b) => b.count - a.count),
    };
  };

  const channels = cfg.channels
    .map((c) => describe(c.id, c.name, c.category, c.description, music.filter((t) => trackChannel(t) === c.id), c))
    .filter((c) => c.trackCount > 0);
  if (music.length > 0) {
    channels.push(describe(ALL_CHANNEL, "All Day", "all", "Every channel, shuffled together", music, { en: "All Day", freq: "ALL", tagline: "Every channel, shuffled together" }));
  }
  const usedCategories = new Set(channels.map((c) => c.category));
  const categories = [
    ...(usedCategories.has("all") ? [{ id: "all", name: "綜合" }] : []),
    ...cfg.categories.filter((c) => usedCategories.has(c.id)),
  ];
  return { categories, channels };
}

type Scheduler = ReturnType<typeof createScheduler>;
const schedulers = new Map<string, Scheduler | null>();

/** 每個「頻道 + 曲風」組合各自獨立洗牌、獨立計時;同組合的所有聽眾聽到同一個進度。 */
export function schedulerFor(tracks: CatalogTrack[], channel: string, genre?: string): Scheduler | null {
  const key = `${channel}/${genre ?? ""}`;
  if (schedulers.has(key)) return schedulers.get(key)!;
  const pool = tracks.filter(
    (t) => isMusic(t) && (channel === ALL_CHANNEL || trackChannel(t) === channel) && (!genre || t.genre === genre),
  );
  const s = pool.length ? createScheduler(pool, DAILY_MUSIC) : null;
  schedulers.set(key, s);
  return s;
}
