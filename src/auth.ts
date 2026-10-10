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

function requireSecret(env: Env): string {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 16) throw new Error("SESSION_SECRET 未設定(至少 16 字元)");
  return env.SESSION_SECRET;
}

/** 簽發 token:payload 必須含 exp(Unix 秒)。 */
export async function signToken(env: Env, payload: Record<string, unknown> & { exp: number }): Promise<string> {
  const body = b64u(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(requireSecret(env), ["sign"]), enc.encode(body));
  return `${body}.${b64u(sig)}`;
}
export async function verifyToken<T extends { exp: number }>(env: Env, token: string | null | undefined): Promise<T | null> {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(requireSecret(env), ["verify"]), b64uDecode(sig), enc.encode(body));
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

// ---------- 使用者與權限 ----------
export interface UserRecord {
  email: string;
  name?: string;
  adminGrant?: boolean; // 後台手動啟用
  stripeActive?: boolean; // 訂閱有效
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  note?: string;
  createdAt: number;
  updatedAt: number;
  lastLogin?: number;
}
export const normEmail = (e: string) => e.trim().toLowerCase();
export const getUser = async (env: Env, email: string) =>
  (await env.USERS.get(`user:${normEmail(email)}`, "json")) as UserRecord | null;
export async function saveUser(env: Env, u: UserRecord): Promise<void> {
  u.email = normEmail(u.email);
  u.updatedAt = Date.now();
  await env.USERS.put(`user:${u.email}`, JSON.stringify(u));
}
export async function updateUser(env: Env, email: string, patch: Partial<UserRecord>): Promise<UserRecord> {
  const now = Date.now();
  const cur = (await getUser(env, email)) ?? { email: normEmail(email), createdAt: now, updatedAt: now };
  const next = { ...cur, ...patch };
  await saveUser(env, next);
  return next;
}
export const isAdmin = (env: Env, email: string) =>
  (env.ADMIN_EMAILS ?? "").split(",").map(normEmail).filter(Boolean).includes(normEmail(email));
export const isEntitled = (env: Env, email: string, u: UserRecord | null) =>
  isAdmin(env, email) || !!u?.adminGrant || !!u?.stripeActive;

// ---------- 登入 session ----------
const SESSION_DAYS = 30;
export interface Session {
  email: string;
  name?: string;
  exp: number;
}
export async function sessionCookie(request: Request, env: Env, email: string, name?: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  return cookie(request, "radio_session", await signToken(env, { email: normEmail(email), name, exp }), SESSION_DAYS * 86400);
}
export const clearSessionCookie = (request: Request) => cookie(request, "radio_session", "", 0);
export async function getSession(request: Request, env: Env): Promise<Session | null> {
  return verifyToken<Session>(env, parseCookies(request)["radio_session"]);
}

// ---------- 嵌入金鑰(給 iframe / 其他網站用,不靠 cookie) ----------
export interface EmbedKey {
  email: string;
  label: string;
  origins: string[]; // 允許嵌入的網站來源,例如 https://shop.example.com;空陣列 = 不限制
  createdAt: number;
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
export async function listKeys(env: Env, email: string): Promise<(EmbedKey & { key: string })[]> {
  const keys = ((await env.USERS.get(`ukeys:${normEmail(email)}`, "json")) as string[] | null) ?? [];
  const recs = await Promise.all(keys.map(async (k) => ({ k, rec: await getKey(env, k) })));
  return recs.filter((r) => r.rec).map((r) => ({ key: r.k, ...r.rec! }));
}
export async function createKey(env: Env, email: string, label: string, origins: string[]): Promise<string | null> {
  const e = normEmail(email);
  const keys = ((await env.USERS.get(`ukeys:${e}`, "json")) as string[] | null) ?? [];
  if (keys.length >= MAX_KEYS) return null;
  const key = `ek_${b64u(crypto.getRandomValues(new Uint8Array(24)))}`;
  const rec: EmbedKey = { email: e, label: label.slice(0, 60) || "未命名", origins, createdAt: Date.now() };
  await env.USERS.put(`key:${key}`, JSON.stringify(rec));
  await env.USERS.put(`ukeys:${e}`, JSON.stringify([...keys, key]));
  return key;
}
export async function deleteKey(env: Env, email: string, key: string): Promise<boolean> {
  const e = normEmail(email);
  const keys = ((await env.USERS.get(`ukeys:${e}`, "json")) as string[] | null) ?? [];
  if (!keys.includes(key)) return false;
  await env.USERS.delete(`key:${key}`);
  await env.USERS.put(`ukeys:${e}`, JSON.stringify(keys.filter((k) => k !== key)));
  return true;
}

// ---------- 播放授權 ----------
export interface Access {
  email: string;
  via: "session" | "key";
  origins?: string[]; // via=key 時,這把金鑰允許的來源
}
/** 判斷這個請求能不能聽:cookie 登入且有權限,或帶有效的嵌入金鑰(?key=)。 */
export async function authorizePlayback(request: Request, env: Env, keyParam: string | null): Promise<Access | null> {
  if (keyParam) {
    const rec = await getKey(env, keyParam);
    if (!rec) return null;
    const origin = request.headers.get("Origin");
    if (origin && rec.origins.length && !rec.origins.includes(origin)) return null;
    const user = await getUser(env, rec.email);
    if (!isEntitled(env, rec.email, user)) return null;
    return { email: rec.email, via: "key", origins: rec.origins };
  }
  const s = await getSession(request, env);
  if (!s) return null;
  const user = await getUser(env, s.email);
  return isEntitled(env, s.email, user) ? { email: s.email, via: "session" } : null;
}

// ---------- 登入後要回到哪一頁(只允許站內路徑,避免被拿去做開放式轉址) ----------
export function safeNext(raw: string | null | undefined): string {
  return raw && /^\/(?!\/)[\w\-./?=&%#]*$/.test(raw) ? raw : "/";
}

// ---------- Google 登入(OAuth 2.0 授權碼流程) ----------
export function googleRedirectUri(request: Request): string {
  return `${new URL(request.url).origin}/auth/google/callback`;
}
export function googleStart(request: Request, env: Env): Response {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return new Response("Google 登入尚未設定(缺少 GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)", { status: 503 });
  }
  const state = b64u(crypto.getRandomValues(new Uint8Array(18)));
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: googleRedirectUri(request),
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account",
  }).toString();
  const headers = new Headers({ Location: url.toString() });
  headers.append("Set-Cookie", cookie(request, "oauth_state", state, 600));
  headers.append("Set-Cookie", cookie(request, "oauth_next", safeNext(new URL(request.url).searchParams.get("next")), 600));
  return new Response(null, { status: 302, headers });
}
export async function googleCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (!state || !code || state !== parseCookies(request)["oauth_state"]) {
    return new Response("登入驗證失敗(state 不符),請回首頁重試", { status: 400 });
  }

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID ?? "",
      client_secret: env.GOOGLE_CLIENT_SECRET ?? "",
      redirect_uri: googleRedirectUri(request),
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) return new Response("Google 登入失敗,請重試", { status: 502 });
  // id_token 是我們直接透過 HTTPS 從 Google token 端點拿到的,依 Google 文件可直接信任其內容
  const { id_token } = (await tokenRes.json()) as { id_token?: string };
  const claims = JSON.parse(dec.decode(b64uDecode((id_token ?? "").split(".")[1] ?? ""))) as {
    email?: string;
    email_verified?: boolean;
    name?: string;
    aud?: string;
  };
  if (!claims.email || !claims.email_verified || claims.aud !== env.GOOGLE_CLIENT_ID) {
    return new Response("Google 帳號的 email 未驗證", { status: 403 });
  }

  await updateUser(env, claims.email, { name: claims.name, lastLogin: Date.now() });
  const headers = new Headers({ Location: safeNext(parseCookies(request)["oauth_next"]) });
  headers.append("Set-Cookie", await sessionCookie(request, env, claims.email, claims.name));
  headers.append("Set-Cookie", cookie(request, "oauth_state", "", 0));
  headers.append("Set-Cookie", cookie(request, "oauth_next", "", 0));
  return new Response(null, { status: 302, headers });
}

/** 本機開發用假登入:需同時 DEV_LOGIN=1 且主機是 localhost,避免誤用在正式環境。 */
export async function devLogin(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (env.DEV_LOGIN !== "1" || !local) return new Response("not found", { status: 404 });
  const email = url.searchParams.get("email") ?? "";
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) return new Response("用法: /auth/dev?email=you@example.com", { status: 400 });
  await updateUser(env, email, { name: email.split("@")[0], lastLogin: Date.now() });
  return new Response(null, { status: 302, headers: { Location: safeNext(url.searchParams.get("next")), "Set-Cookie": await sessionCookie(request, env, email) } });
}
