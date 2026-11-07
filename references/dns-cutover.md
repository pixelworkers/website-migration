# DNS cutover and certificates

Platform-agnostic. The same arithmetic and the same ordering apply whether the
site is WordPress, a Node app, or 400 static files.

`SKILL.md`'s WordPress recipe covers this inline at WP-10 and WP-11; this is the
general version, plus the cases that recipe does not reach.

## TTL is your rollback latency

TTL is how long a resolver may cache an answer. It is also, exactly, how long a
bad cutover keeps hurting after you have reverted it.

With a TTL of 3600, a record you change at 10:00 may still send visitors to the
old server until 11:00 — and if you roll back at 10:15, visitors keep arriving
at the broken new host until 11:15.

So:

1. **A day or more before cutover**, lower the TTL on the records you will
   change to 300.
2. **Wait out the old TTL.** If it was 86400, the lower value is not fully in
   effect for 24 hours. Lowering the TTL an hour before cutover achieves
   nothing at all — the resolvers that matter are still holding the old answer
   *with the old TTL*.
3. Cut over.
4. **A day after** you are satisfied, put the TTL back up. A permanently low
   TTL costs a little latency on every lookup.

## Record the current state before you change anything

```bash
for t in A AAAA CNAME MX TXT NS SOA; do
  echo "--- $t"
  dig +noall +answer "$t" example.com
done
dig +noall +answer A www.example.com
dig +nssearch example.com                 # which nameservers are authoritative
```

Paste that output into your notes. A rollback should be re-entering a value you
have written down, not reconstructing one from memory under pressure with the
site down.

Also check whether the zone you are about to edit is the **live** one. A domain
whose `NS` records point at Cloudflare while someone edits the registrar's own
DNS panel is the most common cause of "I changed it and nothing happened."

```bash
dig +short NS example.com                 # must match the panel you are editing
```

## Change only the website records

| Record | Change it? |
| --- | --- |
| `A` / `AAAA` for the apex | yes — this *is* the cutover |
| `CNAME` or `A` for `www` | yes |
| `CNAME` for other subdomains | only the ones you are actually moving |
| `MX` | **no** |
| `TXT` (SPF, DKIM, DMARC, verification tokens) | **no** |
| `NS` | no — changing nameservers is a different, slower operation |
| `CAA` | only if the new host uses a different certificate authority |

**Dropping `MX` or SPF while moving a website takes down the client's email.**
It happens most often when someone pastes a new host's default zone over the
existing one instead of editing the two records that matter. Never replace a
zone; edit records.

If the old host also handled the email, say so plainly and treat mail as a
separate migration in a separate window. Do not combine them.

A `CAA` record pinned to the old host's CA will make certificate issuance on the
new host fail with a message that does not mention DNS:

```bash
dig +short CAA example.com
```

## The certificate ordering problem

Let's Encrypt's HTTP-01 challenge needs the domain to already point at the
server you are issuing for. Before cutover it does not. Three ways through:

1. **DNS-01 validation — the clean answer.** Proves control with a TXT record
   instead of an HTTP request, so a valid certificate for the real domain can be
   issued before any traffic moves.
   ```bash
   certbot certonly --preferred-challenges dns --manual \
     -d example.com -d www.example.com
   # better, with your DNS provider's API plugin, so renewal is automatic:
   certbot certonly --dns-cloudflare \
     --dns-cloudflare-credentials /etc/letsencrypt/dns.ini \
     -d example.com -d www.example.com
   chmod 600 /etc/letsencrypt/dns.ini     # it holds an API token
   ```
   That credentials file is a live API token for your DNS. `600`, root-owned,
   never in a repository, and scoped to DNS edits for this zone only if the
   provider supports scoping.
2. **Issue immediately after cutover.** Point DNS, then run certbot, or let
   Caddy do it automatically on the first request. Expect a minute or two with a
   certificate warning — acceptable for a small site, not for a shop.
3. **Copy the existing certificate** from the old host if it has one with time
   left. It works, and it means moving a private key between machines (`scp`,
   `chmod 600`, delete the intermediate copy) and inheriting someone else's
   renewal schedule. Last resort.

Then confirm the certificate works on the new host **before** DNS moves, by
resolving the hostname yourself:

```bash
curl -sSv --resolve example.com:443:203.0.113.10 https://example.com/ -o /dev/null
# and check both names and the expiry
echo | openssl s_client -connect 203.0.113.10:443 -servername example.com 2>/dev/null \
  | openssl x509 -noout -subject -ext subjectAltName -dates
```

A certificate covering `example.com` but not `www.example.com` — or the other
way round — is the most common post-cutover warning. Issue for both.

**Check HSTS before cutover.** If the old site sent
`Strict-Transport-Security`, every browser that saw it will refuse to load the
new site over plain HTTP. The certificate has to work on the first try; there is
no degraded mode.

```bash
curl -sSI https://example.com/ | grep -i strict-transport-security
```

## Cloudflare

If `NS` points at Cloudflare and the record is proxied — the orange cloud — the
rules change, mostly in your favour:

- The public `A` record is Cloudflare's address. It does not change when you
  re-point the origin, so watching public DNS tells you nothing.
- **The change you make is the origin IP, in the Cloudflare dashboard.** It is
  instant, invisible to resolvers, and reverts in one click. This is the
  smoothest cutover available — no TTL arithmetic at all.
- Verify against the origin directly, bypassing the proxy, before and after:
  ```bash
  curl -sSI --resolve example.com:443:203.0.113.10 https://example.com/
  ```
- **Purge everything after cutover**, or you will be looking at cached copies of
  the old site while the new one is live.
- **Check the SSL/TLS mode.** "Flexible" means Cloudflare talks to your origin
  over plain HTTP, which produces a redirect loop against any server that forces
  HTTPS. "Full (strict)" is what you want, and it requires a valid certificate
  on the origin.
- Grey-cloud (DNS-only) the record temporarily if you need to see the origin as
  the world would — remembering that this exposes the origin IP while it is off.
- Page Rules, Transform Rules, Workers and Bulk Redirects are configuration that
  lives at Cloudflare, not on either host. They survive the move — which also
  means a rule rewriting paths for the old stack is still rewriting them for the
  new one. Review them before cutover.

## Watching it land

```bash
# poll several independent resolvers; they should converge on the new address
for r in 1.1.1.1 8.8.8.8 9.9.9.9 208.67.222.222; do
  printf '%-16s ' "$r"
  dig +short @"$r" A example.com | tr '\n' ' '
  echo
done
# and the authoritative answer, which should change immediately
dig +short @"$(dig +short NS example.com | head -1)" A example.com
```

Repeat it until they agree. If one resolver lags far behind the others *after*
the TTL has passed, suspect the record rather than propagation: a leftover
second `A` record, a typo, a `www` pointing somewhere else, or a change made in
a zone that is not the live one.

```bash
dig +short A example.com www.example.com   # a stray second A record shows up here
```

## Verify the live domain the moment it moves

```bash
curl -sSI https://example.com/ | head -20
node scripts/linkcheck.mjs https://example.com --out out-prod
node scripts/parity.mjs http://203.0.113.20 https://example.com \
  --inventory out/inventory.json --out out-prod
```

Compare against the old host **by IP** once DNS has moved — the hostname now
resolves to the new server, so comparing hostname to hostname compares the new
site with itself and passes meaninglessly.

## Keep the old host running

For at least 48–72 hours, and a week if the site matters. Some resolvers, and
plenty of client machines, hold a stale answer well past the TTL; corporate
networks and mobile carriers are the worst offenders.

While the old host is up, a visitor on a stale answer sees the old site — dated
content, but a working site. Once it is down they see nothing, and you have no
rollback either.

**Rollback is: put the old IP back in DNS.** Nothing else — which is the entire
reason the old host stays untouched and running. Cancelling the old host is
irreversible, so it stops and asks the user, every time, even if an earlier step
was approved.
