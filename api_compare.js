/**
 * POST /api/compare
 *
 * Fetches campaign data from all three configured sources (Azure Blob,
 * Database, Tableau) concurrently and returns a merged dataset.
 *
 * Body (all fields optional — omit a source to skip it):
 * {
 *   azure:   { containerName, blobPath, campaignKey? }
 *   db:      { table, query?, campaignKey?, dateColumn?, startDate?, endDate? }
 *   tableau: { datasourceName?, viewName?, campaignKey? }
 * }
 *
 * Response:
 * {
 *   ok: true,
 *   campaigns: CampaignRecord[],
 *   sourceCounts: { azure: n, db: n, tableau: n },
 *   durationMs: number
 * }
 */

const { fetchFromAzureBlob, fetchFromDatabase, fetchFromTableau } = require('../lib/data_integration');

module.exports = async function handler(req, res) {
  // CORS — allow same-origin and localhost dev
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const t0 = Date.now();
  const body = req.body || {};

  try {
    // ── Build source configs from env + optional body overrides ────────────
    const azureCfg = process.env.AZURE_STORAGE_CONNECTION_STRING ? {
      connectionString: process.env.AZURE_STORAGE_CONNECTION_STRING,
      containerName:    body.azure?.containerName ?? process.env.AZURE_CONTAINER_NAME ?? 'campaign-exports',
      blobPath:         body.azure?.blobPath      ?? process.env.AZURE_BLOB_PATH      ?? 'campaigns.json',
      campaignKey:      body.azure?.campaignKey   ?? 'campaign_name',
    } : null;

    const dbCfg = process.env.DB_HOST ? {
      dialect: process.env.DB_DIALECT ?? 'pg',
      connection: {
        host:     process.env.DB_HOST,
        port:     parseInt(process.env.DB_PORT ?? '5432'),
        database: process.env.DB_NAME,
        user:     process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        ssl:      process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false },
      },
      table:       body.db?.table       ?? process.env.DB_TABLE       ?? 'campaign_metrics',
      query:       body.db?.query       ?? process.env.DB_QUERY       ?? null,
      campaignKey: body.db?.campaignKey ?? 'campaign_name',
      dateColumn:  body.db?.dateColumn  ?? process.env.DB_DATE_COLUMN ?? null,
      startDate:   body.db?.startDate   ?? null,
      endDate:     body.db?.endDate     ?? null,
    } : null;

    const tableauCfg = process.env.TABLEAU_SERVER_URL ? {
      serverUrl:      process.env.TABLEAU_SERVER_URL,
      siteName:       process.env.TABLEAU_SITE_NAME    ?? '',
      tokenName:      process.env.TABLEAU_TOKEN_NAME,
      tokenSecret:    process.env.TABLEAU_TOKEN_SECRET,
      datasourceName: body.tableau?.datasourceName ?? process.env.TABLEAU_DATASOURCE ?? null,
      viewName:       body.tableau?.viewName       ?? process.env.TABLEAU_VIEW       ?? null,
      campaignKey:    body.tableau?.campaignKey    ?? 'Campaign Name',
    } : null;

    // ── Fetch sources concurrently ─────────────────────────────────────────
    const results = await Promise.allSettled([
      azureCfg   ? fetchFromAzureBlob(azureCfg)   : Promise.resolve(new Map()),
      dbCfg      ? fetchFromDatabase(dbCfg)        : Promise.resolve(new Map()),
      tableauCfg ? fetchFromTableau(tableauCfg)    : Promise.resolve(new Map()),
    ]);

    const toMap = r => r.status === 'fulfilled' ? r.value : new Map();
    const [azure, db, tableau] = results.map(toMap);

    const errors = [];
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        errors.push({ source: ['azure','db','tableau'][i], message: r.reason?.message ?? String(r.reason) });
      }
    });

    // ── Merge by campaign name ─────────────────────────────────────────────
    const allNames = new Set([...azure.keys(), ...db.keys(), ...tableau.keys()]);
    const campaigns = Array.from(allNames).map(name => ({
      name,
      azure:   azure.get(name)   ?? null,
      db:      db.get(name)      ?? null,
      tableau: tableau.get(name) ?? null,
    }));

    return res.status(200).json({
      ok: true,
      campaigns,
      sourceCounts: { azure: azure.size, db: db.size, tableau: tableau.size },
      errors: errors.length ? errors : undefined,
      durationMs: Date.now() - t0,
    });

  } catch (err) {
    console.error('[/api/compare]', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
