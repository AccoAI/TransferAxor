/**
 * Consulta de vuelos con salida o llegada en Madrid-Barajas (MAD).
 * Requiere AERODATABOX_API_KEY (RapidAPI) y/o AVIATIONSTACK_API_KEY.
 */

const MADRID_TZ = "Europe/Madrid";
const MAD_IATA = "MAD";

function normalizeFlightCode(code) {
  return String(code || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 8);
}

function madridDateString(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: MADRID_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date || new Date());
}

function madridTimeString(date) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: MADRID_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date || new Date());
}

function getDefaultSearchDates() {
  const out = [];
  const base = Date.now();
  for (let offset = -1; offset <= 2; offset++) {
    out.push(madridDateString(new Date(base + offset * 86400000)));
  }
  return [...new Set(out)];
}

function parseLocalScheduleTime(localStr) {
  if (!localStr) return null;
  const m = String(localStr).match(/^(\d{4}-\d{2}-\d{2})[T\s]+(\d{2}):(\d{2})/);
  if (!m) return null;
  return { date: m[1], time: m[2] + ":" + m[3] };
}

function partsFromIso(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return { date: madridDateString(d), time: madridTimeString(d), iso: d.toISOString() };
}

function legFromEndpoints(depIata, arrIata, depTime, arrTime, extra) {
  const dep = String(depIata || "").toUpperCase();
  const arr = String(arrIata || "").toUpperCase();
  if (dep !== MAD_IATA && arr !== MAD_IATA) return null;

  const direction = arr === MAD_IATA ? "arrival" : "departure";
  const schedule = direction === "arrival" ? arrTime || depTime : depTime || arrTime;
  if (!schedule) return null;

  const otherIata = direction === "arrival" ? dep : arr;
  return {
    direction,
    date: schedule.date,
    time: schedule.time,
    scheduledIso: schedule.iso || null,
    otherIata,
    otherName: extra.otherName || otherIata,
    terminal: extra.terminal || null,
    status: extra.status || null,
    flightNumber: extra.flightNumber || null,
  };
}

function normalizeAerodataboxFlight(raw, flightNumber) {
  const depIata = raw.departure && raw.departure.airport ? raw.departure.airport.iata : null;
  const arrIata = raw.arrival && raw.arrival.airport ? raw.arrival.airport.iata : null;
  const depLocal =
    (raw.departure && raw.departure.scheduledTime && raw.departure.scheduledTime.local) ||
    (raw.departure && raw.departure.scheduledTime && raw.departure.scheduledTime.utc);
  const arrLocal =
    (raw.arrival && raw.arrival.scheduledTime && raw.arrival.scheduledTime.local) ||
    (raw.arrival && raw.arrival.scheduledTime && raw.arrival.scheduledTime.utc);

  const depTime = parseLocalScheduleTime(depLocal) || partsFromIso(depLocal);
  const arrTime = parseLocalScheduleTime(arrLocal) || partsFromIso(arrLocal);
  const otherName =
    String(arrIata || "").toUpperCase() === MAD_IATA
      ? raw.departure && raw.departure.airport && raw.departure.airport.name
      : raw.arrival && raw.arrival.airport && raw.arrival.airport.name;

  const terminal =
    String(arrIata || "").toUpperCase() === MAD_IATA
      ? raw.arrival && raw.arrival.terminal
      : raw.departure && raw.departure.terminal;

  return legFromEndpoints(depIata, arrIata, depTime, arrTime, {
    otherName,
    terminal,
    status: raw.status || null,
    flightNumber: raw.number || flightNumber,
  });
}

function normalizeAviationstackFlight(raw) {
  const dep = raw.departure || {};
  const arr = raw.arrival || {};
  const depTime = partsFromIso(dep.scheduled || dep.estimated);
  const arrTime = partsFromIso(arr.scheduled || arr.estimated);
  const otherName =
    String(arr.iata || "").toUpperCase() === MAD_IATA ? dep.airport : arr.airport;
  const terminal =
    String(arr.iata || "").toUpperCase() === MAD_IATA ? arr.terminal : dep.terminal;

  return legFromEndpoints(dep.iata, arr.iata, depTime, arrTime, {
    otherName,
    terminal,
    status: raw.flight_status || null,
    flightNumber: (raw.flight && raw.flight.iata) || null,
  });
}

async function fetchJson(url, headers) {
  const res = await fetch(url, { headers });
  if (res.status === 404) return { notFound: true, data: null };
  if (!res.ok) {
    const text = await res.text().catch(function() {
      return "";
    });
    const err = new Error("flight-api-" + res.status);
    err.status = res.status;
    err.body = text.slice(0, 200);
    throw err;
  }
  return { notFound: false, data: await res.json() };
}

async function fetchAerodataboxFlights(flightCode, date) {
  const key = process.env.AERODATABOX_API_KEY || process.env.AERODATABOX_RAPIDAPI_KEY;
  if (!key) return [];

  const host = (process.env.AERODATABOX_RAPIDAPI_HOST || "aerodatabox.p.rapidapi.com").replace(
    /^https?:\/\//,
    ""
  );
  const url =
    "https://" +
    host +
    "/flights/number/" +
    encodeURIComponent(flightCode) +
    "/" +
    encodeURIComponent(date);
  const headers = host.includes("rapidapi")
    ? { "X-RapidAPI-Key": key, "X-RapidAPI-Host": host }
    : { "Ocp-Apim-Subscription-Key": key };

  const { notFound, data } = await fetchJson(url, headers);
  if (notFound || !data) return [];
  const list = Array.isArray(data) ? data : [data];
  return list
    .map(function(item) {
      return normalizeAerodataboxFlight(item, flightCode);
    })
    .filter(Boolean);
}

async function fetchAviationstackFlights(flightCode, date) {
  const key = process.env.AVIATIONSTACK_API_KEY;
  if (!key) return [];

  const params = new URLSearchParams({
    access_key: key,
    flight_iata: flightCode,
    flight_date: date,
    limit: "10",
  });
  const base = process.env.AVIATIONSTACK_BASE_URL || "https://api.aviationstack.com/v1";
  const { notFound, data } = await fetchJson(base + "/flights?" + params.toString(), {});
  if (notFound || !data || !data.data) return [];
  return data.data
    .map(function(item) {
      return normalizeAviationstackFlight(item);
    })
    .filter(Boolean);
}

function isConfigured() {
  return !!(
    process.env.AERODATABOX_API_KEY ||
    process.env.AERODATABOX_RAPIDAPI_KEY ||
    process.env.AVIATIONSTACK_API_KEY
  );
}

function legSortKey(leg) {
  return leg.date + "T" + leg.time;
}

function pickBestLeg(legs, location) {
  if (!legs.length) return null;
  const wantArrival = ["t1", "t2", "t4"].includes(String(location || "").toLowerCase());
  const wantDeparture = String(location || "").toLowerCase() === "hotel";
  const nowKey = madridDateString() + "T" + madridTimeString();

  const scored = legs.map(function(leg) {
    let score = 0;
    if (wantArrival && leg.direction === "arrival") score += 20;
    if (wantDeparture && leg.direction === "departure") score += 20;
    if (legSortKey(leg) >= nowKey) score += 10;
    return { leg, score };
  });
  scored.sort(function(a, b) {
    if (b.score !== a.score) return b.score - a.score;
    return legSortKey(a.leg).localeCompare(legSortKey(b.leg));
  });
  return scored[0].leg;
}

function dedupeLegs(legs) {
  const seen = new Set();
  const out = [];
  legs.forEach(function(leg) {
    const key =
      leg.direction +
      "|" +
      leg.date +
      "|" +
      leg.time +
      "|" +
      leg.otherIata +
      "|" +
      (leg.terminal || "");
    if (seen.has(key)) return;
    seen.add(key);
    out.push(leg);
  });
  out.sort(function(a, b) {
    return legSortKey(a).localeCompare(legSortKey(b));
  });
  return out;
}

/**
 * @param {string} rawCode e.g. IB872
 * @param {{ location?: string, dates?: string[] }} options
 */
async function lookupFlightForMadrid(rawCode, options) {
  const flightCode = normalizeFlightCode(rawCode);
  if (flightCode.length < 3) {
    return { ok: false, error: "invalid-flight", flightCode };
  }
  if (!isConfigured()) {
    return { ok: false, error: "flight-lookup-unavailable", flightCode };
  }

  const dates = (options && options.dates) || getDefaultSearchDates();
  const location = (options && options.location) || "";
  const collected = [];

  for (const date of dates) {
    let batch = [];
    try {
      const aero = await fetchAerodataboxFlights(flightCode, date);
      const avia = await fetchAviationstackFlights(flightCode, date);
      batch = aero.concat(avia);
    } catch (e) {
      if (e.status === 401 || e.status === 403) {
        return { ok: false, error: "flight-lookup-unauthorized", flightCode };
      }
      continue;
    }
    collected.push.apply(collected, batch);
  }

  const legs = dedupeLegs(collected);
  if (!legs.length) {
    return { ok: false, error: "flight-not-found", flightCode };
  }

  const leg = pickBestLeg(legs, location);
  return {
    ok: true,
    flightCode,
    leg,
    legs,
    location,
  };
}

module.exports = {
  MAD_IATA,
  normalizeFlightCode,
  isFlightLookupConfigured: isConfigured,
  lookupFlightForMadrid,
  madridDateString,
  madridTimeString,
};
