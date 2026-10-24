-- ==============================================================================
-- AEGIS PAYMENT SWITCH: DOUBLE-ENTRY ACCOUNTING LEDGER SCHEMA
-- ==============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Merchant Accounts & Settlement Config
CREATE TABLE IF NOT EXISTS merchants (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    merchant_name VARCHAR(255) NOT NULL,
    payout_address VARCHAR(44) NOT NULL, -- Solana base58 public key
    webhook_url TEXT,
    api_key_hash VARCHAR(64) NOT NULL UNIQUE,
    fee_basis_points INT NOT NULL DEFAULT 50, -- 0.5% default switch fee
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Transaction Records (Payment Intent State Machine)
-- States: PENDING -> IN_FLIGHT -> CONFIRMED -> RECONCILED (or EXPIRED, FAILED)
CREATE TYPE payment_state AS ENUM (
    'PENDING',
    'IN_FLIGHT',
    'CONFIRMED',
    'RECONCILED',
    'EXPIRED',
    'FAILED'
);

CREATE TABLE IF NOT EXISTS payment_intents (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    merchant_id UUID NOT NULL REFERENCES merchants(id),
    reference_pubkey VARCHAR(44) NOT NULL UNIQUE, -- Unique ephemeral reference key for Solana Pay
    amount_usdc NUMERIC(18, 6) NOT NULL,
    currency VARCHAR(10) NOT NULL DEFAULT 'USDC',
    order_id VARCHAR(255) NOT NULL,
    state payment_state NOT NULL DEFAULT 'PENDING',
    signature VARCHAR(88), -- Transaction signature once confirmed
    slot_confirmed BIGINT,
    payer_address VARCHAR(44),
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_reference ON payment_intents(reference_pubkey);
CREATE INDEX IF NOT EXISTS idx_payment_merchant_order ON payment_intents(merchant_id, order_id);

-- 3. Double-Entry Accounts (Assets, Liabilities, Revenue)
CREATE TYPE account_type AS ENUM ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE');

CREATE TABLE IF NOT EXISTS ledger_accounts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    account_number VARCHAR(64) NOT NULL UNIQUE,
    merchant_id UUID REFERENCES merchants(id), -- NULL for system accounts
    type account_type NOT NULL,
    balance NUMERIC(24, 6) NOT NULL DEFAULT 0.000000,
    currency VARCHAR(10) NOT NULL DEFAULT 'USDC',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- System Accounts Seeding
INSERT INTO ledger_accounts (account_number, type, currency)
VALUES 
    ('1000-VAULT-CLEARING', 'ASSET', 'USDC'),
    ('2000-MERCHANT-PAYABLE', 'LIABILITY', 'USDC'),
    ('4000-SWITCH-FEE-REVENUE', 'REVENUE', 'USDC')
ON CONFLICT (account_number) DO NOTHING;

-- 4. Double-Entry Journal Entries (Balanced Debits & Credits)
CREATE TABLE IF NOT EXISTS journal_entries (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    payment_intent_id UUID REFERENCES payment_intents(id),
    description TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS journal_lines (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    journal_entry_id UUID NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES ledger_accounts(id),
    debit NUMERIC(18, 6) NOT NULL DEFAULT 0.000000,
    credit NUMERIC(18, 6) NOT NULL DEFAULT 0.000000,
    CONSTRAINT chk_debit_credit_positive CHECK (debit >= 0 AND credit >= 0),
    CONSTRAINT chk_debit_or_credit CHECK ((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0))
);

CREATE INDEX IF NOT EXISTS idx_journal_lines_account ON journal_lines(account_id);

-- 5. Outbound Webhook Delivery Queue & Retry Log
CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    payment_intent_id UUID NOT NULL REFERENCES payment_intents(id),
    merchant_id UUID NOT NULL REFERENCES merchants(id),
    payload JSONB NOT NULL,
    status_code INT,
    response_body TEXT,
    attempts INT NOT NULL DEFAULT 0,
    is_success BOOLEAN NOT NULL DEFAULT FALSE,
    last_attempt_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
