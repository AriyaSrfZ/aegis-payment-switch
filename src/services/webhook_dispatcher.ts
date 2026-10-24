import crypto from "crypto";
import { config } from "../config.js";
import { pool } from "../db/db.js";
import { WebhookPayload } from "../types/index.js";

export class WebhookDispatcher {
  /**
   * Compute HMAC-SHA256 signature for payload verification.
   */
  static generateSignature(payloadString: string, secret: string = config.WEBHOOK_SIGNING_SECRET): string {
    return crypto.createHmac("sha256", secret).update(payloadString).digest("hex");
  }

  /**
   * Dispatch signed webhook event to merchant endpoint.
   */
  static async dispatch(params: {
    paymentIntentId: string;
    merchantId: string;
    webhookUrl: string;
    payload: WebhookPayload;
  }): Promise<boolean> {
    const { paymentIntentId, merchantId, webhookUrl, payload } = params;
    const bodyStr = JSON.stringify(payload);
    const signature = this.generateSignature(bodyStr);

    try {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Aegis-Signature": signature,
          "X-Aegis-Event": payload.event,
          "User-Agent": "AegisSwitch-Webhook/1.0",
        },
        body: bodyStr,
        signal: AbortSignal.timeout(5000), // 5s timeout
      });

      const responseText = await response.text().catch(() => "");
      const isSuccess = response.ok;

      // Log delivery attempt in audit table
      await pool.query(
        `INSERT INTO webhook_deliveries 
         (payment_intent_id, merchant_id, payload, status_code, response_body, attempts, is_success, last_attempt_at)
         VALUES ($1, $2, $3, $4, $5, 1, $6, NOW())`,
        [paymentIntentId, merchantId, bodyStr, response.status, responseText.slice(0, 500), isSuccess]
      );

      return isSuccess;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await pool.query(
        `INSERT INTO webhook_deliveries 
         (payment_intent_id, merchant_id, payload, status_code, response_body, attempts, is_success, last_attempt_at)
         VALUES ($1, $2, $3, 0, $4, 1, FALSE, NOW())`,
        [paymentIntentId, merchantId, bodyStr, `Network Error: ${errorMsg}`]
      );
      return false;
    }
  }
}
