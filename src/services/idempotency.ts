import { Redis } from "ioredis";
import { config } from "../config.js";

export const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    return Math.min(times * 100, 2000);
  },
  lazyConnect: true,
});

export class IdempotencyService {
  /**
   * Acquire an idempotency lock for an in-flight request.
   * Returns true if lock was acquired, false if request is already in-flight or completed.
   */
  static async acquireLock(
    merchantId: string,
    idempotencyKey: string,
    ttlSeconds: number = config.REDIS_IDEMPOTENCY_TTL_SECONDS
  ): Promise<boolean> {
    const key = `aegis:lock:${merchantId}:${idempotencyKey}`;
    const acquired = await redis.set(key, "PROCESSING", "EX", ttlSeconds, "NX");
    return acquired === "OK";
  }

  /**
   * Cache the response for an idempotency key so subsequent identical calls receive the exact same response.
   */
  static async saveResponse(
    merchantId: string,
    idempotencyKey: string,
    responseData: unknown,
    ttlSeconds: number = config.REDIS_IDEMPOTENCY_TTL_SECONDS
  ): Promise<void> {
    const key = `aegis:resp:${merchantId}:${idempotencyKey}`;
    await redis.set(key, JSON.stringify(responseData), "EX", ttlSeconds);
  }

  /**
   * Retrieve cached response if previously processed.
   */
  static async getCachedResponse<T>(
    merchantId: string,
    idempotencyKey: string
  ): Promise<T | null> {
    const key = `aegis:resp:${merchantId}:${idempotencyKey}`;
    const data = await redis.get(key);
    if (!data) return null;
    return JSON.parse(data) as T;
  }

  /**
   * Release an in-flight lock if execution fails before state commit.
   */
  static async releaseLock(merchantId: string, idempotencyKey: string): Promise<void> {
    const key = `aegis:lock:${merchantId}:${idempotencyKey}`;
    await redis.del(key);
  }
}
