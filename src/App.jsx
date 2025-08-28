import React, { useMemo, useState } from "react";

/**
 * App: Timeline Meteo sul Percorso
 * Versione consolidata e funzionante, con helper unici (niente duplicati).
 */

export default function App() {
  const [gmapsUrl, setGmapsUrl] = useState("");
  const [travelMode, setTravelMode] = useState("motorcycle"); // motorcycle | driving | cycling | walking
  const [departLocal, setDepartLocal] = useState(() => new Date().toISOString().slice(0, 16));
  const [sampleKm, setSampleKm] = useState(0); // 0 = solo tappe; >0 = checkpoint ogni X km
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [resolvedUrl, setResolvedUrl] = useState("");

  // Preview parsing per feedback immediato (directions OR single place)
  const parsed = useMemo(() => {
    if (!resolvedUrl) return null;
    try {
      return { kind: "directions", ...parseGoogleMapsDirections(resolvedUrl) };
    } catch (e1) {
      try {
        return { kind: "place", ...parseGoogleMapsPlace(resolvedUrl) };
      } catch (e2) {
        return { error: (e1 && e1.message) || (e2 && e2.message) || "URL non riconosciuto" };
      }
    }
  }, [resolvedUrl]);

  async function onRun() {
    setError("");
    setResult(null);
    setResolvedUrl("");

    try {
      let urlToUse = gmapsUrl.trim();
      if (!urlToUse) throw new Error("Incolla un link di Google Maps (Indicazioni o Posizione singola).");

      // Espansione link corto, se necessario
      if (isShortGmaps(urlToUse)) {
        const exp = await expandShortMaps(urlToUse);
        if (exp) urlToUse = exp;
        else {
          setError("Questo è un link corto di Google Maps che non posso espandere automaticamente. Apri il link, tocca \"Apri in Google Maps\" e copia l'URL completo.");
          setLoading(false);
          return;
        }
      }
      setResolvedUrl(urlToUse);

      // Prova a interpretare come DIRECTIONS, altrimenti come PLACE
      let parsedNow;
      try {
        parsedNow = { kind: "directions", ...parseGoogleMapsDirections(urlToUse) };
      } catch {
        parsedNow = { kind: "place", ...parseGoogleMapsPlace(urlToUse) };
      }

      const departure = new Date(departLocal);
      if (isNaN(+departure)) throw new Error("Data/ora di partenza non valida");

      const profile = travelMode; // per UI
      const nameCache = new Map();

      if (parsedNow.kind === "place") {
        // === Caso POSIZIONE SINGOLA: niente routing, 1 solo punto ===
        const place = await ensureCoords(parsedNow.place);
        // Finestra meteo stretta (±12h come già fai)
        const meteo = await fetchWeatherForWindow(place.lat, place.lon, departure, departure);
        const weather = pickHourlyForDate(meteo, departure);

        // Reverse per nome/prov se non già presenti
        if (!place.name || !place.prov) {
          try {
            const info = await reverseName(place.lat, place.lon);
            if (info?.name) place.name = info.name;
            if (info?.prov) place.prov = info.prov;
          } catch {}
        }

        setResult({
          summary: { distance: 0, duration: 0, legs: 0 },
          schedule: [{ type: "point", place, at: departure, legInfo: null, km: 0, weather }],
          profile,
        });
        return;
      }

      // === Caso INDICAZIONI: flusso originale invariato ===
      const places = await Promise.all(parsedNow.places.map((p) => ensureCoords(p)));

      // Routing OSRM (alias: "motorcycle" => driving)
      const osrmProfile = travelMode === "motorcycle" ? "driving" : travelMode;
      const coordsPath = places.map((p) => `${p.lon},${p.lat}`).join(";");
      const osrmUrl = `https://router.project-osrm.org/route/v1/${osrmProfile}/${coordsPath}?overview=full&geometries=geojson&steps=false&annotations=distance,duration`;

      setLoading(true);
      const routeResp = await fetch(osrmUrl);
      if (!routeResp.ok) throw new Error("Errore routing OSRM");
      const routeJson = await routeResp.json();
      const route = routeJson.routes?.[0];
      if (!route) throw new Error("Percorso non trovato");

      // Timeline (start + fine di ogni leg)
      let t = new Date(departure);
      let cumKm = 0;
      const waypointsSchedule = [{ type: "start", place: places[0], at: new Date(t), legInfo: null, km: 0 }];
      for (let i = 0; i < route.legs.length; i++) {
        const leg = route.legs[i];
        const to = places[i + 1];
        t = new Date(t.getTime() + leg.duration * 1000);
        cumKm += (leg.distance || 0) / 1000;
        waypointsSchedule.push({
          type: "legEnd",
          place: to,
          at: new Date(t),
          legInfo: { distance: leg.distance, duration: leg.duration },
          km: cumKm,
        });
      }

      // Checkpoint (opzionali)
      const samples = generateRouteSamples(
        route.geometry?.coordinates,
        route.distance,
        route.duration,
        departure,
        sampleKm
      );

      const allPoints = [...waypointsSchedule, ...samples];

      // Reverse name per i soli checkpoint senza nome
      for (const wp of allPoints) {
        if (wp.type === "sample" && (!wp.place?.name || String(wp.place.name).startsWith("~km"))) {
          const nk = `${wp.place.lat.toFixed(3)},${wp.place.lon.toFixed(3)}`;
          const cached = nameCache.get(nk);
          if (cached) {
            if (cached.name) wp.place.name = cached.name;
            if (cached.prov) wp.place.prov = cached.prov;
          } else {
            try {
              const info = await reverseName(wp.place.lat, wp.place.lon);
              nameCache.set(nk, info);
              if (info?.name) wp.place.name = info.name;
              if (info?.prov) wp.place.prov = info.prov;
            } catch {}
          }
        }
      }

      // Meteo finestra comune
      const startAt = new Date(waypointsSchedule[0].at);
      const endAt = new Date(waypointsSchedule[waypointsSchedule.length - 1].at);
      const weatherByKey = new Map();
      for (const wp of allPoints) {
        const key = `${wp.place.lat.toFixed(3)},${wp.place.lon.toFixed(3)}`;
        if (weatherByKey.has(key)) continue;
        const meteo = await fetchWeatherForWindow(wp.place.lat, wp.place.lon, startAt, endAt);
        weatherByKey.set(key, meteo);
      }

      const enriched = allPoints
        .map((wp) => {
          const key = `${wp.place.lat.toFixed(3)},${wp.place.lon.toFixed(3)}`;
          const met = pickHourlyForDate(weatherByKey.get(key), wp.at);
          return { ...wp, weather: met };
        })
        .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

      setResult({
        summary: { distance: route.distance, duration: route.duration, legs: route.legs.length },
        schedule: enriched,
        profile,
      });
    } catch (e) {
      setError((e && e.message) || String(e));
    } finally {
      setLoading(false);
    }
  }
// ——— Parsing Google Maps: POSIZIONE SINGOLA ———
// Supporta vari formati: /maps/place/..., /maps/search/?q=..., /maps/@lat,lon,zoom, o query 'q=lat,lon'
function parseGoogleMapsPlace(urlStr) {
  let url; try { url = new URL(urlStr); } catch { throw new Error("URL non valido"); }
  if (url.hostname === "maps.app.goo.gl") throw new Error("Link corto: verrà espanso");

  // 1) /maps/place/NAME/... oppure /maps/search/...
  if (url.pathname.startsWith("/maps/place/") || url.pathname.startsWith("/maps/search/")) {
    const segs = url.pathname.split("/").filter(Boolean);
    // prova a prendere il segmento dopo 'place' o 'search' come nome
    const idx = segs.findIndex(s => s === "place" || s === "search");
    let placeName = segs[idx + 1] ? decodeURIComponent(segs[idx + 1]) : null;

    // se presente "@lat,lon," nel path, usalo
    const at = url.pathname.match(/@(-?\d+(\.\d+)?),(-?\d+(\.\d+)?),/);
    if (at) {
      const lat = parseFloat(at[1]);
      const lon = parseFloat(at[3]);
      return { place: { raw: placeName || `${lat},${lon}` } };
    }

    // se c'è ?q=lat,lon o ?q=Nome, usa quello
    const q = url.searchParams.get("q");
    if (q) return { place: { raw: decodeURIComponent(q) } };

    if (placeName) return { place: { raw: placeName } };
  }

  // 2) /maps/@lat,lon,zoom
  const at = url.pathname.match(/\/@(-?\d+(\.\d+)?),(-?\d+(\.\d+)?),/);
  if (at) {
    const lat = parseFloat(at[1]);
    const lon = parseFloat(at[3]);
    return { place: { raw: `${lat},${lon}` } };
  }

  // 3) ?q=lat,lon oppure ?q=Nome
  const q = url.searchParams.get("q");
  if (q) return { place: { raw: decodeURIComponent(q) } };

  throw new Error("Questo link non contiene una posizione riconoscibile");
}

  return (
    <div className="min-h-screen bg-neutral-900 text-gray-100 p-6">
      <div className="max-w-3xl mx-auto">
        <header className="mb-6">
<h1 className="w-full text-center font-extrabold tracking-tight">
  <span className="block text-6xl sm:text-7xl text-orange-500 uppercase leading-none">
    RIDEMAPP
  </span>
  <span className="block text-3xl sm:text-4xl text-gray-100 uppercase leading-tight">
    TIMELINE METEO
  </span>
  <span className="block text-3xl sm:text-4xl text-gray-100 uppercase leading-tight">
    SUL PERCORSO
  </span>
</h1>
          <p className="text-sm text-gray-600 mt-2">Incolla un link di <strong>Indicazioni Google Maps</strong>, scegli data/ora e (opzionale) checkpoint ogni X km.</p>
        </header>

        <div className="bg-neutral-800 rounded-2xl shadow p-4 space-y-4">
          <label className="block">
            <span className="text-sm font-medium">Link Google Maps – Indicazioni</span>
            <input
              className="mt-1 w-full rounded-xl border border-gray-600 bg-neutral-700 text-gray-100 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-orange-500"
              placeholder="https://www.google.com/maps/dir/?api=1&origin=...&destination=..."
              value={gmapsUrl}
              onChange={(e) => setGmapsUrl(e.target.value)}
            />
          </label>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <label className="block">
              <span className="text-sm font-medium">Modalità</span>
              <select
                className="mt-1 w-full rounded-xl border border-gray-600 bg-neutral-700 text-gray-100 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-orange-500"
                value={travelMode}
                onChange={(e) => setTravelMode(e.target.value)}
              >
                <option value="motorcycle">Moto</option>
                <option value="driving">Auto</option>
                <option value="cycling">Bici</option>
                <option value="walking">Piedi</option>
              </select>
            </label>
            <label className="block">
              <span className="text-sm font-medium">Checkpoint ogni</span>
              <select
                className="mt-1 w-full rounded-xl border border-gray-600 bg-neutral-700 text-gray-100 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-orange-500"
                value={String(sampleKm)}
                onChange={(e) => setSampleKm(parseInt(e.target.value, 10))}
              >
                <option value="0">Solo tappe</option>
                <option value="10">10 km</option>
                <option value="20">20 km</option>
                <option value="30">30 km</option>
                <option value="50">50 km</option>
              </select>
            </label>
            <label className="block">
              <span className="text-sm font-medium">Partenza</span>
<input
  type="datetime-local"
  className="mt-1 w-full rounded-xl border border-gray-600 bg-neutral-700 text-gray-100 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-orange-500 [&::-webkit-calendar-picker-indicator]:invert [&::-webkit-calendar-picker-indicator]:opacity-80"
  value={departLocal}
  onChange={(e) => setDepartLocal(e.target.value)}
/>
            </label>
          </div>

          <div className="flex gap-3 items-center">
            <button
              onClick={onRun}
              disabled={loading || !gmapsUrl.trim()}
              className="w-full rounded-xl bg-orange-500 hover:bg-orange-500 text-gray-100 py-3 font-extrabold uppercase tracking-wide text-center shadow disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {loading ? "Calcolo…" : "Calcola timeline meteo"}
            </button>
            {parsed?.error && <span className="text-sm text-amber-600">{parsed.error}</span>}
          </div>

          {error && (
            <div className="rounded-xl bg-red-50 border border-red-200 p-3 text-sm text-red-700">
              {error}
            </div>
          )}
        </div>

        {result && <ResultView data={result} />}

        {/* Pannello test (dev) */}

      </div>
    </div>
  );
}


// === Tests Panel ===
function TestsPanel({ onPick }) {
  const examples = [
    { label: "Milano → Torino (auto)", url: "https://www.google.com/maps/dir/?api=1&origin=Milano&destination=Torino&travelmode=driving" },
    { label: "Roma → Napoli (auto, via Cassino)", url: "https://www.google.com/maps/dir/?api=1&origin=Roma&destination=Napoli&waypoints=Cassino&travelmode=driving" },
    { label: "Bologna → Firenze (bici)", url: "https://www.google.com/maps/dir/?api=1&origin=Bologna&destination=Firenze&travelmode=cycling" },
    { label: "Coord: Milano → Torino", url: "https://www.google.com/maps/dir/?api=1&origin=45.4642,9.1900&destination=45.0703,7.6869&travelmode=driving" },
  ];
  return (
    <div className="mt-6 bg-white border rounded p-3 space-y-2">
      <h3 className="font-semibold">Esempi rapidi</h3>
      {examples.map((ex, i) => (
        <button
          key={i}
          className="block text-left underline text-blue-600 hover:text-blue-800"
          onClick={() => onPick(ex.url)}
        >
          {ex.label}
        </button>
      ))}
    </div>
  );
}

// ——— Parser & URL helpers ———
function isShortGmaps(urlStr) {
  try {
    const u = new URL(urlStr);
    // Short link mobile
    if (u.hostname === "maps.app.goo.gl") return true;
    // Forma vecchia: goo.gl/maps/...
    if (u.hostname === "goo.gl" && u.pathname.startsWith("/maps")) return true;
    return false;
  } catch {
    return false;
  }
}


async function expandShortMaps(shortUrl) {
  try {
    // 0) Tentativo via proxy serverless
    const PROXY_PATH = "/api/expand-maps"; // Netlify: "/.netlify/functions/expand-maps"
    try {
      const proxyResp = await fetch(`${PROXY_PATH}?u=${encodeURIComponent(shortUrl)}`);
      if (proxyResp.ok) {
        const data = await proxyResp.json();
        if (data?.ok && data?.url && !isShortGmaps(data.url)) return data.url;
      }
    } catch {}

    // 1) Parse locale dell’URL (per eventuale ?link=<encoded>)
    const u = new URL(shortUrl);
    const embedded = u.searchParams.get("link");
    if (embedded) return decodeURIComponent(embedded);

    // 2) Fallback: prova a seguire i redirect (spesso bloccato da CORS)
    const resp = await fetch(shortUrl, { redirect: "follow" });
    if (resp?.url && !isShortGmaps(resp.url)) return resp.url;
    const location = resp.headers?.get?.("Location");
    if (location && !isShortGmaps(location)) return location;
  } catch {}
  // Se non si riesce, lascia che il chiamante gestisca la UX
  return null;
}

function normalizeRaw(s) { return String(s).replace(/\+/g, " ").replace(/\s+/g, " ").trim(); }

function parseGoogleMapsDirections(urlStr) {
  let url; try { url = new URL(urlStr); } catch { throw new Error("URL non valido"); }
  const places = []; let travelMode = null;
  if (url.hostname === "maps.app.goo.gl") throw new Error("Link corto: verrà espanso");
  const sp = url.searchParams;
  if (sp.get("api") === "1" && (url.pathname.startsWith("/maps") || url.pathname.startsWith("/dir") || url.pathname.startsWith("/maps/dir"))) {
    const o = sp.get("origin"), d = sp.get("destination"), w = sp.get("waypoints");
    travelMode = sp.get("travelmode");
    if (!o || !d) throw new Error("Nel link mancano origin/destination");
    places.push({ raw: normalizeRaw(decodeURIComponent(o)) });
    if (w) w.split("|").forEach((x) => places.push({ raw: normalizeRaw(decodeURIComponent(x)) }));
    places.push({ raw: normalizeRaw(decodeURIComponent(d)) });
    return { places, travelMode };
  }
  if (url.pathname.startsWith("/maps/dir/")) {
    const segs = url.pathname.split("/").filter(Boolean); const dirIdx = segs.indexOf("dir");
    const after = segs.slice(dirIdx + 1);
    for (const s of after) { if (s.startsWith("@")) break; if (s.includes(":")) continue; places.push({ raw: normalizeRaw(decodeURIComponent(s)) }); }
    if (places.length < 2) throw new Error("Impossibile determinare orig/dest");
    travelMode = sp.get("travelmode");
    return { places, travelMode };
  }
  throw new Error("Questo non sembra un link di Indicazioni Google Maps");
}

// ——— Geocoding & Meteo ———
function looksLikeLatLon(raw) {
  const parts = String(raw).split(",");
  if (parts.length !== 2) return false;
  const lat = parseFloat(parts[0]);
  const lon = parseFloat(parts[1]);
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

async function geocodeOpenMeteo(q) {
  const name = normalizeRaw(String(q));
  // 1) Open‑Meteo
  try {
    const u = new URL("https://geocoding-api.open-meteo.com/v1/search");
    u.searchParams.set("name", name);
    u.searchParams.set("count", "1");
    u.searchParams.set("language", "it");
    u.searchParams.set("format", "json");
    const r = await fetch(u.toString());
    if (r.ok) {
      const j = await r.json();
      const hit = j.results?.[0];
      if (hit) return { name: hit.name, lat: hit.latitude, lon: hit.longitude };
    }
  } catch {}
  // 2) Nominatim (fallback)
  try {
    const u = new URL("https://nominatim.openstreetmap.org/search");
    u.searchParams.set("format", "jsonv2");
    u.searchParams.set("limit", "1");
    u.searchParams.set("q", name);
    const r = await fetch(u.toString(), { headers: { "Accept-Language": "it" } });
    if (r.ok) {
      const j = await r.json();
      const hit = j?.[0];
      if (hit) {
  const lat = parseFloat(hit.lat);
  const lon = parseFloat(hit.lon);
  // Reverse per ottenere Località + Provincia (sigla)
  const info = await reverseName(lat, lon);
  const name = info?.name || hit.name || hit.display_name;
  const prov = info?.prov || null;
  return { name, prov, lat, lon };
}
    }
  } catch {}
  return null;
}

async function ensureCoords(place) {
  const raw = normalizeRaw(String(place.raw));
  if (looksLikeLatLon(raw)) {
    const [latStr, lonStr] = raw.split(",").map((s) => s.trim());
    return { ...place, lat: parseFloat(latStr), lon: parseFloat(lonStr) };
  }
  const g = await geocodeOpenMeteo(raw);
  if (!g) throw new Error(`Geocoding fallito per: ${raw}`);
  return { ...place, name: g.name, prov: g.prov ?? place.prov ?? null, lat: g.lat, lon: g.lon };

}

async function reverseName(lat, lon) {
  try {
    const u = new URL("https://nominatim.openstreetmap.org/reverse");
    u.searchParams.set("format", "jsonv2");
    u.searchParams.set("lat", String(lat));
    u.searchParams.set("lon", String(lon));
    u.searchParams.set("zoom", "10");
    u.searchParams.set("addressdetails", "1");
    const r = await fetch(u.toString(), { headers: { "Accept-Language": "it" } });
    if (!r.ok) return null;
    const j = await r.json();
    return extractCityProv(j);
  } catch {
    return null;
  }
}
function extractCityProv(nominatimReverseJson) {
  const a = nominatimReverseJson?.address || {};
  // Località sintetica
  const city = a.village || a.town || a.city || a.hamlet || a.suburb || a.municipality || a.county || a.state_district || a.state;
  // Provincia (nome lungo, da mappare a sigla): spesso "county" o "state_district"
  const provName =
    a.county ||
    a.state_district ||
    a.province || // in rari casi esiste
    null;
  const prov = toProvCode(provName);
  return { name: city || null, prov };
}

function toProvCode(name) {
  if (!name) return null;
  const n = String(name).toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");

  // Dizionario minimo + alias comuni; espandibile a piacere
  const map = {
    "agrigento": "AG", "alessandria": "AL", "ancona": "AN", "aosta": "AO", "aosta valley": "AO",
    "arezzo": "AR", "ascoli piceno": "AP", "asti": "AT", "avellino": "AV",
    "bari": "BA", "barletta-andria-trani": "BT", "barletta andria trani": "BT", "belluno": "BL",
    "benevento": "BN", "bergamo": "BG", "biella": "BI", "bologna": "BO",
    "bolzano": "BZ", "alto adige": "BZ", "south tyrol": "BZ",
    "brescia": "BS", "brindisi": "BR", "cagliari": "CA", "caltanissetta": "CL", "campobasso": "CB",
    "caserta": "CE", "catania": "CT", "catanzaro": "CZ", "chieti": "CH", "como": "CO", "cosenza": "CS",
    "cremona": "CR", "crotone": "KR", "cuneo": "CN",
    "enna": "EN", "fermo": "FM", "ferrara": "FE", "firenze": "FI", "florence": "FI",
    "foggia": "FG", "forli-cesena": "FC", "forli cesena": "FC", "frosinone": "FR",
    "genova": "GE", "la spezia": "SP", "gorizia": "GO", "grosseto": "GR",
    "imperia": "IM", "isernia": "IS", "l'aquila": "AQ", "laquila": "AQ", "laquila province": "AQ",
    "latina": "LT", "lecce": "LE", "lecco": "LC", "livorno": "LI", "lodi": "LO", "lucca": "LU",
    "macerata": "MC", "mantova": "MN", "massa-carrara": "MS", "massa carrara": "MS",
    "matera": "MT", "messina": "ME", "milano": "MI", "modena": "MO", "monza e della brianza": "MB",
    "napoli": "NA", "novara": "NO", "nuoro": "NU", "oristano": "OR", "padova": "PD", "palermo": "PA",
    "parma": "PR", "pavia": "PV", "perugia": "PG", "pescara": "PE", "piacenza": "PC", "pisa": "PI",
    "pistoia": "PT", "pordenone": "PN", "potenza": "PZ", "prato": "PO", "rafa": "RA", // Ravenna alias safe
    "ragusa": "RG", "ravenna": "RA", "reggio calabria": "RC", "reggio nell'emilia": "RE", "reggio emilia": "RE",
    "rieti": "RI", "rimini": "RN", "roma": "RM", "rome": "RM", "rovigo": "RO",
    "salerno": "SA", "sassari": "SS", "savona": "SV", "siena": "SI", "siracusa": "SR", "sondrio": "SO",
    "sud sardegna": "SU", "taranto": "TA", "tempio pausania-olbia": "OT", "teramo": "TE", "terni": "TR",
    "torino": "TO", "trapani": "TP", "trento": "TN", "treviso": "TV", "trieste": "TS",
    "udine": "UD", "varese": "VA", "venezia": "VE", "verbania": "VB", "verbano-cusio-ossola": "VB",
    "verona": "VR", "vibo valentia": "VV", "vicenza": "VI", "viterbo": "VT",
    // Sigle già in forma "provincia di XX"
    "provincia di trento": "TN", "provincia autonoma di bolzano": "BZ", "provincia autonoma di trento": "TN",
  };

  // Pulizia comune tipo "Provincia di XXX", "Città metropolitana di XXX"
  const cleaned = n
    .replace(/^provincia (autonoma )?di\s+/i, "")
    .replace(/^citta metropolitana di\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();

  return map[cleaned] || null;
}

async function fetchWeatherForWindow(lat, lon, start, end) {
  const startDate = toISODate(new Date(start.getTime() - 12 * 3600 * 1000));
  const endDate = toISODate(new Date(end.getTime() + 12 * 3600 * 1000));
  const u = new URL("https://api.open-meteo.com/v1/forecast");
  u.searchParams.set("latitude", String(lat)); u.searchParams.set("longitude", String(lon));
  u.searchParams.set("hourly", "temperature_2m,precipitation,weathercode,wind_speed_10m");
  u.searchParams.set("start_date", startDate); u.searchParams.set("end_date", endDate); u.searchParams.set("timezone", "auto");
  const r = await fetch(u.toString()); if (!r.ok) throw new Error("Errore richiesta meteo");
  return await r.json();
}

function pickHourlyForDate(weather, date) {
  if (!weather?.hourly?.time?.length) return null;
  const times = weather.hourly.time.map((t) => new Date(t).getTime());
  const target = new Date(date).getTime();
  let best = 0, bestDiff = Infinity;
  for (let i = 0; i < times.length; i++) {
    const d = Math.abs(times[i] - target);
    if (d < bestDiff) { best = i; bestDiff = d; }
  }
  const h = weather.hourly;
  return {
    time: new Date(h.time[best]),
    temperature_2m: h.temperature_2m[best],
    precipitation: h.precipitation[best],
    weathercode: h.weathercode[best],
    wind_speed_10m: h.wind_speed_10m[best],
  };
}

function toISODate(d) { const y = d.getFullYear(); const m = String(d.getMonth() + 1).padStart(2, "0"); const day = String(d.getDate()).padStart(2, "0"); return `${y}-${m}-${day}`; }

// ——— Campionamento lungo percorso ———
function haversineMeters(lat1, lon1, lat2, lon2) { const R = 6371000; const toRad = (x) => (x * Math.PI) / 180; const dLat = toRad(lat2 - lat1); const dLon = toRad(lon2 - lon1); const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2; const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)); return R * c; }
function cumulativeDistances(coords) { const cum = [0]; for (let i = 1; i < coords.length; i++) { const [lon1, lat1] = coords[i - 1]; const [lon2, lat2] = coords[i]; cum.push(cum[cum.length - 1] + haversineMeters(lat1, lon1, lat2, lon2)); } return cum; }
function interpolatePoint(p1, p2, t) { const [lon1, lat1] = p1; const [lon2, lat2] = p2; return [lon1 + (lon2 - lon1) * t, lat1 + (lat2 - lat1) * t]; }
function pointAtDistance(coords, cum, target) { let i = 1; while (i < cum.length && cum[i] < target) i++; if (i >= cum.length) return coords[coords.length - 1]; const prev = i - 1; const segLen = cum[i] - cum[prev]; const tt = segLen > 0 ? (target - cum[prev]) / segLen : 0; return interpolatePoint(coords[prev], coords[i], Math.max(0, Math.min(1, tt))); }
function generateRouteSamples(coords, totalDistance, totalDuration, departDate, stepKm) { const step = (parseFloat(stepKm) || 0) * 1000; if (!coords || coords.length < 2 || !step) return []; const cum = cumulativeDistances(coords); const out = []; for (let d = step; d < totalDistance; d += step) { const [lon, lat] = pointAtDistance(coords, cum, d); const frac = d / totalDistance; const eta = new Date(departDate.getTime() + frac * totalDuration * 1000); out.push({ type: "sample", place: { lat, lon, name: `~km ${Math.round(d / 1000)}` }, at: eta, legInfo: null, km: d / 1000 }); } return out; }

// Helpers minimi
function formatDuration(seconds) { seconds = Math.round(seconds || 0); const h = Math.floor(seconds / 3600); const m = Math.round((seconds % 3600) / 60); if (h <= 0) return `${m} min`; return `${h} h ${m.toString().padStart(2, "0")} min`; }
function formatPlaceLabel(p) { if (p?.name) return p.name; if (typeof p?.lat === "number" && typeof p?.lon === "number") return `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`; return String(p?.raw || ""); }

// ——— UI risultato ———
function ResultView({ data }) {
  const totalKm = (data.summary.distance / 1000).toFixed(1);
  const totalDur = formatDuration(data.summary.duration);
  return (
    <div className="mt-6">
<div className="bg-neutral-800 rounded-2xl shadow p-4 mb-4">
  <h2 className="text-xl font-semibold text-orange-500">Riepilogo</h2>
  <p className="text-sm text-gray-100 mt-1">
    Profilo: <span className="font-mono">{data.profile}</span> · Totale: {totalKm} km · {totalDur}
  </p>
</div>
      <div className="space-y-4">
        {data.schedule.map((wp, idx) => (
          <ResultRow key={idx} wp={wp} idx={idx} total={data.schedule.length} />
        ))}
      </div>
    </div>
  );
}

function ResultRow({ wp, idx, total }) {
  // Ora
  const dt = new Date(wp.at);
  const hhmm = `${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}`;

  // Km cumulati
  const kmFromStart = Math.round(wp.km || 0);
  const kmLabel = `${kmFromStart} km`;

  // Località + provincia
  const titleBase = formatPlaceLabel(wp.place);
  const title = wp?.place?.prov ? `${titleBase}, ${wp.place.prov}` : titleBase;

  // Meteo: descrizione, temperatura, icona, vento, pioggia
  const W = wp.weather;
  const meteoText = W ? weatherCodeToText(W.weathercode) : "";
  const temp = W ? Math.round(W.temperature_2m) : null;
  const icon = W ? weatherCodeToIcon(W.weathercode) : "—";
  const windTxt = formatWindSubtitle(wp);            // es. "18 km/h"
  const rainMm = W && Number.isFinite(W.precipitation) ? `${(+W.precipitation).toFixed(1)} mm` : ""; // mm previsti

  return (
    <div className="relative bg-neutral-800 rounded-2xl shadow px-4 py-3 overflow-hidden">
      {/* 
        Desktop (>= md): 6 colonne in una riga con proporzioni ~ [1/10, 1/10, 5/10, 1/10, 1/10, 1/10]
          1) Ora
          2) Km
          3) Località (sopra) + Descrizione meteo (sotto)
          4) Temperatura
          5) Icona meteo
          6) Pioggia (sopra) + Vento (sotto)
        Mobile (< md): 4 blocchi orizzontali ~ [1/6, 3/6, 1/6, 1/6], ciascuno impilato (top/bottom)
          [Ora/Km]  [Località/Descrizione]  [Temperatura/Vento]  [Icona/Pioggia]
      */}
      <div
        className="
          grid items-center gap-3 md:gap-x-2
          grid-cols-[1fr_3fr_1fr_1fr]
          md:grid-cols-[1fr_1fr_4.6fr_1.2fr_0.8fr_1.4fr] /* fr => non sfora col gap; stesse proporzioni */
        "
      >
        {/* MOBILE: blocco 1 (Ora sopra, Km sotto) | DESKTOP: colonna 1 = Ora, colonna 2 = Km */}
        <div className="flex flex-col md:hidden">
          <div className="text-lg font-mono tabular-nums text-gray-200">{hhmm}</div>
          <div className="text-sm font-mono tabular-nums text-gray-400">{kmLabel}</div>
        </div>
        <div className="hidden md:block text-lg font-mono tabular-nums text-gray-200">{hhmm}</div>
        <div className="hidden md:block text-lg font-mono tabular-nums text-gray-400">{kmLabel}</div>

        {/* MOBILE: blocco 2 (Località sopra, Descrizione sotto) | DESKTOP: colonna 3 stack (overflow protetto) */}
        <div className="overflow-hidden md:min-w-0">
          <div className="text-lg sm:text-xl font-semibold truncate text-gray-100">{title}</div>
          <div className="text-xs text-gray-300 truncate">{meteoText}</div>
        </div>

        {/* MOBILE: blocco 3 (Temperatura sopra, Vento sotto) | DESKTOP: colonna 4 = Temp */}
        <div className="flex flex-col md:hidden items-end">
          <div className="text-2xl font-bold">{temp !== null ? `${temp}°` : ""}</div>
          <div className="text-xs text-gray-400">{windTxt}</div>
        </div>
        <div className="hidden md:block text-3xl font-bold text-right">{temp !== null ? `${temp}°` : ""}</div>

        {/* MOBILE: blocco 4 (Icona sopra, Pioggia mm sotto) | DESKTOP: colonna 5 = Icona, colonna 6 = Pioggia/Vento stack */}
        <div className="flex flex-col md:hidden items-end">
          <div className="text-2xl" aria-hidden="true">{icon}</div>
          <div className="text-xs text-gray-300">{rainMm}</div>
        </div>

        {/* Desktop: colonna 5 = icona */}
        <div className="hidden md:block text-2xl text-right" aria-hidden="true">{icon}</div>

        {/* Desktop: colonna 6 = Pioggia sopra + Vento sotto (più compatta, no overflow) */}
        <div className="hidden md:flex md:flex-col md:items-end overflow-hidden md:min-w-0 max-w-[7rem] md:pr-1">
          <div className="text-sm text-gray-300 truncate">{rainMm}</div>
          <div className="text-xs text-gray-400 truncate">{windTxt}</div>
        </div>
      </div>
    </div>
  );
}

function formatWindSubtitle(wp) {
  const W = wp.weather;
  if (!W) return "";
  const ws = Math.round(W.wind_speed_10m || 0);
  return `${ws} km/h`;
}
function weatherCodeToIcon(code) {
  // Set minimale di pittogrammi/emoji coerenti col testo
  if (code === 0) return "☀️";
  if ([1, 2, 3].includes(code)) return "⛅";
  if ([45, 48].includes(code)) return "🌫️";
  if ([51, 53, 55, 61, 63, 65, 80, 81, 82].includes(code)) return "🌧️";
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "❄️";
  if ([95, 96, 99].includes(code)) return "⛈️";
  return "🌡️";
}

function weatherCodeToText(code) { const map = { 0: "Sereno", 1: "Prevalentemente sereno", 2: "Parzialmente nuvoloso", 3: "Coperto", 45: "Nebbia", 48: "Nebbia con brina", 51: "Pioviggine leggera", 53: "Pioviggine", 55: "Pioviggine intensa", 56: "Pioggia gelata leggera", 57: "Pioggia gelata", 61: "Pioggia debole", 63: "Pioggia", 65: "Pioggia forte", 66: "Rovescio gelato leggero", 67: "Rovescio gelato", 71: "Neve debole", 73: "Neve", 75: "Neve forte", 77: "Granelli di neve", 80: "Rovesci leggeri", 81: "Rovesci", 82: "Rovesci intensi", 85: "Rovesci di neve leggeri", 86: "Rovesci di neve intensi", 95: "Temporale", 96: "Temporale con grandine", 99: "Temporale con grandine forte" }; return map?.[code] ?? `Codice meteo ${code}`; }

// ——— Dev tests (semplici, senza rete) ———
function DevTests() {
  const tests = useMemo(() => {
    const cases = [];
    // isShortGmaps
    cases.push({ name: 'isShortGmaps maps.app.goo.gl', pass: isShortGmaps('https://maps.app.goo.gl/abc') === true });
    cases.push({ name: 'isShortGmaps goo.gl/maps', pass: isShortGmaps('https://goo.gl/maps/abcd') === true });
    cases.push({ name: 'isShortGmaps google.com/maps (no short)', pass: isShortGmaps('https://www.google.com/maps/dir/?api=1&origin=Milano&destination=Torino') === false });

    // parseGoogleMapsDirections api=1
    try {
      const p = parseGoogleMapsDirections('https://www.google.com/maps/dir/?api=1&origin=Milano&destination=Torino&travelmode=driving');
      cases.push({ name: 'parse api=1 two places', pass: Array.isArray(p.places) && p.places.length >= 2 });
    } catch (e) {
      cases.push({ name: 'parse api=1 two places', pass: false, info: String(e?.message || e) });
    }

    // parse /maps/dir/
    try {
      const p2 = parseGoogleMapsDirections('https://www.google.com/maps/dir/Milano/Torino');
      cases.push({ name: 'parse /maps/dir two places', pass: Array.isArray(p2.places) && p2.places.length >= 2 });
    } catch (e) {
      cases.push({ name: 'parse /maps/dir two places', pass: false, info: String(e?.message || e) });
    }

    return cases;
  }, []);

  const passed = tests.filter(t => t.pass).length;
  return (
    <div className="mt-8 bg-white rounded-2xl border p-4">
      <h3 className="font-semibold">Pannello test (dev)</h3>
      <p className="text-sm text-gray-600">{passed}/{tests.length} test passati</p>
      <ul className="mt-2 list-disc pl-6 text-sm">
        {tests.map((t, i) => (
          <li key={i} className={t.pass ? 'text-green-700' : 'text-red-700'}>
            {t.name} {t.pass ? '✓' : '✗'} {t.info ? `— ${t.info}` : ''}
          </li>
        ))}
      </ul>
    </div>
  );
}
