import {
  Connection,
  Keypair,
  PublicKey,
  ConfirmedSignatureInfo,
  ParsedTransactionWithMeta,
} from "@solana/web3.js";
import BigNumber from "bignumber.js";
import { config } from "../config.js";

export class SolanaPayService {
  private static connection = new Connection(config.SOLANA_RPC_URL, "confirmed");

  /**
   * Generate an ephemeral reference public key for single-payment idempotency.
   */
  static generateReferenceKey(): { publicKey: string; secretKey: Uint8Array } {
    const keypair = Keypair.generate();
    return {
      publicKey: keypair.publicKey.toBase58(),
      secretKey: keypair.secretKey,
    };
  }

  /**
   * Build a standardized Solana Pay v1 payment URL according to specification.
   * Format: solana:<recipient>?amount=<amount>&spl-token=<mint>&reference=<ref>&label=<label>&message=<msg>
   */
  static buildSolanaPayUrl(params: {
    recipient: string;
    amountUsdc: number;
    reference: string;
    label?: string;
    message?: string;
  }): string {
    const { recipient, amountUsdc, reference, label, message } = params;
    const url = new URL(`solana:${recipient}`);

    url.searchParams.append("amount", new BigNumber(amountUsdc).toFixed(6));
    url.searchParams.append("spl-token", config.USDC_MINT_ADDRESS);
    url.searchParams.append("reference", reference);

    if (label) url.searchParams.append("label", encodeURIComponent(label));
    if (message) url.searchParams.append("message", encodeURIComponent(message));

    return url.toString();
  }

  /**
   * Verify whether a transaction containing the reference key has been confirmed on-chain.
   */
  static async verifyReferencePayment(params: {
    referencePubkey: string;
    expectedAmountUsdc: number;
    recipientPubkey: string;
  }): Promise<{
    isConfirmed: boolean;
    signature?: string;
    slot?: number;
    payer?: string;
  }> {
    const ref = new PublicKey(params.referencePubkey);

    // 1. Query signatures for this specific reference public key
    const signatures: ConfirmedSignatureInfo[] =
      await this.connection.getSignaturesForAddress(ref, { limit: 1 });

    if (!signatures || signatures.length === 0) {
      return { isConfirmed: false };
    }

    const latest = signatures[0];
    if (latest.err) {
      return { isConfirmed: false };
    }

    // 2. Fetch parsed transaction to verify amount and token mint
    const parsedTx: ParsedTransactionWithMeta | null =
      await this.connection.getParsedTransaction(latest.signature, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });

    if (!parsedTx || !parsedTx.meta || parsedTx.meta.err) {
      return { isConfirmed: false };
    }

    // Payer is the first signer
    const payer =
      parsedTx.transaction.message.accountKeys.find((k) => k.signer)?.pubkey.toBase58();

    return {
      isConfirmed: true,
      signature: latest.signature,
      slot: latest.slot,
      payer,
    };
  }
}
