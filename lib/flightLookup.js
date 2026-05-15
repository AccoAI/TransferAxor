/**
 * Consulta de vuelos con salida o llegada en Madrid-Barajas (MAD).
 * Variables: AERODATABOX_RAPIDAPI_KEY, AERODATABOX_API_KEY, AVIATIONSTACK_API_KEY
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

/** Terminal Barajas → parada del transfer (t1 | t2 | t4 | null). */
function mapTerminalToLocationKey(terminal) {
  if (terminal == null || terminal === "") return null;
  const raw = String(terminal).trim().toUpperCase().replace(/\s+/g, "");
  if (raw === "T1" || raw === "1") return "t1";
  if (raw === "T2" || raw === "2" || raw === "2S" || raw === "2G" || raw === "T2S") return "t2";
  if (raw === "T4" || raw === "4" || raw === "4S" || raw === "T4S") return "t4";
  const digit = raw.replace(/[^0-9]/g, "");
  if (digit === "1") return "t1";
  if (digit === "2") return "t2";
  if (digit === "4") return "t4";
  return null;
}

function formatTerminalLabel(terminal) {
  const key = mapTerminalToLocationKey(terminal);
  if (key === "t1") return "T1";
  if (key === "t2") return "T2";
  if (key === "t4") return "T4";
  if (terminal != null && String(terminal).trim()) return "T" + String(terminal).replace(/\D/g, "");
  return null;
}

function legFromEndpoints(depIata, arrIata, depTime, arrTime, extra) {
  const dep = String(depIata || "").toUpperCase();
  const arr = String(arrIata || "").toUpperCase();
  if (dep !== MAD_IATA && arr !== MAD_IATA) return null;

  const direction = arr === MAD_IATA ? "arrival" : "departure";
  const schedule = direction === "arrival" ? arrTime || depTime : depTime || arrTime;
  if (!schedule) return null;

  const otherIata = direction === "arrival" ? dep : arr;
  const terminalRaw =
    direction === "arrival" ? extra.arrivalTerminal : extra.departureTerminal;
  const terminalLabel = formatTerminalLabel(terminalRaw);

  return {
    direction,
    date: schedule.date,
    time: schedule.time,
    scheduledIso: schedule.iso || null,
    otherIata,
    otherName: extra.otherName || otherIata,
    terminal: terminalRaw || null,
    terminalLabel: terminalLabel,
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

  return legFromEndpoints(depIata, arrIata, depTime, arrTime, {
    arrivalTerminal: raw.arrival && raw.arrival.terminal,
    departureTerminal: raw.departure && raw.departure.terminal,
    otherName,
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

  return legFromEndpoints(dep.iata, arr.iata, depTime, arrTime, {
    arrivalTerminal: arr.terminal,
    departureTerminal: dep.terminal,
    otherName,
    status: raw.flight_status || null,
    flightNumber: (raw.flight && raw.flight.iata) || null,
  });
}

async function fetchJson(url, headers) {
  const res = await fetch(url, { headers });
  if (res.status === 404) return { notFound: true, data: null, status: 404 };
  if (!res.ok) {
    const text = await res.text().catch(function() {
      return "";
    });
    const err = new Error("flight-api-" + res.status);
    err.status = res.status;
    err.body = text.slice(0, 300);
    throw err;
  }
  return { notFound: false, data: await res.json(), status: res.status };
}

function getAerodataboxHosts() {
  const hosts = [];
  if (process.env.AERODATABOX_RAPIDAPI_HOST) {
    hosts.push(process.env.AERODATABOX_RAPIDAPI_HOST.replace(/^https?:\/\//, ""));
  }
  hosts.push("aerodatabox.p.rapidapi.com", "aerodatabox-api.p.rapidapi.com");
  return [...new Set(hosts)];
}

async function fetchAerodataboxFlights(flightCode, date) {
  const key = process.env.AERODATABOX_API_KEY || process.env.AERODATABOX_RAPIDAPI_KEY;
  if (!key) return { flights: [], authError: false };

  const pathVariants = ["Number", "number"];
  let authError = false;
  let lastError = null;

  for (const host of getAerodataboxHosts()) {
    const headers = host.includes("rapidapi")
      ? { "X-RapidAPI-Key": key, "X-RapidAPI-Host": host }
      : { "Ocp-Apim-Subscription-Key": key };

    for (const pathSeg of pathVariants) {
      const url =
        "https://" +
        host +
        "/flights/" +
        pathSeg +
        "/" +
        encodeURIComponent(flightCode) +
        "/" +
        encodeURIComponent(date);
      try {
        const { notFound, data, status } = await fetchJson(url, headers);
        if (status === 401 || status === 403) {
          authError = true;
          continue;
        }
        if (notFound || !data) continue;
        const list = Array.isArray(data) ? data : [data];
        const flights = list
          .map(function(item) {
            return normalizeAerodataboxFlight(item, flightCode);
          })
          .filter(Boolean);
        if (flights.length) return { flights: flights, authError: false };
      } catch (e) {
        lastError = e;
        if (e.status === 401 || e.status === 403) authError = true;
      }
    }
  }
  if (lastError && lastError.status !== 401 && lastError.status !== 403) throw lastError;
  return { flights: [], authError: authError };
}

async function fetchAviationstackFlights(flightCode, date) {
  const key = process.env.AVIATIONSTACK_API_KEY;
  if (!key) return { flights: [], authError: false };

  const bases = [];
  if (process.env.AVIATIONSTACK_BASE_URL) {
    bases.push(process.env.AVIATIONSTACK_BASE_URL.replace(/\/$/, ""));
  }
  bases.push("https://api.aviationstack.com/v1", "http://api.aviationstack.com/v1");

  const params = new URLSearchParams({
    access_key: key,
    flight_iata: flightCode,
    flight_date: date,
    limit: "10",
  });

  let authError = false;
  for (const base of [...new Set(bases)]) {
    try {
      const { notFound, data, status } = await fetchJson(base + "/flights?" + params.toString(), {});
      if (status === 401 || status === 403) {
        authError = true;
        continue;
      }
      if (notFound || !data || !data.data) continue;
      const flights = data.data
        .map(function(item) {
          return normalizeAviationstackFlight(item);
        })
        .filter(Boolean);
      if (flights.length) return { flights: flights, authError: false };
    } catch (e) {
      if (e.status === 401 || e.status === 403) authError = true;
      else if (e.status !== 404) throw e;
    }
  }
  return { flights: [], authError: authError };
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
  const loc = String(location || "").toLowerCase();
  const nowKey = madridDateString() + "T" + madridTimeString();

  if (!loc) {
    const arrivals = legs.filter(function(l) {
      return l.direction === "arrival";
    });
    const pool = arrivals.length ? arrivals : legs;
    const sorted = pool.slice().sort(function(a, b) {
      const aFuture = legSortKey(a) >= nowKey ? 0 : 1;
      const bFuture = legSortKey(b) >= nowKey ? 0 : 1;
      if (aFuture !== bFuture) return aFuture - bFuture;
      return legSortKey(a).localeCompare(legSortKey(b));
    });
    return sorted[0];
  }

  const wantArrival = ["t1", "t2", "t4"].includes(loc);
  const wantDeparture = loc === "hotel";

  const scored = legs.map(function(leg) {
    let score = 0;
    if (wantArrival && leg.direction === "arrival") score += 20;
    if (wantDeparture && leg.direction === "departure") score += 20;
    if (legSortKey(leg) >= nowKey) score += 10;
    const legStop = mapTerminalToLocationKey(leg.terminal);
    if (wantArrival && legStop === loc) score += 15;
    return { leg: leg, score: score };
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

/** Parada de espera del transfer según el tramo en Madrid. */
function legToWaitingLocation(leg) {
  if (!leg) return null;
  if (leg.direction === "arrival") {
    return mapTerminalToLocationKey(leg.terminal) || "t4";
  }
  return "hotel";
}

function enrichLookupResult(flightCode, leg, legs, location) {
  const suggestedLocation = legToWaitingLocation(leg);
  return {
    ok: true,
    flightCode: flightCode,
    leg: leg,
    legs: legs,
    location: location || "",
    suggestedLocation: suggestedLocation,
    suggestedLocationLabel:
      suggestedLocation === "hotel"
        ? "Hotel Campezo 4"
        : suggestedLocation === "t1"
          ? "Terminal T1"
          : suggestedLocation === "t2"
            ? "Terminal T2"
            : suggestedLocation === "t4"
              ? "Terminal T4"
              : null,
  };
}

/**
 * @param {string} rawCode e.g. IB872
 * @param {{ location?: string, dates?: string[] }} options
 */
async function lookupFlightForMadrid(rawCode, options) {
  const flightCode = normalizeFlightCode(rawCode);
  if (flightCode.length < 3) {
    return { ok: false, error: "invalid-flight", flightCode: flightCode };
  }
  if (!isConfigured()) {
    return { ok: false, error: "flight-lookup-unavailable", flightCode: flightCode };
  }

  const dates = (options && options.dates) || getDefaultSearchDates();
  const location = (options && options.location) || "";
  const collected = [];
  let anyAuthError = false;
  let anyProviderOk = false;

  for (const date of dates) {
    try {
      const aero = await fetchAerodataboxFlights(flightCode, date);
      if (aero.authError) anyAuthError = true;
      if (aero.flights.length) {
        anyProviderOk = true;
        collected.push.apply(collected, aero.flights);
      }
    } catch (e) {
      if (e.status === 401 || e.status === 403) anyAuthError = true;
      else console.error("AeroDataBox", flightCode, date, e.message);
    }
    try {
      const avia = await fetchAviationstackFlights(flightCode, date);
      if (avia.authError) anyAuthError = true;
      if (avia.flights.length) {
        anyProviderOk = true;
        collected.push.apply(collected, avia.flights);
      }
    } catch (e) {
      if (e.status === 401 || e.status === 403) anyAuthError = true;
      else console.error("Aviationstack", flightCode, date, e.message);
    }
  }

  const legs = dedupeLegs(collected);
  if (!legs.length) {
    if (anyAuthError && !anyProviderOk) {
      return { ok: false, error: "flight-lookup-unauthorized", flightCode: flightCode };
    }
    return { ok: false, error: "flight-not-found", flightCode: flightCode };
  }

  const leg = pickBestLeg(legs, location);
  return enrichLookupResult(flightCode, leg, legs, location);
}

module.exports = {
  MAD_IATA,
  normalizeFlightCode,
  mapTerminalToLocationKey,
  legToWaitingLocation,
  isFlightLookupConfigured: isConfigured,
  lookupFlightForMadrid,
  madridDateString,
  madridTimeString,
};
