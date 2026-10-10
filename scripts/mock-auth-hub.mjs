// 本機測試登入流程用的假 auth-hub(只實作 Radio Hum 會用到的兩支:/auth/google 與 /auth/refresh)。
// 為什麼需要:真的 auth-hub 在雲端,而且 cookie 只種在共用網域;本機 localhost 沒辦法走完整個流程。
//
// 用法(三個終端機):
//   node scripts/mock-auth-hub.mjs                       # 假 auth-hub,預設 http://127.0.0.1:9000
//   npx wrangler dev --var AUTH_HUB_ORIGIN:http://127.0.0.1:9000     # Radio Hum 指向它
//   瀏覽器開 http://127.0.0.1:8787 → 按「登入」→ 假的 Google 登入頁輸入 email
//
// 輸入的 email 如果在 ALLOWED_EMBED 裡,就視為「已開通嵌入功能」(模擬 auth-hub 後台開通)。
// 預設 ALLOWED_EMBED=paid@example.com;可用環境變數覆寫:ALLOWED_EMBED=a@x.com,b@y.com node scripts/mock-auth-hub.mjs
import http from "node:http";

const PORT = Number(process.env.PORT || 9000);
const ALLOWED = (process.env.ALLOWED_EMBED || "paid@example.com").split(",").map((s) => s.trim().toLowerCase());

const cookieOf = (req, name) => {
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return "";
};
// 假的 refresh_token:mock:<email>。真的 auth-hub 的 cookie 是 HttpOnly、Path=/auth、種在共用網域,這裡照做
const setRefresh = (email) => `refresh_token=${encodeURIComponent("mock:" + email)}; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=2592000`;

http
  .createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // 假的 Google 登入頁:輸入 email 就當作登入
    if (url.pathname === "/auth/google" && req.method === "GET") {
      const redirect = url.searchParams.get("redirect") || "/";
      const email = url.searchParams.get("email");
      if (email) {
        res.writeHead(302, { Location: redirect, "Set-Cookie": setRefresh(email.toLowerCase()) });
        return res.end();
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(`<!doctype html><meta charset="utf-8"><title>假的 Google 登入</title>
        <form method="GET" style="font:16px system-ui;max-width:360px;margin:20vh auto">
          <h3>假的 Google 登入(只用於本機測試)</h3>
          <input type="hidden" name="redirect" value="${redirect.replace(/"/g, "&quot;")}">
          <input name="email" type="email" required placeholder="email" style="width:100%;padding:8px;margin:8px 0">
          <button style="padding:8px 16px">登入</button>
          <p style="color:#666;font-size:13px">已開通嵌入功能的信箱:${ALLOWED.join("、")}</p>
        </form>`);
    }

    // 換取身分與權限:用 refresh_token cookie 認人,並回傳 ?app=&feature= 的權限(跟真的 auth-hub 同樣的形狀)
    if (url.pathname === "/auth/refresh" && req.method === "POST") {
      const raw = cookieOf(req, "refresh_token");
      if (!raw.startsWith("mock:")) {
        res.writeHead(401, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "no_refresh_token" }));
      }
      const email = raw.slice(5);
      const allowed = ALLOWED.includes(email);
      res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": setRefresh(email) });
      return res.end(
        JSON.stringify({
          accessToken: "mock-access-token",
          user: { id: "u_" + email, email, displayName: email.split("@")[0] },
          entitlement: url.searchParams.get("app") ? (allowed ? { allowed: true, quota: null, used: 0, remaining: null, grantedAt: new Date().toISOString(), expiresAt: null } : { allowed: false, reason: "no_entitlement" }) : undefined,
        }),
      );
    }

    res.writeHead(404);
    res.end("not found");
  })
  .listen(PORT, "127.0.0.1", () => console.log(`假 auth-hub 已啟動:http://127.0.0.1:${PORT}(已開通嵌入功能:${ALLOWED.join(", ")})`));
