# AngularJS + Fastify Starter

Scaffolded web app using AngularJS + Bootstrap for the frontend and Fastify for the backend. Sessions are stored in Redis and authentication data lives in MongoDB.

## Structure

- `public/` Static frontend assets (AngularJS + Bootstrap)
- `server/` Fastify server

## Requirements

- Node.js 18+
- Redis running on `127.0.0.1:6379`
- MongoDB running on `127.0.0.1:27017`
## Setup

```bash
cd server
npm install
cp .env.example .env
npm run dev
```

Open `http://localhost:3000`.

## API Endpoints

- `POST /api/auth/signup`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `GET /api/health`
