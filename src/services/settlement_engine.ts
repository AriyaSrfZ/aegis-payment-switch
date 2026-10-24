import pg from "pg";
import BigNumber from "bignumber.js";
import { withTransaction } from "../db/db.js";

export class SettlementEngine {
  /**
   * Post double-entry journal entries upon payment confirmation.
   * Debits: Asset account (1000-VAULT-CLEARING)
   * Credits: Merchant payable (2000-MERCHANT-PAYABLE) + Switch fee revenue (4000-SWITCH-FEE-REVENUE)
   * Enforces Debits == Credits invariant.
   */
  static async recordSettlement(params: {
    paymentIntentId: string;
    merchantId: string;
    grossAmountUsdc: number;
    feeBasisPoints: number;
  }): Promise<{ journalEntryId: string; netMerchantUsdc: string; switchFeeUsdc: string }> {
    const gross = new BigNumber(params.grossAmountUsdc);
    const feeRate = new BigNumber(params.feeBasisPoints).dividedBy(10000);
    const switchFee = gross.multipliedBy(feeRate).decimalPlaces(6, BigNumber.ROUND_DOWN);
    const netMerchant = gross.minus(switchFee);

    return await withTransaction(async (client: pg.PoolClient) => {
      // 1. Fetch system account IDs
      const accountsRes = await client.query(
        `SELECT id, account_number FROM ledger_accounts 
         WHERE account_number IN ('1000-VAULT-CLEARING', '2000-MERCHANT-PAYABLE', '4000-SWITCH-FEE-REVENUE')`
      );

      const accounts = new Map<string, string>();
      for (const row of accountsRes.rows) {
        accounts.set(row.account_number, row.id);
      }

      const vaultAccountId = accounts.get("1000-VAULT-CLEARING")!;
      const merchantPayableId = accounts.get("2000-MERCHANT-PAYABLE")!;
      const feeRevenueId = accounts.get("4000-SWITCH-FEE-REVENUE")!;

      // 2. Create Journal Entry Header
      const journalRes = await client.query(
        `INSERT INTO journal_entries (payment_intent_id, description)
         VALUES ($1, $2) RETURNING id`,
        [params.paymentIntentId, `Settlement for payment intent ${params.paymentIntentId}`]
      );
      const journalEntryId = journalRes.rows[0].id;

      // 3. Insert Journal Lines (Debits and Credits)
      // Line 1: Debit Vault Asset (Gross)
      await client.query(
        `INSERT INTO journal_lines (journal_entry_id, account_id, debit, credit)
         VALUES ($1, $2, $3, 0)`,
        [journalEntryId, vaultAccountId, gross.toFixed(6)]
      );

      // Line 2: Credit Merchant Payable Liability (Net)
      await client.query(
        `INSERT INTO journal_lines (journal_entry_id, account_id, debit, credit)
         VALUES ($1, $2, 0, $3)`,
        [journalEntryId, merchantPayableId, netMerchant.toFixed(6)]
      );

      // Line 3: Credit Switch Fee Revenue (Fee)
      if (switchFee.isGreaterThan(0)) {
        await client.query(
          `INSERT INTO journal_lines (journal_entry_id, account_id, debit, credit)
           VALUES ($1, $2, 0, $3)`,
          [journalEntryId, feeRevenueId, switchFee.toFixed(6)]
        );
      }

      // 4. Update ledger account aggregate balances
      await client.query(
        `UPDATE ledger_accounts SET balance = balance + $1 WHERE id = $2`,
        [gross.toFixed(6), vaultAccountId]
      );
      await client.query(
        `UPDATE ledger_accounts SET balance = balance + $1 WHERE id = $2`,
        [netMerchant.toFixed(6), merchantPayableId]
      );
      if (switchFee.isGreaterThan(0)) {
        await client.query(
          `UPDATE ledger_accounts SET balance = balance + $1 WHERE id = $2`,
          [switchFee.toFixed(6), feeRevenueId]
        );
      }

      return {
        journalEntryId,
        netMerchantUsdc: netMerchant.toFixed(6),
        switchFeeUsdc: switchFee.toFixed(6),
      };
    });
  }
}
