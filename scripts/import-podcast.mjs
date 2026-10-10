// 從 Podcast 的 RSS feed 下載最新 N 集,放進 library/shows/,並把節目資訊寫進 library/meta.json。
// 用法: node scripts/import-podcast.mjs <RSS 網址> [--limit 3]
// ⚠ 只匯入你已取得「轉播授權」的節目。Podcast 的音檔版權屬於製作人,
//   公開轉播(尤其有廣告或收費)必須先徵得同意,並在節目中標示來源。
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const ROOT = path.resolve(import.meta.dirname, "..");
const SHOWS = path.join(ROOT, "library", "shows");
const META_FILE = path.join(ROOT, "library", "meta.json");

const args = process.argv.slice(2);
const feed = args.find((a) => /^https?:\/\//.test(a));
const li = args.indexOf("--limit");
const limit = li >= 0 ? Number(args[li + 1]) : 3;
if (!feed) {
  console.error("用法: node scripts/import-podcast.mjs <RSS 網址> [--limit 3]");
  process.exit(1);
}

const text = (xml, tag) => {
  const m = new RegExp(`<${tag}[^>]*>([\s\S]*?)</${tag}>`).exec(xml);
  if (!m) return "";
  return m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
};
const safe = (s) => s.replace(/[\/:*?"<>|\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);

const res = await fetch(feed, { headers: { "user-agent": "cloudflare-radio-importer" } });
if (!res.ok) throw new Error(`讀取 RSS 失敗: HTTP ${res.status}`);
const xml = await res.text();

const channelXml = xml.split(/<item[\s>]/)[0];
const showName = text(channelXml, "title");
const showLink = text(channelXml, "link");
const items = [...xml.matchAll(/<item[\s>]([\s\S]*?)<\/item>/g)].map((m) => m[1]).slice(0, limit);
console.log(`節目:${showName}(取最新 ${items.length} 集)`);

fs.mkdirSync(SHOWS, { recursive: true });
const meta = fs.existsSync(META_FILE) ? JSON.parse(fs.readFileSync(META_FILE, "utf8")) : {};

for (const item of items) {
  const title = text(item, "title");
  const enc = /<enclosure[^>]*url=["']([^"']+)["']/.exec(item);
  if (!enc) continue;
  const audioUrl = enc[1].replace(/&amp;/g, "&");
  const ext = path.extname(new URL(audioUrl).pathname).toLowerCase() || ".mp3";
  const date = new Date(text(item, "pubDate") || Date.now()).toISOString().slice(0, 10).replace(/-/g, "");
  const name = `${safe(showName)} ${date} ${safe(title)}${ext}`;
  const dest = path.join(SHOWS, name);
  const rel = `shows/${name}`;
  meta[rel] = {
    title,
    artist: showName,
    url: showLink,
    podcast: { name: showName, feed, url: showLink },
  };
  if (fs.existsSync(dest)) {
    console.log(`已存在,略過:${name}`);
    continue;
  }
  console.log(`下載:${name}`);
  const r = await fetch(audioUrl, { headers: { "user-agent": "cloudflare-radio-importer" } });
  if (!r.ok || !r.body) {
    console.error(`  下載失敗 HTTP ${r.status}`);
    continue;
  }
  await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(dest));
}
fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2));
console.log("完成。接著執行 npm run convert 轉檔,再把節目 id 加到 schedule.json。");
