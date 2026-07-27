/**
 * GET /api/leads?token=... — read stored audit requests.
 *
 * Without this you'd have to click through the Cloudflare KV dashboard to see
 * leads. Gated by a shared secret; returns 404 (not 401) when the token is
 * wrong or unset, so the endpoint's existence isn't advertised to scanners.
 *
 * Required secret (Settings → Environment variables, encrypted):
 *   LEADS_TOKEN      a long random string you choose
 *
 * Usage:
 *   https://seohawaiiaudits.com/api/leads?token=YOUR_TOKEN          → HTML table
 *   https://seohawaiiaudits.com/api/leads?token=YOUR_TOKEN&format=json
 *   https://seohawaiiaudits.com/api/leads?token=YOUR_TOKEN&format=csv
 */

const notFound = () => new Response('Not found', { status: 404 });

const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );

// RFC 4180: wrap in quotes, double any internal quotes.
const csvCell = (s) => `"${String(s == null ? '' : s).replace(/"/g, '""')}"`;

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token') || '';

  // Constant-ish comparison; also refuses when the secret isn't configured.
  if (!env.LEADS_TOKEN || token.length !== env.LEADS_TOKEN.length) return notFound();
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= token.charCodeAt(i) ^ env.LEADS_TOKEN.charCodeAt(i);
  if (diff !== 0) return notFound();

  if (!env.LEADS) return new Response('KV binding "LEADS" is not configured.', { status: 503 });

  // "lead:" prefix skips the "rl:" rate-limit counters sharing this namespace.
  const list = await env.LEADS.list({ prefix: 'lead:', limit: 1000 });
  const leads = (
    await Promise.all(
      list.keys.map(async (k) => {
        try {
          return JSON.parse(await env.LEADS.get(k.name));
        } catch {
          return null;
        }
      })
    )
  )
    .filter(Boolean)
    .sort((a, b) => (a.submitted_at < b.submitted_at ? 1 : -1)); // newest first

  const format = url.searchParams.get('format');

  if (format === 'json') {
    return new Response(JSON.stringify({ count: leads.length, leads }, null, 2), {
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }

  if (format === 'csv') {
    const rows = [
      ['submitted_at', 'business', 'email', 'country', 'ip'],
      ...leads.map((l) => [l.submitted_at, l.business, l.email, l.country, l.ip]),
    ];
    return new Response(rows.map((r) => r.map(csvCell).join(',')).join('\r\n'), {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="seo-hawaii-leads.csv"',
      },
    });
  }

  const rows =
    leads
      .map(
        (l) => `<tr>
      <td class="t">${esc(l.submitted_at)}</td>
      <td><strong>${esc(l.business)}</strong></td>
      <td><a href="mailto:${esc(l.email)}">${esc(l.email)}</a></td>
      <td class="t">${esc(l.country || '—')}</td>
    </tr>`
      )
      .join('') || '<tr><td colspan="4" class="empty">No audit requests yet.</td></tr>';

  return new Response(
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Audit requests — SEO Hawaii</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;background:#FAF4EA;color:#1A1E1F;margin:0;padding:32px 20px;line-height:1.5}
  .wrap{max-width:960px;margin:0 auto}
  h1{font-size:1.5rem;margin:0 0 4px}
  .sub{color:#6E6A62;font-size:.9rem;margin-bottom:24px}
  .sub a{color:#A6884F}
  table{width:100%;border-collapse:collapse;background:#fff;border:1px solid rgba(26,30,31,.12);border-radius:10px;overflow:hidden}
  th,td{text-align:left;padding:12px 14px;border-bottom:1px solid rgba(26,30,31,.09);font-size:.92rem;vertical-align:top}
  th{background:#0F3038;color:#FAF4EA;font-size:.72rem;letter-spacing:.12em;text-transform:uppercase}
  tr:last-child td{border-bottom:none}
  td.t{color:#6E6A62;font-size:.84rem;white-space:nowrap}
  td.empty{text-align:center;color:#6E6A62;padding:32px}
  a{color:#0F3038}
</style></head><body><div class="wrap">
<h1>Audit requests</h1>
<div class="sub">${leads.length} total${list.list_complete === false ? ' (showing first 1000)' : ''} ·
<a href="?token=${encodeURIComponent(token)}&amp;format=csv">Download CSV</a> ·
<a href="?token=${encodeURIComponent(token)}&amp;format=json">JSON</a></div>
<table><thead><tr><th>Received</th><th>Business</th><th>Email</th><th>Country</th></tr></thead>
<tbody>${rows}</tbody></table>
</div></body></html>`,
    { headers: { 'content-type': 'text/html; charset=utf-8', 'x-robots-tag': 'noindex' } }
  );
}
