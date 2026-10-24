// Vercel function: request one live drill (POST /api/drill).
// Dispatches .github/workflows/drill-live.yml. Needs KAIZEN_DISPATCH_TOKEN
// (fine-grained PAT, this repo only, Actions: read & write) in the Vercel
// project env. Guarded: one drill at a time and at most one per 20 minutes.
const OWNER = 'Shaydez-Defi';
const REPO = 'kaizen';
const WF = 'drill-live.yml';
const COOLDOWN_MS = 20 * 60 * 1000;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ message: 'POST only' });
  const token = process.env.KAIZEN_DISPATCH_TOKEN;
  if (!token) return res.status(503).json({ message: 'On-demand drills are off here; scheduled drills run every 3 hours.' });
  const gh = (path, init = {}) =>
    fetch(`https://api.github.com/repos/${OWNER}/${REPO}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'kaizen-live', ...(init.headers || {}) },
    });
  const runs = await (await gh(`/actions/workflows/${WF}/runs?per_page=5`)).json();
  const list = runs.workflow_runs || [];
  if (list.some((r) => r.status !== 'completed')) return res.status(409).json({ message: 'A drill is already running. Watch it live.' });
  const last = list[0];
  if (last && Date.now() - Date.parse(last.created_at) < COOLDOWN_MS) {
    const mins = Math.ceil((COOLDOWN_MS - (Date.now() - Date.parse(last.created_at))) / 60000);
    return res.status(429).json({ message: `Last drill was moments ago. Next one available in ${mins} min.` });
  }
  const r = await gh(`/actions/workflows/${WF}/dispatches`, { method: 'POST', body: JSON.stringify({ ref: 'main', inputs: { requested_by: 'live page' } }) });
  if (r.status !== 204) return res.status(502).json({ message: `GitHub refused the dispatch (HTTP ${r.status}).` });
  return res.status(202).json({ message: 'Drill requested. It shows up as running in a few seconds.' });
}
