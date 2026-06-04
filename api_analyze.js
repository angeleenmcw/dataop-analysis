/**
 * POST /api/analyze
 *
 * Sends campaign anomaly data to Claude (claude-sonnet-4-20250514) and
 * streams back an AI-generated analysis. Uses server-sent events (SSE)
 * so the browser can display the response token-by-token.
 *
 * Body:
 * {
 *   mode:      'summarize' | 'rootcause' | 'recommendations' | 'quality' | 'forecast' | 'full',
 *   anomalies: Anomaly[],
 *   campaigns: CampaignRecord[],
 * }
 *
 * Response: text/event-stream
 *   data: <token>\n\n  (streaming)
 *   data: [DONE]\n\n   (end of stream)
 */

const Anthropic = require('@anthropic-ai/sdk');

const PROMPTS = {
  summarize: (ctx) => `Summarize the data mismatches and anomalies found in this campaign dataset in 3-4 clear paragraphs. Be specific about which campaigns and metrics are affected.\n\n${ctx}`,
  rootcause: (ctx) => `Perform a root cause analysis. Group anomalies by likely cause: tracking/pixel issues, data pipeline errors, attribution problems, budget issues, or platform discrepancies. For each group, suggest which team owns remediation.\n\n${ctx}`,
  recommendations: (ctx) => `Provide 6 specific, actionable optimization recommendations based on the data quality issues found. Include: what to fix, how to fix it, and estimated effort (Low/Medium/High).\n\n${ctx}`,
  quality: (ctx) => `Assess overall data quality across Azure Blob Storage, Database, and Tableau. Score each source out of 100, explain reasoning, identify the weakest link, and give a 30-day remediation plan.\n\n${ctx}`,
  forecast: (ctx) => `Based on the anomaly patterns, forecast which campaigns are most at risk of further data quality degradation in the next 30 days. Explain the signals driving each prediction.\n\n${ctx}`,
  full: (ctx) => `Write a concise data audit report with these sections:\n1. Executive summary (3 sentences)\n2. Source comparison findings\n3. Anomaly breakdown by type and severity\n4. Root causes\n5. Business impact\n6. Prioritized remediation roadmap (owner, effort, timeline)\n\n${ctx}`,
};

function buildContext(campaigns, anomalies) {
  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
  const byType = { statistical: 0, mismatch: 0, missing: 0, logic: 0, trend: 0 };
  anomalies.forEach(a => {
    bySeverity[a.severity] = (bySeverity[a.severity] ?? 0) + 1;
    byType[a.type]         = (byType[a.type]         ?? 0) + 1;
  });

  const top5 = anomalies.slice(0, 5)
    .map(a => `- [${a.severity}] ${a.campaign} / ${a.metric}: ${a.description.slice(0, 110)}`)
    .join('\n');

  return `Campaign data comparison — ${campaigns.length} campaigns across Azure Blob Storage, Database, and Tableau.

Anomaly summary: ${anomalies.length} total
  Severity: critical=${bySeverity.critical}, high=${bySeverity.high}, medium=${bySeverity.medium}, low=${bySeverity.low}
  By type:  statistical=${byType.statistical}, mismatch=${byType.mismatch}, missing=${byType.missing}, logic=${byType.logic}, trend=${byType.trend}

Top anomalies:
${top5}`;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(501).json({ ok: false, error: 'ANTHROPIC_API_KEY not configured on this deployment.' });
  }

  const { mode = 'summarize', anomalies = [], campaigns = [] } = req.body || {};
  if (!PROMPTS[mode]) {
    return res.status(400).json({ ok: false, error: `Unknown mode "${mode}". Valid: ${Object.keys(PROMPTS).join(', ')}` });
  }

  const ctx    = buildContext(campaigns, anomalies);
  const prompt = PROMPTS[mode](ctx);

  // ── Stream response via SSE ──────────────────────────────────────────────
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const stream = client.messages.stream({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages:   [{ role: 'user', content: prompt }],
    });

    stream.on('text', (text) => {
      res.write(`data: ${JSON.stringify(text)}\n\n`);
    });

    await stream.finalMessage();
    res.write('data: [DONE]\n\n');
    res.end();

  } catch (err) {
    console.error('[/api/analyze]', err);
    res.write(`data: ${JSON.stringify('[Error: ' + err.message + ']')}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  }
};
