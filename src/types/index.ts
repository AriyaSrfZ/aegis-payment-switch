import { PublicKey } from "@solana/web3.js";

export type PaymentState =
  | "PENDING"
  | "IN_FLIGHT"
  | "CONFIRMED"
  | "RECONCILED"
  | "EXPIRED"
  | "FAILED";

export interface CreatePaymentIntentRequest {
  merchantId: string;
  orderId: string;
  amountUsdc: number;
  idempotencyKey: string;
  label?: string;
  message?: string;
}

export interface PaymentIntentResponse {
  paymentId: string;
  orderId: string;
  amountUsdc: string;
  currency: string;
  state: PaymentState;
  referencePubkey: string;
  solanaPayUrl: string;
  expiresAt: string;
  createdAt: string;
}

export interface MerchantRecord {
  id: string;
  merchantName: string;
  payoutAddress: string;
  webhookUrl?: string;
  apiKeyHash: string;
  feeBasisPoints: number;
  isActive: boolean;
}

export interface WebhookPayload {
  event: "payment.confirmed" | "payment.reconciled" | "payment.expired";
  paymentId: string;
  orderId: string;
  amountUsdc: string;
  signature?: string;
  payerAddress?: string;
  slotConfirmed?: number;
  timestamp: string;
}
