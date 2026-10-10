import type { Env } from "./env";

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------- base64url / HMAC 簽章 ----------
function b64u(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64uDecode(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
const hmacKey = (secret: string, usage: ("sign" | "verify")[]) =>
  crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, usage);

// 簽章金鑰:有設定 SESSION_SECRET 就用它;否則第一次用到時產生一組亂數存進 KV(做法同 VEIL,免手動設定)。
// 要讓所有人登出、所有串流網址失效:刪掉 KV 的 settings:session_secret(或設定 SESSION_SECRET)即可。
// 注意:KV 在各地機房之間有幾十秒的同步延遲。極少數情況下,第一次使用的那一分鐘內可能出現兩組金鑰,
// 結果是有人需要重新登入一次;之後就穩定了。想完全避免,先執行 wrangler secret put SESSION_SECRET。
let cachedSecret = "";
async function sessionSecret(env: Env): Promise<string> {
  if (env.SESSION_SECRET && env.SESSION_SECRET.length >= 16) return env.SESSION_SECRET;
  if (cachedSecret) return cachedSecret;
  let stored = await env.USERS.get("settings:session_secret");
  if (!stored) {
    const fresh = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
    await env.USERS.put("settings:session_secret", fresh);
    stored = (await env.USERS.get("settings:session_secret")) ?? fresh; // 讀回來,盡量採用同時寫入者勝出的那一組
  }
  cachedSecret = stored;
  return stored;
}

/** 簽發 token:payload 必須含 exp(Unix 秒)。 */
export async function signToken(env: Env, payload: Record<string, unknown> & { exp: number }): Promise<string> {
  const body = b64u(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(await sessionSecret(env), ["sign"]), enc.encode(body));
  return `${body}.${b64u(sig)}`;
}
export async function verifyToken<T extends { exp: number }>(env: Env, token: string | null | undefined): Promise<T | null> {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(await sessionSecret(env), ["verify"]), b64uDecode(sig), enc.encode(body));
    if (!ok) return null;
    const payload = JSON.parse(dec.decode(b64uDecode(body))) as T;
    return payload.exp > Date.now() / 1000 ? payload : null;
  } catch {
    return null;
  }
}

// ---------- cookie ----------
export function parseCookies(request: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
export function cookie(request: Request, name: string, value: string, maxAge: number): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

// ---------- 身分 ----------
export const normEmail = (e: string) => e.trim().toLowerCase();
export const isAdmin = (env: Env, email: string) =>
  (env.ADMIN_EMAILS ?? "").split(",").map(normEmail).filter(Boolean).includes(normEmail(email));

// ---------- 登入 session ----------
// 身分與「有沒有開通嵌入功能」都來自 auth-hub;登入成功時換出來,記在自己簽章的 cookie 裡,之後的請求不再問 auth-hub。
const SESSION_TTL = 12 * 3600; // 12 小時:權限被撤銷時,最晚 12 小時後(或下次按「登入」時)生效
export interface Session {
  email: string;
  name?: string;
  embed: boolean; // 嵌入功能已開通(auth-hub 回報有權限,或帳號在 ADMIN_EMAILS)
  embedUntil: number; // 權限到期時間(毫秒);0 = 沒有到期資訊
  exp: number;
}
export async function sessionCookie(request: Request, env: Env, s: Omit<Session, "exp">): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL;
  return cookie(request, "radio_session", await signToken(env, { ...s, email: normEmail(s.email), exp }), SESSION_TTL);
}
export const clearSessionCookie = (request: Request) => cookie(request, "radio_session", "", 0);
export async function getSession(request: Request, env: Env): Promise<Session | null> {
  return verifyToken<Session>(env, parseCookies(request)["radio_session"]);
}

/** 只允許站內路徑,避免被拿去當開放式轉址。
 *  瀏覽器解析網址前會刪掉 Tab 與換行,"/\t/evil.com" 會變成 "//evil.com"。
 *  所以只接受:/ 開頭、第二個字不是 /,且整串沒有空白、控制字元與反斜線。 */
export const safeNext = (s: unknown): string =>
  typeof s === "string" && /^\/(?!\/)[^\s\\\x00-\x1f\x7f]*$/.test(s) ? s : "/";

// ---------- 嵌入金鑰(給 iframe / 其他網站用,不靠 cookie) ----------
export const KEY_GRACE_MS = 30 * 24 * 3600 * 1000; // auth-hub 沒告訴我們到期日時,金鑰每次登入後延長 30 天
export interface EmbedKey {
  email: string;
  label: string;
  origins: string[]; // 允許嵌入的網站來源,例如 https://shop.example.com;空陣列 = 不限制
  createdAt: number;
  entitledUntil: number; // 這把金鑰的有效期限(毫秒)。擁有者登入(auth-hub 確認仍有權限)時會自動延長
}
const MAX_KEYS = 5;
export const getKey = async (env: Env, key: string) => (await env.USERS.get(`key:${key}`, "json")) as EmbedKey | null;

export function normalizeOrigins(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const raw of list) {
    try {
      const u = new URL(String(raw).trim());
      if (u.protocol === "https:" || u.protocol === "http:") out.push(u.origin);
    } catch {
      /* 忽略格式錯誤的項目 */
    }
  }
  return [...new Set(out)];
}
async function userKeyIds(env: Env, email: string): Promise<string[]> {
  return ((await env.USERS.get(`ukeys:${normEmail(email)}`, "json")) as string[] | null) ?? [];
}
export async function listKeys(env: Env, email: string): Promise<(EmbedKey & { key: string })[]> {
  const keys = await userKeyIds(env, email);
  const recs = await Promise.all(keys.map(async (k) => ({ k, rec: await getKey(env, k) })));
  return recs.filter((r) => r.rec).map((r) => ({ key: r.k, ...r.rec! }));
}
export async function createKey(env: Env, email: string, label: string, origins: string[], entitledUntil: number): Promise<string | null> {
  const e = normEmail(email);
  const keys = await userKeyIds(env, e);
  if (keys.length >= MAX_KEYS) return null;
  const key = `ek_${b64u(crypto.getRandomValues(new Uint8Array(24)))}`;
  const rec: EmbedKey = { email: e, label: label.slice(0, 60) || "未命名", origins, createdAt: Date.now(), entitledUntil };
  await env.USERS.put(`key:${key}`, JSON.stringify(rec));
  await env.USERS.put(`ukeys:${e}`, JSON.stringify([...keys, key]));
  return key;
}
export async function deleteKey(env: Env, email: string, key: string): Promise<boolean> {
  const e = normEmail(email);
  const keys = await userKeyIds(env, e);
  if (!keys.includes(key)) return false;
  await env.USERS.delete(`key:${key}`);
  await env.USERS.put(`ukeys:${e}`, JSON.stringify(keys.filter((k) => k !== key)));
  return true;
}
/** 登入時,依 auth-hub 最新的答案更新這個人所有金鑰的有效期限:仍有權限 → 延長;已經沒有 → 立刻失效。 */
export async function renewKeys(env: Env, email: string, until: number): Promise<void> {
  for (const k of await userKeyIds(env, email)) {
    const rec = await getKey(env, k);
    if (rec && rec.entitledUntil !== until) await env.USERS.put(`key:${k}`, JSON.stringify({ ...rec, entitledUntil: until }));
  }
}

// ---------- 播放授權(帶嵌入金鑰的請求) ----------
export interface Access {
  email: string;
  origins: string[]; // 這把金鑰允許的來源
}
export async function authorizePlayback(request: Request, env: Env, key: string): Promise<Access | null> {
  const rec = await getKey(env, key);
  if (!rec) return null;
  const origin = request.headers.get("Origin");
  if (origin && rec.origins.length && !rec.origins.includes(origin)) return null;
  // 管理員(ADMIN_EMAILS)的金鑰不會過期;其他人的金鑰要在有效期限內
  if (!isAdmin(env, rec.email) && !(rec.entitledUntil > Date.now())) return null;
  return { email: rec.email, origins: rec.origins };
}

// ---------- 登入:交給 auth-hub(做法同 VEIL) ----------
// 瀏覽器若已有 auth-hub 的 refresh_token(種在共用網域的 /auth 路徑,這裡收得到),就直接向 auth-hub 換取身分與權限;
// 沒有才導去 auth-hub 用 Google 登入,登入完導回 /auth/callback 再做一次同樣的交換。
// 為什麼由 Worker 在伺服器端代為處理:auth-hub 每次 refresh 都會換發新 token(rotation),
// 回傳的 Set-Cookie 一定要轉給瀏覽器,否則使用者在其他共用 auth-hub 的站會被登出。
const HUB_DEFAULT = "https://auth-hub.observer1220.workers.dev";
const NEXT_COOKIE = "radio_next";

// 兩套網域並存:從 kentshen.com 進來的人,登入 cookie 在 .kentshen.com 上,要用 auth.kentshen.com。
// 連伺服器端代打的請求也要用對應網域的網址:auth-hub 看請求的主機決定 Set-Cookie 的 Domain,
// 這個 Set-Cookie 會被轉給瀏覽器,Domain 對不上瀏覽器就會直接丟掉。
export const hubOrigin = (env: Env, url: URL) =>
  url.hostname.endsWith(".kentshen.com") ? "https://auth.kentshen.com" : env.AUTH_HUB_ORIGIN || HUB_DEFAULT;
export const subscribeUrl = (env: Env, url: URL) =>
  env.SUBSCRIBE_URL || (url.hostname.endsWith(".kentshen.com") ? "https://pay.kentshen.com/" : "https://ecpay-donation.observer1220.workers.dev/");

function authHubFetch(env: Env, path: string, init: RequestInit, origin: string): Promise<Response> {
  const url = `${origin}${path}`;
  // 明確指定了 AUTH_HUB_ORIGIN(本機測試指到 mock)就走一般 fetch;正式環境走 service binding
  return env.AUTH_HUB?.fetch && !env.AUTH_HUB_ORIGIN ? env.AUTH_HUB.fetch(url, init) : fetch(url, init);
}

type Exchange =
  | { status: "no_login"; cookies: string[] }
  | { status: "error"; cookies: string[]; code: string | number }
  | { status: "ok"; cookies: string[]; email: string; name: string; allowed: boolean; expiresAtMs: number };

/** auth-hub 回傳的到期時間可能是秒、毫秒或 ISO 字串;看不懂就回 0(視為沒有到期資訊)。 */
function toMs(v: unknown): number {
  if (typeof v === "number" && v > 0) return v < 1e12 ? v * 1000 : v;
  if (typeof v === "string" && v) {
    const t = Date.parse(v);
    return Number.isNaN(t) ? 0 : t;
  }
  return 0;
}

async function exchangeWithAuthHub(request: Request, env: Env): Promise<Exchange> {
  const refresh = parseCookies(request)["refresh_token"];
  if (!refresh) return { status: "no_login", cookies: [] };
  const app = env.AUTH_APP || "radio-hum";
  const feature = env.AUTH_FEATURE || "embed";
  let res: Response;
  try {
    res = await authHubFetch(
      env,
      `/auth/refresh?app=${encodeURIComponent(app)}&feature=${encodeURIComponent(feature)}`,
      { method: "POST", headers: { Cookie: `refresh_token=${refresh}`, "User-Agent": request.headers.get("User-Agent") || "" } },
      hubOrigin(env, new URL(request.url)),
    );
  } catch (err) {
    // auth-hub 連不上(掛掉、網路問題、service binding 沒設好):只影響登入,免費收聽完全不受影響
    console.error("auth-hub unreachable", err);
    return { status: "error", cookies: [], code: "unreachable" };
  }
  const cookies = res.headers.getSetCookie?.() ?? [];
  if (res.status === 401) return { status: "no_login", cookies };
  if (!res.ok) return { status: "error", cookies, code: res.status };
  const body = (await res.json()) as { user?: { email?: string; displayName?: string }; entitlement?: { allowed?: boolean; expiresAt?: unknown } };
  const email = normEmail(String(body.user?.email ?? ""));
  if (!email) return { status: "error", cookies, code: "no_email" };
  return { status: "ok", cookies, email, name: body.user?.displayName ?? "", allowed: body.entitlement?.allowed === true, expiresAtMs: toMs(body.entitlement?.expiresAt) };
}

const redirect = (location: string, cookies: string[] = []) => {
  const headers = new Headers({ Location: location });
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(null, { status: 302, headers });
};
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const authPage = (status: number, message: string, cookies: string[] = []) => {
  const headers = new Headers({ "Content-Type": "text/html; charset=utf-8" });
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(`<!doctype html><meta charset="utf-8"><title>Radio Hum 登入</title><p>${message}</p><p><a href="/">回到首頁</a></p>`, { status, headers });
};

/** 換出 session 並同步這個人的嵌入金鑰有效期限。 */
async function startSession(request: Request, env: Env, x: Extract<Exchange, { status: "ok" }>, next: string): Promise<Response> {
  const embed = isAdmin(env, x.email) || x.allowed;
  // 有效期限:auth-hub 有給到期日就用它(最多不超過 30 天,避免到期日很遠卻撤銷不了);沒給就 30 天
  const until = embed ? Math.min(x.expiresAtMs || Infinity, Date.now() + KEY_GRACE_MS) : 0;
  await renewKeys(env, x.email, until);
  const session = await sessionCookie(request, env, { email: x.email, name: x.name, embed, embedUntil: until });
  return redirect(next, [...x.cookies, cookie(request, NEXT_COOKIE, "", 0), session]);
}

export async function handleAuth(request: Request, env: Env, url: URL): Promise<Response> {
  if (url.pathname === "/auth/login" || url.pathname === "/auth/callback") {
    const isCallback = url.pathname === "/auth/callback";
    const next = isCallback ? safeNext(parseCookies(request)[NEXT_COOKIE]) : safeNext(url.searchParams.get("next"));
    const r = await exchangeWithAuthHub(request, env);

    if (r.status === "no_login") {
      // 從 auth-hub 回來還是沒有登入狀態,就不要再導回去,避免無限轉址
      if (isCallback) return authPage(401, "登入沒有完成,請再試一次。", r.cookies);
      const hub = `${hubOrigin(env, url)}/auth/google?redirect=${encodeURIComponent(`${url.origin}/auth/callback`)}`;
      return redirect(hub, [...r.cookies, cookie(request, NEXT_COOKIE, next, 600)]);
    }
    if (r.status === "error") return authPage(502, `登入服務暫時無法使用(${escapeHtml(String(r.code))}),請稍後再試。`, r.cookies);
    return startSession(request, env, r, next);
  }

  // 只登出 Radio Hum,不動 auth-hub 的登入狀態(否則其他站也會一起登出)
  if (url.pathname === "/auth/logout") {
    if (request.method === "POST") return new Response(null, { status: 204, headers: { "Set-Cookie": clearSessionCookie(request) } });
    return redirect(safeNext(url.searchParams.get("next")), [clearSessionCookie(request)]);
  }
  return new Response("not found", { status: 404 });
}

/** 本機開發用假登入:需同時 DEV_LOGIN=1 且主機是 localhost,避免誤用在正式環境。
 *  ?embed=1 模擬「已開通嵌入功能」;不帶就是已登入但未開通(管理員信箱除外)。 */
export async function devLogin(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (env.DEV_LOGIN !== "1" || !local) return new Response("not found", { status: 404 });
  const email = normEmail(url.searchParams.get("email") ?? "");
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) return new Response("用法: /auth/dev?email=you@example.com[&embed=1][&next=/tracker]", { status: 400 });
  const embed = isAdmin(env, email) || url.searchParams.get("embed") === "1";
  const until = embed ? Date.now() + KEY_GRACE_MS : 0;
  await renewKeys(env, email, until);
  const session = await sessionCookie(request, env, { email, name: email.split("@")[0], embed, embedUntil: until });
  return redirect(safeNext(url.searchParams.get("next")), [session]);
}
