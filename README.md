# site-migration

A [Claude Code](https://claude.com/claude-code) skill for migrating a website to
a new platform, framework, or host **without losing content, SEO, or uptime**.

Maintained by [Pixelworkers](https://pixelworkers.org).

Most migrations go wrong in one of three ways: pages silently vanish, old links
start 404ing and tank search rankings, or someone flips DNS before the new site
is actually ready. This skill makes those outcomes hard to reach by accident. It
runs a phased, **verify-before-cutover** workflow backed by four read-only audit
scripts, on one principle:

> The old site stays live and untouched until the new site is proven, URL for
> URL, to be at least as good. DNS is the last step, never the first.

## Install

Copy this folder into your skills directory so Claude Code can discover it:

```bash
# project-scoped
cp -r claude-site-migration .claude/skills/site-migration
# or user-scoped (all projects)
cp -r claude-site-migration ~/.claude/skills/site-migration
```

Then just describe the migration to Claude Code — e.g. *"migrate my Squarespace
site to self-hosted Next.js without losing SEO"* — and the skill activates.

## What's in the box

| File | Purpose |
| --- | --- |
| `SKILL.md` | The workflow and safety doctrine Claude follows. |
| `scripts/inventory.mjs` | Crawl the source site → complete URL inventory (JSON + CSV). |
| `scripts/parity.mjs` | Compare old vs new URL-by-URL; the cutover gate. |
| `scripts/redirects.mjs` | Generate 301 redirect configs (Caddy / nginx / Netlify / Next.js). |
| `scripts/linkcheck.mjs` | Crawl a site and report broken links. |
| `scripts/lib.mjs` | Shared, dependency-free HTTP + HTML helpers. |

## Requirements

- Node.js 18 or newer (uses built-in `fetch`). Tested on Node 22.
- No npm install. No dependencies. The scripts only issue HTTP `GET`/`HEAD`
  requests and write report files — they never mutate a target site.

## Worked example

Migrating `https://oldsite.com` to a rebuild staged at
`https://staging.newsite.com`:

```bash
# 1. Inventory the live source (read-only)
node scripts/inventory.mjs https://oldsite.com --out out

# 2. Build the new site on its staging URL (your work)

# 3. Prove parity — this is the gate. Resolve every problem it reports.
node scripts/parity.mjs https://oldsite.com https://staging.newsite.com \
  --inventory out/inventory.json --out out
cat out/parity-report.md

# 4. Catch broken links on the rebuild
node scripts/linkcheck.mjs https://staging.newsite.com --out out

# 5. Generate the 301 redirect map for your stack
node scripts/redirects.mjs --inventory out/inventory.json --out out --format caddy
# (changed URLs? feed a mapping.csv of old_path,new_path instead of --inventory)

# 6. Work the pre-cutover checklist in SKILL.md, then — only with sign-off —
#    point DNS at the new host and re-verify against the live domain.
```

`parity.mjs` and `linkcheck.mjs` exit non-zero while problems remain, so they
can gate a CI pipeline or a cutover script.

## Safety

The scripts are read-only over HTTP by design. The workflow in `SKILL.md`
additionally requires a source backup, a staged (non-DNS) rebuild, proven
parity, a loaded redirect map, a low DNS TTL, a running old host through the
monitoring window, and explicit human confirmation before any irreversible step
(DNS change, source deletion, old-host decommission).

## License

MIT © Pixelworkers. See [LICENSE](./LICENSE).
