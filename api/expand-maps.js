// /api/expand-maps.js
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const SHORT_HOSTS = new Set(['maps.app.goo.gl', 'goo.gl']);

  try {
    const u = String(req.query.u || '').trim();
    if (!u) return res.status(400).json({ ok: false, error: 'Missing u param' });

    let url;
    try { url = new URL(u); } catch { return res.status(400).json({ ok: false, error: 'Invalid URL' }); }

    if (!SHORT_HOSTS.has(url.hostname)) {
      return res.status(400).json({ ok: false, error: 'Host not allowed' });
    }

    const embedded = url.searchParams.get('link');
    if (embedded) {
      return res.status(200).json({ ok: true, url: decodeURIComponent(embedded) });
    }

    let current = url.toString();
    for (let i = 0; i < 5; i++) {
      const r = await fetch(current, { redirect: 'manual' });
      const loc = r.headers.get('location');
      const finalUrl = r.url;

      if (loc) {
        current = new URL(loc, current).toString();
        const host = new URL(current).hostname;
        if (!SHORT_HOSTS.has(host)) {
          return res.status(200).json({ ok: true, url: current });
        }
        continue;
      }

      if (finalUrl && !SHORT_HOSTS.has(new URL(finalUrl).hostname)) {
        return res.status(200).json({ ok: true, url: finalUrl });
      }

      break;
    }

    return res.status(502).json({ ok: false, error: 'Could not expand (no redirect exposed)' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}
