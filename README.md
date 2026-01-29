# Torn City Stats Dashboard

A Torn City helper dashboard built with AngularJS and Fastify. It pulls live items
and price data via WebSocket, stores log history in IndexedDB, and renders
activity charts for revives, xanax, training, and crime skills.

## Features
- Signup/login with server-side sessions (Redis) and users stored in MongoDB.
- New accounts are created as inactive and require approval.
- Admin panel to manage WebSocket credentials and approve/delete pending users.
- Bazaar view with live price updates and daily-average charts.
- Logs import via WebSocket, cached locally in IndexedDB (idb wrapper).
- D3 charts for revives, xanax, training, and crime skill progression.

## Pages
- `/` Signup/login
- `/bazaar` Items + price history
- `/revives` Revive success/failure chart
- `/xanax` Xanax usage chart
- `/training` Training stat history
- `/crime-skills` Crime skill levels grouped by crime
- `/admin` WS credentials + pending account approvals

## Stack
- Frontend: AngularJS, Bootstrap, D3, idb (IndexedDB wrapper)
- Backend: Fastify + EJS
- Data: MongoDB (users), Redis (sessions)

## Account approval flow
1. A user signs up and is created as inactive.
2. Any active user can open `/admin` and approve or delete pending accounts.
3. Inactive users cannot log in or access the app.

## Requirements
- Node.js 18+
- MongoDB (default: `mongodb://127.0.0.1:27017/angular_app`)
- Redis (default: `redis://127.0.0.1:6379`)

## Configuration
These are read from environment variables (defaults shown):
- `PORT=3000`
- `MONGO_URL=mongodb://127.0.0.1:27017/angular_app`
- `REDIS_URL=redis://127.0.0.1:6379`
- `SESSION_SECRET=change-me-in-env-change-me-in-env`
- `STATIC_DIR=../public`
- `TORN_AUTH_URL=https://torn.dubertrand.fr/authenticate`
- `TORN_AUTH_LOGIN_FIELD=login`
- `TORN_AUTH_PASSWORD_FIELD=password`
- `TORN_AUTH_TOKEN_FIELD=token`

## Setup
```bash
cd server
npm install
npm run dev
```
Open `http://localhost:3000`.

## Data flow notes
- WebSocket credentials are stored per user in the Admin page.
- Item/price streams and log imports come from `wss://torn.dubertrand.fr`.
- Logs are fetched on demand and cached in IndexedDB (via `idb`).
- Charts are rendered with D3 based on the IndexedDB log store.

## API endpoints
- `POST /api/auth/signup`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `GET /api/admin/pending-users`
- `POST /api/admin/users/:id/activate`
- `DELETE /api/admin/users/:id`
- `GET /api/health`
