import { getUser, normEmail, updateUser } from "./auth";
import type { Env } from "./env";

export const billingEnabled = (env: Env) => !!(env.STRIPE_SECRET_KEY && env.STRIPE_PRICE_ID);

async function stripe(env: Env, path: string, params: Record<string, string>): Promise<any> {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const json = (await res.json()) as any;
  if (!res.ok) throw new Error(json?.error?.message ?? `Stripe HTTP ${res.status}`);
  return json;
}

/** 建立訂閱結帳頁,回傳要導向的網址。 */
export async function createCheckout(request: Request, env: Env, email: string): Promise<string> {
  const origin = new URL(request.url).origin;
  const user = await getUser(env, email);
  const params: Record<string, string> = {
    mode: "subscription",
    "line_items[0][price]": env.STRIPE_PRICE_ID!,
    "line_items[0][quantity]": "1",
    success_url: `${origin}/?billing=success`,
    cancel_url: `${origin}/?billing=cancel`,
    client_reference_id: normEmail(email),
    "subscription_data[metadata][email]": normEmail(email),
    allow_promotion_codes: "true",
  };
  if (user?.stripeCustomerId) params.customer = user.stripeCustomerId;
  else params.customer_email = normEmail(email);
  return (await stripe(env, "checkout/sessions", params)).url as string;
}

/** 客戶自助管理(更換信用卡、取消訂閱、看發票)。 */
export async function createPortal(request: Request, env: Env, email: string): Promise<string | null> {
  const user = await getUser(env, email);
  if (!user?.stripeCustomerId) return null;
  const session = await stripe(env, "billing_portal/sessions", { customer: user.stripeCustomerId, return_url: new URL(request.url).origin });
  return session.url as string;
}

// ---------- Webhook ----------
async function verifySignature(env: Env, body: string, header: string | null): Promise<boolean> {
  if (!header || !env.STRIPE_WEBHOOK_SECRET) return false;
  const items = header.split(",").map((p) => p.trim());
  const t = items.find((p) => p.startsWith("t="))?.slice(2);
  const v1 = items.filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  if (!t || v1.length === 0 || Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.STRIPE_WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${body}`)));
  const hex = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  return v1.includes(hex);
}

export async function handleWebhook(request: Request, env: Env): Promise<Response> {
  const body = await request.text();
  if (!(await verifySignature(env, body, request.headers.get("Stripe-Signature")))) return new Response("bad signature", { status: 400 });
  const event = JSON.parse(body) as { type: string; data: { object: any } };
  const obj = event.data.object;

  const emailForCustomer = async (customerId?: string, metaEmail?: string) =>
    metaEmail || (customerId ? await env.USERS.get(`cust:${customerId}`) : null);

  if (event.type === "checkout.session.completed" && obj.mode === "subscription") {
    const email = obj.client_reference_id || obj.customer_details?.email;
    if (email) {
      await updateUser(env, email, { stripeActive: true, stripeCustomerId: obj.customer, stripeSubscriptionId: obj.subscription });
      if (obj.customer) await env.USERS.put(`cust:${obj.customer}`, normEmail(email));
    }
  } else if (event.type.startsWith("customer.subscription.")) {
    const email = await emailForCustomer(obj.customer, obj.metadata?.email);
    if (email) {
      // past_due 先給寬限(Stripe 會自動重試扣款),真的 canceled / unpaid 才關閉
      const active = event.type !== "customer.subscription.deleted" && ["active", "trialing", "past_due"].includes(obj.status);
      await updateUser(env, email, { stripeActive: active, stripeCustomerId: obj.customer, stripeSubscriptionId: obj.id });
    }
  }
  return new Response("ok");
}
