/**
 * POST /api/anomalies
 *
 * Runs the full anomaly detection suite on a submitted campaign dataset.
 * Accepts either raw campaign records (from /api/compare) or fetches
 * fresh data itself if source configs are provided.
 *
 * Body:
 * {
 *   campaigns: CampaignRecord[],   // from /api/compare, OR
 *   config?: {                     // anomaly engine tuning (all optional)
 *     zScoreThreshold:   number,   // default 2.5
 *     deltaThresholdPct: number,   // default 5
 *     ctrFloor:          number,   // default 0.5
 *     roasFloor:         number,   // default 1.0
 *     trendBreakPct:     number,   // default 40
 *     detectTrends:      boolean,  // default true
 *     detectLogic:       boolean,  // default true
 *     detectMissing:     boolean,  // default true
 *   }
 * }
 *
 * Response:
 * {
 *   ok: true,
 *   anomalies: Anomaly[],
 *   summary: {
 *     total: number,
 *     bySeverity: { critical, high, medium, low },
 *     byType: { statistical, mismatch, missing, logic, trend }
 *   },
 *   durationMs: number
 * }
 */

const { AnomalyEngine } = require('../lib/anomaly_engine');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const t0   = Date.now();
  const body = req.body || {};

  if (!body.campaigns || !Array.isArray(body.campaigns)) {
    return res.status(400).json({ ok: false, error: '`campaigns` array is required in request body.' });
  }

  try {
    const engine    = new AnomalyEngine(body.config ?? {});
    const anomalies = engine.detect(body.campaigns);

    // ── Build summary ──────────────────────────────────────────────────────
    const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
    const byType     = { statistical: 0, mismatch: 0, missing: 0, logic: 0, trend: 0 };
    anomalies.forEach(a => {
      bySeverity[a.severity] = (bySeverity[a.severity] ?? 0) + 1;
      byType[a.type]         = (byType[a.type]         ?? 0) + 1;
    });

    // ── Health score (0-100) ───────────────────────────────────────────────
    const totalCells = body.campaigns.length * 10; // 10 metrics per campaign
    const penalty    = bySeverity.critical * 8 + bySeverity.high * 4 +
                       bySeverity.medium * 1.5 + bySeverity.low * 0.5;
    const health     = Math.max(0, Math.round(100 - (penalty / totalCells) * 100));

    return res.status(200).json({
      ok: true,
      anomalies,
      summary: {
        total: anomalies.length,
        bySeverity,
        byType,
        healthScore: health,
      },
      durationMs: Date.now() - t0,
    });

  } catch (err) {
    console.error('[/api/anomalies]', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
