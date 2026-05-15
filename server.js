/**
 * Servidor Transfer Axor - Ubicación en tiempo real y pasajeros
 * Ruta: Campezo 4 Madrid ↔ T1, T2, T3, T4 Aeropuerto Barajas
 */

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const {
  normalizeFlightCode,
  lookupFlightForMadrid,
  legToWaitingLocation,
  isFlightLookupConfigured,
} = require("./lib/flightLookup");

const app = express();
const server = http.createServer(app);

/** Conexiones móviles en segundo plano o redes inestables: más margen antes de dar por muerto el socket */
const io = new Server(server, {
  pingInterval: 25000,
  pingTimeout: 120000,
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000,
    skipMiddlewares: true,
  },
});

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const CONDUCTOR_ACCESS_KEY = process.env.CONDUCTOR_ACCESS_KEY || "";
const MAX_SIGNUP_PEOPLE = 15;
/** Tras desconectar el conductor, mantener última posición en mapas hasta este tiempo (ms). */
const CONDUCTOR_GRACE_MS = Number(process.env.CONDUCTOR_GRACE_MS) || 45 * 60 * 1000;

const CAMPEZO_DEFAULT = { lat: 40.4479297, lng: -3.5830589 };
const WAITING_LOCATIONS = ["hotel", "t1", "t2", "t4"];
// Destinos válidos desde cualquier parada (el origen no puede coincidir con el destino; se valida en cliente)
const VALID_DESTINATIONS = new Set(["hotel", "t1", "t2", "t4", "ifema", "simuladores"]);

/** circuit: ruta circular programada. adhoc: IFEMA, simuladores, apoyo, etc. (editable por vehículo) */
const vehicles = {
  vito1: {
    lat: CAMPEZO_DEFAULT.lat,
    lng: CAMPEZO_DEFAULT.lng,
    label: "Vito NJC",
    capacity: 8,
    passengers: 0,
    lastUpdate: null,
    serviceMode: "circuit",
    circuitSchedule: "A",
  },
  vito2: {
    lat: CAMPEZO_DEFAULT.lat,
    lng: CAMPEZO_DEFAULT.lng,
    label: "Vito LZD",
    capacity: 8,
    passengers: 0,
    lastUpdate: null,
    serviceMode: "circuit",
    circuitSchedule: "B",
  },
  vito3: {
    lat: CAMPEZO_DEFAULT.lat,
    lng: CAMPEZO_DEFAULT.lng,
    label: "Vito MMR",
    capacity: 8,
    passengers: 0,
    lastUpdate: null,
    serviceMode: "adhoc",
    circuitSchedule: null,
  },
  vito4: {
    lat: CAMPEZO_DEFAULT.lat,
    lng: CAMPEZO_DEFAULT.lng,
    label: "Vito MDX",
    capacity: 8,
    passengers: 0,
    lastUpdate: null,
    serviceMode: "adhoc",
    circuitSchedule: null,
  },
  minibus: {
    lat: CAMPEZO_DEFAULT.lat,
    lng: CAMPEZO_DEFAULT.lng,
    label: "Minibus MSX",
    capacity: 15,
    passengers: 0,
    lastUpdate: null,
    serviceMode: "adhoc",
    circuitSchedule: null,
  },
};

const signups = new Map();
const scheduledTrips = new Map();
const MADRID_TZ = "Europe/Madrid";

let activeVehicleId = null;
let activeSocketId = null;
const socketToVehicle = {};
let conductorGraceTimer = null;

function cancelConductorGraceTimer() {
  if (conductorGraceTimer) {
    clearTimeout(conductorGraceTimer);
    conductorGraceTimer = null;
  }
}

function scheduleConductorStaleCleanup() {
  cancelConductorGraceTimer();
  conductorGraceTimer = setTimeout(function() {
    conductorGraceTimer = null;
    if (activeSocketId !== null) return;
    if (!activeVehicleId) return;
    clearAllVehicles();
    activeVehicleId = null;
    broadcastState();
  }, CONDUCTOR_GRACE_MS);
}

app.get("/config.js", (req, res) => {
  const key = process.env.GOOGLE_MAPS_API_KEY || "";
  res.type("application/javascript");
  res.send("window.GOOGLE_MAPS_API_KEY = " + JSON.stringify(key) + ";\n");
});

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/flight-lookup", async (req, res) => {
  const location = String(req.query.location || "").toLowerCase();
  try {
    if (!isFlightLookupConfigured()) {
      return res.status(503).json({ ok: false, error: "flight-lookup-unavailable" });
    }
    const result = await lookupFlightForMadrid(req.query.code, { location });
    if (!result.ok) {
      const status =
        result.error === "flight-not-found"
          ? 404
          : result.error === "flight-lookup-unauthorized"
            ? 503
            : 400;
      return res.status(status).json(result);
    }
    return res.json(result);
  } catch (err) {
    console.error("flight-lookup:", err.message || err);
    return res.status(500).json({ ok: false, error: "flight-lookup-failed" });
  }
});

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "mapa.html")));
app.get("/hotel", (req, res) => res.sendFile(path.join(__dirname, "public", "hotel.html")));
app.get("/conductor", (req, res) => res.sendFile(path.join(__dirname, "public", "conductor.html")));
app.get("/apuntarse", (req, res) => res.redirect("/"));

function emptyWaitingCounts() {
  return { hotel: 0, t1: 0, t2: 0, t4: 0 };
}

function getWaitingCounts() {
  const counts = emptyWaitingCounts();
  for (const signup of signups.values()) {
    if (counts[signup.location] !== undefined) {
      counts[signup.location] += signup.people || 1;
    }
  }
  return counts;
}

function clearAllVehicles() {
  for (const id of Object.keys(vehicles)) {
    vehicles[id].lat = CAMPEZO_DEFAULT.lat;
    vehicles[id].lng = CAMPEZO_DEFAULT.lng;
    vehicles[id].lastUpdate = null;
    vehicles[id].passengers = 0;
  }
}

function getVehiclesForClients() {
  const out = {};
  for (const id of Object.keys(vehicles)) {
    out[id] = {
      lat: vehicles[id].lat,
      lng: vehicles[id].lng,
      label: vehicles[id].label,
      capacity: vehicles[id].capacity,
      passengers: vehicles[id].passengers,
      lastUpdate: id === activeVehicleId ? vehicles[id].lastUpdate : null,
      serviceMode: vehicles[id].serviceMode || "circuit",
      circuitSchedule: vehicles[id].circuitSchedule != null ? vehicles[id].circuitSchedule : null,
    };
  }
  return out;
}

function emitWaitingToConductors() {
  io.to("conductors").emit("waiting", getWaitingCounts());
}

function getScheduledTripsForConductors() {
  const list = [];
  for (const trip of scheduledTrips.values()) {
    list.push({ ...trip });
  }
  list.sort(function(a, b) {
    const aKey =
      a.departureDate && a.departureTime
        ? a.departureDate + "T" + a.departureTime
        : "z" + (a.flightCode || "");
    const bKey =
      b.departureDate && b.departureTime
        ? b.departureDate + "T" + b.departureTime
        : "z" + (b.flightCode || "");
    return aKey.localeCompare(bKey);
  });
  return list;
}

function emitScheduledTripsToConductors() {
  io.to("conductors").emit("scheduled-trips", getScheduledTripsForConductors());
}

function broadcastState() {
  io.emit("vehicles", getVehiclesForClients());
  emitWaitingToConductors();
}

function removeSignup(socketId) {
  if (signups.delete(socketId)) broadcastState();
}

function clampPassengers(count, capacity) {
  const n = Number(count);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(capacity, Math.round(n)));
}

function clampSignupPeople(count) {
  const n = Number(count);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(MAX_SIGNUP_PEOPLE, Math.round(n)));
}

function isConductorAuthorized(token) {
  if (!CONDUCTOR_ACCESS_KEY) return true;
  return token === CONDUCTOR_ACCESS_KEY;
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

function parseDepartureDate(dateStr) {
  const match = String(dateStr || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return match[0];
}

function parseDepartureTime(timeStr) {
  const match = String(timeStr || "").match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return match[1] + ":" + match[2];
}

function isDepartureInPast(departureDate, departureTime) {
  const today = madridDateString();
  if (departureDate < today) return true;
  if (departureDate > today) return false;
  return departureTime <= madridTimeString();
}

function removeScheduledTrip(socketId) {
  if (scheduledTrips.delete(socketId)) emitScheduledTripsToConductors();
}

io.on("connection", (socket) => {
  socket.emit("vehicles", getVehiclesForClients());

  const existingSignup = signups.get(socket.id);
  if (existingSignup) {
    socket.emit("signup-status", {
      location: existingSignup.location,
      people: existingSignup.people || 1,
      destination: existingSignup.destination || null,
    });
  }

  const existingTrip = scheduledTrips.get(socket.id);
  if (existingTrip) {
    socket.emit("trip-schedule-status", existingTrip);
  }

  socket.on("conductor-auth", (data) => {
    const token = data && data.token;
    if (!isConductorAuthorized(token)) {
      socket.emit("conductor-auth-fail");
      return;
    }
    socket.join("conductors");
    socket.data.isConductor = true;
    socket.emit("conductor-auth-ok");
    socket.emit("waiting", getWaitingCounts());
    socket.emit("scheduled-trips", getScheduledTripsForConductors());
  });

  socket.on("register", (data) => {
    const vehicleId = data && data.vehicleId;
    if (!vehicles[vehicleId]) return;
    cancelConductorGraceTimer();
    if (activeSocketId && activeSocketId !== socket.id) {
      delete socketToVehicle[activeSocketId];
    }
    const reconnectSameVehicle = activeVehicleId === vehicleId && activeSocketId === null;
    const vehicleChange = activeVehicleId !== null && activeVehicleId !== vehicleId;
    const firstRegistration = activeVehicleId === null;
    if (!reconnectSameVehicle && (vehicleChange || firstRegistration)) {
      clearAllVehicles();
    }
    activeVehicleId = vehicleId;
    activeSocketId = socket.id;
    socketToVehicle[socket.id] = vehicleId;
    broadcastState();
  });

  socket.on("position", (data) => {
    const vehicleId = socketToVehicle[socket.id];
    if (!vehicleId || !vehicles[vehicleId]) return;
    const lat = data && data.lat;
    const lng = data && data.lng;
    if (typeof lat !== "number" || typeof lng !== "number") return;

    vehicles[vehicleId].lat = lat;
    vehicles[vehicleId].lng = lng;
    vehicles[vehicleId].lastUpdate = new Date().toISOString();
    broadcastState();
  });

  socket.on("passengers", (data) => {
    const vehicleId = socketToVehicle[socket.id];
    if (!vehicleId || !vehicles[vehicleId]) return;
    vehicles[vehicleId].passengers = clampPassengers(data && data.count, vehicles[vehicleId].capacity);
    broadcastState();
  });

  socket.on("signup", (data) => {
    const location = data && data.location;
    if (!WAITING_LOCATIONS.includes(location)) return;
    const people = clampSignupPeople(data && data.people);
    const d = String((data && data.destination) || "").toLowerCase();
    if (!VALID_DESTINATIONS.has(d)) return;
    if (d === location) return; // origen ≡ destino no tiene sentido
    const destination = d;
    signups.set(socket.id, { location, people, destination });
    socket.emit("signup-status", { location, people, destination });
    broadcastState();
  });

  socket.on("cancel-signup", () => {
    removeSignup(socket.id);
    socket.emit("signup-status", { location: null, people: 0 });
  });

  socket.on("schedule-trip", async (data) => {
    const mode = data && data.mode === "flight" ? "flight" : "datetime";
    let location = data && data.location;
    const people =
      mode === "flight" ? 1 : clampSignupPeople(data && data.people);

    if (mode === "flight") {
      const flightCode = normalizeFlightCode(data && data.flightCode);
      if (flightCode.length < 3) {
        socket.emit("trip-schedule-status", { active: false, error: "invalid-flight" });
        return;
      }
      if (!isFlightLookupConfigured()) {
        socket.emit("trip-schedule-status", { active: false, error: "flight-lookup-unavailable" });
        return;
      }
      const hintLocation = WAITING_LOCATIONS.includes(location) ? location : "";
      let lookup;
      try {
        lookup = await lookupFlightForMadrid(flightCode, { location: hintLocation });
      } catch (err) {
        console.error("schedule-trip flight:", err.message || err);
        socket.emit("trip-schedule-status", { active: false, error: "flight-lookup-failed" });
        return;
      }
      if (!lookup.ok || !lookup.leg) {
        socket.emit("trip-schedule-status", {
          active: false,
          error: lookup.error || "flight-not-found",
        });
        return;
      }
      location =
        lookup.suggestedLocation ||
        legToWaitingLocation(lookup.leg) ||
        (WAITING_LOCATIONS.includes(location) ? location : null);
      if (!WAITING_LOCATIONS.includes(location)) {
        socket.emit("trip-schedule-status", { active: false, error: "flight-terminal-unknown" });
        return;
      }
      const trip = {
        location: location,
        people: 1,
        mode: "flight",
        active: true,
        flightCode: flightCode,
        flightDate: lookup.leg.date,
        flightTime: lookup.leg.time,
        flightLeg: lookup.leg.direction,
        flightTerminal: lookup.leg.terminal || null,
        flightTerminalLabel: lookup.leg.terminalLabel || null,
        flightOtherAirport: lookup.leg.otherIata || null,
        flightOtherAirportName: lookup.leg.otherName || null,
        flightStatus: lookup.leg.status || null,
        departureDate: lookup.leg.date,
        departureTime: lookup.leg.time,
      };
      scheduledTrips.set(socket.id, trip);
      socket.emit("trip-schedule-status", trip);
      emitScheduledTripsToConductors();
      return;
    }

    if (!WAITING_LOCATIONS.includes(location)) {
      socket.emit("trip-schedule-status", { active: false, error: "invalid-location" });
      return;
    }
    const trip = { location, people, mode, active: true };

    if (mode === "datetime") {
      const departureDate = parseDepartureDate(data && data.departureDate);
      const departureTime = parseDepartureTime(data && data.departureTime);
      if (!departureDate || !departureTime) {
        socket.emit("trip-schedule-status", { active: false, error: "invalid-datetime" });
        return;
      }
      if (isDepartureInPast(departureDate, departureTime)) {
        socket.emit("trip-schedule-status", { active: false, error: "past-datetime" });
        return;
      }
      trip.departureDate = departureDate;
      trip.departureTime = departureTime;
    }

    scheduledTrips.set(socket.id, trip);
    socket.emit("trip-schedule-status", trip);
    emitScheduledTripsToConductors();
  });

  socket.on("cancel-trip-schedule", () => {
    removeScheduledTrip(socket.id);
    socket.emit("trip-schedule-status", { active: false });
  });

  socket.on("disconnect", () => {
    removeSignup(socket.id);
    removeScheduledTrip(socket.id);
    if (socket.id === activeSocketId) {
      delete socketToVehicle[socket.id];
      activeSocketId = null;
      scheduleConductorStaleCleanup();
      broadcastState();
    } else {
      delete socketToVehicle[socket.id];
    }
  });
});

setInterval(function() {
  io.emit("vehicles", getVehiclesForClients());
}, 3000);

server.listen(PORT, HOST, () => {
  console.log(`Transfer Axor: http://localhost:${PORT}`);
  console.log(`  - Cliente (mapa):  http://localhost:${PORT}`);
  console.log(`  - Hotel (TV):      http://localhost:${PORT}/hotel`);
  console.log(`  - Conductor:       http://localhost:${PORT}/conductor`);
  if (!CONDUCTOR_ACCESS_KEY) {
    console.log("  - Aviso: CONDUCTOR_ACCESS_KEY no definida; el panel de conductor queda abierto.");
  }
});
