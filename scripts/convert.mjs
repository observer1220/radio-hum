// 把 library/music、library/shows 底下的音檔轉成 HLS 片段,並更新 playlist.json。
// 只處理新增或修改過的檔案(依 檔案大小+修改時間 判斷)。
// 用法: node scripts/convert.mjs
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const LIB = path.join(ROOT, "library");
const OUT = path.join(ROOT, "hls-output");
const CATALOG = path.join(ROOT, "playlist.json");
const META_FILE = path.join(LIB, "meta.json");
const AUDIO_EXT = new Set([".mp3", ".wav", ".m4a", ".flac", ".ogg", ".aac", ".opus"]);

const readJson = (p, fallback) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : fallback);

function parseM3u8(file) {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const segments = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^#EXTINF:([\d.]+)/.exec(lines[i]);
    if (m) segments.push({ file: lines[i + 1].trim(), duration: Number(m[1]) });
  }
  return segments;
}

function convert(src, dir) {
  const tmp = `${dir}.tmp`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const r = spawnSync(
    "ffmpeg",
    [
      "-y", "-loglevel", "error", "-i", src, "-vn",
      // 響度正規化:Suno / Podcast 不同來源音量差很多,統一到 -16 LUFS
      "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
      "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2",
      "-f", "hls", "-hls_time", "10", "-hls_playlist_type", "vod", "-hls_list_size", "0",
      "-hls_segment_filename", path.join(tmp, "seg_%03d.aac"),
      path.join(tmp, "index.m3u8"),
    ],
    { stdio: "inherit" },
  );
  if (r.status !== 0) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw new Error(`ffmpeg 轉檔失敗: ${src}`);
  }
  return tmp;
}

const meta = readJson(META_FILE, {});
const catalog = readJson(CATALOG, { tracks: [] });
const byId = new Map(catalog.tracks.map((t) => [t.id, t]));
const seenSources = new Set();
let converted = 0;
let skipped = 0;

// 資料夾規則:library/<頻道>/<曲風>/檔名.mp3(曲風資料夾可省略)
//   library/shows/ 是節目(Podcast / 訪談),不屬於任何頻道
//   library/music/ 是舊的測試資料夾,歸入 demo 頻道
function* walk(dir, rel = []) {
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) yield* walk(full, [...rel, name]);
    else yield { name, full, rel: [...rel, name] };
  }
}
const slug = (x) => x.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

for (const top of fs.readdirSync(LIB).sort()) {
  const topDir = path.join(LIB, top);
  if (!fs.statSync(topDir).isDirectory()) continue;
  const kind = top === "shows" ? "show" : "music";
  const channel = kind === "show" ? undefined : top === "music" ? "demo" : slug(top);
  for (const f of walk(topDir)) {
    const name = f.name;
    if (!AUDIO_EXT.has(path.extname(name).toLowerCase())) continue;
    const rel = [top, ...f.rel].join("/");
    const src = f.full;
    // 曲風 = 頻道資料夾底下的第一層子資料夾
    const genre = kind === "music" && f.rel.length > 1 ? slug(f.rel[0]) : undefined;
    seenSources.add(rel);

    const id = `${kind}-${crypto.createHash("sha1").update(rel).digest("hex").slice(0, 8)}`;
    const outDir = path.join(OUT, id);
    const st = fs.statSync(src);
    const stamp = `${st.size}-${Math.floor(st.mtimeMs)}`;
    const stampFile = path.join(outDir, ".stamp");
    const upToDate =
      fs.existsSync(path.join(outDir, "index.m3u8")) &&
      fs.existsSync(stampFile) &&
      fs.readFileSync(stampFile, "utf8") === stamp;

    if (upToDate) {
      skipped++;
    } else {
      console.log(`轉檔 ${rel} → ${id}`);
      const tmp = convert(src, outDir);
      fs.rmSync(outDir, { recursive: true, force: true });
      fs.renameSync(tmp, outDir);
      fs.writeFileSync(stampFile, stamp);
      converted++;
    }

    // 曲名:優先用 meta.json,其次檔名 "創作者 - 曲名"
    const base = path.basename(name, path.extname(name));
    const [a, ...rest] = base.split(" - ");
    const guessed = rest.length ? { artist: a.trim(), title: rest.join(" - ").trim() } : { title: base };
    const segments = parseM3u8(path.join(outDir, "index.m3u8"));
    const entry = {
      id,
      kind,
      ...(channel ? { channel } : {}),
      ...(genre ? { genre } : {}),
      ...guessed,
      ...(meta[rel] ?? {}),
      source: rel,
      segments,
      totalDuration: Number(segments.reduce((s, x) => s + x.duration, 0).toFixed(6)),
    };
    if (byId.has(id)) Object.assign(byId.get(id), entry);
    else byId.set(id, entry);
  }
}

// 來源檔已被刪掉的項目從節目庫移除(R2 上的檔案不會自動刪除)
// 兩種情況會從節目庫移除:① 來源檔已被刪掉 ② 轉好的資料夾(hls-output/<id>)已經不在了
//(例如你手動刪掉舊的測試歌 track-001~003:它們沒有來源檔,以前會永遠留在清單裡,網站就一直顯示)
const removed = [];
const tracks = [...byId.values()].filter((t) => {
  const keep = (!t.source || seenSources.has(t.source)) && fs.existsSync(path.join(OUT, t.id, "index.m3u8"));
  if (!keep) removed.push(t.id);
  return keep;
});
if (removed.length) console.log(`已從節目庫移除 ${removed.length} 筆(來源或轉檔結果已不存在):${removed.join(", ")}`);
fs.writeFileSync(CATALOG, `{"tracks":[\n${tracks.map((t) => JSON.stringify(t)).join(",\n")}\n]}\n`);
console.log(`完成:新轉檔 ${converted} 個,略過 ${skipped} 個,節目庫共 ${tracks.length} 筆。`);
