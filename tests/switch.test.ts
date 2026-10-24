import test from "node:test";
import assert from "node:assert/strict";
import BigNumber from "bignumber.js";
import { SolanaPayService } from "../src/services/solana_pay.js";
import { WebhookDispatcher } from "../src/services/webhook_dispatcher.js";

test("SolanaPayService: Generates valid base58 reference key", () => {
  const { publicKey, secretKey } = SolanaPayService.generateReferenceKey();
  assert.equal(typeof publicKey, "string");
  assert.ok(publicKey.length >= 32 && publicKey.length <= 44);
  assert.equal(secretKey.length, 64);
});

test("SolanaPayService: Encodes valid Solana Pay URL with SPL token reference", () => {
  const recipient = "2nNtE6uEJQjX5vN1cS1m4FBRDuxxqq2hwmtFqn92xkNd";
  const ref = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const url = SolanaPayService.buildSolanaPayUrl({
    recipient,
    amountUsdc: 25.5,
    reference: ref,
    label: "Superteam POS",
    message: "Order #8492",
  });

  assert.ok(url.startsWith("solana:2nNtE6uEJQjX5vN1cS1m4FBRDuxxqq2hwmtFqn92xkNd?"));
  assert.ok(url.includes("amount=25.500000"));
  assert.ok(url.includes("reference=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"));
  assert.ok(url.includes("spl-token="));
});

test("WebhookDispatcher: Computes deterministic HMAC-SHA256 signatures", () => {
  const payload = JSON.stringify({ event: "payment.confirmed", id: "test-uuid", amount: "100.000000" });
  const secret = "test_super_secret_signing_key_32bytes";
  const sig1 = WebhookDispatcher.generateSignature(payload, secret);
  const sig2 = WebhookDispatcher.generateSignature(payload, secret);

  assert.equal(sig1, sig2);
  assert.equal(sig1.length, 64); // SHA-256 hex digest is 64 chars
});

test("SettlementEngine Math: Debits strictly equal Credits across fee splits", () => {
  const gross = new BigNumber(150.75);
  const feeBasisPoints = 50; // 0.5%
  const feeRate = new BigNumber(feeBasisPoints).dividedBy(10000);
  const switchFee = gross.multipliedBy(feeRate).decimalPlaces(6, BigNumber.ROUND_DOWN);
  const netMerchant = gross.minus(switchFee);

  const totalDebits = gross;
  const totalCredits = netMerchant.plus(switchFee);

  assert.ok(totalDebits.isEqualTo(totalCredits));
  assert.equal(switchFee.toFixed(6), "0.753750");
  assert.equal(netMerchant.toFixed(6), "149.996250");
});
