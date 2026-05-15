# Transfer Axor — Ubicación en tiempo real

Webapp para ver en tiempo real la ubicación de los transfers entre **Calle Campezo 4 (Madrid)** y las terminales **T1, T2, T3 y T4** del Aeropuerto de Barajas. Incluye 3 minibuses y 1 bus en un recorrido circular.

## Cómo funciona

- **Pantalla principal (mapa)**: Muestra el mapa con la ruta fija (Campezo 4 → T1 → T2 → T3 → T4 → Campezo 4) y la posición en vivo de cada vehículo. Ideal para mostrarla en recepción del hotel o para que los pasajeros esperando vean dónde está su transfer.
- **Modo conductor**: El conductor abre en el móvil la página “Modo conductor”, elige su vehículo (Minibús 1/2/3 o Bus) y deja la página abierta. El GPS del móvil envía la posición cada pocos segundos al servidor y se actualiza en el mapa.

## Requisitos

- Node.js 18 o superior
- **Google Maps**: Para ver el mapa y la ruta por carretera necesitas una API key de Google Cloud:
  1. Entra en [Google Cloud Console](https://console.cloud.google.com/) y crea o elige un proyecto.
  2. Activa **Maps JavaScript API** y **Directions API** (o “Directions API (Legacy)”).
  3. Crea una clave de API (APIs y servicios → Credenciales → Crear credenciales → Clave de API).
  4. En el proyecto: copia `public/config.js.example` como `public/config.js` y escribe tu clave:  
     `window.GOOGLE_MAPS_API_KEY = "tu_clave_aqui";`  
     O bien edita `public/mapa.html` y sustituye `YOUR_GOOGLE_MAPS_API_KEY` por tu clave.

- **Consulta de vuelos** (programar con código tipo `IB872`): el servidor consulta horarios reales y comprueba que el vuelo **sale o llega a Madrid-Barajas (MAD)**. Necesitas al menos una de estas variables de entorno:
  - **AeroDataBox** (recomendado, [RapidAPI AeroDataBox](https://rapidapi.com/aerodatabox/api/aerodatabox)): `AERODATABOX_RAPIDAPI_KEY` (o `AERODATABOX_API_KEY` si usas la suscripción directa).
  - **Aviationstack** (alternativa, [aviationstack.com](https://aviationstack.com)): `AVIATIONSTACK_API_KEY`.

  Sin clave, el mapa sigue funcionando; solo fallará la programación por código de vuelo.

## Instalación y arranque

```bash
cd app_transferAxor
npm install
npm start
```

Luego abre en el navegador:

- **Mapa (pantalla principal)**: http://localhost:3000
- **Conductor (móvil)**: http://localhost:3000/conductor

Para usar desde el móvil del conductor, el servidor debe ser accesible en la red (misma WiFi o exponer con ngrok/túnel). En el mismo ordenador puedes probar abriendo el mapa en el PC y /conductor en el móvil (usando la IP del PC en la red, por ejemplo `http://192.168.1.X:3000/conductor`).

## Estructura

- `server.js` — Servidor Express + Socket.io; guarda y difunde las posiciones de los 4 vehículos.
- `public/mapa.html` — Vista del mapa con **Google Maps**: ruta por carretera (Directions API) Campezo 4 ↔ T1–T4 y marcadores en tiempo real.
- `public/conductor.html` — Vista para el conductor: selección de vehículo y envío de GPS.
- `public/styles.css` — Estilos comunes.

## Notas

- **Hotel**: Calle Campezo 4, 28022 Madrid (San Blas). Coordenadas usadas en la app para el hotel y la ETA.
- Las posiciones por defecto de los vehículos están en Campezo 4 hasta que un conductor envíe su ubicación.
- La ruta que se dibuja es la calculada por Google (por carretera) en el orden: Campezo 4 → T1 → T2 → T3 → T4 → Campezo 4.