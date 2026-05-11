/**
 * Servidor Transfer Axor - Ubicación en tiempo real y pasajeros
 * Ruta: Campezo 10 Madrid ↔ T1, T2, T3, T4 Aeropuerto Barajas
 */

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const CONDUCTOR_ACCESS_KEY = process.env.CONDUCTOR_ACCESS_KEY || "";
const MAX_SIGNUP_PEOPLE = 15;

const CAMPEZO_DEFAULT = { lat: 40.447914, lng: -3.583004 };
const WAITING_LOCATIONS = ["hotel", "t1", "t2", "t3", "t4"];

const vehicles = {
  vito1: { lat: CAMPEZO_DEFAULT.lat, lng: CAMPEZO_DEFAULT.lng, label: "Vito 1", capacity: 8, passengers: 0, lastUpdate: null },
  vito2: { lat: CAMPEZO_DEFAULT.lat, lng: CAMPEZO_DEFAULT.lng, label: "Vito 2", capacity: 8, passengers: 0, lastUpdate: null },
  vito3: { lat: CAMPEZO_DEFAULT.lat, lng: CAMPEZO_DEFAULT.lng, label: "Vito 3", capacity: 8, passengers: 0, lastUpdate: null },
  vito4: { lat: CAMPEZO_DEFAULT.lat, lng: CAMPEZO_DEFAULT.lng, label: "Vito 4", capacity: 8, passengers: 0, lastUpdate: null },
  minibus: { lat: CAMPEZO_DEFAULT.lat, lng: CAMPEZO_DEFAULT.lng, label: "Minibús", capacity: 15, passengers: 0, lastUpdate: null },
};

const signups = new Map();

let activeVehicleId = null;
let activeSocketId = null;
const socketToVehicle = {};

if (process.env.GOOGLE_MAPS_API_KEY) {
  app.get("/config.js", (req, res) => {
    res.type("application/javascript");
    res.send("window.GOOGLE_MAPS_API_KEY = " + JSON.stringify(process.env.GOOGLE_MAPS_API_KEY) + ";\n");
  });
}

app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "mapa.html")));
app.get("/conductor", (req, res) => res.sendFile(path.join(__dirname, "public", "conductor.html")));
app.get("/apuntarse", (req, res) => res.redirect("/"));

function emptyWaitingCounts() {
  return { hotel: 0, t1: 0, t2: 0, t3: 0, t4: 0 };
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
    };
  }
  return out;
}

function emitWaitingToConductors() {
  io.to("conductors").emit("waiting", getWaitingCounts());
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

io.on("connection", (socket) => {
  socket.emit("vehicles", getVehiclesForClients());

  const existingSignup = signups.get(socket.id);
  if (existingSignup) {
    socket.emit("signup-status", {
      location: existingSignup.location,
      people: existingSignup.people || 1,
    });
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
  });

  socket.on("register", (data) => {
    const vehicleId = data && data.vehicleId;
    if (!vehicles[vehicleId]) return;
    if (activeSocketId && activeSocketId !== socket.id) {
      delete socketToVehicle[activeSocketId];
    }
    clearAllVehicles();
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
    signups.set(socket.id, { location, people });
    socket.emit("signup-status", { location, people });
    broadcastState();
  });

  socket.on("cancel-signup", () => {
    removeSignup(socket.id);
    socket.emit("signup-status", { location: null, people: 0 });
  });

  socket.on("disconnect", () => {
    removeSignup(socket.id);
    if (socket.id === activeSocketId) {
      clearAllVehicles();
      activeVehicleId = null;
      activeSocketId = null;
      delete socketToVehicle[socket.id];
      broadcastState();
    } else {
      delete socketToVehicle[socket.id];
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Transfer Axor: http://localhost:${PORT}`);
  console.log(`  - Cliente (mapa):  http://localhost:${PORT}`);
  console.log(`  - Conductor:       http://localhost:${PORT}/conductor`);
  if (!CONDUCTOR_ACCESS_KEY) {
    console.log("  - Aviso: CONDUCTOR_ACCESS_KEY no definida; el panel de conductor queda abierto.");
  }
});
