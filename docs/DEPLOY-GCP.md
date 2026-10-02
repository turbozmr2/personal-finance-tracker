# Hosting on Google Cloud, fed by Era

How to run the tracker off your PC, on a small Compute Engine VM, with its
data pulled from Era Context on a schedule.

## Why a Compute Engine VM (and not Vercel or Cloud Run)

The app keeps everything in one SQLite file and talks to it synchronously
through better-sqlite3 (about 250 call sites). It needs a disk that survives
restarts and a single long-lived process.

| Option | Fits? | Why |
|---|---|---|
| **Compute Engine VM** | **Yes, as is** | Persistent disk, one always-on process, systemd timers for the Era sync and backups. An `e2-micro` in `us-central1`, `us-west1` or `us-east1` with a 30 GB standard disk is inside Google Cloud's always-free tier. |
| Cloud Run | Only with extra machinery | Containers have no persistent disk. SQLite on a Cloud Storage FUSE mount is unsafe (no file locking), so it would need Litestream replication to a bucket, `max-instances=1`, and a restore on every cold start. Scheduled syncs need Cloud Scheduler hitting an authenticated route. |
| Vercel | No, not without a rewrite | Serverless functions have no persistent disk, so SQLite is out. Moving to a hosted database (Turso/libSQL, Postgres) means making every database call async — a rewrite of the data layer. Long first syncs would also run into function time limits. |

## 1. Create the VM

In Cloud Shell or any machine with `gcloud` signed in to your project:

```
gcloud compute instances create finance \
  --zone=us-central1-a \
  --machine-type=e2-micro \
  --image-family=debian-12 --image-project=debian-cloud \
  --boot-disk-size=30GB --boot-disk-type=pd-standard \
  --scopes=storage-rw
```

Leave the default firewall alone: the app listens on `127.0.0.1` only and
the tunnel (step 5) is outbound, so **no inbound port is opened**.

`e2-small` (2 GB RAM, about $13/month) builds faster and needs no swap; the
script adds 2 GB of swap so `e2-micro` can build too.

## 2. Install the app

```
gcloud compute ssh finance --zone=us-central1-a
curl -fsSLO https://raw.githubusercontent.com/<you>/personal-finance-tracker/<branch>/deploy/gcp/setup.sh
sudo bash setup.sh https://github.com/<you>/personal-finance-tracker.git <branch>
```

A private repository needs a deploy key or a token in the clone URL. The
script installs Node 24, builds the app, and enables three systemd units:

| Unit | What it does |
|---|---|
| `finance-tracker.service` | `next start` on `127.0.0.1:3000`, restarted on failure and at boot |
| `era-sync.timer` | `npm run era:sync` at 06:20 and 18:20 |
| `finance-backup.timer` | Nightly snapshot into `/opt/finance/data/backups`, copied to `gs://$BACKUP_BUCKET` when set |

Re-run the same command to deploy a newer commit.

## 3. Add your Era API key

Create a key in Era, then on the VM:

```
sudo nano /etc/finance-tracker/env        # set ERA_API_KEY=...
sudo systemctl restart finance-tracker    # so Settings → Era sees it
sudo systemctl start era-sync.service     # first sync: all history
journalctl -u era-sync.service -n 20      # "Era: N new, … (M Era calls)"
```

The file is readable only by root and the service user. The key is sent
only as an `Authorization: Bearer` header to `https://context.era.app/mcp`
(override with `ERA_MCP_URL`).

What comes across:

- **Checking, savings and credit card** accounts: transactions (pending
  ones included) and balances.
- **Brokerage, retirement, HSA, mortgage and loan** accounts: balances only,
  for net worth. Their transactions would read as spending.
- **Non-USD accounts and real estate** are skipped and listed as such in
  Settings → Era. The app is USD-only.

Each sync costs one Era MCP call for the accounts plus one per 100
transactions. The first pulls all history; later ones re-read the last 21
days, typically two or three calls. Twice a day is about 200 calls a month,
well inside the Organize plan's 1,000.

## 4. Optional: off-VM backups

```
gcloud storage buckets create gs://<unique-name> --location=us-central1
```

Put the bucket name in `BACKUP_BUCKET` in `/etc/finance-tracker/env`. To
restore, stop the service, copy a backup over `/opt/finance/data/finance.db`
and start it again.

## 5. Reach it from your phone and the wall display

The app has no login of its own, so publish it the way
[`HOUSEHOLD.md`](HOUSEHOLD.md) describes — Cloudflare Tunnel plus Cloudflare
Access — with one difference in **step 3**: choose **Debian / 64-bit** and
run the install command it prints on the VM (it installs `cloudflared` as a
systemd service). The route stays `HTTP` → `localhost:3000`.

Everything else in `HOUSEHOLD.md` applies unchanged: the Access policies,
the display token for `/wall` and `GET /api/wall`, and the hub contract.

Do not open port 3000 in the VPC firewall or give it a load balancer without
an authenticating layer in front.
