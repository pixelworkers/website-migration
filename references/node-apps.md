# Node applications

Next.js, Nuxt, Remix, SvelteKit, Express, NestJS, Strapi, Payload — anything
where a long-running Node process answers the request.

The files are the easy part. What breaks is everything around them: the
environment, the process manager, the reverse proxy, and the callback URLs
registered in other people's dashboards.

Work the phases in `SKILL.md`. These are the Node-specific commands.

## N-1 · Pre-flight: record the runtime and the processes

```bash
# on the source
node --version && npm --version
cat .nvmrc .node-version 2>/dev/null
jq '.engines, .scripts, .dependencies | keys' package.json 2>/dev/null | head -40
pm2 jlist > ~/pm2-source.json          # or: systemctl cat example.service
crontab -l
ss -ltnp | grep node                   # which ports, which processes
```

Keep `~/pm2-source.json` — it records the exact entry point, arguments,
instance count, cwd and `env` of every running process. Reconstructing that
from memory after the old box is gone is the usual reason a move takes two days
instead of two hours.

**Match the source's Node major version on the target.** A build that works on
18 may fail on 22, and a native module compiled for one ABI will not load on
another. Verify parity on the version it already ran, cut over, then upgrade as
its own change.

Also note: every backing service the app talks to (Postgres, MySQL, Redis,
Elasticsearch, S3) and whether it is on the same box or remote; anything in
front of the origin (Cloudflare, a load balancer); and whether sessions live in
memory (they will not survive, and a multi-instance restart logs everyone out).

## N-2 · Back up, then move the repository

Back up first: a tarball of the app root, a dump of its database
([Databases](./databases.md)), and the current DNS zone written down.

Deploy from git on the target rather than copying a working directory:

```bash
# on the target
git clone https://git.example.com/app.git /srv/example.com
cd /srv/example.com && git checkout "$(ssh user@oldhost 'cd /srv/app && git rev-parse HEAD')"
```

Pinning the target to the source's exact commit means parity is a property of
the code, not a hope. Move to `main` afterwards, deliberately.

No repository — the only copy is on the server? rsync it, excluding everything
that must be rebuilt or re-keyed:

```bash
rsync -azP --no-owner --no-group \
  --exclude 'node_modules/' \
  --exclude '.next/' --exclude '.nuxt/' --exclude 'dist/' --exclude 'build/' \
  --exclude '.cache/' --exclude '.turbo/' \
  --exclude '.env' --exclude '.env.*' \
  --exclude '.git/' \
  --dry-run \
  /srv/app/ user@newhost:/srv/example.com/
# read the dry-run output, then run it again without --dry-run
```

`node_modules` is excluded on purpose: it is slow to copy, and anything with a
compiled binding (`sharp`, `bcrypt`, `better-sqlite3`, `canvas`, `node-gyp`
anything) is built against the old machine's libraries and will fail to load on
the new one. `npm ci` rebuilds it correctly — as long as you did not copy it.

`.env` is excluded because the target needs its own values, and because an
`.env` that travels by rsync tends to end up in a backup nobody locked down.

## N-3 · Carry the environment across by hand

This is the step that is always underestimated. Read the source's `.env` and
write the target's deliberately, value by value.

```bash
# list the keys (names only — never print the values into a log or a transcript)
ssh user@oldhost 'cut -d= -f1 /srv/app/.env | grep -v "^#" | sort'
```

Then on the target, with the file locked down before anything is written into
it:

```bash
install -m 600 -o appuser -g appuser /dev/null /srv/example.com/.env
# edit it with an editor; do not echo secrets into your shell history
```

Every value naming the old host has to change:

- `DATABASE_URL`, `REDIS_URL`, and any other connection string
- the app's own public URL — `NEXTAUTH_URL`, `NEXT_PUBLIC_SITE_URL`,
  `PUBLIC_BASE_URL`, `APP_URL`. A stale one breaks absolute links, sitemaps,
  OG images and the OAuth round trip, and the symptom looks like a DNS fault.
- S3/R2 bucket, region and endpoint
- SMTP host and credentials
- webhook signing secrets, if the endpoint URL changes and the provider reissues

**Session and token secrets must be carried across unchanged** —
`NEXTAUTH_SECRET`, `AUTH_SECRET`, `JWT_SECRET`, `SESSION_SECRET`, Payload's
`PAYLOAD_SECRET`. A new value invalidates every signed cookie and every token in
the wild; if the app encrypts data at rest with it, that data is unreadable for
good.

Build-time versus run-time matters in Next.js: anything `NEXT_PUBLIC_*` is
inlined into the client bundle **at build time**. Change it and you must
rebuild; restarting the process does nothing.

## N-4 · Install, build, and run it under a non-root user

```bash
sudo useradd --system --home /srv/example.com --shell /usr/sbin/nologin appuser
sudo chown -R appuser:appuser /srv/example.com

sudo -u appuser npm ci                 # ci, not install — respects the lockfile
sudo -u appuser npm run build
sudo -u appuser npm prune --omit=dev   # optional, after a successful build
```

Never run the app as root. It needs to read its own directory and write a cache
and an upload path; nothing else on the box.

Bind to localhost and let the proxy terminate TLS:

```bash
PORT=3000 HOSTNAME=127.0.0.1 sudo -u appuser npm start
curl -sSI http://127.0.0.1:3000/       # 200 before you involve DNS at all
```

If the app binds `0.0.0.0`, the port is reachable from the internet directly,
bypassing the proxy, its headers and its rate limits. Bind `127.0.0.1`, or
firewall the port.

## N-5 · Recreate the process manager

Processes do not move with files. Use `~/pm2-source.json` from N-1 as the spec.

**systemd** — the durable option; it survives a reboot with no extra step:

```ini
# /etc/systemd/system/example.service
[Unit]
Description=example.com
After=network.target

[Service]
Type=simple
User=appuser
WorkingDirectory=/srv/example.com
EnvironmentFile=/srv/example.com/.env
Environment=NODE_ENV=production PORT=3000 HOSTNAME=127.0.0.1
ExecStart=/usr/bin/node /srv/example.com/node_modules/.bin/next start
Restart=always
RestartSec=5
# least privilege
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/srv/example.com/.next/cache /srv/example.com/uploads

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now example
sudo systemctl status example
journalctl -u example -n 50 --no-pager
```

Set `ExecStart` to the real paths on your box — `command -v node` for the
interpreter and the package's own `node_modules/.bin/` entry for the server —
rather than the illustrative paths above.

**pm2**, if that is what the old host used:

```bash
sudo -u appuser pm2 start npm --name example -- start
sudo -u appuser pm2 save
pm2 startup                            # prints the command to run as root — read it, then run it
```

`pm2 save` writes the process list that `pm2 resurrect` restores on boot.
Skipping it means the site is down after the first reboot and nobody knows why.

## N-6 · Reverse proxy and certificate

The app listens on a port; the proxy maps the domain to it, terminates TLS, and
is where the domain actually lives. That config is on the host, not in the repo.

```caddy
example.com {
  reverse_proxy 127.0.0.1:3000
  encode zstd gzip
}
```

```nginx
server {
  listen 443 ssl http2;
  server_name example.com;
  # ssl_certificate / ssl_certificate_key …

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;          # websockets
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;      # or the app builds http:// URLs
    proxy_read_timeout 60s;
  }
  client_max_body_size 25m;                          # match the app's upload limit
}
```

`X-Forwarded-Proto` is not optional: without it a framework behind TLS
generates `http://` absolute URLs and redirect loops. If the app is behind
Cloudflare *and* nginx, make sure it trusts only the proxy in front of it —
blindly trusting `X-Forwarded-For` from anywhere lets a caller spoof their IP
past a rate limiter.

Certificate before DNS: [DNS cutover](./dns-cutover.md).

## N-7 · The things in other people's dashboards

A changed domain invalidates every URL someone else has on file. These are the
most common cause of "the site works but login is broken", and none of them are
in your repository:

- **OAuth redirect URIs** — Google, GitHub, Microsoft, Apple, Auth0, Clerk.
  Add the new URL *before* cutover; keep the old one until the old host is gone.
- **Webhook endpoints** — Stripe, GitHub, Shopify, Twilio, a payment provider.
  Point them at the new host, and remember the signing secret is per-endpoint:
  a new endpoint means a new secret in `.env`.
- **API key allowlists** — Maps keys restricted by HTTP referrer, reCAPTCHA
  domains, Algolia/Meilisearch allowed origins, an S3 bucket CORS policy.
- **Analytics and search console** — property URL, and a fresh sitemap submission.
- **CDN / image optimisation** — a `next/image` `remotePatterns` entry, or an
  image CDN pointing at the old origin.

Keep both hosts' URLs registered through the cutover window so a rollback does
not also mean re-editing five dashboards.

## N-8 · Verify, then cut over

```bash
node scripts/inventory.mjs https://example.com --out out
node scripts/parity.mjs https://example.com https://staging.example.com \
  --inventory out/inventory.json --out out
node scripts/linkcheck.mjs https://staging.example.com --out out
```

Resolve every row in `out/parity-report.md`, then check what a crawl cannot
see: log in with each auth provider, submit every form, run a test payment in
test mode, trigger a webhook from the provider's dashboard and confirm it is
received and verified, check background jobs and scheduled tasks actually run,
and confirm the app log is clean rather than merely present.

```bash
systemctl is-enabled example           # survives a reboot?
journalctl -u example --since '10 min ago' -p warning --no-pager
```

Scheduled work and keeping writes safe through the move:
[Sites that keep working](./live-site-windows.md). Symptoms:
[Troubleshooting](./troubleshooting.md).
