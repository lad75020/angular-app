"use strict";

require("dotenv").config();

const path = require("path");
const fastify = require("fastify");
const bcrypt = require("bcrypt");
const staticPlugin = require("@fastify/static");
const view = require("@fastify/view");
const ejs = require("ejs");
const cookie = require("@fastify/cookie");
const session = require("@fastify/session");
const mongodb = require("@fastify/mongodb");
const { createClient } = require("redis");
const RedisStore = require("connect-redis").default;

const app = fastify({ logger: true });

const PORT = Number(process.env.PORT || 3000);
const MONGO_URL = process.env.MONGO_URL || "mongodb://127.0.0.1:27017/angular_app";
const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const SESSION_SECRET =
  process.env.SESSION_SECRET || "change-me-in-env-change-me-in-env";
const STATIC_DIR = process.env.STATIC_DIR || path.join(__dirname, "..", "public");
const VIEWS_DIR = path.join(__dirname, "views");
const TORN_AUTH_URL =
  process.env.TORN_AUTH_URL || "https://torn.dubertrand.fr/authenticate";
const TORN_AUTH_LOGIN_FIELD = process.env.TORN_AUTH_LOGIN_FIELD || "login";
const TORN_AUTH_PASSWORD_FIELD = process.env.TORN_AUTH_PASSWORD_FIELD || "password";
const TORN_AUTH_TOKEN_FIELD = process.env.TORN_AUTH_TOKEN_FIELD || "token";

app.register(mongodb, { url: MONGO_URL });
app.register(cookie);

const redisClient = createClient({ url: REDIS_URL });

redisClient.on("error", (err) => {
  app.log.error({ err }, "redis error");
});

async function buildSessionStore() {
  if (!redisClient.isOpen) {
    await redisClient.connect();
  }

  const store = new RedisStore({
    client: redisClient,
    prefix: "sess:",
  });

  app.register(session, {
    secret: SESSION_SECRET,
    cookieName: "sid",
    store,
    cookie: {
      httpOnly: true,
      secure: false,
      sameSite: "lax",
      path: "/",
    },
    saveUninitialized: false,
  });
}

app.register(staticPlugin, {
  root: STATIC_DIR,
  prefix: "/",
});

app.register(view, {
  engine: { ejs },
  root: VIEWS_DIR,
});

app.get("/api/health", async () => {
  return { ok: true };
});

app.get("/api/auth/me", async (request, reply) => {
  if (!request.session.user) {
    reply.code(401);
    return { ok: false, error: "Not authenticated" };
  }

  return { ok: true, user: request.session.user };
});

app.get("/api/user/ws-credentials", async (request, reply) => {
  if (!request.session.user) {
    reply.code(401);
    return { ok: false, error: "Not authenticated" };
  }

  const users = app.mongo.db.collection("users");
  const userId = request.session.user.id;
  const user = await users.findOne({ _id: new app.mongo.ObjectId(userId) });

  if (!user) {
    reply.code(404);
    return { ok: false, error: "User not found" };
  }

  const creds = user.wsCredentials || { login: "", password: "" };
  return { ok: true, credentials: creds };
});

app.post("/api/user/ws-credentials", async (request, reply) => {
  if (!request.session.user) {
    reply.code(401);
    return { ok: false, error: "Not authenticated" };
  }

  const { login, password } = request.body || {};

  if (!login || !password) {
    reply.code(400);
    return { ok: false, error: "Login and password required" };
  }

  const users = app.mongo.db.collection("users");
  const userId = request.session.user.id;
  const result = await users.updateOne(
    { _id: new app.mongo.ObjectId(userId) },
    {
      $set: {
        wsCredentials: { login, password },
        updatedAt: new Date(),
      },
    }
  );

  if (!result.matchedCount) {
    reply.code(404);
    return { ok: false, error: "User not found" };
  }

  return { ok: true };
});

app.post("/api/user/ws-token", async (request, reply) => {
  if (!request.session.user) {
    reply.code(401);
    return { ok: false, error: "Not authenticated" };
  }

  if (!TORN_AUTH_URL) {
    reply.code(501);
    return { ok: false, error: "TORN_AUTH_URL is not configured" };
  }

  if (typeof fetch !== "function") {
    reply.code(500);
    return { ok: false, error: "Fetch API is not available in this runtime" };
  }

  const users = app.mongo.db.collection("users");
  const userId = request.session.user.id;
  const user = await users.findOne({ _id: new app.mongo.ObjectId(userId) });

  if (!user || !user.wsCredentials) {
    reply.code(400);
    return { ok: false, error: "WebSocket credentials not set" };
  }

  const { login, password } = user.wsCredentials;
  if (!login || !password) {
    reply.code(400);
    return { ok: false, error: "WebSocket credentials not set" };
  }

  const authBody = {
    [TORN_AUTH_LOGIN_FIELD]: login,
    [TORN_AUTH_PASSWORD_FIELD]: password,
  };

  let response;
  try {
    response = await fetch(TORN_AUTH_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(authBody),
    });
  } catch (err) {
    request.log.error({ err }, "torn auth request failed");
    reply.code(502);
    return { ok: false, error: "Failed to reach auth endpoint" };
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    request.log.info(
      { status: response.status, body: text },
      "torn auth non-200 response"
    );
    reply.code(401);
    return {
      ok: false,
      error: text || "Auth failed",
      status: response.status,
    };
  }

  let data = null;
  try {
    data = await response.json();
  } catch (err) {
    reply.code(502);
    return { ok: false, error: "Invalid auth response" };
  }

  request.log.info({ authResponse: data }, "torn auth response payload");

  if (data && typeof data === "object" && data.error) {
    reply.code(401);
    return { ok: false, error: data.error };
  }

  const token =
    (data && data.token) ||
    (data && data[TORN_AUTH_TOKEN_FIELD]) ||
    (data && data.jwt) ||
    (data && data.accessToken);

  if (!token) {
    reply.code(502);
    return { ok: false, error: "Token not found in auth response" };
  }

  request.session.wsToken = token;
  return { ok: true, token };
});

app.post("/api/auth/signup", async (request, reply) => {
  const { email, password } = request.body || {};

  if (!email || !password) {
    reply.code(400);
    return { ok: false, error: "Email and password required" };
  }

  const users = app.mongo.db.collection("users");
  const existing = await users.findOne({ email });

  if (existing) {
    reply.code(409);
    return { ok: false, error: "Email already exists" };
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const now = new Date();
  const result = await users.insertOne({
    email,
    passwordHash,
    createdAt: now,
    updatedAt: now,
  });

  request.session.user = { id: result.insertedId.toString(), email };
  return { ok: true, user: request.session.user };
});

app.post("/api/auth/login", async (request, reply) => {
  const { email, password } = request.body || {};

  if (!email || !password) {
    reply.code(400);
    return { ok: false, error: "Email and password required" };
  }

  const users = app.mongo.db.collection("users");
  const user = await users.findOne({ email });

  if (!user) {
    reply.code(401);
    return { ok: false, error: "Invalid credentials" };
  }

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    reply.code(401);
    return { ok: false, error: "Invalid credentials" };
  }

  request.session.user = { id: user._id.toString(), email: user.email };
  return { ok: true, user: request.session.user };
});

app.post("/api/auth/logout", async (request, reply) => {
  await new Promise((resolve, reject) => {
    request.session.destroy((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
  reply.clearCookie("sid");
  return { ok: true };
});

app.get("/", async (request, reply) => {
  return reply.view("index.ejs");
});

app.get("/bazaar", async (request, reply) => {
  return reply.view("bazaar.ejs");
});

app.get("/admin", async (request, reply) => {
  return reply.view("admin.ejs");
});

app.get("/revives", async (request, reply) => {
  return reply.view("revives.ejs");
});

app.get("/xanax", async (request, reply) => {
  return reply.view("xanax.ejs");
});

app.setNotFoundHandler((request, reply) => {
  if (request.raw.url.startsWith("/api")) {
    reply.code(404).send({ ok: false, error: "Not found" });
    return;
  }

  reply.view("index.ejs");
});

async function start() {
  try {
    await buildSessionStore();
    await app.listen({ port: PORT, host: "0.0.0.0" });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
