import { Router, Request, Response } from "express";
import { z } from "zod";
import { pool } from "../db/db.js";
import { config } from "../config.js";
import { IdempotencyService } from "../services/idempotency.js";
import { SolanaPayService } from "../services/solana_pay.js";
import { SettlementEngine } from "../services/settlement_engine.js";
import { WebhookDispatcher } from "../services/webhook_dispatcher.js";
import { PaymentIntentResponse } from "../types/index.js";

export const router = Router();

const createPaymentSchema = z.object({
  merchantId: z.string().uuid(),
  orderId: z.string().min(1).max(255),
  amountUsdc: z.number().positive(),
  label: z.string().optional(),
  message: z.string().optional(),
});

/**
 * Health check
 */
router.get("/health", async (_req: Request, res: Response) => {
  res.json({
    status: "healthy",
    cluster: config.SOLANA_CLUSTER,
    service: "aegis-payment-switch",
    timestamp: new Date().toISOString(),
  });
});

/**
 * Ingress: Create a new payment intent with POS reference key
 * Header required: Idempotency-Key
 */
router.post("/v1/payments", async (req: Request, res: Response): Promise<void> => {
  const idempotencyKey = req.header("Idempotency-Key");
  if (!idempotencyKey) {
    res.status(400).json({ error: "Missing required 'Idempotency-Key' header" });
    return;
  }

  const parseResult = createPaymentSchema.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({ error: "Invalid request payload", details: parseResult.error.format() });
    return;
  }

  const { merchantId, orderId, amountUsdc, label, message } = parseResult.data;

  // 1. Check cached idempotency response
  const cached = await IdempotencyService.getCachedResponse<PaymentIntentResponse>(merchantId, idempotencyKey);
  if (cached) {
    res.status(200).json({ ...cached, _idempotent_replay: true });
    return;
  }

  // 2. Acquire Redis distributed lock
  const locked = await IdempotencyService.acquireLock(merchantId, idempotencyKey);
  if (!locked) {
    res.status(409).json({ error: "Concurrent request in-flight for this Idempotency-Key" });
    return;
  }

  try {
    // 3. Verify merchant existence and fetch payout configuration
    const merchantRes = await pool.query(
      `SELECT id, payout_address, is_active FROM merchants WHERE id = $1`,
      [merchantId]
    );

    if (merchantRes.rows.length === 0 || !merchantRes.rows[0].is_active) {
      await IdempotencyService.releaseLock(merchantId, idempotencyKey);
      res.status(404).json({ error: "Active merchant not found" });
      return;
    }

    const recipient = merchantRes.rows[0].payout_address;

    // 4. Generate reference key & Solana Pay URL
    const { publicKey: referencePubkey } = SolanaPayService.generateReferenceKey();
    const solanaPayUrl = SolanaPayService.buildSolanaPayUrl({
      recipient,
      amountUsdc,
      reference: referencePubkey,
      label,
      message,
    });

    // 5. Insert payment intent in DB (expires in 15 minutes)
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    const insertRes = await pool.query(
      `INSERT INTO payment_intents 
       (merchant_id, order_id, amount_usdc, reference_pubkey, state, expires_at)
       VALUES ($1, $2, $3, $4, 'PENDING', $5)
       RETURNING id, created_at`,
      [merchantId, orderId, amountUsdc, referencePubkey, expiresAt]
    );

    const paymentId = insertRes.rows[0].id;
    const createdAt = insertRes.rows[0].created_at;

    const responsePayload: PaymentIntentResponse = {
      paymentId,
      orderId,
      amountUsdc: amountUsdc.toFixed(6),
      currency: "USDC",
      state: "PENDING",
      referencePubkey,
      solanaPayUrl,
      expiresAt: expiresAt.toISOString(),
      createdAt: new Date(createdAt).toISOString(),
    };

    // 6. Cache response and return
    await IdempotencyService.saveResponse(merchantId, idempotencyKey, responsePayload);
    res.status(201).json(responsePayload);
  } catch (err) {
    await IdempotencyService.releaseLock(merchantId, idempotencyKey);
    res.status(500).json({ error: "Internal payment switch failure", message: String(err) });
  }
});

/**
 * Status Verification: Poll payment status and trigger on-chain reconciliation
 */
router.get("/v1/payments/:id", async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;

  try {
    const paymentRes = await pool.query(
      `SELECT p.*, m.payout_address, m.fee_basis_points, m.webhook_url
       FROM payment_intents p
       JOIN merchants m ON p.merchant_id = m.id
       WHERE p.id = $1`,
      [id]
    );

    if (paymentRes.rows.length === 0) {
      res.status(404).json({ error: "Payment intent not found" });
      return;
    }

    const payment = paymentRes.rows[0];

    // If already confirmed or reconciled, return immediately
    if (payment.state === "CONFIRMED" || payment.state === "RECONCILED") {
      res.json({
        paymentId: payment.id,
        orderId: payment.order_id,
        state: payment.state,
        amountUsdc: Number(payment.amount_usdc).toFixed(6),
        signature: payment.signature,
        slotConfirmed: payment.slot_confirmed,
        updatedAt: payment.updated_at,
      });
      return;
    }

    // Check expiration
    if (new Date() > new Date(payment.expires_at)) {
      await pool.query(`UPDATE payment_intents SET state = 'EXPIRED', updated_at = NOW() WHERE id = $1`, [id]);
      res.json({ paymentId: payment.id, state: "EXPIRED" });
      return;
    }

    // Verify on-chain payment reference
    const verification = await SolanaPayService.verifyReferencePayment({
      referencePubkey: payment.reference_pubkey,
      expectedAmountUsdc: Number(payment.amount_usdc),
      recipientPubkey: payment.payout_address,
    });

    if (verification.isConfirmed && verification.signature) {
      // 1. Transition state to CONFIRMED
      await pool.query(
        `UPDATE payment_intents 
         SET state = 'CONFIRMED', signature = $1, slot_confirmed = $2, payer_address = $3, updated_at = NOW()
         WHERE id = $4`,
        [verification.signature, verification.slot, verification.payer, id]
      );

      // 2. Trigger Double-Entry Settlement Engine
      await SettlementEngine.recordSettlement({
        paymentIntentId: id,
        merchantId: payment.merchant_id,
        grossAmountUsdc: Number(payment.amount_usdc),
        feeBasisPoints: payment.fee_basis_points,
      });

      // 3. Transition to RECONCILED
      await pool.query(`UPDATE payment_intents SET state = 'RECONCILED', updated_at = NOW() WHERE id = $1`, [id]);

      // 4. Dispatch Signed Merchant Webhook asynchronously
      if (payment.webhook_url) {
        WebhookDispatcher.dispatch({
          paymentIntentId: id,
          merchantId: payment.merchant_id,
          webhookUrl: payment.webhook_url,
          payload: {
            event: "payment.confirmed",
            paymentId: id,
            orderId: payment.order_id,
            amountUsdc: Number(payment.amount_usdc).toFixed(6),
            signature: verification.signature,
            payerAddress: verification.payer,
            slotConfirmed: verification.slot,
            timestamp: new Date().toISOString(),
          },
        }).catch(() => {});
      }

      res.json({
        paymentId: payment.id,
        orderId: payment.order_id,
        state: "CONFIRMED",
        amountUsdc: Number(payment.amount_usdc).toFixed(6),
        signature: verification.signature,
        slotConfirmed: verification.slot,
      });
      return;
    }

    // Still pending
    res.json({
      paymentId: payment.id,
      orderId: payment.order_id,
      state: "PENDING",
      referencePubkey: payment.reference_pubkey,
      expiresAt: payment.expires_at,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to check payment status", message: String(err) });
  }
});
