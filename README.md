# Gangotri WhatsApp Automation

Production-ready WhatsApp stock assistant dashboard. It uses the official WhatsApp Cloud API (not a browser session) and serves its responsive frontend and API from one Node.js service.

## Recommended free deployment: Render + Supabase

Render provides a free HTTPS Node web service and an `onrender.com` subdomain. Supabase provides the free Postgres database. No paid domain or hosting plan is required.

### 1. Create the free database

1. Create a project at [supabase.com](https://supabase.com).
2. In **SQL Editor**, run:

```sql
create table public.stock (
  name text primary key,
  quantity integer not null default 0 check (quantity >= 0),
  price numeric(10,2) not null default 0 check (price >= 0)
);
alter table public.stock enable row level security;

insert into public.stock (name, quantity, price) values
  ('Paracetamol 650mg', 50, 30.00),
  ('Dolo 650', 20, 32.50),
  ('Azithromycin 500mg', 0, 120.00),
  ('Cetirizine 10mg', 100, 18.00)
on conflict (name) do update set
  quantity = excluded.quantity,
  price = excluded.price;
```

3. Copy the project URL and the `service_role` key from **Project Settings > API**. The service-role key is server-only and must never be placed in frontend code.

### 2. Deploy on Render

1. Push this folder to a GitHub repository. Do not commit `.env` or API keys.
2. In Render, choose **New > Web Service**, connect the repository, and select **Free**.
3. Use build command `npm ci` and start command `npm start`. `render.yaml` contains the same settings.
4. Copy the HTTPS URL Render creates, such as `https://gangotri-whatsapp-automation.onrender.com`.
5. Add the environment variables below in Render **Environment**, set `APP_URL` to the exact Render URL, and redeploy.

### 3. Environment variables

| Variable | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `APP_URL` | Render HTTPS URL |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase server-only service-role key |
| `WHATSAPP_ACCESS_TOKEN` | Meta WhatsApp Cloud API access token |
| `WHATSAPP_PHONE_NUMBER_ID` | Meta phone number ID |
| `WHATSAPP_APP_SECRET` | Meta app secret used to verify webhook signatures |
| `WHATSAPP_VERIFY_TOKEN` | A long random string you choose |

### 4. Connect WhatsApp Cloud API

1. Create/configure a Meta developer app with WhatsApp Cloud API and add a test or business phone number.
2. In the app dashboard, add a webhook subscription for **messages**.
3. Set callback URL to `https://YOUR-RENDER-SERVICE.onrender.com/webhook/whatsapp`.
4. Set the verify token to the exact `WHATSAPP_VERIFY_TOKEN` value, complete verification, and subscribe to `messages`.
5. Add the access token, phone number ID, and app secret in Render and redeploy.
6. Send a WhatsApp text such as `Dolo 650` to the business number. The webhook searches Supabase and replies with stock.

If a medicine still returns “not found”, open the deployed dashboard, add it under **Inventory**, and click **Save stock**. The dashboard and WhatsApp webhook use the same Supabase `stock` table.

The dashboard sends outbound messages through `POST /api/messages`. WhatsApp business-initiated messages may require an approved template outside the 24-hour customer service window.

### 5. Local verification

```powershell
Copy-Item .env.example .env
npm install
npm run check
npm start
```

Open `http://localhost:3000`. Local use requires real Supabase and WhatsApp values for data and messaging; the deployed app never depends on localhost.

## Free-tier limitations

- Render free services sleep after inactivity, so the first request can take around 30–60 seconds. They have limited monthly hours and are not suitable for guaranteed 24/7 automation.
- Render's local filesystem is ephemeral; inventory is stored in Supabase instead of SQLite.
- Supabase free projects have usage/storage limits and can pause after prolonged inactivity.
- Meta requires WhatsApp policy compliance, recipient opt-in, rate limits, and approved templates for some outbound conversations.
- Scheduled jobs are not bundled because Render free web services cannot guarantee cron execution. Use an external free cron provider to call an authenticated endpoint if scheduled sends are later added.
