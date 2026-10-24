# AegisSwitch: Enterprise Solana Payment Switch & POS Engine

[![Build Status](https://img.shields.io/badge/build-passing-brightgreen)](#)
[![Blockchain](https://img.shields.io/badge/Solana-Mainnet%20%7C%20Devnet-purple)](#)
[![Settlement](https://img.shields.io/badge/Settlement-SPL%20USDC-blue)](#)
[![Double-Entry](https://img.shields.io/badge/Accounting-Double--Entry-orange)](#)

A high-concurrency, enterprise-grade payment switch connecting physical Point-of-Sale (POS) terminals, e-commerce checkouts, and mobile Telegram mini-apps directly to the Solana blockchain. Engineered for instant retail payment verification, off-chain double-entry ledger safety, and automated merchant batch settlement.

Author: **Ariya Sarrafzadeh (Callsign: HaroSS)** | Principal Solutions Architect & Technical Product Manager  
Solana Settlement Address: `2nNtE6uEJQjX5vN1cS1m4FBRDuxxqq2hwmtFqn92xkNd`

---

## 1. System Architecture Topology

```
+-----------------------------------------------------------------------------------+
|                              Client Ingress Layer                                 |
|  +------------------------+                     +-------------------------------+  |
|  | Physical POS Terminal  |                     |  E-Commerce / Telegram Cart   |  |
|  +------------------------+                     +-------------------------------+  |
+-----------------------------------------------------------------------------------+
                                          |
                        HTTPS (Mutual TLS / HMAC Signature)
                                          v
+-----------------------------------------------------------------------------------+
|                         Aegis Payment Switch Core                                 |
|                                                                                   |
|  +-----------------------+   Reference Key Map   +-----------------------------+  |
|  |   POS QR Generator    | --------------------> | Redis Idempotency Engine    |  |
|  | (Solana Pay Spec v1)  |                       | (TTL 180s, In-Flight Guard) |  |
|  +-----------------------+                       +-----------------------------+  |
|              |                                                  |                 |
|              v                                                  v                 |
|  +-----------------------------------------------------------------------------+  |
|  |                 PostgreSQL Balanced Double-Entry Accounting                 |  |
|  |   1000-VAULT-CLEARING (Asset) == 2000-MERCHANT-PAYABLE + 4000-FEE-REVENUE   |  |
|  +-----------------------------------------------------------------------------+  |
+-----------------------------------------------------------------------------------+
                                          |
                +-------------------------+-------------------------+
                |                                                   |
                v                                                   v
+-------------------------------+                   +-------------------------------+
|    Solana RPC Network         |                   |  Merchant Webhook Dispatcher  |
| - getSignaturesForAddress     |                   | - HMAC-SHA256 Signed Event    |
| - getParsedTransaction (USDC) |                   | - Exponential Backoff Retry   |
+-------------------------------+                   +-------------------------------+
```

---

## 2. Operator Configuration: Where to Human Edit

Before running in production, adjust the following parameters:

| Config Location | Variable / Field | Description | Default / Example |
| :--- | :--- | :--- | :--- |
| [`.env:10`](.env#L10) | `SOLANA_RPC_URL` | High-throughput RPC endpoint | `https://api.mainnet-beta.solana.com` (Use Helius/QuickNode in prod) |
| [`.env:14`](.env#L14) | `MASTER_TREASURY_ADDRESS` | Platform fee & cold storage wallet | `2nNtE6uEJQjX5vN1cS1m4FBRDuxxqq2hwmtFqn92xkNd` |
| [`.env:18`](.env#L18) | `USDC_MINT_ADDRESS` | SPL USDC Token Mint address | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` (Mainnet) |
| [`.env:22`](.env#L22) | `REDIS_URL` | Redis instance for distributed locks | `redis://127.0.0.1:6379` |
| [`.env:26`](.env#L26) | `DATABASE_URL` | PostgreSQL ledger database | `postgresql://postgres:postgres@127.0.0.1:5432/aegis_switch` |
| [`.env:30`](.env#L30) | `WEBHOOK_SIGNING_SECRET`| Shared secret for HMAC signatures | Generate random 32-byte hex string |
| [`src/db/schema.sql:53`](src/db/schema.sql#L53) | System Accounts | Chart of accounts naming | `1000-VAULT-CLEARING`, `2000-MERCHANT-PAYABLE` |

---

## 3. Quick Start & Execution

### 1. Boot Infrastructure (PostgreSQL & Redis)
```bash
docker-compose up -d
```

### 2. Install Dependencies & Build
```bash
npm install
npm run build
```

### 3. Run Test Suite
```bash
npx tsx tests/switch.test.ts
```

### 4. Start Development Server
```bash
npm run dev
```

---

## 4. API Specification

### `POST /v1/payments`
Generates a payment intent with a single-use reference key and Solana Pay QR URL.

**Headers:**
`Idempotency-Key: <unique-uuid>`

**Request Body:**
```json
{
  "merchantId": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
  "orderId": "INV-2026-9042",
  "amountUsdc": 49.99,
  "label": "Coffee & Co.",
  "message": "Order #9042 POS Terminal 3"
}
```

**Response (201 Created):**
```json
{
  "paymentId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "orderId": "INV-2026-9042",
  "amountUsdc": "49.990000",
  "currency": "USDC",
  "state": "PENDING",
  "referencePubkey": "7Z3...base58",
  "solanaPayUrl": "solana:2nNtE...?amount=49.990000&spl-token=EPjF...&reference=7Z3...",
  "expiresAt": "2026-10-24T18:55:00.000Z",
  "createdAt": "2026-10-24T18:40:00.000Z"
}
```

---

## 5. Security & Invariants
- **Double-Entry Balance Invariant:** $\sum \text{Debits} \equiv \sum \text{Credits}$ enforced at database constraint level.
- **Micro-Lamport Rounding:** All fees calculated using arbitrary-precision math (`bignumber.js`) with truncation at 6 decimal places to prevent penny-shaving exploits.
- **Idempotency Protection:** In-flight concurrent requests return HTTP `409 Conflict`; completed requests return cached responses with identical reference keys.
