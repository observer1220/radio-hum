import channelsData from "../channels.json";
import playlistData from "../playlist.json";
import {
  authorizePlayback,
  clearSessionCookie,
  createKey,
  deleteKey,
  devLogin,
  getKey,
  getSession,
  getUser,
  googleCallback,
  googleStart,
  isAdmin,
  isEntitled,
  listKeys,
  normEmail,
  normalizeOrigins,
  signToken,
  updateUser,
  verifyToken,
  type UserRecord,
} from "./auth";
import { billingEnabled, createCheckout, createPortal, handleWebhook } from "./billing";
import { ALL_CHANNEL, buildDirectory, schedulerFor, type CatalogTrack, type ChannelsConfig } from "./channels";
import type { Env } from "./env";

export type { Env };

const TRACKS = (playlistData as { tracks: CatalogTrack[] }).tracks;
const TRACK_BY_ID = new Map(TRACKS.map((t) => [t.id, t]));
const CHANNELS_CFG = channelsData as ChannelsConfig;
const DIRECTORY = buildDirectory(TRACKS, CHANNELS_CFG);

const SEGMENTS_IN_WINDOW = 6; // 每次回應的 live playlist 要帶幾段(約 60 秒緩衝)
const STREAM_TOKEN_TTL = 15 * 60; // 播放清單內每個片段網址附帶的短效 token(每次更新清單都會換新)

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });

// ---------- 直播清單 ----------
async function livePlaylist(request: Request, env: Env, channel: string, genre: string | undefined): Promise<Response> {
  const url = new URL(request.url);
  const key = url.searchParams.get("key");
  const access = await authorizePlayback(request, env, key);
  const cors: Record<string, string> = {};
  const origin = request.headers.get("Origin");
  if (access?.via === "key" && origin) cors["Access-Control-Allow-Origin"] = origin;
  if (!access) return new Response(key ? "invalid or unauthorized key" : "login and subscription required", { status: 401, headers: cors });

  const scheduler = schedulerFor(TRACKS, channel, genre);
  const win = scheduler?.windowAt(Math.floor(Date.now() / 1000), SEGMENTS_IN_WINDOW);
  if (!win) return new Response("channel not found or empty", { status: 404, headers: cors });

  const token = await signToken(env, { exp: Math.floor(Date.now() / 1000) + STREAM_TOKEN_TTL });
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-TARGETDURATION:11",
    `#EXT-X-MEDIA-SEQUENCE:${win.mediaSequence}`,
    `#EXT-X-DISCONTINUITY-SEQUENCE:${win.discontinuitySequence}`,
  ];
  for (const item of win.items) {
    if (item.discontinuity) lines.push("#EXT-X-DISCONTINUITY"); // 換曲 / 跨日:音訊時間戳會重置
    lines.push(`#EXTINF:${item.duration.toFixed(6)},`);
    lines.push(`/live/segments/${item.trackId}/${item.file}?t=${token}`);
  }
  return new Response(lines.join("\n") + "\n", {
    headers: { "Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": "no-store", ...cors },
  });
}

async function liveSegment(request: Request, env: Env, trackId: string, file: string): Promise<Response> {
  const url = new URL(request.url);
  if (!(await verifyToken(env, url.searchParams.get("t")))) return new Response("token expired or invalid", { status: 401 });

  // 片段內容永遠不變,所以驗證 token 後用「不含 token 的網址」做邊緣快取,省 R2 讀取
  const cache = (caches as unknown as { default: Cache }).default;
  const cacheKey = new Request(`${url.origin}/live/segments/${trackId}/${file}`);
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const obj = await env.RADIO_BUCKET.get(`${trackId}/${file}`);
  if (!obj) return new Response("segment not found", { status: 404 });
  const res = new Response(obj.body, { headers: { "Content-Type": "audio/aac", "Cache-Control": "private, max-age=3600" } });
  const forCache = res.clone();
  forCache.headers.set("Cache-Control", "public, max-age=86400");
  await cache.put(cacheKey, forCache);
  return res;
}

// ---------- 靜態頁面(public/) ----------
async function page(env: Env, request: Request, assetPath: string, extraHeaders: Record<string, string> = {}): Promise<Response> {
  const res = await env.ASSETS.fetch(new Request(new URL(assetPath, request.url), request));
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(extraHeaders)) out.headers.set(k, v);
  return out;
}

/** /embed/... 頁面要允許哪些網站用 iframe 嵌入:有金鑰就依金鑰登記的來源限制。 */
async function embedHeaders(env: Env, key: string | null): Promise<Record<string, string>> {
  const rec = key ? await getKey(env, key) : null;
  const ancestors = rec && rec.origins.length ? ["'self'", ...rec.origins].join(" ") : "*";
  return { "Content-Security-Policy": `frame-ancestors ${ancestors}`, "Cache-Control": "no-store" };
}

// ---------- API ----------
async function me(request: Request, env: Env): Promise<Response> {
  const base = { billingEnabled: billingEnabled(env), googleEnabled: !!env.GOOGLE_CLIENT_ID, devLogin: env.DEV_LOGIN === "1" };
  const s = await getSession(request, env);
  if (!s) return json({ ...base, loggedIn: false, entitled: false, isAdmin: false });
  const user = await getUser(env, s.email);
  return json({
    ...base,
    loggedIn: true,
    email: s.email,
    name: s.name ?? user?.name ?? "",
    entitled: isEntitled(env, s.email, user),
    isAdmin: isAdmin(env, s.email),
    hasBillingPortal: !!user?.stripeCustomerId,
  });
}

async function keysApi(request: Request, env: Env, rest: string): Promise<Response> {
  const s = await getSession(request, env);
  if (!s) return json({ error: "login required" }, 401);
  if (!isEntitled(env, s.email, await getUser(env, s.email))) return json({ error: "subscription required" }, 403);

  if (request.method === "GET") return json({ keys: await listKeys(env, s.email) });
  if (request.method === "POST") {
    const body = (await request.json().catch(() => ({}))) as { label?: string; origins?: unknown };
    const key = await createKey(env, s.email, String(body.label ?? ""), normalizeOrigins(body.origins));
    return key ? json({ key }) : json({ error: "最多 5 把金鑰,請先刪除不用的" }, 400);
  }
  if (request.method === "DELETE" && rest) {
    return (await deleteKey(env, s.email, rest)) ? json({ ok: true }) : json({ error: "not found" }, 404);
  }
  return json({ error: "method not allowed" }, 405);
}

async function adminApi(request: Request, env: Env): Promise<Response> {
  const s = await getSession(request, env);
  if (!s || !isAdmin(env, s.email)) return json({ error: "forbidden" }, 403);

  if (request.method === "GET") {
    const users: UserRecord[] = [];
    let cursor: string | undefined;
    do {
      const page = await env.USERS.list({ prefix: "user:", cursor });
      for (const k of page.keys) {
        const u = (await env.USERS.get(k.name, "json")) as UserRecord | null;
        if (u) users.push(u);
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor && users.length < 2000);
    users.sort((a, b) => (b.lastLogin ?? 0) - (a.lastLogin ?? 0));
    return json({ users: users.map((u) => ({ ...u, entitled: isEntitled(env, u.email, u) })) });
  }
  if (request.method === "POST") {
    const body = (await request.json().catch(() => ({}))) as { email?: string; adminGrant?: boolean; note?: string };
    if (!body.email || !/^[^@\s]+@[^@\s]+$/.test(body.email)) return json({ error: "email 格式錯誤" }, 400);
    const patch: Partial<UserRecord> = {};
    if (typeof body.adminGrant === "boolean") patch.adminGrant = body.adminGrant;
    if (typeof body.note === "string") patch.note = body.note.slice(0, 200);
    return json({ user: await updateUser(env, normEmail(body.email), patch) });
  }
  return json({ error: "method not allowed" }, 405);
}

// ---------- 路由 ----------
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      // 直播
      const liveMatch = path.match(/^\/live\/([a-z0-9_-]+)(?:\/([a-z0-9_-]+))?\/playlist\.m3u8$/);
      if (liveMatch && liveMatch[1] !== "segments") return livePlaylist(request, env, liveMatch[1], liveMatch[2]);
      if (path === "/live/playlist.m3u8") return livePlaylist(request, env, ALL_CHANNEL, undefined);
      const segMatch = path.match(/^\/live\/segments\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+)$/);
      if (segMatch) return liveSegment(request, env, segMatch[1], segMatch[2]);

      // 公開資料
      if (path === "/api/channels") return json(DIRECTORY, 200, { "cache-control": "public, max-age=300" });
      const trackMatch = path.match(/^\/api\/track\/([A-Za-z0-9_-]+)$/);
      if (trackMatch) {
        const t = TRACK_BY_ID.get(trackMatch[1]);
        if (!t) return json({ error: "not found" }, 404);
        return json({ title: t.title ?? t.id, artist: t.artist ?? "", genre: t.genre ?? "", channel: t.channel ?? "" }, 200, { "cache-control": "public, max-age=86400" });
      }

      // 帳號與付款
      if (path === "/api/me") return me(request, env);
      if (path === "/api/admin/users") return adminApi(request, env);
      const keysMatch = path.match(/^\/api\/keys(?:\/(.+))?$/);
      if (keysMatch) return keysApi(request, env, keysMatch[1] ?? "");

      if (path === "/auth/google") return googleStart(request, env);
      if (path === "/auth/google/callback") return googleCallback(request, env);
      if (path === "/auth/dev") return devLogin(request, env);
      if (path === "/auth/logout" && request.method === "POST") {
        return new Response(null, { status: 204, headers: { "Set-Cookie": clearSessionCookie(request) } });
      }

      if (path === "/billing/webhook" && request.method === "POST") return handleWebhook(request, env);
      if (path === "/billing/checkout" || path === "/billing/portal") {
        if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
        const s = await getSession(request, env);
        if (!s) return json({ error: "login required" }, 401);
        if (!billingEnabled(env)) return json({ error: "付款尚未設定" }, 503);
        const target = path === "/billing/checkout" ? await createCheckout(request, env, s.email) : await createPortal(request, env, s.email);
        return target ? json({ url: target }) : json({ error: "找不到付款紀錄" }, 404);
      }

      // 頁面
      if (path === "/" || path === "/player") return page(env, request, "/player.html");
      if (path === "/admin") return page(env, request, "/admin.html", { "Cache-Control": "no-store" });
      const embedMatch = path.match(/^\/embed\/([a-z0-9_-]+)(?:\/([a-z0-9_-]+))?$/);
      if (embedMatch) return page(env, request, "/embed.html", await embedHeaders(env, url.searchParams.get("key")));

      // 其餘交給靜態檔案(player.js、player.css…);沒有就 404
      const asset = await env.ASSETS.fetch(request);
      return asset.status === 404 ? new Response("not found", { status: 404 }) : asset;
    } catch (err) {
      console.error(err);
      return new Response("server error", { status: 500 });
    }
  },
};
