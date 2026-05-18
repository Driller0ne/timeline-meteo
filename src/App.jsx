import React, { useMemo, useState, useEffect, useRef } from "react";
import { MapContainer, TileLayer, Marker, Popup, Polyline, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

/**
 * App: Timeline Meteo sul Percorso
 *
 * v2.18 — Fix difensivi (race conditions + geocoder strict + OSRM validation)
 *  33. setLoading(true) spostato in CIMA a onRun(), prima di qualsiasi await.
 *      Prima era dentro i branch (place/directions) DOPO l'espansione del
 *      link short, che con ScrapingBee può durare 5-10s: in quella finestra
 *      il bottone era ancora abilitato e si potevano lanciare onRun() in
 *      parallelo (race condition → errore visibile + risultato vecchio).
 *  34. Race-condition guard con runIdRef: ogni onRun() ottiene un ID
 *      incrementale; solo l'ultima invocazione può applicare i suoi
 *      setState finali. Le precedenti vengono "ignorate" se l'utente ha
 *      cliccato di nuovo nel frattempo.
 *  35. setResult(null) esplicito in tutti i rami di errore/early-return,
 *      per garantire che il risultato precedente non resti visibile insieme
 *      a un nuovo messaggio di errore.
 *  36. Photon ora hard-filter su countrycode === "IT": se nessun risultato
 *      italiano, ritorna null (prima accettava il primo risultato globale,
 *      causando "collassi" di tappe diverse sulle stesse coordinate).
 *      L'app resta "Italia-centric" sui geocoder testuali, ma continua a
 *      funzionare ovunque nel mondo se il link contiene coordinate dirette.
 *  37. Validazione OSRM: se la rotta totale ha distance < 100m oppure
 *      qualche leg ha distance === 0, errore esplicito invece di mostrare
 *      una timeline finta con tutti i punti collassati.
 *  38. Sanity check geocoding: se ≥3 tappe finiscono entro 500m l'una
 *      dall'altra (sospetto collasso da geocoder generico), errore esplicito.
 *
 * v2.17 — Sessione B: mappa Leaflet + meteo sovraimpresso
 *  28. Aggiunta mappa interattiva con OpenStreetMap (CartoDB Positron tiles).
 *      Layout: affiancata alla timeline su desktop (lg:), sotto su mobile.
 *      Container allargato a max-w-7xl per ospitare entrambe le viste.
 *  29. Polyline arancione (#fd5216) della rotta usando geometry da OSRM.
 *      In caso di posizione singola: niente polyline, solo marker centrato.
 *  30. Marker custom (divIcon HTML) per ogni tappa/checkpoint, con emoji
 *      meteo + temperatura + ora di arrivo (opzione C). Click apre popup
 *      con dettagli completi (località, km, mm pioggia, vento).
 *  31. Auto-fit del bounding box quando arriva un risultato.
 *  32. Controlli zoom +/- in alto a sinistra (default Leaflet) +
 *      pulsante custom "Espandi" che porta la mappa a tutto schermo
 *      (utile su mobile).
 *
 * v2.16 — Sessione A: default partenza + pulsanti incolla/cancella
 *  24. Default "Partenza" calcolato in ORA LOCALE (era UTC: mostrava un orario
 *      sbagliato di 1-2h a seconda del fuso italiano).
 *  25. Default = "adesso + 1h, arrotondato all'ora piena". Es: alle 14:03 → 15:00.
 *      Più realistico per pianificazione, evita il problema "il default era
 *      già nel passato quando l'utente clicca Calcola".
 *  26. Aggiunto pulsante "Incolla" nel campo Link (usa navigator.clipboard).
 *      Su browser/contesti dove l'API non è disponibile (Safari iOS senza HTTPS,
 *      vecchi browser), il pulsante mostra un messaggio amichevole e resta non
 *      operativo, ma l'utente può sempre incollare manualmente.
 *  27. Aggiunto pulsante "Cancella" che appare solo quando il campo Link
 *      contiene testo.
 *
 *  Nota fuso orario meteo: già funzionante prima della v2.16. La chiamata a
 *  Open-Meteo include timezone=auto, che fa restituire le ore nel fuso locale
 *  del PUNTO geografico richiesto (Bologna→Roma, Madrid→Madrid ecc.). Quindi
 *  le ore mostrate in timeline sono sempre corrette per ciascuna tappa.
 *
 * v2.15 — Blocco 4 follow-up: supporto Waze
 *  22. Aggiunto parser per i link Waze (waze.com / www.waze.com).
 *      Formati supportati:
 *        ?ll=lat,lon                → place singolo
 *        ?q=Nome                    → place per nome (geocodato)
 *        ?to=ll.lat,lon &from=ll... → directions
 *        ?to=place.Nome             → directions con luogo testuale
 *      Travel mode: sempre "driving" (Waze è solo per auto).
 *      No waypoint multipli (Waze non li supporta nei link).
 *  23. Link "Share Drive" Waze (?a=share_drive) sono live tracking di
 *      un viaggio in tempo reale, NON un percorso pianificato. Vengono
 *      rifiutati con messaggio di errore dedicato.
 *
 * v2.14 — Blocco 4 (client-side, link iPhone/Apple/consent EU):
 *  18. Aggiunto parser per il formato legacy `?saddr=...&daddr=...&dirflg=...`
 *      usato dagli URL Google Maps espansi da short link iPhone.
 *      Supporta waypoints multipli separati da " to:" o "+to:".
 *      dirflg → travelmode: d=driving, w=walking, b=bicycling, r=transit.
 *  19. Aggiunto unwrap automatico di `consent.google.com/...?continue=...`:
 *      se l'utente incolla direttamente un URL di consent EU (es. dopo aver
 *      espanso uno short link su unshorten.me), il vero URL Maps viene
 *      estratto automaticamente dal parametro `continue=`.
 *  20. Aggiunto parser per `maps.apple.com/?...` (Apple Maps): supporta
 *      ll=lat,lon, q=Nome, address=Indirizzo, saddr+daddr per Directions.
 *  21. Per i link `maps.app.goo.gl` che NON si riescono ad espandere dal proxy
 *      (Google ora usa Firebase Dynamic Links con risoluzione client-side JS),
 *      l'utente può: (a) aprire il link in un browser desktop, attendere il
 *      redirect a Google Maps, copiare l'URL completo; oppure (b) usare un
 *      servizio terzo di unshortening. In entrambi i casi l'URL risultante
 *      viene ora parsato correttamente grazie ai fix 18-20.
 *
 * v2.13 — Blocco 3, follow-up: indirizzi italiani complessi
 *  17. Strategia "hint progressivi": per ogni tappa proviamo varie versioni
 *      della query, dalla più completa alla più generica. Esempio:
 *        "Toppy S.r.l., Via Moretto, 1, 40056 Valsamoggia BO"
 *          → "Via Moretto, 1, 40056 Valsamoggia BO"   (-1° segmento)
 *          → "40056 Valsamoggia BO"                   (dal CAP)
 *          → "Valsamoggia BO"                         (ultimo segmento)
 *      Per ogni hint applichiamo la cascata Open-Meteo → Nominatim → Photon.
 *      Quando una query semplificata trova coordinate, il primo segmento
 *      della query originale (es. "Toppy S.r.l.") viene mantenuto come
 *      label visiva nella timeline.
 *
 * v2.12 — Blocco 3 (geocoding POI):
 *  13. Cascata geocoder a 3 stadi: Open-Meteo → Nominatim → Photon (Komoot)
 *      per supportare meglio POI commerciali (es. "McDonald's Sassuolo")
 *      e tollerare i typo.
 *  14. Nominatim ora con bias Italia (countrycodes=it), limit=3, addressdetails=1.
 *      Nota: User-Agent è un "forbidden header" nel browser e non può essere
 *      impostato via fetch; l'identificazione avviene tramite Referer automatico
 *      e Accept-Language. Per uso massivo servirebbe un proxy serverless.
 *  15. Fallimento parziale: se una tappa INTERMEDIA è introvabile, viene
 *      saltata e mostrato un avviso giallo; la rotta si calcola con le altre.
 *      Origine e destinazione restano bloccanti (non possono essere saltate
 *      perché ridefinirebbero la rotta).
 *  16. Messaggi di errore più chiari quando origin/destination falliscono.
 *
 * v2.11 — Blocco 1 (pulizia):
 *   7. setLoading(true) spostato PRIMA del geocoding nel ramo "directions"
 *      (era dopo: l'utente non vedeva "Calcolo…" durante la risoluzione coordinate)
 *   8. Rimosso setLoading(false) inutile nel ramo "short link non espandibile"
 *      (il finally lo gestisce già)
 *   9. Rimosso refuso "rafa": "RA" da toProvCode (Ravenna è già presente)
 *  10. Rimossa funzione TestsPanel (mai utilizzata in render)
 *  11. Rimossa funzione DevTests (mai utilizzata in render)
 *  12. Aggiornato testo etichette/header: l'app accetta sia Indicazioni
 *      che Posizione singola, non solo Indicazioni
 *
 * v2.10 — bug fixes rispetto a v2.8/v2.9:
 *   1. parseGoogleMapsPlace spostata FUORI da App (era dentro per errore)
 *   2. setLoading(true) aggiunto nel ramo "place" (era mancante)
 *   3. ResultView gestisce distance:0/duration:0 (posizione singola)
 *   4. Shadowing "const name" in geocodeOpenMeteo rinominato in resolvedName
 *   5. Commento CSS rimosso dalla stringa className in ResultRow
 *   6. parseGoogleMapsPlace: usa le coordinate @lat,lon come raw (evita il
 *      geocoding sul nome testuale es. "Toppy S.r.l., Via Moretto, 1..."),
 *      preservando il nome come label visiva in place.name
 */

export default function App() {
  const [gmapsUrl, setGmapsUrl] = useState("");
  const [travelMode, setTravelMode] = useState("motorcycle"); // motorcycle | driving | cycling | walking
  const [departLocal, setDepartLocal] = useState(() => defaultDepartureLocal());
  const [sampleKm, setSampleKm] = useState(0); // 0 = solo tappe; >0 = checkpoint ogni X km
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // FIX #26 (v2.16): messaggio temporaneo per warning del pulsante "Incolla"
  // (es. clipboard API non disponibile / permesso negato). Diverso da `error`
  // perché non è bloccante, è solo un suggerimento.
  const [pasteWarn, setPasteWarn] = useState("");
  // FIX #34 (v2.18): race-condition guard. Ogni onRun() ottiene un ID
  // incrementale. Solo l'ultima invocazione "vince": le precedenti, se
  // ancora in corso, NON applicano più i loro setState.
  const runIdRef = useRef(0);
  const [result, setResult] = useState(null);
  const [resolvedUrl, setResolvedUrl] = useState("");

  // Preview parsing per feedback immediato (directions OR single place OR Apple/Waze).
  // Nota: applichiamo PRIMA unwrapConsentUrl per estrarre l'URL Maps reale
  // se l'utente ha incollato un URL consent.google.com/...?continue=...
  const parsed = useMemo(() => {
    if (!resolvedUrl) return null;
    const unwrapped = unwrapConsentUrl(resolvedUrl);
    // Waze (priorità: parser specifico)
    if (/^https?:\/\/(www\.)?waze\.com/i.test(unwrapped)) {
      try { return parseWazeUrl(unwrapped); }
      catch (eW) { return { error: eW?.message || "URL Waze non valido" }; }
    }
    // Apple Maps (parser specifico)
    if (/^https?:\/\/maps\.apple\.com/i.test(unwrapped)) {
      try { return parseAppleMaps(unwrapped); }
      catch (eA) { return { error: eA?.message || "URL Apple Maps non valido" }; }
    }
    try {
      return { kind: "directions", ...parseGoogleMapsDirections(unwrapped) };
    } catch (e1) {
      try {
        return { kind: "place", ...parseGoogleMapsPlace(unwrapped) };
      } catch (e2) {
        return { error: (e1 && e1.message) || (e2 && e2.message) || "URL non riconosciuto" };
      }
    }
  }, [resolvedUrl]);

  async function onRun() {
    // FIX #34 (v2.18): ottieni un ID univoco per questa invocazione.
    // Tutti gli setState successivi avvengono solo se siamo ancora la run corrente.
    const myRunId = ++runIdRef.current;
    const isCurrent = () => runIdRef.current === myRunId;

    // FIX #33 (v2.18): setLoading(true) IMMEDIATAMENTE, prima di qualsiasi await.
    // Prima era posizionato dopo expandShortMaps() (5-10s con ScrapingBee),
    // lasciando il bottone abilitato e causando race conditions.
    setLoading(true);
    setError("");
    setResult(null);
    setResolvedUrl("");

    try {
      let urlToUse = gmapsUrl.trim();
      if (!urlToUse) throw new Error("Incolla un link di Google Maps, Apple Maps o Waze (Indicazioni o Posizione singola).");

      // FIX #19 (v2.14): se l'utente ha incollato un URL consent.google.com,
      // estraiamo il vero URL Maps dal parametro `continue=`
      urlToUse = unwrapConsentUrl(urlToUse);

      // Espansione link corto, se necessario
      if (isShortGmaps(urlToUse)) {
        const exp = await expandShortMaps(urlToUse);
        if (!isCurrent()) return; // FIX #34: un'altra run ha preso il timone
        if (exp) urlToUse = unwrapConsentUrl(exp); // anche l'espanso può finire su consent
        else {
          // FIX #35: setResult(null) difensivo prima di setError
          setResult(null);
          setError(
            "Non sono riuscito a espandere questo link corto di Google Maps. " +
            "Apri il link in un browser desktop (Chrome/Safari), attendi che si apra Google Maps, " +
            "copia l'URL completo dalla barra del browser e incollalo qui."
          );
          return;
        }
      }
      if (!isCurrent()) return;
      setResolvedUrl(urlToUse);

      // Determina il parser appropriato in base all'host
      // FIX #20 (v2.14): supporto Apple Maps
      // FIX #22 (v2.15): supporto Waze (priorità)
      let parsedNow;
      if (/^https?:\/\/(www\.)?waze\.com/i.test(urlToUse)) {
        parsedNow = parseWazeUrl(urlToUse);
      } else if (/^https?:\/\/maps\.apple\.com/i.test(urlToUse)) {
        parsedNow = parseAppleMaps(urlToUse);
      } else {
        // Google Maps: prova directions, poi place
        try {
          parsedNow = { kind: "directions", ...parseGoogleMapsDirections(urlToUse) };
        } catch {
          parsedNow = { kind: "place", ...parseGoogleMapsPlace(urlToUse) };
        }
      }

      const departure = new Date(departLocal);
      if (isNaN(+departure)) throw new Error("Data/ora di partenza non valida");

      const profile = travelMode; // per UI
      const nameCache = new Map();

      if (parsedNow.kind === "place") {
        // === Caso POSIZIONE SINGOLA: niente routing, 1 solo punto ===
        const place = await ensureCoords(parsedNow.place);
        if (!isCurrent()) return; // FIX #34
        // Finestra meteo stretta (±12h)
        const meteo = await fetchWeatherForWindow(place.lat, place.lon, departure, departure);
        if (!isCurrent()) return;
        const weather = pickHourlyForDate(meteo, departure);

        // Reverse per nome/prov se non già presenti
        if (!place.name || !place.prov) {
          try {
            const info = await reverseName(place.lat, place.lon);
            if (info?.name) place.name = info.name;
            if (info?.prov) place.prov = info.prov;
          } catch {}
        }

        if (!isCurrent()) return;
        setResult({
          summary: { distance: 0, duration: 0, legs: 0, singlePlace: true },
          schedule: [{ type: "point", place, at: departure, legInfo: null, km: 0, weather }],
          profile,
        });
        return;
      }

      // === Caso INDICAZIONI ===
      // FIX #15 (v2.12): geocoding "tollerante al fallimento parziale".
      // Per ciascuna tappa proviamo a risolvere le coordinate; se la tappa
      // intermedia non si trova, la saltiamo e mostriamo un avviso.
      // L'origine (prima tappa) e la destinazione (ultima) restano bloccanti.
      const geocodeResults = await Promise.all(
        parsedNow.places.map(async (p, idx) => {
          try {
            const resolved = await ensureCoords(p);
            return { ok: true, idx, place: resolved, originalRaw: p.raw };
          } catch (err) {
            return { ok: false, idx, originalRaw: p.raw, error: err?.message || String(err) };
          }
        })
      );
      if (!isCurrent()) return; // FIX #34

      const firstResult = geocodeResults[0];
      const lastResult = geocodeResults[geocodeResults.length - 1];

      if (!firstResult.ok) {
        throw new Error(
          `Impossibile trovare le coordinate dell'origine: "${firstResult.originalRaw}". ` +
          `Prova a usare le coordinate (es. 44.65,11.18) o a copiare un link diretto di Google Maps di quella tappa.`
        );
      }
      if (!lastResult.ok) {
        throw new Error(
          `Impossibile trovare le coordinate della destinazione: "${lastResult.originalRaw}". ` +
          `Prova a usare le coordinate (es. 44.65,11.18) o a copiare un link diretto di Google Maps di quella tappa.`
        );
      }

      // Tappe valide → al router; tappe scartate → in lista per l'avviso UI
      const places = geocodeResults.filter((r) => r.ok).map((r) => r.place);
      const skipped = geocodeResults.filter((r) => !r.ok).map((r) => r.originalRaw);
      const warning = skipped.length > 0
        ? (skipped.length === 1
            ? `Tappa intermedia saltata: "${skipped[0]}" (coordinate non trovate). La rotta è stata calcolata senza questa tappa.`
            : `Tappe intermedie saltate: ${skipped.map((s) => `"${s}"`).join(", ")} (coordinate non trovate). La rotta è stata calcolata senza queste tappe.`)
        : null;

      // FIX #38 (v2.18): sanity check sul geocoding.
      // Se 3+ tappe sono entro 500m l'una dall'altra, è quasi certo un collasso
      // del geocoder su coordinate generiche. Errore esplicito.
      if (places.length >= 3) {
        const tooClose = countCloseClusters(places, 0.5); // 500m
        if (tooClose >= 3) {
          throw new Error(
            `Geocoding sospetto: ${tooClose} tappe risultano molto vicine tra loro (entro 500m). ` +
            `Probabilmente il link contiene nomi che non sono stati riconosciuti correttamente. ` +
            `Prova a usare un link diretto da Google Maps con coordinate, oppure verifica le tappe.`
          );
        }
      }

      // Routing OSRM (alias: "motorcycle" => driving)
      const osrmProfile = travelMode === "motorcycle" ? "driving" : travelMode;
      const coordsPath = places.map((p) => `${p.lon},${p.lat}`).join(";");
      const osrmUrl = `https://router.project-osrm.org/route/v1/${osrmProfile}/${coordsPath}?overview=full&geometries=geojson&steps=false&annotations=distance,duration`;

      const routeResp = await fetch(osrmUrl);
      if (!isCurrent()) return;
      if (!routeResp.ok) throw new Error("Errore routing OSRM");
      const routeJson = await routeResp.json();
      const route = routeJson.routes?.[0];
      if (!route) throw new Error("Percorso non trovato");

      // FIX #37 (v2.18): validazione OSRM.
      // Se la rotta totale è < 100m oppure qualche leg ha distance 0,
      // OSRM ha praticamente non calcolato nulla (coordinate coincidenti
      // o non raggiungibili). Errore esplicito invece di timeline finta.
      if (route.distance < 100) {
        throw new Error(
          `OSRM ha calcolato una rotta degenere (${Math.round(route.distance)}m totali). ` +
          `Le coordinate delle tappe sono troppo vicine o coincidenti. ` +
          `Verifica che il link contenga tappe distinte.`
        );
      }
      if (route.legs?.some((leg) => leg.distance === 0)) {
        throw new Error(
          `OSRM ha trovato una o più tratte di lunghezza zero. ` +
          `Probabilmente due tappe consecutive hanno le stesse coordinate.`
        );
      }

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
      if (!isCurrent()) return;

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
      if (!isCurrent()) return;

      const enriched = allPoints
        .map((wp) => {
          const key = `${wp.place.lat.toFixed(3)},${wp.place.lon.toFixed(3)}`;
          const met = pickHourlyForDate(weatherByKey.get(key), wp.at);
          return { ...wp, weather: met };
        })
        .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

      if (!isCurrent()) return;
      setResult({
        summary: { distance: route.distance, duration: route.duration, legs: route.legs.length },
        schedule: enriched,
        profile,
        warning,
        // FIX #29 (v2.17): salva la geometria del percorso da OSRM per il render mappa.
        // Array di [lon, lat] (verrà invertito in [lat, lon] nel componente).
        routeGeometry: route.geometry?.coordinates || null,
      });
    } catch (e) {
      // FIX #35: setResult(null) difensivo anche nel catch generale
      if (isCurrent()) {
        setResult(null);
        setError((e && e.message) || String(e));
      }
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }

  return (
    <div className="min-h-screen w-screen bg-neutral-900 text-gray-100 p-6 md:pt-12">
      <div className="w-full max-w-7xl mx-auto">
        {/* Sezione "stabile": header + form, sempre centrati su 3xl */}
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
          <p className="text-sm text-gray-400 mt-2">
            Incolla un link di <strong>Google Maps</strong>, <strong>Apple Maps</strong> o <strong>Waze</strong> (Indicazioni o Posizione singola),
            scegli data/ora e (opzionale) checkpoint ogni X km.
          </p>
        </header>

        <div className="bg-neutral-800 rounded-2xl shadow p-4 space-y-4">
          <label className="block">
            <span className="text-sm font-medium">Link Google Maps, Apple Maps o Waze</span>
            <div className="relative mt-1">
              <input
                className="w-full rounded-xl border border-gray-600 bg-neutral-700 text-gray-100 px-3 py-2 pr-28 focus:outline-none focus:ring-2 focus:ring-orange-500"
                placeholder="https://www.google.com/maps/dir/?api=1&origin=...&destination=..."
                value={gmapsUrl}
                onChange={(e) => { setGmapsUrl(e.target.value); if (pasteWarn) setPasteWarn(""); }}
              />
              {/* Pulsanti incolla / cancella sovrapposti a destra dell'input */}
              <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-1">
                {gmapsUrl && (
                  <button
                    type="button"
                    onClick={() => { setGmapsUrl(""); setPasteWarn(""); setError(""); }}
                    aria-label="Cancella"
                    title="Cancella"
                    className="w-7 h-7 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-100 hover:bg-neutral-600 text-lg leading-none"
                  >
                    ✕
                  </button>
                )}
                <button
                  type="button"
                  onClick={async () => {
                    const res = await readClipboardSafe();
                    if (res.ok && res.text) {
                      setGmapsUrl(res.text.trim());
                      setPasteWarn("");
                      setError("");
                    } else if (res.ok && !res.text) {
                      setPasteWarn("Il clipboard è vuoto.");
                      setTimeout(() => setPasteWarn(""), 4000);
                    } else {
                      setPasteWarn("Non riesco a leggere il clipboard. Incollalo manualmente nel campo.");
                      setTimeout(() => setPasteWarn(""), 6000);
                    }
                  }}
                  className="px-3 py-1 rounded-lg bg-neutral-600 hover:bg-orange-500 text-gray-100 text-sm font-medium transition-colors"
                  title="Incolla dal clipboard"
                >
                  Incolla
                </button>
              </div>
            </div>
            {pasteWarn && (
              <p className="text-xs text-amber-400 mt-1">{pasteWarn}</p>
            )}
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
        </div>{/* /max-w-3xl sub-container (chiude header+form) */}

        {/* Sezione risultato: grid 1col su mobile, 2col su desktop (lg:) */}
        {result && (
          <div className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="min-w-0">
              <ResultView data={result} />
            </div>
            <div className="lg:sticky lg:top-6 h-[420px] lg:h-[calc(100vh-6rem)] lg:max-h-[760px]">
              <RouteMap data={result} />
            </div>
          </div>
        )}
      </div>
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

    // 1) Parse locale dell'URL (per eventuale ?link=<encoded>)
    const u = new URL(shortUrl);
    const embedded = u.searchParams.get("link");
    if (embedded) return decodeURIComponent(embedded);

    // 2) Fallback: prova a seguire i redirect (spesso bloccato da CORS)
    const resp = await fetch(shortUrl, { redirect: "follow" });
    if (resp?.url && !isShortGmaps(resp.url)) return resp.url;
    const location = resp.headers?.get?.("Location");
    if (location && !isShortGmaps(location)) return location;
  } catch {}
  return null;
}

// FIX #24/#25 (v2.16): default per il campo "Partenza".
// Calcola "adesso + 1h, arrotondato all'ora piena", in ORA LOCALE.
// Es: 14:03 → 15:00, 14:50 → 16:00, 23:30 → 01:00 del giorno dopo.
// Il valore è formattato come stringa "YYYY-MM-DDTHH:mm" compatibile con
// <input type="datetime-local">, NEL fuso orario dell'utente.
function defaultDepartureLocal() {
  const now = new Date();
  // +1h, poi azzeriamo minuti/secondi/ms → arrotondamento all'ora piena successiva
  const target = new Date(now.getTime() + 60 * 60 * 1000);
  target.setMinutes(0, 0, 0);
  // Formato locale "YYYY-MM-DDTHH:mm"
  const pad = (n) => String(n).padStart(2, "0");
  return `${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(target.getDate())}` +
         `T${pad(target.getHours())}:${pad(target.getMinutes())}`;
}

// FIX #26 (v2.16): wrapper per Clipboard API (compatibile con vari browser).
// Ritorna { ok: true, text } se è riuscito a leggere, altrimenti { ok: false, reason }.
async function readClipboardSafe() {
  // Controllo disponibilità API
  if (!navigator?.clipboard?.readText) {
    return { ok: false, reason: "API non disponibile in questo browser" };
  }
  // Controllo contesto sicuro (HTTPS richiesto da molti browser)
  if (typeof window !== "undefined" && window.isSecureContext === false) {
    return { ok: false, reason: "Lettura clipboard non consentita su HTTP (serve HTTPS)" };
  }
  try {
    const text = await navigator.clipboard.readText();
    return { ok: true, text: String(text || "") };
  } catch (e) {
    // Permesso negato dall'utente o dal browser (es. Safari iOS richiede gesture esplicita)
    return { ok: false, reason: e?.message || "Permesso negato" };
  }
}

function normalizeRaw(s) { return String(s).replace(/\+/g, " ").replace(/\s+/g, " ").trim(); }

// FIX #19 (v2.14): se l'URL è una pagina di consent EU di Google
// (consent.google.com/m, consent.google.com/ml, ecc.), estrae il vero URL Maps
// dal parametro `continue=`. Altrimenti ritorna l'URL originale invariato.
// Si applica all'URL incollato dall'utente PRIMA di qualsiasi parser.
function unwrapConsentUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.hostname === "consent.google.com" || u.hostname === "consent.youtube.com") {
      const cont = u.searchParams.get("continue");
      if (cont) return cont; // già URL-decoded da searchParams.get()
    }
  } catch {}
  return urlStr;
}

// FIX #20 (v2.14): parser per i link Apple Maps (maps.apple.com/?...).
// Formati supportati:
//   Place:
//     ?ll=lat,lon              → coordinate dirette
//     ?ll=lat,lon&q=Nome       → coordinate + label
//     ?q=Nome|q=lat,lon        → ricerca testuale o coordinate
//     ?address=Indirizzo       → indirizzo testuale
//   Directions:
//     ?saddr=...&daddr=...&dirflg=d  → origin/destination (waypoints via "+to:")
// dirflg → travelmode: d=driving, w=walking, r=cycling/transit
function parseAppleMaps(urlStr) {
  let url;
  try { url = new URL(urlStr); } catch { throw new Error("URL Apple Maps non valido"); }
  if (url.hostname !== "maps.apple.com") throw new Error("Non è un link Apple Maps");

  const sp = url.searchParams;

  // 1) DIRECTIONS — se ci sono sia saddr che daddr
  const saddrA = sp.get("saddr");
  const daddrA = sp.get("daddr");
  if (saddrA && daddrA) {
    const places = [{ raw: normalizeRaw(saddrA) }];
    // daddr può contenere waypoints separati da " to:" (Apple) o "+to:" (vecchio)
    const segs = String(daddrA).split(/\s+to:|\+to:/);
    for (const seg of segs) places.push({ raw: normalizeRaw(seg) });

    const flag = sp.get("dirflg");
    let travelMode = null;
    if (flag === "d") travelMode = "driving";
    else if (flag === "w") travelMode = "walking";
    else if (flag === "r") travelMode = "transit"; // non supportato da OSRM

    return { kind: "directions", places, travelMode };
  }

  // 2) PLACE — coordinate esplicite via ll=
  const ll = sp.get("ll");
  if (ll && /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(ll.trim())) {
    const name = sp.get("q") ? normalizeRaw(sp.get("q")) : null;
    return { kind: "place", place: { raw: ll.trim(), name } };
  }

  // 3) PLACE — ?address=Indirizzo
  const address = sp.get("address");
  if (address) {
    return { kind: "place", place: { raw: normalizeRaw(address) } };
  }

  // 4) PLACE — ?q=Nome oppure ?q=lat,lon
  const qA = sp.get("q");
  if (qA) {
    return { kind: "place", place: { raw: normalizeRaw(qA) } };
  }

  throw new Error("Link Apple Maps senza posizione riconoscibile");
}

// FIX #22 (v2.15): parser per i link Waze (waze.com / www.waze.com).
// Formati supportati:
//   Place:
//     ?ll=lat,lon               → coordinate dirette
//     ?q=Nome                   → ricerca testuale (sarà geocodata)
//   Directions:
//     ?to=ll.lat,lon &from=ll.lat,lon       → origin + destination via coordinate
//     ?to=place.NomeLuogo &from=place.Nome  → origin + destination testuali
//     ?to=ll.X,Y senza from                 → trattato come place singolo
// Travel mode: Waze è solo auto → forzato "driving".
// Waypoint intermedi: Waze non li supporta nei link → max 2 punti.
//
// FIX #23 (v2.15): se il link è uno "Share Drive" Waze (?a=share_drive),
// è un live tracking di un viaggio in corso, non un percorso pianificato.
// Rifiutato con messaggio di errore esplicito.
function parseWazeUrl(urlStr) {
  let url;
  try { url = new URL(urlStr); } catch { throw new Error("URL Waze non valido"); }
  if (!/(^|\.)waze\.com$/i.test(url.hostname)) throw new Error("Non è un link Waze");

  const sp = url.searchParams;

  // Caso speciale: Share Drive (live tracking real-time, non pianificato)
  const action = sp.get("a");
  if (action === "share_drive" || action === "live_drive") {
    throw new Error(
      'Questo è un link "Share Drive" di Waze, che condivide un viaggio in tempo reale e non un percorso pianificato. ' +
      'Per RideMAPP serve un link a una posizione o a una rotta pianificata.'
    );
  }

  // Helper: parsa un parametro Waze tipo "ll.LAT,LON" o "place.Nome"
  // Ritorna { raw: "..." } compatibile con il resto del codice.
  function parseWazeParam(value) {
    if (!value) return null;
    // Formato "ll.LAT,LON"
    const llMatch = value.match(/^ll\.\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/i);
    if (llMatch) return { raw: `${llMatch[1]},${llMatch[2]}` };
    // Formato "place.Nome"
    const placeMatch = value.match(/^place\.(.+)$/i);
    if (placeMatch) return { raw: normalizeRaw(placeMatch[1]) };
    // Fallback: valore così com'è (raw)
    return { raw: normalizeRaw(value) };
  }

  const to = sp.get("to");
  const from = sp.get("from");

  // DIRECTIONS: sia from che to presenti
  if (from && to) {
    const fromPlace = parseWazeParam(from);
    const toPlace = parseWazeParam(to);
    if (fromPlace && toPlace) {
      return {
        kind: "directions",
        places: [fromPlace, toPlace],
        travelMode: "driving",
      };
    }
  }

  // PLACE: coordinate dirette via ll=LAT,LON
  const ll = sp.get("ll");
  if (ll) {
    const llMatch = ll.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (llMatch) {
      return { kind: "place", place: { raw: `${llMatch[1]},${llMatch[2]}` } };
    }
  }

  // PLACE: solo "to" (senza from) — trattato come destinazione singola
  if (to) {
    const toPlace = parseWazeParam(to);
    if (toPlace) return { kind: "place", place: toPlace };
  }

  // PLACE: ?q=Nome (ricerca testuale)
  const q = sp.get("q");
  if (q) return { kind: "place", place: { raw: normalizeRaw(q) } };

  throw new Error("Link Waze senza posizione riconoscibile");
}

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

  // FIX #18 (v2.14): formato LEGACY ?saddr=...&daddr=...&dirflg=...
  // Usato dagli URL Google Maps espansi dai short link iPhone.
  // daddr può contenere waypoints separati da " to:" (es. "BO to:Modena").
  const saddrL = sp.get("saddr");
  const daddrL = sp.get("daddr");
  if (saddrL && daddrL) {
    places.push({ raw: normalizeRaw(saddrL) });
    const segs = String(daddrL).split(/\s+to:|\+to:/);
    for (const seg of segs) places.push({ raw: normalizeRaw(seg) });

    const flag = sp.get("dirflg");
    if (flag === "d") travelMode = "driving";
    else if (flag === "w") travelMode = "walking";
    else if (flag === "b") travelMode = "bicycling";
    else if (flag === "r") travelMode = "transit"; // non supportato da OSRM

    return { places, travelMode };
  }

  throw new Error("Questo non sembra un link di Indicazioni Google Maps");
}

// FIX #1: parseGoogleMapsPlace era definita DENTRO App() per errore di copia/incolla.
// Ora è correttamente fuori, come tutte le altre funzioni helper.
// Supporta: /maps/place/..., /maps/search/..., /maps/@lat,lon,zoom, ?q=lat,lon o ?q=Nome
//
// FIX #6: quando l'URL contiene coordinate @lat,lon, le usiamo come `raw`
// (looksLikeLatLon → true → ensureCoords salta il geocoding).
// Il nome testuale (es. "Toppy S.r.l., Via Moretto, 1, 40056 Valsamoggia BO")
// viene conservato in `name` solo come etichetta visiva — non viene mai
// passato alle API di geocoding, evitando l'errore "Geocoding fallito per: ...".
function parseGoogleMapsPlace(urlStr) {
  let url; try { url = new URL(urlStr); } catch { throw new Error("URL non valido"); }
  if (url.hostname === "maps.app.goo.gl") throw new Error("Link corto: verrà espanso");

  // 1) /maps/place/NAME/... oppure /maps/search/...
  if (url.pathname.startsWith("/maps/place/") || url.pathname.startsWith("/maps/search/")) {
    const segs = url.pathname.split("/").filter(Boolean);
    const idx = segs.findIndex(s => s === "place" || s === "search");
    const placeName = segs[idx + 1] ? decodeURIComponent(segs[idx + 1]) : null;

    // Se presenti coordinate @lat,lon nel path: usale come raw (bypass geocoding),
    // il nome testuale diventa solo label visiva in .name
    const at = url.pathname.match(/@(-?\d+(\.\d+)?),(-?\d+(\.\d+)?),/);
    if (at) {
      const lat = parseFloat(at[1]);
      const lon = parseFloat(at[3]);
      return { place: { raw: `${lat},${lon}`, name: placeName || null } };
    }

    // Se c'è ?q=lat,lon o ?q=Nome, usa quello
    const q = url.searchParams.get("q");
    if (q) return { place: { raw: decodeURIComponent(q) } };

    if (placeName) return { place: { raw: placeName } };
  }

  // 2) /maps/@lat,lon,zoom (senza /place/)
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

// ——— Geocoding & Meteo ———
function looksLikeLatLon(raw) {
  const parts = String(raw).split(",");
  if (parts.length !== 2) return false;
  const lat = parseFloat(parts[0]);
  const lon = parseFloat(parts[1]);
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

// Costruisce una lista di "hint" progressivi a partire da una query.
// Es: "Toppy S.r.l., Via Moretto, 1, 40056 Valsamoggia BO" →
//   [
//     "Toppy S.r.l., Via Moretto, 1, 40056 Valsamoggia BO", // intera
//     "Via Moretto, 1, 40056 Valsamoggia BO",               // -1° segmento
//     "40056 Valsamoggia BO",                               // dal CAP
//   ]
// Il primo hint è sempre la query originale. Gli altri vengono aggiunti
// solo se la query contiene virgole (cioè ha più segmenti).
function buildAddressHints(query) {
  const hints = [query];
  const parts = query.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length <= 1) return hints;

  // Hint: senza il primo segmento (di solito nome azienda / POI)
  const withoutFirst = parts.slice(1).join(", ");
  if (withoutFirst && !hints.includes(withoutFirst)) hints.push(withoutFirst);

  // Hint: dal CAP italiano in poi (5 cifre)
  const capIdx = parts.findIndex((p) => /\b\d{5}\b/.test(p));
  if (capIdx > 0) {
    const fromCap = parts.slice(capIdx).join(", ");
    if (!hints.includes(fromCap)) hints.push(fromCap);
  }

  // Hint: solo l'ultimo segmento (di solito Comune + sigla provincia)
  const last = parts[parts.length - 1];
  if (last && !hints.includes(last)) hints.push(last);

  return hints;
}

// Provider 1: Open-Meteo Geocoding (rapido, ottimo per città italiane)
async function _tryOpenMeteo(q) {
  try {
    const u = new URL("https://geocoding-api.open-meteo.com/v1/search");
    u.searchParams.set("name", q);
    u.searchParams.set("count", "3");
    u.searchParams.set("language", "it");
    u.searchParams.set("format", "json");
    const r = await fetch(u.toString());
    if (!r.ok) return null;
    const j = await r.json();
    // Preferisci risultati in Italia se presenti
    const itHit = j.results?.find((h) => h.country_code === "IT");
    const hit = itHit || j.results?.[0];
    if (!hit) return null;
    return {
      name: hit.name,
      prov: null,
      lat: hit.latitude,
      lon: hit.longitude,
      source: "open-meteo",
    };
  } catch {
    return null;
  }
}

// Provider 2: Nominatim (OpenStreetMap) — bravo con POI e indirizzi
async function _tryNominatim(q) {
  try {
    const u = new URL("https://nominatim.openstreetmap.org/search");
    u.searchParams.set("format", "jsonv2");
    u.searchParams.set("limit", "3");
    u.searchParams.set("q", q);
    u.searchParams.set("countrycodes", "it");
    u.searchParams.set("addressdetails", "1");
    const r = await fetch(u.toString(), { headers: { "Accept-Language": "it" } });
    if (!r.ok) return null;
    const j = await r.json();
    const hit = j?.[0];
    if (!hit) return null;
    const lat = parseFloat(hit.lat);
    const lon = parseFloat(hit.lon);
    const info = extractCityProv(hit);
    const resolvedName = info?.name || hit.display_name?.split(",")[0]?.trim() || q;
    return {
      name: resolvedName,
      prov: info?.prov || null,
      lat,
      lon,
      source: "nominatim",
    };
  } catch {
    return null;
  }
}

// Provider 3: Photon (Komoot) — tollerante ai typo, ottimo come fallback
// FIX #36 (v2.18): HARD filter su countrycode === "IT". Prima Photon
// accettava il primo risultato globale se nessun IT match, causando
// "collassi" di tappe diverse alle stesse coordinate generiche.
// Ora ritorna null se nessun risultato italiano: meglio un errore
// esplicito che un risultato sbagliato silenzioso.
async function _tryPhoton(q) {
  try {
    const u = new URL("https://photon.komoot.io/api/");
    u.searchParams.set("q", q);
    u.searchParams.set("lang", "it");
    u.searchParams.set("limit", "5");
    u.searchParams.set("lat", "42.5");
    u.searchParams.set("lon", "12.5");
    const r = await fetch(u.toString());
    if (!r.ok) return null;
    const j = await r.json();
    const features = j?.features || [];
    // HARD filter: solo risultati con countrycode "IT" sono accettati.
    const itHit = features.find((f) => f?.properties?.countrycode === "IT");
    if (!itHit) return null;
    const [lon, lat] = itHit.geometry.coordinates;
    const props = itHit.properties || {};
    const resolvedName = props.name || props.city || props.street || q;
    return {
      name: resolvedName,
      prov: null,
      lat,
      lon,
      source: "photon",
    };
  } catch {
    return null;
  }
}

// Cascata geocoder: per ogni "hint" (query progressivamente più semplice)
// prova i 3 provider in ordine. Al primo successo si ferma.
// Se ha dovuto usare un hint semplificato, conserva il primo segmento della
// query originale come label visiva (più riconoscibile per l'utente).
async function geocode(q) {
  const queryName = normalizeRaw(String(q));
  const hints = buildAddressHints(queryName);

  for (let i = 0; i < hints.length; i++) {
    const hint = hints[i];
    const result =
      (await _tryOpenMeteo(hint)) ||
      (await _tryNominatim(hint)) ||
      (await _tryPhoton(hint));

    if (result) {
      if (i > 0) {
        // Query è stata semplificata: usa il primo segmento dell'originale
        // come label, perché è più riconoscibile per l'utente.
        const labelFromOriginal = queryName.split(",")[0]?.trim();
        if (labelFromOriginal) result.name = labelFromOriginal;
      }
      return result;
    }
  }

  return null;
}

async function ensureCoords(place) {
  const raw = normalizeRaw(String(place.raw));
  if (looksLikeLatLon(raw)) {
    const [latStr, lonStr] = raw.split(",").map((s) => s.trim());
    return { ...place, lat: parseFloat(latStr), lon: parseFloat(lonStr) };
  }
  const g = await geocode(raw);
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
  const city = a.village || a.town || a.city || a.hamlet || a.suburb || a.municipality || a.county || a.state_district || a.state;
  const provName =
    a.county ||
    a.state_district ||
    a.province ||
    null;
  const prov = toProvCode(provName);
  return { name: city || null, prov };
}

function toProvCode(name) {
  if (!name) return null;
  const n = String(name).toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");

  // FIX #9 (v2.11): rimosso refuso "rafa": "RA" (Ravenna è già mappata correttamente)
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
    "pistoia": "PT", "pordenone": "PN", "potenza": "PZ", "prato": "PO",
    "ragusa": "RG", "ravenna": "RA", "reggio calabria": "RC", "reggio nell'emilia": "RE", "reggio emilia": "RE",
    "rieti": "RI", "rimini": "RN", "roma": "RM", "rome": "RM", "rovigo": "RO",
    "salerno": "SA", "sassari": "SS", "savona": "SV", "siena": "SI", "siracusa": "SR", "sondrio": "SO",
    "sud sardegna": "SU", "taranto": "TA", "tempio pausania-olbia": "OT", "teramo": "TE", "terni": "TR",
    "torino": "TO", "trapani": "TP", "trento": "TN", "treviso": "TV", "trieste": "TS",
    "udine": "UD", "varese": "VA", "venezia": "VE", "verbania": "VB", "verbano-cusio-ossola": "VB",
    "verona": "VR", "vibo valentia": "VV", "vicenza": "VI", "viterbo": "VT",
    "provincia di trento": "TN", "provincia autonoma di bolzano": "BZ", "provincia autonoma di trento": "TN",
  };

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

// FIX #38 (v2.18): conta quanti `places` hanno almeno un altro `place`
// entro `kmThreshold` km. Usato come sanity check: se troppe tappe sono
// "appiccicate", il geocoder probabilmente ha collassato.
function countCloseClusters(places, kmThreshold) {
  if (!Array.isArray(places) || places.length < 2) return 0;
  let count = 0;
  for (let i = 0; i < places.length; i++) {
    const pi = places[i];
    if (!Number.isFinite(pi?.lat) || !Number.isFinite(pi?.lon)) continue;
    for (let j = 0; j < places.length; j++) {
      if (i === j) continue;
      const pj = places[j];
      if (!Number.isFinite(pj?.lat) || !Number.isFinite(pj?.lon)) continue;
      const d = haversineMeters(pi.lat, pi.lon, pj.lat, pj.lon) / 1000;
      if (d < kmThreshold) { count++; break; }
    }
  }
  return count;
}
function cumulativeDistances(coords) { const cum = [0]; for (let i = 1; i < coords.length; i++) { const [lon1, lat1] = coords[i - 1]; const [lon2, lat2] = coords[i]; cum.push(cum[cum.length - 1] + haversineMeters(lat1, lon1, lat2, lon2)); } return cum; }
function interpolatePoint(p1, p2, t) { const [lon1, lat1] = p1; const [lon2, lat2] = p2; return [lon1 + (lon2 - lon1) * t, lat1 + (lat2 - lat1) * t]; }
function pointAtDistance(coords, cum, target) { let i = 1; while (i < cum.length && cum[i] < target) i++; if (i >= cum.length) return coords[coords.length - 1]; const prev = i - 1; const segLen = cum[i] - cum[prev]; const tt = segLen > 0 ? (target - cum[prev]) / segLen : 0; return interpolatePoint(coords[prev], coords[i], Math.max(0, Math.min(1, tt))); }
function generateRouteSamples(coords, totalDistance, totalDuration, departDate, stepKm) { const step = (parseFloat(stepKm) || 0) * 1000; if (!coords || coords.length < 2 || !step) return []; const cum = cumulativeDistances(coords); const out = []; for (let d = step; d < totalDistance; d += step) { const [lon, lat] = pointAtDistance(coords, cum, d); const frac = d / totalDistance; const eta = new Date(departDate.getTime() + frac * totalDuration * 1000); out.push({ type: "sample", place: { lat, lon, name: `~km ${Math.round(d / 1000)}` }, at: eta, legInfo: null, km: d / 1000 }); } return out; }

// Helpers
function formatDuration(seconds) { seconds = Math.round(seconds || 0); const h = Math.floor(seconds / 3600); const m = Math.round((seconds % 3600) / 60); if (h <= 0) return `${m} min`; return `${h} h ${m.toString().padStart(2, "0")} min`; }
function formatPlaceLabel(p) { if (p?.name) return p.name; if (typeof p?.lat === "number" && typeof p?.lon === "number") return `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`; return String(p?.raw || ""); }

// ——— UI risultato ———
// FIX #3: gestisce il caso posizione singola (distance:0, duration:0, singlePlace:true)
// FIX #15 (v2.12): mostra avviso giallo se ci sono tappe intermedie saltate
function ResultView({ data }) {
  const isSinglePlace = data.summary.singlePlace === true;
  const totalKm = (data.summary.distance / 1000).toFixed(1);
  const totalDur = formatDuration(data.summary.duration);

  return (
    <div className="mt-6">
      {data.warning && (
        <div className="mb-4 rounded-xl bg-amber-900/30 border border-amber-700/50 p-3 text-sm text-amber-200">
          ⚠️ {data.warning}
        </div>
      )}
      <div className="bg-neutral-800 rounded-2xl shadow p-4 mb-4">
        <h2 className="text-xl font-semibold text-orange-500">Riepilogo</h2>
        <p className="text-sm text-gray-100 mt-1">
          {isSinglePlace
            ? <>Profilo: <span className="font-mono">{data.profile}</span> · Posizione singola</>
            : <>Profilo: <span className="font-mono">{data.profile}</span> · Totale: {totalKm} km · {totalDur}</>
          }
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
  const dt = new Date(wp.at);
  const hhmm = `${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}`;

  const kmFromStart = Math.round(wp.km || 0);
  const kmLabel = `${kmFromStart} km`;

  const titleBase = formatPlaceLabel(wp.place);
  const title = wp?.place?.prov ? `${titleBase}, ${wp.place.prov}` : titleBase;

  const W = wp.weather;
  const meteoText = W ? weatherCodeToText(W.weathercode) : "";
  const temp = W ? Math.round(W.temperature_2m) : null;
  const icon = W ? weatherCodeToIcon(W.weathercode) : "—";
  const windTxt = formatWindSubtitle(wp);
  const rainMm = W && Number.isFinite(W.precipitation) ? `${(+W.precipitation).toFixed(1)} mm` : "";

  return (
    <div className="relative bg-neutral-800 rounded-2xl shadow px-4 py-3 overflow-hidden">
      {/*
        Desktop (>= md): 6 colonne — Ora | Km | Località+Meteo | Temp | Icona | Pioggia+Vento
        Mobile  (< md):  4 blocchi  — [Ora/Km] [Località/Descrizione] [Temp/Vento] [Icona/Pioggia]
      */}
      <div
        className="
          grid items-center gap-3 md:gap-x-2
          grid-cols-[1fr_3fr_1fr_1fr]
          md:grid-cols-[1fr_1fr_4.6fr_1.2fr_0.8fr_1.4fr]
        "
      >
        {/* MOBILE: blocco 1 (Ora sopra, Km sotto) | DESKTOP: colonna 1 = Ora, colonna 2 = Km */}
        <div className="flex flex-col md:hidden">
          <div className="text-lg font-mono tabular-nums text-gray-200">{hhmm}</div>
          <div className="text-sm font-mono tabular-nums text-gray-400">{kmLabel}</div>
        </div>
        <div className="hidden md:block text-lg font-mono tabular-nums text-gray-200">{hhmm}</div>
        <div className="hidden md:block text-lg font-mono tabular-nums text-gray-400">{kmLabel}</div>

        {/* MOBILE: blocco 2 (Località sopra, Descrizione sotto) | DESKTOP: colonna 3 */}
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

        {/* MOBILE: blocco 4 (Icona sopra, Pioggia mm sotto) | DESKTOP: colonna 5 = Icona, colonna 6 = Pioggia/Vento */}
        <div className="flex flex-col md:hidden items-end">
          <div className="text-2xl" aria-hidden="true">{icon}</div>
          <div className="text-xs text-gray-300">{rainMm}</div>
        </div>

        {/* Desktop: colonna 5 = icona */}
        <div className="hidden md:block text-2xl text-right" aria-hidden="true">{icon}</div>

        {/* Desktop: colonna 6 = Pioggia sopra + Vento sotto */}
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
  if (code === 0) return "☀️";
  if ([1, 2, 3].includes(code)) return "⛅";
  if ([45, 48].includes(code)) return "🌫️";
  if ([51, 53, 55, 61, 63, 65, 80, 81, 82].includes(code)) return "🌧️";
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "❄️";
  if ([95, 96, 99].includes(code)) return "⛈️";
  return "🌡️";
}

function weatherCodeToText(code) { const map = { 0: "Sereno", 1: "Prevalentemente sereno", 2: "Parzialmente nuvoloso", 3: "Coperto", 45: "Nebbia", 48: "Nebbia con brina", 51: "Pioviggine leggera", 53: "Pioviggine", 55: "Pioviggine intensa", 56: "Pioggia gelata leggera", 57: "Pioggia gelata", 61: "Pioggia debole", 63: "Pioggia", 65: "Pioggia forte", 66: "Rovescio gelato leggero", 67: "Rovescio gelato", 71: "Neve debole", 73: "Neve", 75: "Neve forte", 77: "Granelli di neve", 80: "Rovesci leggeri", 81: "Rovesci", 82: "Rovesci intensi", 85: "Rovesci di neve leggeri", 86: "Rovesci di neve intensi", 95: "Temporale", 96: "Temporale con grandine", 99: "Temporale con grandine forte" }; return map?.[code] ?? `Codice meteo ${code}`; }


// ============================================================================
// FIX #28-32 (v2.17): mappa Leaflet con polyline rotta + marker meteo
// ============================================================================

// Helper componente: chiama map.fitBounds() ogni volta che i bounds cambiano.
// Va dentro <MapContainer>, perché ha bisogno dell'hook useMap().
function FitBoundsOnChange({ bounds }) {
  const map = useMap();
  useEffect(() => {
    if (!bounds) return;
    try {
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 });
    } catch {}
  }, [bounds, map]);
  return null;
}

// Helper: invalidate map size dopo che il container è stato montato/resized
// (Leaflet ha bisogno di sapere quanto è grande il suo wrapper, e a volte non
// se ne accorge da solo se il container nasce con dimensioni dinamiche).
function InvalidateSizeOnResize() {
  const map = useMap();
  useEffect(() => {
    const t = setTimeout(() => map.invalidateSize(), 100);
    const onResize = () => map.invalidateSize();
    window.addEventListener("resize", onResize);
    return () => {
      clearTimeout(t);
      window.removeEventListener("resize", onResize);
    };
  }, [map]);
  return null;
}

// Costruisce un divIcon Leaflet personalizzato per una tappa.
// Mostra: emoji meteo grande, temperatura, ora di arrivo (opzione C).
// Il colore di sfondo del pin varia in base al tipo (start/end/sample).
function buildWeatherDivIcon(wp) {
  const W = wp.weather;
  const icon = W ? weatherCodeToIcon(W.weathercode) : "📍";
  const temp = W && Number.isFinite(W.temperature_2m) ? `${Math.round(W.temperature_2m)}°` : "";
  const dt = new Date(wp.at);
  const pad = (n) => String(n).padStart(2, "0");
  const hhmm = `${pad(dt.getHours())}:${pad(dt.getMinutes())}`;

  // Colore bordo in base al tipo
  let border = "#fd5216"; // default: tappa/checkpoint
  if (wp.type === "start") border = "#22c55e";   // verde: partenza
  else if (wp.type === "legEnd") border = "#fd5216"; // arancione: tappa
  else if (wp.type === "sample") border = "#9ca3af"; // grigio: checkpoint km

  const html = `
    <div style="
      background: white;
      border: 2px solid ${border};
      border-radius: 12px;
      padding: 2px 6px 4px 6px;
      box-shadow: 0 2px 6px rgba(0,0,0,0.25);
      text-align: center;
      min-width: 44px;
      font-family: system-ui, -apple-system, sans-serif;
      line-height: 1.1;
    ">
      <div style="font-size: 18px;">${icon}</div>
      <div style="font-size: 13px; font-weight: 700; color: #111;">${temp}</div>
      <div style="font-size: 10px; color: #555; font-variant-numeric: tabular-nums;">${hhmm}</div>
    </div>
  `;
  return L.divIcon({
    html,
    className: "ridemapp-marker", // niente stili default Leaflet
    iconSize: [56, 56],
    iconAnchor: [28, 56], // punta in basso al centro
    popupAnchor: [0, -56],
  });
}

function RouteMap({ data }) {
  const containerRef = useRef(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Estrae le coordinate della polyline (se presenti)
  // Geometry da OSRM è [lon, lat], Leaflet vuole [lat, lon] → inverto.
  const polyline = useMemo(() => {
    const coords = data?.routeGeometry;
    if (!coords || !Array.isArray(coords) || coords.length < 2) return null;
    return coords.map((c) => [c[1], c[0]]);
  }, [data]);

  // Calcola i bounds da tutte le tappe + (se presente) la polyline
  const bounds = useMemo(() => {
    const pts = [];
    for (const wp of data?.schedule || []) {
      if (Number.isFinite(wp?.place?.lat) && Number.isFinite(wp?.place?.lon)) {
        pts.push([wp.place.lat, wp.place.lon]);
      }
    }
    if (polyline) {
      for (const p of polyline) pts.push(p);
    }
    if (pts.length === 0) return null;
    if (pts.length === 1) {
      // Singolo punto: bounds artificiali per evitare un crash di fitBounds
      const [lat, lon] = pts[0];
      const d = 0.02;
      return [[lat - d, lon - d], [lat + d, lon + d]];
    }
    return pts;
  }, [data, polyline]);

  // Centro iniziale (Italia) se non ci sono bounds
  const initialCenter = bounds ? null : [42.5, 12.5];

  // Pulsante "Espandi" — toggle fullscreen via API browser nativa
  function toggleFullscreen() {
    const el = containerRef.current;
    if (!el) return;
    if (!document.fullscreenElement) {
      el.requestFullscreen?.()
        .then(() => setIsFullscreen(true))
        .catch(() => {});
    } else {
      document.exitFullscreen?.()
        .then(() => setIsFullscreen(false))
        .catch(() => {});
    }
  }

  // Listener per uscita da fullscreen via Esc o pulsante browser
  useEffect(() => {
    const onFsChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  if (!bounds && !initialCenter) {
    return null;
  }

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full rounded-2xl overflow-hidden shadow border border-neutral-700 bg-neutral-800"
    >
      {/* Pulsante "Espandi a tutto schermo" — overlay in alto a destra */}
      <button
        type="button"
        onClick={toggleFullscreen}
        title={isFullscreen ? "Esci da tutto schermo" : "Espandi a tutto schermo"}
        aria-label={isFullscreen ? "Esci da tutto schermo" : "Espandi a tutto schermo"}
        className="absolute top-2 right-2 z-[1000] w-9 h-9 flex items-center justify-center rounded-lg bg-white/95 hover:bg-orange-500 hover:text-white text-gray-800 text-base shadow border border-gray-300 transition-colors"
      >
        {isFullscreen ? "⤡" : "⛶"}
      </button>

      <MapContainer
        center={initialCenter || [42.5, 12.5]}
        zoom={6}
        scrollWheelZoom={true}
        zoomControl={true}
        style={{ width: "100%", height: "100%", background: "#f8f8f8" }}
      >
        {/* Tile layer: CartoDB Positron (minimal grey, marker meteo risaltano) */}
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/">CARTO</a>'
          url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
          subdomains={["a", "b", "c", "d"]}
          maxZoom={19}
        />

        {/* Polyline della rotta (se presente) */}
        {polyline && (
          <Polyline
            positions={polyline}
            pathOptions={{
              color: "#fd5216",
              weight: 4,
              opacity: 0.85,
              lineCap: "round",
              lineJoin: "round",
            }}
          />
        )}

        {/* Marker per ciascuna tappa */}
        {(data?.schedule || []).map((wp, idx) => {
          if (!Number.isFinite(wp?.place?.lat) || !Number.isFinite(wp?.place?.lon)) return null;
          return (
            <Marker
              key={idx}
              position={[wp.place.lat, wp.place.lon]}
              icon={buildWeatherDivIcon(wp)}
            >
              <Popup>
                <MarkerPopupContent wp={wp} />
              </Popup>
            </Marker>
          );
        })}

        {bounds && <FitBoundsOnChange bounds={bounds} />}
        <InvalidateSizeOnResize />
      </MapContainer>
    </div>
  );
}

function MarkerPopupContent({ wp }) {
  const W = wp.weather;
  const dt = new Date(wp.at);
  const pad = (n) => String(n).padStart(2, "0");
  const hhmm = `${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
  const kmFromStart = Math.round(wp.km || 0);
  const titleBase = formatPlaceLabel(wp.place);
  const title = wp?.place?.prov ? `${titleBase}, ${wp.place.prov}` : titleBase;
  const meteoText = W ? weatherCodeToText(W.weathercode) : "";
  const temp = W && Number.isFinite(W.temperature_2m) ? `${Math.round(W.temperature_2m)}°C` : "—";
  const rain = W && Number.isFinite(W.precipitation) ? `${(+W.precipitation).toFixed(1)} mm` : "—";
  const wind = W && Number.isFinite(W.wind_speed_10m) ? `${Math.round(W.wind_speed_10m)} km/h` : "—";

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", minWidth: 180 }}>
      <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4, color: "#111" }}>{title}</div>
      <div style={{ fontSize: 12, color: "#555", marginBottom: 6 }}>
        {hhmm} · {kmFromStart} km dall'inizio
      </div>
      <div style={{ fontSize: 13, color: "#333", marginBottom: 6 }}>{meteoText}</div>
      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "2px 8px", fontSize: 12, color: "#444" }}>
        <span>🌡️</span><span>{temp}</span>
        <span>💧</span><span>{rain}</span>
        <span>💨</span><span>{wind}</span>
      </div>
    </div>
  );
}
