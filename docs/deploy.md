# Deploying Relay on a server (pm2 + nginx)

The first hosting runs on an existing Ubuntu EC2 machine next to other Node apps, without Docker.

```
browser ──https──▶ nginx (app.relay.operium.pro)
                     ├─ /api/events  ─▶ relay-realtime 127.0.0.1:3203  (live updates, no buffering)
                     ├─ /api/, /webhooks/, /health ─▶ relay-api 127.0.0.1:3201
                     └─ everything else ─▶ relay-web 127.0.0.1:3200 (Next.js)
relay-worker (sending, broadcasts, media) ─ health on 127.0.0.1:3202
Redis 127.0.0.1:6379 (queues) · Postgres + files on Neon
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

## Updating

```bash
cd /var/www/relay && git pull && pnpm install --frozen-lockfile && pnpm --filter @relay/web build && pm2 reload ecosystem.config.cjs
```
When a commit adds a migration: `DATABASE_URL="$(grep ^DATABASE_URL= .env | cut -d= -f2-)" pnpm --filter @relay/db migrate` before the reload.

## Rules

- **Only one worker per database.** The server and a laptop both pointing at the same Neon database must not both run `relay-worker`, or webhooks and sends get split between them.
- Logs: `pm2 logs relay-api` (pm2-logrotate caps them).
