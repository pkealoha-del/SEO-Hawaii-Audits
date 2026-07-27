/**
 * POST /api/audit — free citation audit request handler.
 *
 * Cloudflare Pages Function. Lives at functions/api/audit.js in the repo root;
 * Pages auto-detects the functions/ directory with no build step required.
 *
 * Storage model, and why:
 *   Leads are written to a KV namespace. Email notification is OFF by default
 *   and is NOT sent from seohawaiiaudits.com — that domain is the protected
 *   cold-email click destination and per the brand wiki it "never sends email
 *   itself" and gets "no mailbox, ever." Sending from it would park cold-email
 *   sending reputation on the one domain that must stay clean. If you enable
 *   notifications, NOTIFY_FROM must be an islandsyncsolutions.com address.
 *
 * Required binding:
 *   LEADS            KV namespace binding (Settings → Functions → KV bindings)
 *
 * Optional secrets (Settings → Environment variables, encrypted):
 *   RESEND_API_KEY   enables email notification
 *   NOTIFY_FROM      e.g. "SEO Hawaii <audits@islandsyncsolutions.com>"
 *   NOTIFY_TO        defaults to info@islandsyncsolutions.com
 *
 * Contract with the front end: any non-2xx response makes the page fall back
 * to its pre-filled mailto: link, so a misconfiguration degrades to the old
 * behavior instead of silently eating leads. Never return 200 on a failed write.
 */

const MAX_BODY_BYTES = 4096;
const RATE_LIMIT_PER_HOUR = 5;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

const clean = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

const validEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);

export async function onRequestPost(context) {
  const { request, env } = context;

  // ---- Parse (cap the body so a junk POST can't cost us anything) ----
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return json({ error: 'Payload too large.' }, 413);

  let data;
  try {
    data =
      (request.headers.get('content-type') || '').includes('application/json')
        ? JSON.parse(raw)
        : Object.fromEntries(new URLSearchParams(raw));
  } catch {
    return json({ error: 'Malformed request.' }, 400);
  }

  // ---- Honeypot: humans never see this field, bots fill it ----
  if (clean(data.company_fax, 100)) {
    // Look successful so the bot doesn't retry, but store nothing.
    return json({ ok: true });
  }

  // ---- Validate ----
  const email = clean(data.email, 200).toLowerCase();
  const business = clean(data.business, 300);

  if (!validEmail(email)) return json({ error: 'Please enter a valid email address.' }, 400);
  if (!business) return json({ error: 'Business name is required.' }, 400);

  if (!env.LEADS) {
    // Misconfigured: no KV binding. Fail loudly so the page falls back to mailto
    // rather than accepting a lead we have nowhere to put.
    console.error('[audit] LEADS KV binding is missing — lead not stored.');
    return json({ error: 'Storage unavailable.' }, 503);
  }

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

  // ---- Light per-IP rate limit ----
  try {
    const rlKey = `rl:${ip}`;
    const count = parseInt((await env.LEADS.get(rlKey)) || '0', 10);
    if (count >= RATE_LIMIT_PER_HOUR) {
      return json({ error: 'Too many requests. Please email us directly.' }, 429);
    }
    await env.LEADS.put(rlKey, String(count + 1), { expirationTtl: 3600 });
  } catch (err) {
    // Rate limiting is best-effort — never block a real lead over it.
    console.warn('[audit] rate-limit check failed:', err && err.message);
  }

  // ---- Store ----
  const now = new Date().toISOString();
  const lead = {
    email,
    business,
    submitted_at: now,
    ip,
    country: (request.cf && request.cf.country) || null,
    user_agent: clean(request.headers.get('user-agent'), 300),
  };

  try {
    // Timestamp-prefixed key so list() returns leads in chronological order.
    await env.LEADS.put(`lead:${now}:${crypto.randomUUID().slice(0, 8)}`, JSON.stringify(lead));
  } catch (err) {
    console.error('[audit] KV write failed:', err && err.message);
    return json({ error: 'Could not save your request.' }, 500);
  }

  // ---- Optional email notification (off unless RESEND_API_KEY is set) ----
  if (env.RESEND_API_KEY) {
    const from = env.NOTIFY_FROM || '';
    if (!/@([a-z0-9-]+\.)*islandsyncsolutions\.com>?\s*$/i.test(from)) {
      // Guardrail, not a preference: seohawaiiaudits.com must never send mail.
      console.error(
        '[audit] NOTIFY_FROM must be an islandsyncsolutions.com address. ' +
          'Notification skipped; the lead is still saved in KV.'
      );
    } else {
      try {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${env.RESEND_API_KEY}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            from,
            to: env.NOTIFY_TO || 'info@islandsyncsolutions.com',
            reply_to: email,
            subject: `Free citation audit request — ${business}`,
            text: [
              'New audit request from seohawaiiaudits.com',
              '',
              `Business: ${business}`,
              `Email:    ${email}`,
              `When:     ${now}`,
            ].join('\n'),
          }),
        });
        if (!res.ok) console.error('[audit] Resend returned', res.status, await res.text());
      } catch (err) {
        // The lead is already safely in KV — a failed notification is not a failed submit.
        console.error('[audit] notification failed:', err && err.message);
      }
    }
  }

  return json({ ok: true });
}

// Method-specific exports only — mixing these with a catch-all onRequest()
// makes precedence ambiguous, so don't add one.
export const onRequestGet = () =>
  new Response('Method not allowed', { status: 405, headers: { allow: 'POST' } });
