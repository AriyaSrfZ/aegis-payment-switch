import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  PORT: z.string().default("4000").transform((val) => parseInt(val, 10)),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z.string().default("info"),

  // [HUMAN EDIT]: Solana RPC Connection
  SOLANA_RPC_URL: z.string().url().default("https://api.mainnet-beta.solana.com"),
  SOLANA_CLUSTER: z.string().default("mainnet-beta"),

  // [HUMAN EDIT]: Master Treasury Address (Cold/Warm Vault)
  MASTER_TREASURY_ADDRESS: z.string().min(32).max(44),

  // [HUMAN EDIT]: SPL USDC Mint Address
  USDC_MINT_ADDRESS: z
    .string()
    .min(32)
    .max(44)
    .default("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),

  // [HUMAN EDIT]: Redis Cache & Idempotency Engine
  REDIS_URL: z.string().default("redis://127.0.0.1:6379"),
  REDIS_IDEMPOTENCY_TTL_SECONDS: z.string().default("180").transform((v) => parseInt(v, 10)),

  // [HUMAN EDIT]: PostgreSQL Double-Entry Ledger Database
  DATABASE_URL: z.string().default("postgresql://postgres:postgres@127.0.0.1:5432/aegis_switch"),

  // [HUMAN EDIT]: HMAC Signing Secret for Outbound Webhooks
  WEBHOOK_SIGNING_SECRET: z.string().min(16).default("aegis_sec_live_replace_with_strong_random_secret_32_bytes"),
});

export const config = envSchema.parse(process.env);
