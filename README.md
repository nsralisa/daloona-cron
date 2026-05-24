# bawaba-cron

Scheduled background jobs for [Bawaba](https://bawaba.syrially.com) — an
independent directory of Syrian websites and digital services.

This repo exists for one reason: **GitHub Actions on private repos is
metered (2,000 min/month free), public repos are unlimited.** Bawaba's
crons add up to ~4,000 min/month, so the cron infrastructure lives here
in public while the app code stays in a separate private repo.

Nothing sensitive is in this repo:

- No application code, no business logic, no user data
- Credentials live in encrypted GitHub Secrets (`SUPABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY`) — never in code, never in env files
- The Syrian RSS feeds we poll are public (the same feeds we list at
  https://bawaba.syrially.com/sources)
- The Supabase project URL is public by design (it's in the mobile
  bundle and on the marketing site)

## What runs here

| Workflow | Schedule | Script | What it does |
|---|---|---|---|
| `fx-update.yml` | every 30 min | `scripts/fx-fetch.ts` | Scrape sp-today + cb.gov.sy → upsert exchange-rate rows + gold karats into `fx.rates` / `fx.gold` |
| `news-update.yml` | every 15 min | `scripts/news-fetch.ts` | Fetch RSS from curated Syrian news outlets → upsert headlines into `news.items` (dedup on `source_id, external_id`) |

Both write to the same Supabase project the main Bawaba app reads
from, via the service-role key.

> **Schema note.** The main repo's migrations 0068 + 0069 moved the
> FX + news tables out of `public` and into their own schemas (`fx`,
> `news`). These scripts route every read/write through
> `supabase.schema('fx' | 'news')`. If you point this at a Supabase
> project that hasn't applied 0065–0069 yet, the writes will 404 —
> apply the schema migrations first, then add `fx, news` to the
> project's Settings → API → "Exposed schemas".

## Local test

```bash
bun install
SUPABASE_SERVICE_ROLE_KEY=sb_secret_... \
EXPO_PUBLIC_SUPABASE_URL=https://your-project.supabase.co \
bun run news
```

(Yes, the env name is `EXPO_PUBLIC_SUPABASE_URL` — historical
artifact from when these scripts lived in the mobile repo. Either
that or `NEXT_PUBLIC_SUPABASE_URL` works.)

## Secrets

Set on this repo via:

```bash
gh secret set SUPABASE_URL -b "https://your-project.supabase.co"
gh secret set SUPABASE_SERVICE_ROLE_KEY -b "sb_secret_..."
```

Verify with `gh secret list`.

## Editing

This repo is tiny and intentionally so. If you touch a script:

1. `bun run typecheck` — must pass
2. Run locally against staging or dev Supabase first
3. Push → workflow runs at next cron tick OR run manually from
   GitHub Actions UI ("Run workflow")

## License

Internal tooling, no public license.
