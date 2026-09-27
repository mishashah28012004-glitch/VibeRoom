# VibeRoom

VibeRoom is a real-time YouTube watch-party application with room membership, roles, synchronized playback, participant requests, and chat. The React/Vite frontend and Express/Socket.IO/MySQL backend deploy independently.

## Project Structure

```text
VibeRoom/
  client/                 React + Vite frontend; Netlify base directory
    public/_redirects     Netlify SPA refresh fallback
    src/                  UI, REST client, and Socket.IO client
    .env.example
    package.json
    vite.config.js
  backend/                Express + Socket.IO + MySQL API; Render root
    routes/rooms.js       Authentication, room, membership, and role endpoints
    server.js             REST API, socket events, and health check
    db.js                 MySQL connection pool
    auth.js               JWT signing and validation
    migrate.js            Additive schema initialization
    package.json
    .env.example
    .gitignore
  netlify.toml
  render.yaml
```

The old root `public/` assets are retained as legacy files; the separated backend does not serve them. Current frontend files and dependencies live under `client/`. Backend files and dependencies live under `backend/`.

## Features And Connections

- Guest identity is created by `POST /api/auth/guest`; a signed JWT is used for room membership and authenticated endpoints.
- Rooms can be generated or manually created, checked, joined, and queried. Hosts can assign roles, remove participants, and transfer ownership.
- Socket.IO validates a user's token and room membership on `join-room`. Host/moderator playback events update persisted video state and synchronize viewers.
- Approved participant playback requests, live room chat, participant updates, and host/role changes use the existing Socket.IO protocol.
- MySQL stores users, rooms, room participants, room events, and room bans. The server keeps transient chat and pending requests in memory.

REST endpoints:

- `POST /api/auth/guest`
- `POST /api/rooms/generate-code`
- `GET /api/rooms/check/:roomCode`
- `POST /api/rooms`
- `GET /api/rooms/:roomCode`
- `POST /api/rooms/:roomCode/join`
- `GET /api/rooms/:roomCode/participants`
- `PATCH /api/rooms/:roomCode/participants/:userId/role`
- `DELETE /api/rooms/:roomCode/participants/:userId`
- `POST /api/rooms/:roomCode/transfer-host`
- `GET /health` (includes a database connectivity check)

The Socket.IO flow preserves `playback:play`, `playback:pause`, `playback:seek`, `playback:changeVideo`, `video-state`, `request:action`, `request:respond`, `room-chat`, `participants:update`, and the existing role/removal/host-transfer events.

## Requirements

- Node.js 20.19+ or 22.12+
- npm
- A reachable MySQL database (local or hosted)

## Local Development

Create the backend environment file and install backend dependencies from PowerShell:

```powershell
Set-Location backend
Copy-Item .env.example .env
npm install
```

Edit `backend/.env` with a reachable MySQL host, database name, username, password, and a unique JWT secret of at least 32 characters. Set `CLIENT_ORIGIN=http://localhost:5173`. Create the database if needed, without dropping existing data:

```sql
CREATE DATABASE watchparty CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

The migration uses only `CREATE TABLE IF NOT EXISTS`; run it once against the selected database:

```powershell
npm run migrate
npm start
```

In a second terminal, install and run the frontend:

```powershell
Set-Location client
npm install
Copy-Item .env.example .env
npm run dev
```

Open the Vite URL, normally `http://localhost:5173`. With `VITE_API_URL` blank, Vite proxies `/api` and `/socket.io` to `http://localhost:3000`. To use another backend port locally, set `VITE_API_PROXY_TARGET` in `client/.env` and update the backend `PORT` and `CLIENT_ORIGIN` accordingly.

Build and preview the frontend independently:

```powershell
Set-Location client
npm run build
npm run preview
```

## Environment Variables

Set these on the Render backend service. `PORT` is supplied by Render and defaults to `3000` locally.

| Variable | Required | Purpose |
| --- | --- | --- |
| `PORT` | Platform/local default | HTTP and Socket.IO port |
| `DB_HOST` | Yes | MySQL server hostname; use the hosted provider's remote hostname on Render |
| `DB_PORT` | No, defaults to `3306` | MySQL server port |
| `DB_NAME` | Yes | Existing MySQL database name |
| `DB_USER` | Yes | MySQL username |
| `DB_PASS` | Yes | MySQL password |
| `JWT_SECRET` | Yes | Unique signing secret, at least 32 characters |
| `CLIENT_ORIGIN` | Yes in production | Exact Netlify site origin; comma-separate additional trusted origins |

For local development, `CLIENT_ORIGIN` should include the Vite origin. Production must use HTTPS origins and must not use `*`. Keep all backend secrets only in Render's environment settings or the ignored `backend/.env`; never add them to `client/.env` or `VITE_*` variables.

Netlify needs one build-time environment variable:

| Variable | Value |
| --- | --- |
| `VITE_API_URL` | Render backend origin, such as `https://viberoom-backend.onrender.com` (no `/api` suffix) |

`VITE_API_URL` is public browser configuration, not a secret. The client uses it for both REST and Socket.IO. Netlify's SPA fallback is in `client/public/_redirects`.

## Deploy

### Render Backend

1. Provision a remote MySQL database. Ensure it permits connections from Render and note its host, port, database name, user, and password. Use the database containing existing VibeRoom data if migrating an existing deployment; do not create a replacement database unintentionally.
2. Create a Render Web Service from this repository using the included `render.yaml`, or configure it manually with root directory `backend`, build command `npm install`, start command `npm start`, and health check path `/health`.
3. Set `DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASS`, `JWT_SECRET`, and `CLIENT_ORIGIN` in Render. Set `CLIENT_ORIGIN` to the exact Netlify origin after creating the site. Render supplies `PORT`; `DB_PORT` defaults to `3306` in the Blueprint.
4. Run the additive schema migration once using the Render Shell: `npm run migrate` from the backend root. This creates missing tables but does not drop or clear existing tables.
5. Verify the service's `/health` response reports `{"ok":true,"db":"connected"}`. The API process intentionally does not accept traffic when the configured MySQL connection cannot be established.

### Netlify Frontend

1. Import the same GitHub repository into Netlify.
2. Set base directory to `client`, build command to `npm run build`, and publish directory to `dist`. These values are also recorded in the root `netlify.toml`.
3. Set `VITE_API_URL` to the Render service origin, with no trailing slash or `/api` suffix, then deploy/redeploy so the value is included in the Vite build.
4. Set Render `CLIENT_ORIGIN` to the deployed Netlify site origin (for example, `https://your-site.netlify.app`). Add any additional exact frontend origins as a comma-separated list, then redeploy the backend.
5. Confirm `/health`, guest creation, room creation/join, Socket.IO WebSocket connection, playback synchronization, chat, and participant updates using two browser sessions.

### Railway Backend And Vercel Frontend

For Railway, configure the service root directory as `/backend`, build command as `npm install`, start command as `npm start`, and health check path as `/health`. The backend `railway.json` supplies the build/start/health-check settings when Railway uses that config file. Set `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASS`, `JWT_SECRET`, and `CLIENT_ORIGIN` in the Railway service variables. Set `CLIENT_ORIGIN` to `https://vibe-room-flax.vercel.app` (include `http://localhost:5173` only if local development should also be allowed). Run `npm run migrate` once in the Railway service shell after verifying the database values.

For Vercel, configure the project root directory as `client`, framework preset as Vite, and set the project environment variable `VITE_API_URL` to `https://viberoom-production-1cf2.up.railway.app` without a trailing slash. Redeploy after changing the environment variable. `client/public/_redirects` is for Netlify; Vercel's Vite SPA fallback is handled by its static deployment behavior for this app's root-only route.

The backend can run locally and the frontend can build locally without deployment credentials. Actual hosted database, account, and two-browser integration tests require valid external services and must be run after provisioning; no deployment is claimed here.

## Database And Runtime Notes

The migration creates `users`, `rooms`, `room_participants`, `room_events`, and `room_bans` if absent. It does not create the database itself and does not drop data. Room membership, roles, bans, and video state are persistent. Chat history and pending playback approvals are in-memory only, and a single backend instance is expected until shared Socket.IO and transient state are configured.

YouTube playback depends on each video's embed permissions and browser autoplay policy. A hosted MySQL provider may require additional network allowlisting or TLS configuration. Confirm the provider's connection requirements before deployment.