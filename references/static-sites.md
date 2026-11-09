# Static and generated sites

The easiest migration there is — files, a server config, a certificate — and
still the one that breaks internal links most often, because almost nothing a
static site depends on actually lives in the files you copy.

Covers hand-written HTML, and anything generated: Astro, Hugo, Eleventy,
Jekyll, Gatsby, a Next.js `output: 'export'` build, a Vite SPA.

The phases in `SKILL.md` still govern: inventory the source, stage the rebuild
on a temporary URL, prove parity, generate redirects, then DNS last.

## S-1 · Decide what you are moving: source or output

Move the **source repository** and rebuild on the target. Copying `dist/`
leaves you with a site nobody can change.

```bash
git clone --mirror https://git.example.com/site.git site.git   # keep the history
# or, if the only copy is on the old server:
rsync -azP --no-owner --no-group user@oldhost:/srv/site/ ./source/
```

If only the build output exists — a common state for a site someone inherited —
copy it, publish it, and then write down how to rebuild it. Record the exact
toolchain version before the old box goes away:

```bash
# on the source, while you still have it
node --version; npm --version
cat package.json | head -40          # look for an "engines" field
ls .nvmrc .node-version .tool-versions 2>/dev/null
hugo version 2>/dev/null; bundle exec jekyll --version 2>/dev/null
```

A generator pinned to a four-year-old major version will not build on today's
Node. Reproduce the old version first, confirm the build matches what is live,
and upgrade as a separate piece of work — never during the migration.

## S-2 · Build on the target and compare against what is live

```bash
npm ci                               # ci, not install — respects the lockfile
npm run build
find dist -type f | wc -l            # vs the file count on the old host
```

Then diff the built output against the live site rather than trusting it:

```bash
node scripts/inventory.mjs https://example.com --out out
node scripts/parity.mjs https://example.com https://staging.example.com \
  --inventory out/inventory.json --out out
```

A build that produces 400 files where the old host served 480 URLs is a missing
content directory, a `draft: true` that used to be false, or a generator config
pointing at the wrong content root.

## S-3 · Trailing slashes and index files — where the links break

`/about` and `/about/` are different URLs, and which one your server serves (and
whether it redirects between them) is a **server** setting that does not travel
with the files. Changing server family silently changes the default.

| Source | Default behaviour |
| --- | --- |
| Netlify / Vercel | `/about` serves `about.html`; pretty URLs, usually no trailing slash |
| GitHub Pages / Jekyll | `/about/` serves `about/index.html` |
| nginx | serves `/about/index.html` only with `try_files`; otherwise 404 |
| Apache | `DirectoryIndex` + `MultiViews` may serve either, depending on config |
| Caddy `file_server` | serves `about.html` and `about/index.html`, both |

Pick the form the old site used — your `out/inventory.json` records exactly
which URLs answered `200` — and make the target match it, redirecting the other
form with a 301 so neither duplicates in search:

```nginx
# nginx: pretty URLs, no trailing slash (matches Netlify/Vercel behaviour)
location / {
  try_files $uri $uri.html $uri/index.html =404;
}
# and collapse the other form so it does not duplicate
rewrite ^/(.*)/$ /$1 permanent;
```

```caddy
# Caddy: the same shape, with automatic HTTPS
example.com {
  root * /srv/example.com/dist
  file_server
  try_files {path} {path}.html {path}/index.html
  encode zstd gzip
}
```

Verify before cutover, both forms, both hosts:

```bash
for p in /about /about/ /blog /blog/; do
  printf '%s  ' "$p"
  curl -o /dev/null -sS -w '%{http_code} -> %{redirect_url}\n' "https://staging.example.com$p"
done
```

## S-4 · Port the rules that are not in the files

Redirects, custom 404s, headers and auth live in a platform file or a server
config, and each platform uses a different one. Find the source's and translate
it; nothing here moves on its own.

| Came from | Look for |
| --- | --- |
| Netlify | `netlify.toml`, `_redirects`, `_headers` |
| Vercel | `vercel.json` (`redirects`, `rewrites`, `headers`, `cleanUrls`, `trailingSlash`) |
| Cloudflare Pages | `_redirects`, `_headers`, `functions/` |
| Apache shared host | `.htaccess` in every directory, not just the root |
| nginx | the `server` block, plus any `include`d snippet |
| S3 + CloudFront | bucket website config, CloudFront functions / Lambda@Edge |

```bash
# collect every rule file before you decommission anything
find ./source -maxdepth 3 \( -name '.htaccess' -o -name '_redirects' \
  -o -name '_headers' -o -name 'netlify.toml' -o -name 'vercel.json' \
  -o -name 'firebase.json' -o -name 'staticwebapp.config.json' \) -print
```

Hand-translate each rule, then regenerate the URL-change half of the map from
the inventory rather than by hand:

```bash
node scripts/redirects.mjs --inventory out/inventory.json --out out --format all
# changed URLs instead? feed a mapping.csv of old_path,new_path
node scripts/redirects.mjs --map mapping.csv --out out --format caddy
```

Serverless functions are not static. A Netlify function, a Vercel API route or
a Pages Function is an application — it needs a runtime on the target (see
[Node applications](./node-apps.md)), not a file copy. Inventory them now:

```bash
ls -la netlify/functions api functions 2>/dev/null
```

## S-5 · Headers, caching and the forms

- **Caching.** A hashed asset (`app.4f3a1b.js`) wants a long `Cache-Control`;
  HTML wants a short one. Managed platforms set this for you; your own server
  does not, and getting it backwards means visitors are served last week's HTML
  for a year.
  ```nginx
  location ~* \.(?:css|js|woff2|avif|webp|png|jpg|svg)$ {
    add_header Cache-Control "public, max-age=31536000, immutable";
  }
  location ~* \.html$ { add_header Cache-Control "public, max-age=0, must-revalidate"; }
  ```
- **Security headers** the old platform may have added by default:
  `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy`, and a `Content-Security-Policy` if one exists. Compare the
  two hosts rather than assuming:
  ```bash
  diff <(curl -sSI https://example.com/ | sort) \
       <(curl -sSI https://staging.example.com/ | sort)
  ```
- **Forms.** A static site has no backend, so the form posted somewhere — Netlify
  Forms, Formspree, a serverless function, an embedded provider. That endpoint
  does not come with the files. Re-point it, submit a real test entry, and
  confirm the notification arrives.
- **Compression.** `gzip on;` / `encode zstd gzip` — managed platforms do it
  silently and a bare nginx install does not, which shows up as a Core Web
  Vitals regression nobody can explain.

## S-6 · Ownership and the certificate

```bash
chown -R root:www-data /srv/example.com         # or nginx:nginx
find /srv/example.com -type d -exec chmod 755 {} \;
find /srv/example.com -type f -exec chmod 644 {} \;
```

Static files need to be **readable** by the web server and writable by nobody.
There is no uploads directory and no reason for anything to be group-writable.
A static site with a writable document root is a static site waiting to host
someone else's content.

Then the certificate, before DNS — see [DNS cutover](./dns-cutover.md). With
Caddy it is automatic once DNS resolves; before cutover, issue over DNS-01 so
you can test HTTPS on the real hostname while the old host is still live.
