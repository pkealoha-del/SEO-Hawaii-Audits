# Deploying seohawaiiaudits.com

Copy the contents of this folder into the root of `pkealoha-del/SEO-Hawaii-Audits`:

```
index.html
functions/api/audit.js
functions/api/leads.js
```

Cloudflare Pages auto-detects `functions/` — no build command, output dir stays `/`.
Push to `main` and it rebuilds in about a minute.

**Do this before pushing, or the form falls back to email:** set up the KV binding in step 1.
The page never breaks without it — it degrades to the old pre-filled `mailto:` — but leads
won't be captured.

---

## 1. Create the KV namespace (required)

Cloudflare dashboard → **Storage & Databases → KV → Create instance**

- Name it `seo-hawaii-leads`

Then **Workers & Pages → seo-hawaii-audits → Settings → Bindings → Add → KV namespace**

| Field | Value |
|---|---|
| Variable name | `LEADS` |
| KV namespace | `seo-hawaii-leads` |

The variable name must be exactly `LEADS`. Add it to **Production** (and Preview if you want
the preview branch to capture too).

## 2. Set the admin token (required to read leads)

Generate a long random string. In a terminal:

```bash
openssl rand -hex 32
```

**Settings → Variables and Secrets → Add** — type **Secret**, not plaintext:

| Field | Value |
|---|---|
| `LEADS_TOKEN` | the random string you just generated |

## 3. Redeploy

Settings changes don't apply to the running build. **Deployments → … → Retry deployment**,
or just push a commit.

---

## Reading your leads

```
https://seohawaiiaudits.com/api/leads?token=YOUR_TOKEN
```

An HTML table, newest first. Add `&format=csv` to download, `&format=json` for raw data.

Bookmark it. Anyone with the token can read the list, so treat it like a password — and if it
ever leaks, generate a new one and update the secret. A wrong or missing token returns a plain
404, so the endpoint doesn't announce itself to scanners. The page is also `noindex`.

---

## Email notification (optional, off by default)

Leads sit in KV until you look. If you'd rather get an email per lead, set `RESEND_API_KEY`
and `NOTIFY_FROM` as secrets (free tier at resend.com covers this easily).

⚠️ **`NOTIFY_FROM` must be an `islandsyncsolutions.com` address.** The function refuses to
send from anything else, on purpose.

`seohawaiiaudits.com` is your protected cold-email click destination — per the brand wiki it
"never sends email itself" and gets "no mailbox, ever." Sending notifications from it would
park email-sending reputation on the one domain that has to stay clean, which is the exact
risk the two-domain split exists to prevent. Most Pages-form tutorials tell you to send from
the site's own domain; don't, here.

If the API key is set but `NOTIFY_FROM` is wrong, the function logs an error, skips the email,
and **still saves the lead**. A notification failure never costs you a lead.

| Secret | Example |
|---|---|
| `RESEND_API_KEY` | `re_...` |
| `NOTIFY_FROM` | `SEO Hawaii <audits@islandsyncsolutions.com>` |
| `NOTIFY_TO` | optional, defaults to `info@islandsyncsolutions.com` |

---

## What's built in

- **Honeypot** — a hidden `company_fax` field. Bots fill it; those submissions return `ok`
  so the bot doesn't retry, but nothing is stored.
- **Rate limit** — 5 submissions per IP per hour, then `429`.
- **Body cap** — 4 KB.
- **Fallback** — any non-2xx (endpoint down, KV unbound, offline) drops the visitor to the
  pre-filled `mailto:`. The success message only appears after the server confirms the write.

## Testing locally

```bash
npx wrangler pages dev . --kv LEADS --binding LEADS_TOKEN=testtoken123 --port 8788
```

Then open `http://127.0.0.1:8788/` and submit the form. Read them back at
`http://127.0.0.1:8788/api/leads?token=testtoken123`. Local KV state lands in `.wrangler/` —
don't commit it.
