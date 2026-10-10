# 讓 Radio Hum 用 auth-hub 登入:auth-hub 這一側要做的設定

Radio Hum 這邊的程式已經改好(做法同 VEIL / UnderCurrent)。但 **auth-hub 是另一個專案(`AUTH-HUB`,正式在用)**,
下面這些要在它那邊設定,Radio Hum 的登入才會真的通。**這些步驟我沒有動 AUTH-HUB 專案,等你確認再做。**

## 1. 在 auth-hub 登記服務與付費功能

在 `AUTH-HUB/seed.sql` 加上這兩段(用 `INSERT OR IGNORE`,重複執行不會出事),然後 `npm run db:seed:remote`:

```sql
INSERT OR IGNORE INTO apps (id, slug, name) VALUES
  ('app_radio_hum', 'radio-hum', 'Radio Hum');

INSERT OR IGNORE INTO features (id, app_id, slug, name) VALUES
  -- Radio Hum:收聽免費且不需登入;這個 feature 只鎖「把電台嵌入自己的網站」。不計次。
  ('feat_radio_embed', 'app_radio_hum', 'embed', '嵌入到自己的網站');
```

`slug` 必須和 Radio Hum 的 `AUTH_APP`(預設 `radio-hum`)、`AUTH_FEATURE`(預設 `embed`)一致。

## 2. 把 Radio Hum 的網址加進 auth-hub 的 ALLOWED_ORIGINS

`AUTH-HUB/wrangler.toml` 的 `ALLOWED_ORIGINS` 加上 Radio Hum 的網址(**不要用 `*`**),然後重新部署 auth-hub。
登入完成後 auth-hub 會導回 `redirect` 指定的網址,不在白名單裡會被擋下(防 open redirect)。

- Radio Hum 的 workers.dev 網址:`https://<你的 Worker 名稱>.observer1220.workers.dev`
- 如果之後有自訂網域(例如 `radio.kentshen.com`),也一起加上。

**重要:網址必須在 `*.observer1220.workers.dev` 或 `*.kentshen.com` 底下**,auth-hub 的登入 cookie 才收得到(其他網域無法共用登入狀態)。

## 3. 開通使用者

到 auth-hub 後台(`/admin`,見 `AUTH-HUB/ADMIN.md`)給使用者 `radio-hum / embed` 的權限。
Radio Hum 的「開通使用者(auth-hub)」按鈕(只有管理員看得到)會直接連到那裡。
對方開通後,重新按一次「登入」就會生效。

## 4. 付款(選用)

訂閱走你現有的 ECPay 訂閱站(`pay.kentshen.com` / `ecpay-donation`)。要讓付款後自動開通 `radio-hum / embed`,
需要在那個專案裡把這個 feature 加進商品設定(它透過 `/internal/entitlements/grant` 呼叫 auth-hub 開通)。
Radio Hum 的「前往訂閱」按鈕預設連到那個站,可用 `SUBSCRIBE_URL` 改。

## 5. Radio Hum 這邊的 service binding

`wrangler.toml` 已經加了:

```toml
[[services]]
binding = "AUTH_HUB"
service = "auth-hub"
```

auth-hub 這個 Worker 已經存在,所以可以直接部署。(Radio Hum 的 Worker 名稱必須和 Cloudflare 上的專案名稱一致,
否則 Cloudflare 的自動建置會失敗。)

## 6. (建議,之後做)讓「撤銷權限」立刻讓嵌入金鑰失效

目前 Radio Hum 的嵌入金鑰有「有效期限」(auth-hub 沒給到期日就是 30 天,擁有者每次登入自動延長)。
如果某個客戶在 auth-hub 後台被撤銷權限、但他一直沒再登入,他的金鑰會繼續用到期限為止。

要做到立刻失效,需要在 auth-hub 加一支只給服務端呼叫的內部端點,例如:

```
POST /internal/entitlements/status      (header: Authorization: Bearer <SERVICE_TOKEN>)
body: { "email": "...", "app": "radio-hum", "feature": "embed" }
→ { "allowed": true|false, "expiresAt": ... }
```

寫法可以參考現有的 `/internal/entitlements/grant`(同樣用 `SERVICE_TOKEN` 驗證)。有了它,Radio Hum 在嵌入金鑰被使用時,
可以每 10 分鐘左右向 auth-hub 確認一次(結果快取在 KV),撤銷就會在 10 分鐘內生效,不用等對方再登入。
