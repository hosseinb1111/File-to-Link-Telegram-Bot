# File-to-Link Bot

A Telegram bot and web uploader running on a Cloudflare Worker. Send a file to the bot (up to 20 MB) or upload a file of up to 2 GB through the web page, and get a temporary download link. Files are stored in Backblaze B2 and deleted automatically when their link expires.

## Features

- **Telegram bot:** send any file up to 20 MB and receive a download link.
- **Web uploader (`/upload`):** upload files up to 2 GB. The browser splits the file into 16 MB pieces, the Worker stores them in Backblaze, and the pieces are joined back together when someone downloads the link.
- **Expiring links:** each link has a time limit (default 10 minutes). Expired files are removed by a scheduled job.
- **Manual expiry:** every link has an "Expire Link Now" button in Telegram.
- **Owner-only access:** only the Telegram account set as `OWNER_USER_ID` can upload files or use the admin panel.
- **Admin panel in Telegram:** send `/admin` to see active links (8 per page) and expire any of them.

## How it works

```
Browser ──(16 MB pieces)──> Worker /upload/chunk ──> Backblaze B2
Browser ──(finish)────────> Worker /upload/finish ──> D1 (link record)
Visitor ──> Worker /d/<token> ──> streams pieces from B2 as one file
```

- **Storage:** Backblaze B2 through the S3-compatible API, using the bundled `s3mini` client.
- **Metadata:** Cloudflare D1 (SQLite) stores tokens, file names, expiry times, and the list of piece keys.
- **Cleanup:** a Cron trigger deletes expired links and their pieces, and discards abandoned Telegram uploads after 6 hours.

## Requirements

- A Cloudflare account with Workers and D1
- A Backblaze B2 bucket and an application key with read and write access
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- Node.js and [Wrangler](https://developers.cloudflare.com/workers/wrangler/) (`npm install -g wrangler`)

## Setup

### 1. Create the D1 database

```bash
npx wrangler d1 create file-links
```

Add the binding to `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "file-links"
database_id = "<id from the previous command>"
```

### 2. Create the tables

Run the schema below (save it as `schema.sql`):

```sql
CREATE TABLE IF NOT EXISTS links (
  token TEXT PRIMARY KEY,
  r2_key TEXT NOT NULL,
  file_name TEXT NOT NULL,
  chat_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  parts TEXT
);

CREATE TABLE IF NOT EXISTS upload_sessions (
  chat_id INTEGER PRIMARY KEY,
  file_name TEXT NOT NULL,
  ttl INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS upload_parts (
  chat_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  size INTEGER NOT NULL,
  PRIMARY KEY (chat_id, seq)
);
```

Then apply it:

```bash
npx wrangler d1 execute file-links --remote --file=./schema.sql
```

### 3. Configure `wrangler.toml`

```toml
name = "file-link-bot"
main = "src/index.js"
compatibility_date = "2025-01-01"

[triggers]
crons = ["*/5 * * * *"]

[vars]
BASE_URL = "https://<your-worker>.workers.dev"
TTL_SECONDS = "600"
B2_ENDPOINT = "https://s3.us-east-005.backblazeb2.com"
B2_BUCKET_NAME = "<your-bucket>"
B2_REGION = "us-east-005"
```

### 4. Set the secrets

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put B2_KEY_ID
npx wrangler secret put B2_APPLICATION_KEY
npx wrangler secret put OWNER_USER_ID
npx wrangler secret put ADMIN_PASSWORD
```

- `TELEGRAM_WEBHOOK_SECRET` is any random string you choose. It must match the one used when setting the webhook.
- `OWNER_USER_ID` is your numeric Telegram user ID (you can get it from [@userinfobot](https://t.me/userinfobot)).
- `ADMIN_PASSWORD` is the password for the `/upload` page. Any username works in the browser prompt.

### 5. Deploy

```bash
npx wrangler deploy
```

### 6. Register the Telegram webhook

Replace the placeholders and open the URL in a browser:

```
https://api.telegram.org/bot<TOKEN>/setWebhook?url=<BASE_URL>/webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>
```

## Usage

**In Telegram**

| Action | Result |
|---|---|
| Send a file (up to 20 MB) | Bot replies with a download link and an Expire button |
| `/start` | Welcome message |
| `/admin` (owner only) | Lists active links with Expire buttons, 8 per page |
| Any other text | Hint to send a file or type `/start` |

**On the web**

Open `https://<your-worker>/upload`, enter the password, choose a file, and copy the link when the upload finishes. Keep the tab open until it completes.

## Project structure

```
.
├── src/index.js      # Worker code: bot, admin panel, uploader, downloads, cleanup
├── schema.sql        # D1 table definitions
├── wrangler.toml     # Worker configuration
└── README.md
```

The `s3mini` client is included at the top of `src/index.js`.

## Limits

| Item | Limit |
|---|---|
| Telegram upload | 20 MB per file |
| Web upload | 2 GB per file, sent in 16 MB pieces |
| Link lifetime | Default 10 minutes; up to 7 days from the web uploader |
| Download size on Cloudflare Free | About 400 MB (subrequest limit). Workers Paid removes this practical limit. |

## Notes

- Abandoned web uploads leave their pieces in Backblaze. Add a lifecycle rule on the bucket to delete objects under `uploads/` after a few days.
- Telegram stores photos and videos in compressed form. Send files as documents so the data is unchanged.
- Keep the `ADMIN_PASSWORD`, bot token, and B2 keys out of the repository. Use Wrangler secrets.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
