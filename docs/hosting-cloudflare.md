# Hosting Cyberverse on Cloudflare

Cyberverse can run on your own domain, fully on Cloudflare, with no server to look
after. This was agreed on 2026-11-23 (`DECISIONS.md`). Only the simulated lab
goes online. Nothing in Cyberverse touches a real network, and live mode
(`npm run compose`) is not part of the hosted build.

## How it runs on Cloudflare

| Part | Where it runs |
|---|---|
| The screens (`ui/`) | Cloudflare static assets, served straight from Cloudflare's edge |
| The lists (practicals, towers, manuals) | The Worker (`cloudflare/app.ts`), which builds the world once from files bundled into it at build time |
| Each round | Its own Durable Object, a small program that keeps one round's clock, attacker and alerts in memory while it's played |
| Logins | Cloudflare Access, in front of the whole domain |

The world files are bundled into the Worker and never served as files,
because they hold the attacker's plans and lab-only passwords. The Worker and
the local server share the same API code (`src/server/api.ts`).

The lab stays locked in three ways:

- Cloudflare Access asks every visitor to sign in before anything loads.
- The Worker checks the Access login again on every API call
  (`cloudflare/access.ts`). Until Access is set up it refuses every call.
- The `*.workers.dev` address and preview links are switched off, so the
  only way in is through your domain and its login.

## What you need

- A Cloudflare account, with your domain added to it. Cloudflare's
  dashboard walks you through moving the domain's nameservers.
- The **Workers Paid** plan ($5 a month) for a class. The free plan allows
  only 10 ms of processing per request, and a round's simulation can go over
  that. See <https://developers.cloudflare.com/workers/platform/pricing/>.
- Node.js 22.18 or newer on the computer you deploy from.

Cloudflare moves its menus now and then. If a name below doesn't match the
dashboard, search the dashboard for it.

## First deploy

1. **Install and sign in.**

   ```bash
   cd cyberverse
   npm install
   npx wrangler login
   ```

   `wrangler login` opens your browser to sign in to Cloudflare.

2. **Check the address.** The lab lives at **cyberverse.dataquant.dev**, set
   in `cloudflare/wrangler.jsonc`:

   ```jsonc
   "routes": [{ "pattern": "cyberverse.dataquant.dev", "custom_domain": true }],
   ```

   `dataquant.dev` has to be added to the same Cloudflare account you sign in
   with (Cloudflare's dashboard, **Add a domain**). Cloudflare then creates the
   DNS record and the HTTPS certificate for `cyberverse.dataquant.dev` on the
   first deploy. If `cyberverse.dataquant.dev` already has a DNS record, delete
   it first, or the deploy stops.

3. **Set up the login (Cloudflare Access).** In the Cloudflare dashboard, open
   **Zero Trust**. The first time, pick a team name and the free plan, which
   covers up to 50 users. Then:
   1. Go to **Access → Applications → Add an application → Self-hosted**.
   2. Application domain: `cyberverse.dataquant.dev`, for the whole site.
   3. Add a policy with the action **Allow**, and include the people who may
      play. You can list emails one by one, or allow every address that ends
      in your company's domain.
   4. Under login methods, keep **One-time PIN**. Learners type their email
      and get a code.
   5. Save. On the application's overview, copy the **Application Audience
      (AUD) Tag**.
   6. Note your team domain, like `yourteam.cloudflareaccess.com`. It's in
      Zero Trust under **Settings**.

4. **Give the Worker the login settings.** In `cloudflare/wrangler.jsonc`,
   fill in:

   ```jsonc
   "vars": { "ACCESS_TEAM_DOMAIN": "yourteam.cloudflareaccess.com", "ACCESS_AUD": "<the AUD tag>" },
   ```

   These are not secrets: the AUD tag only names the application.

5. **Deploy.**

   ```bash
   npm run cf:deploy
   ```

   This builds `cloudflare/dist/` (the UI and the bundled world) and uploads
   the Worker. Open <https://cyberverse.dataquant.dev>, sign in with your email, and play.

## Updating

Pull the latest code and run `npm run cf:deploy` again. Rounds being played
at that moment end, the same as when the local server restarts.

## Trying it on your own computer first

```bash
cd cyberverse
npm install
npm run cf:dev
```

Then open <http://localhost:8787>. This runs the Worker in Cloudflare's own
runtime on your computer. The Access check is skipped only for `localhost`,
and only in this mode: `npm run cf:dev` passes `LAB_OPEN=local-only`, which
never goes into `wrangler.jsonc` or a deploy.

## Good to know

- **Progress** (floors done, the tour, window layout) is kept in each
  learner's browser, as it is locally. A learner on a new computer starts the
  towers again.
- **A round lasts while its page is open.** If the page stays closed for a
  while, Cloudflare frees the round, and starting the floor again begins a new
  one.
- **`npm run dev` reloads** are a local feature only. The hosted lab
  reports `dev: false`.
- **Checks:** `npm test` covers the Worker with a stand-in for Durable
  Objects (`test/cloudflare.test.ts`). `npm run cf:check` builds and
  type-checks the Cloudflare folder.
