import express from "express";
import { pino } from "pino";
import { config } from "./config.js";
import { router } from "./api/routes.js";
import { redis } from "./services/idempotency.js";
import { pool } from "./db/db.js";

const logger = pino({
  level: config.LOG_LEVEL,
  transport: config.NODE_ENV === "development" ? { target: "pino-pretty" } : undefined,
});

const app = express();

app.use(express.json());

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    logger.info({
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Date.now() - start,
    });
  });
  next();
});

app.use(router);

async function startServer() {
  try {
    // Verify Redis connection
    await redis.connect().catch((err) => {
      logger.warn(`Redis lazy-connect: ${err.message} (Will retry on command)`);
    });

    // Test DB connection
    await pool.query("SELECT 1");
    logger.info("Database connection established");

    app.listen(config.PORT, () => {
      logger.info(`Aegis Payment Switch listening on port ${config.PORT} [Cluster: ${config.SOLANA_CLUSTER}]`);
    });
  } catch (err) {
    logger.error({ err }, "Fatal startup error");
    // In dev mode, still allow server to listen so tests and mocking can run
    app.listen(config.PORT, () => {
      logger.warn(`Aegis Payment Switch started with offline warning on port ${config.PORT}`);
    });
  }
}

if (process.env.NODE_ENV !== "test") {
  startServer();
}

export { app };
