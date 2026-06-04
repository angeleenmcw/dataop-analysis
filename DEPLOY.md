# Campaign Comparator — Vercel Deployment Guide

## Project structure

```
/
├── public/
│   └── index.html          ← Full dashboard (served as static site)
├── api/
│   ├── compare.js          ← POST /api/compare   — fetches Azure + DB + Tableau
│   ├── anomalies.js        ← POST /api/anomalies  — runs anomaly detection
│   └── analyze.js          ← POST /api/analyze    — Claude AI analysis (SSE stream)
├── lib/
│   ├── anomaly_engine.js   ← Core detection engine (shared by api/ routes)
│   └── data_integration.js ← Azure / DB / Tableau adapters
├── vercel.json             ← Vercel config
└── package.json
```

---

## Deploy in 5 minutes

### 1. Install Vercel CLI

```bash
npm install -g vercel
```

### 2. Clone / copy this folder, then log in

```bash
vercel login
```

### 3. Set environment variables

In the Vercel dashboard → Project → Settings → Environment Variables, add:

| Variable | Description | Required |
|---|---|---|
| `AZURE_STORAGE_CONNECTION_STRING` | Azure Storage connection string | If using Azure |
| `AZURE_CONTAINER_NAME` | Blob container name | If using Azure |
| `AZURE_BLOB_PATH` | Path to blob file (e.g. `daily/campaigns.json`) | If using Azure |
| `DB_HOST` | Database host | If using DB |
| `DB_PORT` | Database port (default 5432) | If using DB |
| `DB_NAME` | Database name | If using DB |
| `DB_USER` | Database user | If using DB |
| `DB_PASSWORD` | Database password | If using DB |
| `DB_DIALECT` | `pg`, `mysql2`, or `mssql` | If using DB |
| `DB_TABLE` | Table name | If using DB |
| `DB_SSL` | `true` / `false` | If using DB |
| `TABLEAU_SERVER_URL` | e.g. `https://10az.online.tableau.com` | If using Tableau |
| `TABLEAU_SITE_NAME` | Site name (blank = Default) | If using Tableau |
| `TABLEAU_TOKEN_NAME` | Personal Access Token name | If using Tableau |
| `TABLEAU_TOKEN_SECRET` | Personal Access Token secret | If using Tableau |
| `TABLEAU_DATASOURCE` | Published data source name | If using Tableau |
| `ANTHROPIC_API_KEY` | Your Anthropic API key | For AI analysis |

Or use the CLI:
```bash
vercel env add ANTHROPIC_API_KEY
vercel env add AZURE_STORAGE_CONNECTION_STRING
# etc.
```

### 4. Deploy

```bash
vercel --prod
```

Your app is live at `https://your-project.vercel.app`.

---

## How it works

```
Browser (index.html)
  │
  ├── Load sample data        →  uses built-in JS data, no API call
  │
  ├── Run comparison          →  POST /api/compare
  │                               ├── fetchFromAzureBlob()
  │                               ├── fetchFromDatabase()
  │                               └── fetchFromTableau()
  │                           →  POST /api/anomalies
  │                               └── AnomalyEngine.detect()
  │
  └── AI Analysis buttons     →  POST /api/analyze  (SSE stream)
                                  └── Anthropic claude-sonnet-4-20250514
```

All credentials stay on the server (Vercel Functions). The browser never sees them.

---

## Local development

```bash
npm install
vercel dev       # starts local dev server at http://localhost:3000
```

`vercel dev` emulates both the static file serving and the serverless functions locally.

---

## API reference

### POST /api/compare

Fetch and merge campaign data from all configured sources.

```js
// Request body — all fields optional
{
  azure:   { containerName?, blobPath?, campaignKey? },
  db:      { table?, query?, campaignKey?, dateColumn?, startDate?, endDate? },
  tableau: { datasourceName?, viewName?, campaignKey? }
}

// Response
{
  ok: true,
  campaigns: CampaignRecord[],
  sourceCounts: { azure: 42, db: 45, tableau: 41 },
  errors: [...],   // partial failures if one source is down
  durationMs: 1240
}
```

### POST /api/anomalies

Run anomaly detection on a campaign dataset.

```js
// Request body
{
  campaigns: CampaignRecord[],  // from /api/compare
  config: {
    zScoreThreshold: 2.5,
    deltaThresholdPct: 5,
    ctrFloor: 0.5,
    roasFloor: 1.0,
    trendBreakPct: 40,
    detectTrends: true,
    detectLogic: true,
    detectMissing: true
  }
}

// Response
{
  ok: true,
  anomalies: Anomaly[],
  summary: {
    total: 23,
    bySeverity: { critical: 2, high: 5, medium: 11, low: 5 },
    byType: { statistical: 6, mismatch: 8, missing: 3, logic: 4, trend: 2 },
    healthScore: 74
  },
  durationMs: 38
}
```

### POST /api/analyze  (SSE stream)

AI analysis via Claude. Returns `text/event-stream`.

```js
// Request body
{
  mode: 'summarize' | 'rootcause' | 'recommendations' | 'quality' | 'forecast' | 'full',
  anomalies: Anomaly[],
  campaigns: CampaignRecord[]
}

// Response: SSE stream
data: "Based on the"\n\n
data: " campaign data"\n\n
...
data: [DONE]\n\n
```

---

## Adding a cron job (optional)

To run comparisons on a schedule (e.g. every morning), add to `vercel.json`:

```json
{
  "crons": [
    {
      "path": "/api/compare",
      "schedule": "0 7 * * *"
    }
  ]
}
```

This calls `/api/compare` at 7am UTC daily. Pair with a database (Vercel Postgres or Neon) to store results over time — then you can chart anomaly trends week-over-week.

---

## Scaling up

| Need | Add |
|---|---|
| Store anomaly history | Vercel Postgres (1 click in dashboard) or Neon |
| Scheduled runs | `crons` in `vercel.json` (see above) |
| Slack / email alerts | Add `/api/notify.js` — POST to Slack webhook when `severity === 'critical'` |
| Auth / login | Vercel's built-in auth or NextAuth.js |
| More sources (GA4, Meta Ads, etc.) | Add a new adapter in `lib/data_integration.js` |
