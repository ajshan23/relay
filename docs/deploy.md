# Deploying Relay on a server (pm2 + nginx)

The first hosting runs on an existing Ubuntu EC2 machine next to other Node apps, without Docker.

```
browser ──https──▶ nginx (app.relay.operium.pro)
                     ├─ /api/events  ─▶ relay-realtime 127.0.0.1:3203  (live updates, no buffering)
                     ├─ /api/, /webhooks/, /health ─▶ relay-api 127.0.0.1:3201
                     └─ everything else ─▶ relay-web 127.0.0.1:3200 (Next.js)
relay-worker (sending, broadcasts, media, Embedded Signup follow-ups) ─ health on 127.0.0.1:3202
Redis 127.0.0.1:6379 (queues) · Postgres on Supabase (Mumbai, same region as the server) · files on Neon storage
```

Everything listens on 127.0.0.1 (`HOST=127.0.0.1` in `ecosystem.config.cjs`), so nginx is the only way in.

## One-time setup (as root)

**1. DNS.** Add an A record `app.relay` under `operium.pro`, pointing to the server's public IP (`curl -s https://checkip.amazonaws.com`).

**2. Redis.** BullMQ needs `noeviction`: queued jobs must never be dropped to save memory.
```bash
apt-get update && apt-get install -y redis-server
sed -i -E 's/^#? ?bind .*/bind 127.0.0.1 -::1/; s/^#? ?maxmemory .*/maxmemory 128mb/; s/^#? ?maxmemory-policy .*/maxmemory-policy noeviction/; s/^#? ?supervised .*/supervised systemd/' /etc/redis/redis.conf
grep -q '^maxmemory ' /etc/redis/redis.conf || echo 'maxmemory 128mb' >> /etc/redis/redis.conf
grep -q '^maxmemory-policy ' /etc/redis/redis.conf || echo 'maxmemory-policy noeviction' >> /etc/redis/redis.conf
systemctl enable --now redis-server && systemctl restart redis-server && redis-cli ping
```
Keep queued jobs across a Redis restart with the append-only file (rewritten in place, safe to run again):
```bash
sed -i -E 's/^#? ?appendonly .*/appendonly yes/; s/^#? ?appendfsync .*/appendfsync everysec/' /etc/redis/redis.conf
grep -q '^appendonly ' /etc/redis/redis.conf || echo 'appendonly yes' >> /etc/redis/redis.conf
systemctl restart redis-server
redis-cli CONFIG GET maxmemory-policy && redis-cli CONFIG GET appendonly && redis-cli INFO memory | grep -E '^(used_memory_human|maxmemory_human):'
```
Expect `noeviction`, `yes`, and used memory well below the limit. Relay is built so Redis trouble slows
it down rather than taking it down: pages and webhooks only need Postgres, every queue add gives up after a
second, and the worker puts back unprocessed webhook events and stuck outgoing messages every minute from
Postgres. `curl -s localhost:3202` (worker) and `curl -s localhost:3201/health/ready` (API) show Redis
reachability and memory; the worker logs a warning above 80% of `maxmemory`.

**2b. ffmpeg** (voice notes recorded in Relay are converted to WhatsApp's Ogg/Opus voice format; video previews use it too):
```bash
apt-get install -y ffmpeg && ffmpeg -version | head -1
```

**3. Read-only access to the private repo** (a deploy key; add the printed key in GitHub → repo → Settings → Deploy keys, "Allow write access" off):
```bash
ssh-keygen -t ed25519 -f /root/.ssh/relay_deploy -N "" -C "relay-deploy@$(hostname)"
printf 'Host github-relay\n  HostName github.com\n  User git\n  IdentityFile /root/.ssh/relay_deploy\n  IdentitiesOnly yes\n' >> /root/.ssh/config
cat /root/.ssh/relay_deploy.pub
# after adding it on GitHub:
git clone git@github-relay:ajshan23/relay.git /var/www/relay
```

**4. Settings.** Copy the local `.env` to `/var/www/relay/.env` (`chmod 600`) and change only:

| Setting | Server value |
|---|---|
| `NODE_ENV` | `production` |
| `WEB_URL` | `https://app.relay.operium.pro` |
| `REDIS_URL` | `redis://127.0.0.1:6379` |
| `OLD_*`, `DEV_TEST_*` | remove |

Keep `CHANNEL_SECRET_KEY` identical: it decrypts the channel tokens already in the database.
The web build also needs `apps/web/.env.production.local`:
```
NEXT_PUBLIC_API_URL=https://app.relay.operium.pro
NEXT_PUBLIC_SITE_URL=https://relay.operium.pro
```

**5. Build and start.**
```bash
cd /var/www/relay && pnpm install --frozen-lockfile && pnpm --filter @relay/web build
pm2 start ecosystem.config.cjs && pm2 save
```

**6. nginx + HTTPS.** Site file `/etc/nginx/sites-available/relay` (see below), then
`ln -s /etc/nginx/sites-available/relay /etc/nginx/sites-enabled/relay && nginx -t && systemctl reload nginx && certbot --nginx -d app.relay.operium.pro`.

```nginx
server {
    listen 80;
    server_name app.relay.operium.pro;
    client_max_body_size 110m;

    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    location /api/events {
        proxy_pass http://127.0.0.1:3203;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 1h;
    }
    location /api/      { proxy_pass http://127.0.0.1:3201; proxy_read_timeout 120s; }
    location /webhooks/ { proxy_pass http://127.0.0.1:3201; }
    location = /health  { proxy_pass http://127.0.0.1:3201; }
    location / {
        proxy_pass http://127.0.0.1:3200;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

**7. Meta.** Webhook callback URL: `https://app.relay.operium.pro/webhooks/meta`, same verify token as `META_VERIFY_TOKEN`.
In the app's Webhooks settings (WhatsApp Business Account object) subscribe to: `messages`, `account_update`,
`message_template_status_update`, `message_template_quality_update`, `phone_number_quality_update`,
`phone_number_name_update`, `business_capability_update`, `business_username_updates`, `history`,
`smb_app_state_sync`, `smb_message_echoes`. (Relay also sends this list to each business's account when it connects.)

**8. Embedded Signup (businesses connect their own WhatsApp).** In the Meta app dashboard:
- Facebook Login for Business → Configurations → create one with login variation **WhatsApp Embedded Signup**
  (products: Cloud API; permissions `whatsapp_business_management`, `whatsapp_business_messaging`). If the token
  expiry can be chosen, pick "never". Copy its **Configuration ID** into `.env` as `META_CONFIG_ID`.
- Facebook Login for Business → Settings → Client OAuth settings: Client OAuth login, Web OAuth login, Enforce HTTPS,
  Embedded Browser OAuth Login, Strict Mode, **Login with the JavaScript SDK**: all Yes.
  Allowed domains for the JavaScript SDK and Valid OAuth redirect URIs: `https://app.relay.operium.pro/`.
- `.env` needs `META_APP_ID`, `META_APP_SECRET`, `META_CONFIG_ID`, `CHANNEL_SECRET_KEY`. No web rebuild is needed:
  the browser reads them from `GET /api/channels/whatsapp/signup-config`.
- Until Meta grants Advanced Access (App Review), only people with a role on the Meta app can finish the signup.
  Test with a second business portfolio: a number created in the developer app can't be onboarded.
- Numbers that stay on the WhatsApp Business app (coexistence) get their contacts and up to 6 months of chats copied
  within 24 hours of connecting; imported chats start closed and never count as unread.

**9. Automations (Kairos).** Automations run on Kairos, a Postgres-only engine inside `relay-worker`: no extra
service, and the worker creates and migrates its `kairos` schema itself when it starts.
- For instant wake-ups when a customer replies (otherwise within about a second): `KAIROS_LISTEN_URL` = a
  connection that keeps its session, so LISTEN works. On Supabase that's the **session pooler** (port 5432);
  `DATABASE_URL` is the **transaction pooler** (port 6543), which can't LISTEN. (On Neon: the direct host.)
- The Kairos dashboard (runs, waits, failures, workers, engine health) is its own small app on 127.0.0.1:3204.
  Set `KAIROS_ADMIN_PASSWORD` in `.env` (a long random one; it is the only login), add an A record `kairos.relay`
  under `operium.pro`, then this site file and `certbot --nginx -d kairos.relay.operium.pro`:
```nginx
server {
    listen 80;
    server_name kairos.relay.operium.pro;
    location / {
        proxy_pass http://127.0.0.1:3204;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```
- First time: `pnpm --filter @relay/kairos-dashboard build && pm2 start ecosystem.config.cjs --only kairos-dashboard`.

## Updating

```bash
cd /var/www/relay && git pull && pnpm install --frozen-lockfile && pnpm --filter @relay/web build && pnpm --filter @relay/kairos-dashboard build && pm2 reload ecosystem.config.cjs
```
When a commit adds a migration: `DATABASE_URL="$(grep ^DATABASE_URL= .env | cut -d= -f2-)" pnpm --filter @relay/db migrate` before the reload.
(drizzle-kit runs over the session port by itself: a 6543 URL becomes 5432. Up to 0022 is applied on Supabase.)

### Database: Supabase
`DATABASE_URL` = Supabase's **transaction pooler** (`aws-1-ap-south-1.pooler.supabase.com:6543`); with port 6543
the app turns prepared statements off by itself. `KAIROS_LISTEN_URL` = the **session pooler** (same host, 5432).
Every table in `public` has RLS on and no access for `anon`/`authenticated`, so Supabase's Data API and the
publishable key can't read Relay's data; Relay connects as `postgres`, which owns the tables.

## Rules

- **Only one worker per database.** The server and a laptop both pointing at the same database must not both run `relay-worker`, or webhooks and sends get split between them (and automation runs would execute on whichever code version claims them).
- Logs: `pm2 logs relay-api` (pm2-logrotate caps them).
