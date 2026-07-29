/**
 * GET /api/canary?token=... — end-to-end health probe for lead storage.
 *
 * WHY THIS EXISTS
 * On 2026-07-29 the LEADS KV namespace was deleted while the site kept running.
 * /api/audit went on returning 200 {"ok":true} — the success response the front
 * end treats as "lead saved" — while the data went nowhere. Visitors saw
 * "Got it — mahalo" and those leads are unrecoverable.
 *
 * Nothing caught it. The Cloudflare deploy-failure alert can't: deleting a
 * namespace isn't a deploy, so no build runs and no alert fires. And every
 * other signal we had was a proxy — "did the deploy succeed", "did the endpoint
 * return 200" — and both were true while the thing itself was broken.
 *
 * So this probe tests the property we actually care about: a value written
 * through the LEADS binding can be read back. It is polled by a scheduled
 * GitHub Action (.github/workflows/canary.yml) which fails loudly if not.
 *
 * WHY IT DOESN'T WRITE A FAKE LEAD
 * The obvious design — POST a synthetic lead to /api/audit and read it back —
 * would drip junk into the founder's lead list on every run, and there is no
 * delete endpoint to clean up after it. Instead this writes one fixed key,
 * "canary:probe", overwritten in place, so the namespace gains exactly one key
 * no matter how long it runs. /api/leads lists the "lead:" prefix only, so the
 * probe key never appears there.
 *
 * WHY IT TOLERATES A STALE READ
 * KV is eventually consistent: a read immediately after a write is not
 * guaranteed to return what was just written, so "read back this run's nonce"
 * would flap and train everyone to ignore it. Instead it writes a fresh
 * timestamp, reads whatever is there, and asks a weaker but honest question:
 * is there a value, and was it written recently enough? A missing value or one
 * that has stopped advancing is the real signal — that's what a deleted
 * namespace or a silently-discarded write looks like after a run or two.
 *
 * Required binding:  LEADS         (same KV namespace the leads use)
 * Required secret:   CANARY_TOKEN  (Settings → Variables and secrets)
 *
 * CANARY_TOKEN is deliberately NOT LEADS_TOKEN. This token is held by GitHub
 * Actions; LEADS_TOKEN reads every stored lead. Keeping them separate means a
 * leaked CI secret exposes a health check, not prospects' contact details.
 * Until CANARY_TOKEN is set the endpoint 404s, so shipping it is inert.
 */

const PROBE_KEY = 'canary:probe';

// How old the stored value may be before it counts as a failure. Must exceed
// the polling interval (currently 6h) by enough that one skipped or delayed
// GitHub run doesn't page anyone — Actions cron is best-effort, not punctual.
const MAX_AGE_MS = 26 * 60 * 60 * 1000; // 26h

// Outlives the interval so a healthy gap never looks like breakage, but expires
// if the canary stops entirely — a dead probe leaves no litter behind.
const PROBE_TTL_SECONDS = 7 * 24 * 60 * 60; // 7d

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

// 404 rather than 401, matching leads.js: don't advertise the endpoint exists.
const notFound = () => new Response('Not found', { status: 404 });

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token') || '';

  // Length check first, then constant-time compare. Also refuses when the
  // secret isn't configured, so an unset CANARY_TOKEN can't leave an
  // unauthenticated KV write endpoint exposed.
  if (!env.CANARY_TOKEN || token.length !== env.CANARY_TOKEN.length) return notFound();
  let diff = 0;
  for (let i = 0; i < token.length; i++) {
    diff |= token.charCodeAt(i) ^ env.CANARY_TOKEN.charCodeAt(i);
  }
  if (diff !== 0) return notFound();

  // The binding being absent entirely is the loud version of the failure —
  // /api/audit already returns 503 here. Report it as a canary failure too.
  if (!env.LEADS) {
    return json({ ok: false, error: 'binding_missing', detail: 'KV binding "LEADS" is not configured.' }, 503);
  }

  const now = Date.now();
  const written = { probed_at: new Date(now).toISOString(), ts: now };

  // ---- Write leg ----
  try {
    await env.LEADS.put(PROBE_KEY, JSON.stringify(written), { expirationTtl: PROBE_TTL_SECONDS });
  } catch (err) {
    return json({ ok: false, error: 'write_failed', detail: String((err && err.message) || err) }, 500);
  }

  // ---- Read leg ----
  let stored;
  try {
    stored = await env.LEADS.get(PROBE_KEY);
  } catch (err) {
    return json({ ok: false, error: 'read_failed', detail: String((err && err.message) || err) }, 500);
  }

  // The signal the 07-29 incident would have tripped: the write reported
  // success and the value isn't there.
  if (stored == null) {
    return json(
      {
        ok: false,
        error: 'readback_missing',
        detail: 'Wrote the probe key and read back nothing. Leads submitted now are likely being discarded.',
      },
      500
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return json({ ok: false, error: 'readback_corrupt', detail: 'Probe key is not valid JSON.' }, 500);
  }

  const age = now - Number(parsed.ts || 0);

  // Either this run's write or a recent one is fine (see eventual consistency
  // note above). A value that has stopped advancing is not.
  if (!Number.isFinite(age) || age < 0 || age > MAX_AGE_MS) {
    return json(
      {
        ok: false,
        error: 'readback_stale',
        detail: `Probe value is ${Math.round(age / 3600000)}h old (limit ${Math.round(
          MAX_AGE_MS / 3600000
        )}h). Writes may be succeeding without persisting.`,
        stored_probed_at: parsed.probed_at || null,
      },
      500
    );
  }

  return json({
    ok: true,
    probed_at: written.probed_at,
    readback_age_seconds: Math.round(age / 1000),
    note: 'LEADS binding accepted a write and returned it on read.',
  });
}
