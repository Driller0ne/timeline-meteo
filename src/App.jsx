import React, { useMemo, useState } from "react";

/**
 * App: Timeline Meteo sul Percorso
 * Versione consolidata e funzionante, con helper unici (niente duplicati).
 */

export default function App() {
  const [gmapsUrl, setGmapsUrl] = useState("");
  const [travelMode, setTravelMode] = useState("driving"); // driving | cycling | walking
  const [departLocal, setDepartLocal] = useState(() => new Date().toISOString().slice(0, 16));
  const [sampleKm, setSampleKm] = useState(0); // 0 = solo tappe; >0 = checkpoint ogni X km
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [resolvedUrl, setResolvedUrl] = useState("");

  // Preview parsing per feedback immediato
  const parsed = useMemo(() => {
    try {
      return resolvedUrl ? parseGoogleMapsDirections(resolvedUrl) : null;
    } catch (e) {
      return { error: (e && e.message) || String(e) };
    }
  }, [resolvedUrl]);

  async function onRun() {
    setError("");
    setResult(null);
    setResolvedUrl("");
    try {
      let urlToUse = gmapsUrl.trim();
      if (!urlToUse) throw new Error("Incolla un link di Indicazioni Google Maps valido.");

      // Espansione link corto, se necessario
      if (isShortGmaps(urlToUse)) {
        const exp = await expandShortMaps(urlToUse);
        if (exp) {
          urlToUse = exp;
        } else {
          setError("Questo è un link corto di Google Maps che non posso espandere automaticamente. Apri il link, tocca \"Apri in Google Maps\" e copia l'URL completo delle Indicazioni.");
          setLoading(false);
          return;
        }
      }
      setResolvedUrl(urlToUse);

      const parsedNow = parseGoogleMapsDirections(urlToUse);
      const departure = new Date(departLocal);
      if (isNaN(+departure)) throw new Error("Data/ora di partenza non valida");

      // Geocoding punti (origin, waypoints, destination)
      const places = await Promise.all(parsedNow.places.map((p) => ensureCoords(p)));

      // Routing OSRM
      const profile = travelMode;
      const coordsPath = places.map((p) => `${p.lon},${p.lat}`).join(";");
      const osrmUrl = `https://router.project-osrm.org/route/v1/${profile}/${coordsPath}?overview=full&geometries=geojson&steps=false&annotations=distance,duration`;
      setLoading(true);
      const routeResp = await fetch(osrmUrl);
      if (!routeResp.ok) throw new Error("Errore routing OSRM");
      const routeJson = await routeResp.json();
      const route = routeJson.routes?.[0];
      if (!route) throw new Error("Percorso non trovato");

      // Timeline tappe (start + arrivo di ogni leg)
      let t = new Date(departure);
      const waypointsSchedule = [{ type: "start", place: places[0], at: new Date(t), legInfo: null }];
      for (let i = 0; i < route.legs.length; i++) {
        const leg = route.legs[i];
        const to = places[i + 1];
        t = new Date(t.getTime() + leg.duration * 1000);
        waypointsSchedule.push({ type: "legEnd", place: to, at: new Date(t), legInfo: { distance: leg.distance, duration: leg.duration } });
      }

      // Checkpoint lungo il percorso (opzionali)
      const samples = generateRouteSamples(route.geometry?.coordinates, route.distance, route.duration, departure, sampleKm);

      const allPoints = [...waypointsSchedule, ...samples];

      // Arricchisci i soli checkpoint con un nome località (reverse geocoding), con cache
      const nameCache = new Map();
      for (const wp of allPoints) {
        if (wp.type === "sample" && (!wp.place?.name || String(wp.place.name).startsWith("~km"))) {
          const nk = `${wp.place.lat.toFixed(3)},${wp.place.lon.toFixed(3)}`;
          if (nameCache.has(nk)) {
            const nm = nameCache.get(nk);
            if (nm) wp.place.name = nm;
          } else {
            try {
              const nm = await reverseName(wp.place.lat, wp.place.lon);
              nameCache.set(nk, nm);
              if (nm) wp.place.name = nm;
            } catch {}
          }
        }
      }

      // Meteo: finestra comune
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

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 p-6">
      <div className="max-w-3xl mx-auto">
        <header className="mb-6">
          <h1 className="text-3xl font-semibold tracking-tight">Timeline Meteo sul Percorso</h1>
          <p className="text-sm text-gray-600 mt-2">Incolla un link di <strong>Indicazioni Google Maps</strong>, scegli data/ora e (opzionale) checkpoint ogni X km.</p>
        </header>

        <div className="bg-white rounded-2xl shadow p-4 space-y-4">
          <label className="block">
            <span className="text-sm font-medium">Link Google Maps – Indicazioni</span>
            <input className="mt-1 w-full rounded-xl border border-gray-300 px-3 py-2" placeholder="https://www.google.com/maps/dir/?api=1&origin=...&destination=..." value={gmapsUrl} onChange={(e) => setGmapsUrl(e.target.value)} />
          </label>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <label className="block">
              <span className="text-sm font-medium">Modalità</span>
              <select className="mt-1 w-full rounded-xl border border-gray-300 px-3 py-2" value={travelMode} onChange={(e) => setTravelMode(e.target.value)}>
                <option value="driving">Auto</option>
                <option value="cycling">Bici</option>
                <option value="walking">Piedi</option>
              </select>
            </label>
            <label className="block">
              <span className="text-sm font-medium">Checkpoint ogni</span>
              <select className="mt-1 w-full rounded-xl border border-gray-300 px-3 py-2" value={String(sampleKm)} onChange={(e) => setSampleKm(parseInt(e.target.value, 10))}>
                <option value="0">Solo tappe</option>
                <option value="10">10 km</option>
                <option value="20">20 km</option>
                <option value="30">30 km</option>
                <option value="50">50 km</option>
              </select>
            </label>
            <label className="block">
              <span className="text-sm font-medium">Partenza</span>
              <input type="datetime-local" className="mt-1 w-full rounded-xl border border-gray-300 px-3 py-2" value={departLocal} onChange={(e) => setDepartLocal(e.target.value)} />
            </label>
          </div>

          <div className="flex gap-3 items-center">
            <button onClick={onRun} disabled={loading || !gmapsUrl.trim()} className="rounded-xl bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 font-medium shadow disabled:opacity-60">
              {loading ? "Calcolo…" : "Calcola timeline meteo"}
            </button>
            {parsed?.error && <span className="text-sm text-amber-600">{parsed.error}</span>}
          </div>

          {error && <div className="rounded-xl bg-red-50 border border-red-200 p-3 text-sm text-red-700">{error}</div>}
        </div>

        {result && <ResultView data={result} />}

        {/* Pannello test (dev) */}
        <DevTests />
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
      if (hit) return { name: hit.display_name, lat: parseFloat(hit.lat), lon: parseFloat(hit.lon) };
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
  return { ...place, name: g.name, lat: g.lat, lon: g.lon };
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
    const a = j.address || {};
    const city = a.village || a.town || a.city || a.hamlet || a.suburb || a.municipality;
    return city || null;
  } catch { return null; }
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
      <div className="bg-white rounded-2xl shadow p-4 mb-4">
        <h2 className="text-xl font-semibold">Riepilogo</h2>
        <p className="text-sm text-gray-700 mt-1">Profilo: <span className="font-mono">{data.profile}</span> · Totale: {totalKm} km · {totalDur}</p>
      </div>
      <div className="space-y-4">
        {data.schedule.map((wp, idx) => (
          <TimelineCard key={idx} wp={wp} idx={idx} total={data.schedule.length} />
        ))}
      </div>
    </div>
  );
}

function TimelineCard({ wp, idx, total }) {
  const isStart = wp.type === "start"; const isFinal = idx === total - 1; const leg = wp.legInfo;
  let label; if (isStart) label = "Partenza"; else if (isFinal) label = "Arrivo"; else if (wp.type === "sample") label = `Checkpoint ~${Math.round(wp.km)} km`; else label = `Arrivo tappa ${idx}`;
  return (
    <div className="relative bg-white rounded-2xl shadow p-4">
      <div className="flex items-start gap-4">
        <div className="mt-1"><div className={`w-3 h-3 rounded-full ${isStart ? "bg-green-500" : isFinal ? "bg-purple-500" : "bg-blue-500"}`} /></div>
        <div className="flex-1">
          <div className="flex flex-wrap items-center gap-2"><span className="text-xs uppercase tracking-wider text-gray-500">{label}</span><span className="text-sm font-medium">{formatPlaceLabel(wp.place)}</span></div>
          <div className="mt-1 text-sm text-gray-700"><span className="font-medium">{new Date(wp.at).toLocaleString()}</span>{leg && (<><span className="mx-2 text-gray-400">•</span><span>{(leg.distance / 1000).toFixed(1)} km</span><span className="mx-2 text-gray-400">•</span><span>{formatDuration(leg.duration)}</span></>)}</div>
          {wp.weather ? (
            <div className="mt-2 rounded-xl bg-sky-50 border border-sky-100 p-3 text-sm">
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-medium">Meteo previsto</span>
                <span className="text-gray-700">{weatherCodeToText(wp.weather.weathercode)}</span>
                <span className="text-gray-400">•</span>
                <span>🌡️ {Math.round(wp.weather.temperature_2m)}°C</span>
                <span className="text-gray-400">•</span>
                <span>💨 {Math.round(wp.weather.wind_speed_10m)} km/h</span>
                <span className="text-gray-400">•</span>
                <span>☔ {wp.weather.precipitation?.toFixed(1)} mm</span>
              </div>
            </div>
          ) : (<p className="mt-2 text-sm text-gray-500">Meteo non disponibile per questa ora.</p>)}
        </div>
      </div>
    </div>
  );
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
