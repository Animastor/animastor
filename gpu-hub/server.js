// GPU Hub entrypoint. gpu-hub.js exports a testable buildHubApp factory;
// this file wires the real Redis client + env config and starts the server.
const { buildHubApp } = require('./gpu-hub');

const REDIS_URL = process.env.REDIS_URL || "redis://animastor-redis:6379";
const redis = new (require("ioredis"))(REDIS_URL);
const { PORT = 5000 } = process.env;

const app = buildHubApp({
  redis,
  config: {
    BACKEND_URL: process.env.BACKEND_URL || "http://animastor-backend:3000",
    GPU_TIMEOUT_MS: Number(process.env.GPU_TIMEOUT_MS ?? process.env.GPU_TIMEOUT ?? 600000),
    GPU_HUB_API_KEY: process.env.GPU_HUB_API_KEY || null,
  },
});

const server = app.listen(PORT, () => {
  console.log("🚀 GPU HUB running on", PORT);
});

process.on('SIGTERM', async () => {
  console.log("[SHUTDOWN] SIGTERM received, shutting down...");
  app.__hub.stopIntervals();
  server.close(() => {
    console.log("[SHUTDOWN] HTTP server closed");
  });
  try {
    await redis.quit();
    console.log("[SHUTDOWN] Redis connection closed");
  } catch (_) {}
  console.log("[SHUTDOWN] Goodbye");
  process.exit(0);
});
