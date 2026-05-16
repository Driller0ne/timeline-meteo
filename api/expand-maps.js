// /api/expand-maps.js
//
// Vercel serverless function: espande short link di Google Maps in URL completi.
//
// v2.14 — Blocco 4:
//  - Gestione redirect via consent.google.com (caso EU): estrae il parametro
//    `continue=` per ottenere l'URL Maps reale.
//  - Aggiunto goo.gle alla whitelist short link.
//  - User-Agent realistico (in alcuni casi cambia il comportamento del redirect).
//  - Timeout 8s su ogni fetch (AbortController) per evitare function "appese".
//  - Loop redirect alzato da 5 a 8 (catene EU possono essere lunghe).
//  - Se il `continue=` punta a un nuovo short link, l'iterazione prosegue.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const SHORT_HOSTS = new Set(['maps.app.goo.gl', 'goo.gl', 'goo.gle']);
  const CONSENT_HOSTS = new Set(['consent.google.com', 'consent.youtube.com']);
  const FETCH_TIMEOUT_MS = 8000;
  const MAX_HOPS = 8;
  // UA realistico: alcuni redirect Google variano in base allo User-Agent.
  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
             'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

  // Estrae l'URL reale da un URL consent.google.com (parametro `continue`).
  function extractFromConsent(consentUrlStr) {
    try {
      const cu = new URL(consentUrlStr);
      if (!CONSENT_HOSTS.has(cu.hostname)) return null;
      const cont = cu.searchParams.get('continue');
      if (cont) return decodeURIComponent(cont);
    } catch {}
    return null;
  }

  // Fetch con timeout via AbortController.
  async function fetchWithTimeout(target, opts = {}) {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      return await fetch(target, { ...opts, signal: ctrl.signal });
    } finally {
      clearTimeout(tid);
    }
  }

  try {
    const u = String(req.query.u || '').trim();
    if (!u) return res.status(400).json({ ok: false, error: 'Missing u param' });

    let url;
    try { url = new URL(u); } catch { return res.status(400).json({ ok: false, error: 'Invalid URL' }); }

    if (!SHORT_HOSTS.has(url.hostname)) {
      return res.status(400).json({ ok: false, error: 'Host not allowed' });
    }

    // Caso speciale: link con parametro ?link= contiene direttamente l'URL espanso.
    const embedded = url.searchParams.get('link');
    if (embedded) {
      return res.status(200).json({ ok: true, url: decodeURIComponent(embedded) });
    }

    let current = url.toString();

    for (let i = 0; i < MAX_HOPS; i++) {
      let r;
      try {
        r = await fetchWithTimeout(current, {
          redirect: 'manual',
          headers: {
            'User-Agent': UA,
            'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
        });
      } catch (fetchErr) {
        return res.status(504).json({
          ok: false,
          error: `Fetch failed/timeout at hop ${i + 1}: ${fetchErr?.message || fetchErr}`,
        });
      }

      const loc = r.headers.get('location');
      const finalUrl = r.url;

      // CASO 1: redirect HTTP esplicito (Location header)
      if (loc) {
        try {
          current = new URL(loc, current).toString();
        } catch {
          return res.status(502).json({ ok: false, error: 'Invalid redirect URL' });
        }
        const host = (() => { try { return new URL(current).hostname; } catch { return ''; } })();

        // Arriviamo su consent.google.com? Estraiamo il continue=
        if (CONSENT_HOSTS.has(host)) {
          const real = extractFromConsent(current);
          if (real) {
            const realHost = (() => { try { return new URL(real).hostname; } catch { return ''; } })();
            // Se continue= è a sua volta short, prosegui il loop con quello.
            if (SHORT_HOSTS.has(realHost)) {
              current = real;
              continue;
            }
            // Altrimenti è già un URL Maps "lungo": ritornalo.
            return res.status(200).json({ ok: true, url: real });
          }
          // consent.google.com senza continue: impossibile risolvere.
          return res.status(502).json({
            ok: false,
            error: 'Stuck on consent.google.com without continue param',
          });
        }

        // Host non-short e non-consent: abbiamo finito.
        if (!SHORT_HOSTS.has(host)) {
          return res.status(200).json({ ok: true, url: current });
        }
        // Ancora short: continua l'iterazione.
        continue;
      }

      // CASO 2: nessun Location, ma fetch ha riportato un finalUrl diverso
      // (può capitare con redirect 'follow' o cache).
      if (finalUrl && finalUrl !== current) {
        const fHost = (() => { try { return new URL(finalUrl).hostname; } catch { return ''; } })();
        if (CONSENT_HOSTS.has(fHost)) {
          const real = extractFromConsent(finalUrl);
          if (real) return res.status(200).json({ ok: true, url: real });
        }
        if (!SHORT_HOSTS.has(fHost)) {
          return res.status(200).json({ ok: true, url: finalUrl });
        }
      }

      // Nessun Location, nessun cambio di URL: fine catena.
      break;
    }

    return res.status(502).json({
      ok: false,
      error: 'Could not expand (no redirect exposed after ' + MAX_HOPS + ' hops)',
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}
