# Managed and closed platforms

Getting a site **off** a platform that never gave you a shell: Wix,
Squarespace, Webflow, Shopify, GoDaddy's website builder — and the softer cases,
Vercel, Netlify and cPanel shared hosting, where you have some access but not
the one you want.

The workflow in `SKILL.md` is unchanged. Only the *extraction* changes: with no
`rsync` and no `mysqldump`, the source of truth for what the site contains is
the HTTP crawl, and the crawl is the only complete inventory you will get.

## M-1 · First, check what access actually exists

Before resigning yourself to the manual route:

```bash
# several shared hosts run SSH on a non-standard port without advertising it
for p in 22 2222 2083 7822; do
  echo "--- port $p"
  ssh -o ConnectTimeout=5 -o BatchMode=yes -p "$p" user@oldhost 'echo ok' 2>&1 | tail -1
done
```

cPanel has an *SSH Access* / *Terminal* page where a key can be added, and many
hosts enable it on request within minutes. It is worth one support ticket: with
a shell the migration is an hour of scripted, verifiable work, and without it a
half day of manual steps.

Vercel and Netlify have no shell, but they do have a CLI and an API, which is
nearly as good — see M-5.

## M-2 · The crawl is your inventory — take it first and keep it

With no filesystem access, `inventory.json` *is* the record of what the site
contained. Take it before anything changes on the platform, and archive it.

```bash
node scripts/inventory.mjs https://example.com --out out
# closed builders often publish no usable sitemap:
node scripts/inventory.mjs https://example.com --crawl --max 1000 --out out
```

Then enumerate by hand everything a crawl cannot reach, because on these
platforms that list is long: gated or members-only pages, form endpoints and
where submissions currently go, the blog's RSS feed, product and collection
pages behind a filter, redirects configured in the platform's dashboard,
scheduled or unpublished content, and every embedded third party (booking,
chat, reviews, payment).

Fetch a durable copy of the rendered HTML while the site is still up — a
platform you have cancelled is a platform you cannot re-read:

```bash
wget --mirror --page-requisites --adjust-extension --convert-links \
  --no-parent --wait=1 --random-wait \
  --directory-prefix=./source-mirror https://example.com/
```

Mirror into a directory of its own and treat what lands there as untrusted
input: it is someone else's HTML and JavaScript. Read it, grep it, port content
out of it — do not run a build tool from inside it.

## M-3 · Get the content out in a usable form

Rendered HTML is a fallback, not a content model. Look for a real export first.

| Platform | Export route | What you actually get |
| --- | --- | --- |
| Squarespace | Settings → Import/Export → Export (WordPress WXR) | Pages, blog posts, images. **Not** product pages, album/gallery pages, event collections, or any page built from a block the exporter ignores |
| Wix | No site export | Blog posts via RSS; media via the Media Manager; pages by hand or from the mirror |
| Webflow | Project → Export code (paid plans), CMS → CSV per collection | A static build plus CMS rows; no CMS *references* resolved |
| Shopify | Admin → Products/Customers/Orders → Export CSV | Catalogue and customers; theme via the Shopify CLI; pages/blogs via CSV |
| GoDaddy builder | No export | Mirror only |
| Ghost | Settings → Labs → Export JSON | Everything, cleanly |
| Drupal/Joomla | database dump | see [PHP applications](./php-apps.md) |

A Squarespace WXR import into WordPress, or a Webflow CSV into a Next.js
content directory, gets you most of the way — then `parity.mjs` tells you
exactly what the exporter dropped:

```bash
node scripts/parity.mjs https://example.com https://staging.example.com \
  --inventory out/inventory.json --out out
```

**Download the media separately and verify the count.** Exporters routinely
reference images by their CDN URL and ship none of the bytes, which looks fine
on the staging site right up until the old account is closed.

```bash
# pull every image the inventory saw, into its own directory
jq -r '.pages[].url' out/inventory.json > out/urls.txt
# fetch the assets each page references, then count what landed
find ./source-mirror -type f \( -name '*.jpg' -o -name '*.png' -o -name '*.webp' \
  -o -name '*.avif' -o -name '*.svg' -o -name '*.pdf' \) | wc -l
```

Platform CDN URLs are usually hotlinkable for a while after cancellation and
then are not. Rehost every asset on the target before cutover; a page whose
images still load from the old platform's CDN is not migrated.

## M-4 · Carry the URLs across, exactly

This is where re-platforming off a builder loses rankings. Closed platforms have
URL conventions you did not choose and the new stack will not reproduce by
accident:

- Squarespace blogs: `/blog/2024/3/14/post-title`
- Wix blogs: `/post/post-title`; Wix gallery and dynamic pages can carry `?`
  query parameters that are load-bearing
- Shopify: `/products/handle`, `/collections/handle`,
  `/collections/x/products/y` for the same product reached two ways
- Webflow collections: `/blog/slug` with the collection slug fixed in settings

Either reproduce the old paths on the new stack — cheapest, safest, no redirect
needed — or map them and redirect every one:

```bash
# mapping.csv: old_path,new_path
node scripts/redirects.mjs --map mapping.csv --out out --format all
```

Pull the old platform's own dashboard redirects into the same map before you
lose access to them; they are rules someone added for a reason and they vanish
with the account. Shopify's are under *Online Store → Navigation → URL
Redirects* and can be exported.

Then confirm the generated rules actually fire on staging, rather than assuming:

```bash
while IFS=, read -r old new; do
  [ "$old" = "old_path" ] && continue
  printf '%s  ' "$old"
  curl -o /dev/null -sS -w '%{http_code} -> %{redirect_url}\n' \
    "https://staging.example.com$old"
done < mapping.csv
```

Finally: on a closed platform you cannot install a redirect. Once DNS moves, the
old URLs are served by **your** new host, so every 301 has to be live on the
target *before* cutover. There is no second chance and no partial state.

## M-5 · Vercel / Netlify / Cloudflare Pages → your own server

Here you do have real access; it is just not a shell.

```bash
# Vercel — list and pull the environment, project settings and the deployment
vercel env ls
vercel env pull .env.production.local     # writes secrets to disk: chmod 600 it
vercel project ls
# Netlify
netlify env:list
netlify sites:list
netlify api getSite --data '{"site_id":"SITE_ID"}' > ./netlify-site.json
```

```bash
chmod 600 .env.production.local           # and never commit it
```

What has to be ported by hand, because it is platform configuration rather than
code:

- `vercel.json` / `netlify.toml` / `_redirects` / `_headers` → nginx or Caddy.
  Generate the redirect half from the inventory (`scripts/redirects.mjs`) and
  translate the rest; see [Static sites](./static-sites.md) § S-4.
- **Serverless functions and edge middleware are applications.** An API route, a
  Netlify function, a Next.js `middleware.ts` running at the edge — these need a
  Node process on your server, not a file copy. See
  [Node applications](./node-apps.md). A `middleware.ts` doing auth or
  redirects that silently stops running is the single easiest thing to miss in
  this move, because the build still succeeds.
- **Image optimisation.** `next/image` on Vercel is served by Vercel. Self-hosted
  it needs `sharp` installed and a writable `.next/cache/images`, or every
  image 500s.
- **ISR / on-demand revalidation** needs a persistent filesystem — which a
  single server has and a platform abstracted away. Check the cache directory is
  writable by the app user and survives a deploy.
- Cron jobs (`vercel.json` → `crons`, Netlify scheduled functions) become
  systemd timers or crontab entries.
- Preview deployments, password protection and analytics have no equivalent.
  Decide what replaces them before anyone asks.

## M-6 · cPanel / shared hosting with FTP but no shell

### Files

**Preferred: let the host build the archive.** In cPanel, *Files → Backup →
Download a Home Directory Backup*, or *File Manager* → select the document root
→ *Compress* to `.tar.gz` → download that one file. One archive downloads far
faster than thousands of small files, and nothing is silently skipped.

**Fallback: an FTP mirror.** `lftp` beats a GUI client here because it resumes
and parallelises. Keep the password out of the command line — `ps` shows an
`lftp -u user,password` invocation to every other account on the machine, and
your shell history keeps it forever. `lftp` reads `~/.netrc`:

```bash
umask 077
cat >> ~/.netrc <<'NETRC'
machine ftp.example.com
  login THE_USER
  password THE_PASSWORD
NETRC
chmod 600 ~/.netrc

lftp ftps://ftp.example.com -e "set ftp:ssl-force true; \
  set ftp:ssl-protect-data true; \
  mirror --continue --parallel=4 --verbose /public_html ./source-files; bye"
```

Insist on FTPS or SFTP — note the `ftps://` scheme and `ssl-force`, which make
`lftp` refuse to fall back. Plain FTP sends the password and the whole site in
clear text. Remove the `~/.netrc` entry when the migration is done.

Then verify the count rather than assuming:

```bash
find ./source-files -type f | wc -l     # compare with cPanel's File Manager
find ./source-files -name '.htaccess' -print
```

FTP transfers drop files quietly — a timeout mid-directory leaves a
plausible-looking tree missing a hundred images. And **many FTP clients skip
dotfiles by default**, which is how `.htaccess` gets left behind, which is why
every URL but the homepage 404s after the move.

### Database

**Preferred: phpMyAdmin export.** *Export → Custom*:

- Format: SQL · Compression: gzipped
- Tick **Add DROP TABLE / VIEW / PROCEDURE / FUNCTION / EVENT**
- Tick **Add CREATE PROCEDURE / FUNCTION / EVENT** so routines and triggers come too
- Data dump options: type `INSERT`, and tick **Use hexadecimal for BLOB**

A large database hits phpMyAdmin's execution timeout mid-export and hands you a
truncated file that still looks like valid SQL. Always check the tail:

```bash
chmod 600 export.sql.gz
gzip -dc export.sql.gz | tail -5          # a complete mysqldump ends with a comment
gzip -dc export.sql.gz | grep -c 'CREATE TABLE'
```

If it truncates, export table by table.

**For a big database: Adminer.** A single PHP file, far more reliable than
phpMyAdmin on large exports. It is also a database console open to the internet,
so: upload it under an unguessable filename, restrict it to your IP with an
`.htaccess` `Require ip` rule if the host honours one, use it, and **delete it
the moment you are done** — then confirm it is gone by requesting the URL and
getting a 404. Leaving it behind is a full database compromise.

Get row counts out of the source for verification, since no `mysqldump` sidecar
exists. Run this in phpMyAdmin's SQL tab and save the result:

```sql
SELECT CONCAT(table_name, '|', table_rows) FROM information_schema.tables
WHERE table_schema = DATABASE() ORDER BY table_name;
```

`table_rows` is an InnoDB estimate and can be out by a factor of two — treat a
mismatch as a prompt to check the tables that matter with `SELECT COUNT(*)`, not
as proof of failure. A missing table is never an estimate.

### Then migrate from your machine

With the files and the dump local, every remaining step treats the target as the
only remote host:

```bash
mkdir -p ./source-files && tar -xzf cpanel-backup.tar.gz -C ./source-files
rsync -azP --no-owner --no-group --dry-run \
  ./source-files/public_html/ user@newhost:/var/www/example.com/
```

Unpack a downloaded archive into its own empty directory — it is untrusted
content from another machine, and a tarball with absolute or `../` paths will
otherwise write wherever it likes. Then continue at
[PHP applications](./php-apps.md) § P-4, or `SKILL.md`'s WordPress recipe at
WP-5 if it is WordPress.

### The backup rule still holds

`backup` here means the downloaded archive plus the database export, both
verified readable, `chmod 600`, copied somewhere that is neither host, before
anything is loaded onto the target.

## M-7 · Before you cancel the old account

Cancellation on a closed platform is irreversible and takes the content with
it. **Stop and get explicit confirmation from the user**, and only after the
monitoring window is clean. Before then:

- [ ] `parity.mjs` reports zero unresolved problems against the archived inventory
- [ ] every asset is rehosted — no page still loading images from the old CDN
- [ ] forms submit and the notification arrives
- [ ] the domain is out of the platform's DNS and the registrar lock/auth code
      is in hand (builders often hold the registration as well as the DNS)
- [ ] email is accounted for: if the platform also provided mailboxes, that is a
      separate migration in a separate window — do not combine them
- [ ] the archived `out/inventory.json`, `source-mirror/` and every export file
      are stored somewhere permanent

Keep the platform account alive — even on its cheapest plan — through the
monitoring window. It is the only rollback that exists.
