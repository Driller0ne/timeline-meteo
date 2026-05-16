// /api/expand-maps.js
//
// Vercel serverless function: espande short link di Google Maps in URL completi.
//
// v2.15 — Blocco 4, finale:
//  - Aggiunto fallback "headless renderer" (provider-agnostic) per i link
//    maps.app.goo.gl che Google serve come Firebase Dynamic Links page
//    (risoluzione client-side JS, impossibile via fetch standard).
//  - Provider attualmente supportato: ScrapingBee (variabile d'ambiente
//    SCRAPINGBEE_API_KEY su Vercel). Se la key non è configurata o i
//    credits sono esauriti, il proxy cade silenziosamente nei fallback
//    standard e ritorna il messaggio di errore "workaround manuale".
//  - Architettura: il provider è isolato in una funzione `tryHeadless()`,
//    facile da sostituire con Crawlbase, Browserless o self-hosted Puppeteer
//    in futuro senza toccare il resto del codice.
//
// v2.14b — Blocco 4, follow-up:
//  - Strategia ibrida: prima tenta redirect HTTP classico, poi se non c'è
//    Location header (Google a volte restituisce HTML con redirect JS),
//    legge il body HTML e cerca l'URL Maps in vari pattern (meta refresh,
//    canonical, og:url, script).
//  - Headers super-realistici (Sec-Fetch-*, Upgrade-Insecure-Requests).
//  - Debug info nel response in caso di fallimento, per troubleshooting rapido.

// ============================================================================
// CONFIGURAZIONE PROVIDER HEADLESS RENDERER
// ----------------------------------------------------------------------------
// Per cambiare provider in futuro (es. Crawlbase pay-as-you-go), sostituisci
// la funzione `tryHeadless()` più sotto con la nuova logica. Il resto del
// codice resta invariato.
//
// Variabili d'ambiente attese (impostare su Vercel → Settings → Env Vars):
//   SCRAPINGBEE_API_KEY = la chiave ottenuta da scrapingbee.com
//
// Se la variabile non è impostata, il fallback headless viene saltato
// silenziosamente (la function continua a fare il fallback HTTP normale).
// ============================================================================

// Vercel: chiediamo fino a 30s di esecuzione (il fallback ScrapingBee
// con JS rendering può richiedere 5-10s + il resto della logica).
// Hobby tier supporta fino a 60s con questa direttiva.
export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const SHORT_HOSTS = new Set(['maps.app.goo.gl', 'goo.gl', 'goo.gle']);
  const CONSENT_HOSTS = new Set(['consent.google.com', 'consent.youtube.com']);
  const FETCH_TIMEOUT_MS = 9000;
  const MAX_HOPS = 5;
  const MAX_HTML_BYTES = 80 * 1024; // leggiamo al massimo 80KB del body HTML

  // UA realistico (Safari macOS recente).
  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
             'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

  // Headers tipici di un browser reale che visita un link.
  const BROWSER_HEADERS = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
  };

  const debug = []; // log dei hop per troubleshooting

  function isMapsLikeUrl(s) {
    if (!s) return false;
    try {
      const parsed = new URL(s);
      const h = parsed.hostname;
      // Accetta www.google.com, google.com, maps.google.com, google.<tld>/maps
      return /(^|\.)google\.[a-z.]+$/i.test(h) && /\/maps(\/|$|\?)/.test(parsed.pathname + (parsed.search || ''));
    } catch { return false; }
  }

  function extractFromConsent(consentUrlStr) {
    try {
      const cu = new URL(consentUrlStr);
      if (!CONSENT_HOSTS.has(cu.hostname)) return null;
      const cont = cu.searchParams.get('continue');
      if (cont) return decodeURIComponent(cont);
    } catch {}
    return null;
  }

  // Decodifica entità HTML comuni
  function htmlDecode(s) {
    return String(s)
      .replace(/&amp;/g, '&')
      .replace(/&#x2F;/gi, '/')
      .replace(/&#47;/g, '/')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');
  }

  // Normalizza escape JS/JSON tipici nei body di Google
  // Esempi:
  //   "https:\u002f\u002fwww.google.com\u002fmaps\u002f..."   → "https://www.google.com/maps/..."
  //   "https:\/\/www.google.com\/maps\/..."                    → "https://www.google.com/maps/..."
  function normalizeJsEscapes(s) {
    return String(s)
      .replace(/\\u002[fF]/g, '/')   // unicode escape per "/"
      .replace(/\\\//g, '/')          // JSON escape per "/"
      .replace(/\\u003[aA]/g, ':');   // unicode escape per ":" (raro ma capita)
  }

  // Cerca un URL Google Maps in un body HTML, provando vari pattern.
  function extractMapsUrlFromHtml(html) {
    if (!html) return null;

    // Pre-processa: normalizza gli escape JS/Unicode comuni nei body Google,
    // così le regex "https://..." matchano anche quando l'HTML contiene
    // "https:\u002f\u002f..." o "https:\/\/...".
    const normalized = normalizeJsEscapes(html);

    const patterns = [
      // <meta http-equiv="refresh" content="0;url=...">
      /<meta\s+http-equiv=["']?refresh["']?[^>]*content=["'][^"']*?url=([^"'>\s]+)/i,
      // <link rel="canonical" href="...">
      /<link\s+rel=["']canonical["']\s+href=["']([^"']+)["']/i,
      // <meta property="og:url" content="...">
      /<meta\s+(?:property|name)=["']og:url["']\s+content=["']([^"']+)["']/i,
      // window.location.replace("...") oppure window.location = "..."
      /window\.location(?:\.href|\.replace)?\s*[=(]\s*["']([^"']+)["']/i,
      // location.replace("...") generico
      /location\.replace\(["']([^"']+)["']\)/i,
      // Anchor verso google.com/maps
      /href=["'](https?:\/\/(?:www\.|maps\.)?google\.[a-z.]+\/maps[^"'\s]*)["']/i,
      // URL in JSON/JS inline (catch-all "fuzzy")
      /(https?:\/\/(?:www\.|maps\.)?google\.[a-z.]+\/maps\/(?:place|dir|search)\/[^"'\s<>]+)/i,
    ];

    for (const re of patterns) {
      const m = normalized.match(re);
      if (m && m[1]) {
        const url = htmlDecode(m[1]);
        if (isMapsLikeUrl(url)) return url;
      }
    }
    return null;
  }

  async function fetchWithTimeout(target, opts = {}) {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      return await fetch(target, { ...opts, signal: ctrl.signal });
    } finally {
      clearTimeout(tid);
    }
  }

  // Legge body HTML limitando i byte letti
  async function readBodyLimited(response, maxBytes) {
    try {
      const reader = response.body?.getReader?.();
      if (!reader) {
        const txt = await response.text();
        return txt.slice(0, maxBytes);
      }
      const decoder = new TextDecoder('utf-8', { fatal: false });
      let read = 0;
      let out = '';
      while (read < maxBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        read += value.byteLength;
        out += decoder.decode(value, { stream: true });
      }
      try { await reader.cancel(); } catch {}
      return out;
    } catch {
      return '';
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

    const embedded = url.searchParams.get('link');
    if (embedded) {
      return res.status(200).json({ ok: true, url: decodeURIComponent(embedded), via: 'embedded-link' });
    }

    let current = url.toString();

    for (let i = 0; i < MAX_HOPS; i++) {
      const hopInfo = { i, url: current };

      // STAGE 1: prova con redirect manual (vede Location header)
      let r;
      try {
        r = await fetchWithTimeout(current, {
          redirect: 'manual',
          headers: BROWSER_HEADERS,
        });
      } catch (fetchErr) {
        hopInfo.error = `manual fetch failed: ${fetchErr?.message || fetchErr}`;
        debug.push(hopInfo);
        return res.status(504).json({
          ok: false,
          error: `Fetch timeout/failed at hop ${i + 1}`,
          debug,
        });
      }

      hopInfo.manualStatus = r.status;
      const loc = r.headers.get('location');
      hopInfo.location = loc;

      if (loc) {
        // Redirect HTTP classico
        try {
          current = new URL(loc, current).toString();
        } catch {
          debug.push(hopInfo);
          return res.status(502).json({ ok: false, error: 'Invalid redirect URL', debug });
        }
        const host = (() => { try { return new URL(current).hostname; } catch { return ''; } })();
        hopInfo.nextHost = host;
        debug.push(hopInfo);

        if (CONSENT_HOSTS.has(host)) {
          const real = extractFromConsent(current);
          if (real) {
            const realHost = (() => { try { return new URL(real).hostname; } catch { return ''; } })();
            if (SHORT_HOSTS.has(realHost)) {
              current = real;
              continue;
            }
            return res.status(200).json({ ok: true, url: real, via: 'consent-continue', debug });
          }
          return res.status(502).json({
            ok: false,
            error: 'Stuck on consent.google.com without continue param',
            debug,
          });
        }

        if (!SHORT_HOSTS.has(host)) {
          return res.status(200).json({ ok: true, url: current, via: 'http-redirect', debug });
        }
        // Ancora short → continua
        continue;
      }

      // STAGE 2: nessun Location. Forse pagina HTML con redirect JS.
      // Rifacciamo la fetch con redirect:'follow' per leggere il body finale.
      let r2;
      try {
        r2 = await fetchWithTimeout(current, {
          redirect: 'follow',
          headers: BROWSER_HEADERS,
        });
      } catch (fetchErr) {
        hopInfo.error = `follow fetch failed: ${fetchErr?.message || fetchErr}`;
        debug.push(hopInfo);
        return res.status(504).json({
          ok: false,
          error: `Body fetch failed at hop ${i + 1}`,
          debug,
        });
      }

      hopInfo.followStatus = r2.status;
      hopInfo.followFinalUrl = r2.url;

      // Se redirect:'follow' ci ha portato a un URL non-short, ottimo
      if (r2.url && r2.url !== current) {
        const fHost = (() => { try { return new URL(r2.url).hostname; } catch { return ''; } })();
        if (CONSENT_HOSTS.has(fHost)) {
          const real = extractFromConsent(r2.url);
          if (real) {
            debug.push(hopInfo);
            return res.status(200).json({ ok: true, url: real, via: 'follow-consent', debug });
          }
        }
        if (!SHORT_HOSTS.has(fHost)) {
          debug.push(hopInfo);
          return res.status(200).json({ ok: true, url: r2.url, via: 'follow-finalUrl', debug });
        }
      }

      // Ultima possibilità: parse del body HTML
      const html = await readBodyLimited(r2, MAX_HTML_BYTES);
      hopInfo.htmlBytes = html.length;
      const fromHtml = extractMapsUrlFromHtml(html);
      hopInfo.fromHtml = fromHtml;

      // Se non troviamo l'URL, includiamo nel debug alcune info per capire perché:
      // - un campione del body (primi 1.5KB del <head>, dove di solito ci sono meta/link)
      // - tutti gli URL "google.com/maps/..." trovati nel body (anche se nessuno è passato
      //   da isMapsLikeUrl per qualche motivo)
      if (!fromHtml && html) {
        const normalized = normalizeJsEscapes(html);
        // Sample del <head> se esiste, altrimenti i primi 1500 char
        const headMatch = normalized.match(/<head[^>]*>([\s\S]{0,3000})<\/head>/i);
        hopInfo.htmlHeadSample = (headMatch ? headMatch[1] : normalized.slice(0, 1500))
          .replace(/\s+/g, ' ')
          .slice(0, 1500);
        // Lista degli URL google trovati (qualsiasi)
        const allGoogleUrls = [...normalized.matchAll(
          /https?:\/\/(?:www\.|maps\.|consent\.)?google\.[a-z.]+\/[^\s"'<>]{0,200}/gi
        )].map(m => m[0]).slice(0, 10);
        hopInfo.googleUrlsFound = [...new Set(allGoogleUrls)];
      }

      debug.push(hopInfo);

      if (fromHtml) {
        const fhHost = (() => { try { return new URL(fromHtml).hostname; } catch { return ''; } })();
        if (CONSENT_HOSTS.has(fhHost)) {
          const real = extractFromConsent(fromHtml);
          if (real) return res.status(200).json({ ok: true, url: real, via: 'html-consent', debug });
        }
        return res.status(200).json({ ok: true, url: fromHtml, via: 'html-extracted', debug });
      }

      // Nessun progresso possibile con HTTP+HTML parsing.
      // Last resort: provider headless (ScrapingBee o equivalente).
      break;
    }

    // ===== FALLBACK FINALE: headless renderer =====
    // Se l'URL è ancora uno short link (= il loop non l'ha espanso),
    // proviamo con ScrapingBee. Se la chiave non è configurata o fallisce,
    // ritorniamo 502 col debug.
    const stillShort = (() => {
      try { return SHORT_HOSTS.has(new URL(current).hostname); }
      catch { return false; }
    })();

    if (stillShort) {
      const headlessResult = await tryHeadless(current, debug);
      if (headlessResult?.url) {
        let finalUrl = headlessResult.url;
        // Se anche l'headless ci dà un consent.google.com, estraiamo continue=
        try {
          const fh = new URL(finalUrl).hostname;
          if (CONSENT_HOSTS.has(fh)) {
            const real = extractFromConsent(finalUrl);
            if (real) finalUrl = real;
          }
        } catch {}
        return res.status(200).json({
          ok: true,
          url: finalUrl,
          via: headlessResult.via,
          debug,
        });
      }
    }

    return res.status(502).json({
      ok: false,
      error: 'Could not expand (no redirect, no HTML pattern, headless fallback unavailable or failed)',
      debug,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e), debug });
  }

  // ==========================================================================
  // tryHeadless(): provider-agnostic headless rendering.
  // Restituisce { url, via } se trova l'URL Maps, null altrimenti.
  // Provider corrente: ScrapingBee. Per cambiare provider in futuro,
  // sostituisci solo il corpo di questa funzione.
  // ==========================================================================
  async function tryHeadless(shortUrl, debugLog) {
    const SCRAPINGBEE_KEY = process.env.SCRAPINGBEE_API_KEY;
    const hopInfo = { i: 'headless', provider: 'scrapingbee', shortUrl };

    if (!SCRAPINGBEE_KEY) {
      hopInfo.skipped = 'no SCRAPINGBEE_API_KEY env var';
      debugLog.push(hopInfo);
      return null;
    }

    try {
      // Costruisco la richiesta a ScrapingBee
      const sbUrl = new URL('https://app.scrapingbee.com/api/v1/');
      sbUrl.searchParams.set('api_key', SCRAPINGBEE_KEY);
      sbUrl.searchParams.set('url', shortUrl);
      sbUrl.searchParams.set('render_js', 'true');
      // Aspetta 3.5s dopo il page load, per dare tempo al JS Firebase di
      // fare il suo redirect (di solito ~1-2s, ma diamo margine).
      sbUrl.searchParams.set('wait', '3500');
      // Blocca immagini/CSS per velocizzare il rendering (default è già true,
      // ma esplicitiamolo).
      sbUrl.searchParams.set('block_resources', 'true');
      // Restituisci HTML finale, non screenshot.
      sbUrl.searchParams.set('return_page_source', 'true');

      // Timeout interno: 12s (ScrapingBee ha sua propria timeout di rete)
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 12000);

      let sbResp;
      try {
        sbResp = await fetch(sbUrl.toString(), { signal: ctrl.signal });
      } finally {
        clearTimeout(tid);
      }

      hopInfo.scrapingBeeStatus = sbResp.status;

      // ScrapingBee espone l'URL finale (dopo redirect) nell'header Spb-resolved-url.
      const resolvedFromHeader = sbResp.headers.get('Spb-resolved-url') ||
                                  sbResp.headers.get('spb-resolved-url');
      hopInfo.resolvedHeader = resolvedFromHeader;

      // Caso 1: l'header dà già l'URL finale, e non è uno short
      if (resolvedFromHeader) {
        try {
          const rHost = new URL(resolvedFromHeader).hostname;
          if (!SHORT_HOSTS.has(rHost)) {
            debugLog.push(hopInfo);
            return { url: resolvedFromHeader, via: 'scrapingbee-header' };
          }
        } catch {}
      }

      // Caso 2: parse del body HTML (Google Maps web ha canonical + og:url)
      if (sbResp.ok) {
        const sbHtml = await sbResp.text();
        hopInfo.htmlBytes = sbHtml.length;
        const fromHtml = extractMapsUrlFromHtml(sbHtml);
        hopInfo.fromHtml = fromHtml;
        if (fromHtml) {
          debugLog.push(hopInfo);
          return { url: fromHtml, via: 'scrapingbee-html' };
        }
      } else {
        // Errore esplicito da ScrapingBee (es. 401 chiave invalida,
        // 402 no credits, 422 url invalido, 500 server error)
        try {
          const errText = await sbResp.text();
          hopInfo.scrapingBeeError = errText.slice(0, 500);
        } catch {}
      }

      debugLog.push(hopInfo);
      return null;
    } catch (e) {
      hopInfo.exception = e?.message || String(e);
      debugLog.push(hopInfo);
      return null;
    }
  }
}
