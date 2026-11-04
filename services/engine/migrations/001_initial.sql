CREATE TABLE commerce_rules (
  id uuid PRIMARY KEY,
  owner_chat_id text NOT NULL CHECK (owner_chat_id ~ '^-?[1-9][0-9]{0,19}$'),
  recipient_chat_id text NOT NULL CHECK (recipient_chat_id ~ '^-?[1-9][0-9]{0,19}$'),
  name text NOT NULL,
  repository text NOT NULL,
  required_label text NOT NULL,
  product_id text NOT NULL,
  package_id text NOT NULL,
  per_purchase_cap_usd_cents integer NOT NULL CHECK (per_purchase_cap_usd_cents > 0),
  daily_cap_usd_cents integer NOT NULL,
  monthly_cap_usd_cents integer NOT NULL,
  auto_approve_up_to_usd_cents integer NOT NULL CHECK (auto_approve_up_to_usd_cents >= 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','enabled','paused')),
  enabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (per_purchase_cap_usd_cents <= daily_cap_usd_cents),
  CHECK (daily_cap_usd_cents <= monthly_cap_usd_cents),
  CHECK (auto_approve_up_to_usd_cents <= per_purchase_cap_usd_cents)
);
CREATE FUNCTION protect_rule_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.enabled_at IS NOT NULL AND (
    NEW.owner_chat_id IS DISTINCT FROM OLD.owner_chat_id OR
    NEW.recipient_chat_id IS DISTINCT FROM OLD.recipient_chat_id OR
    NEW.repository IS DISTINCT FROM OLD.repository OR
    NEW.product_id IS DISTINCT FROM OLD.product_id OR
    NEW.package_id IS DISTINCT FROM OLD.package_id OR
    NEW.required_label IS DISTINCT FROM OLD.required_label OR
    NEW.enabled_at IS DISTINCT FROM OLD.enabled_at
  ) THEN RAISE EXCEPTION 'Enabled rule identity is immutable; create a revised rule'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rule_identity BEFORE UPDATE ON commerce_rules
FOR EACH ROW EXECUTE FUNCTION protect_rule_identity();

CREATE TABLE trigger_events (
  id uuid PRIMARY KEY,
  delivery_id text NOT NULL UNIQUE,
  payload jsonb NOT NULL,
  reason text NOT NULL DEFAULT 'queued',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE purchases (
  id uuid PRIMARY KEY,
  rule_id uuid NOT NULL REFERENCES commerce_rules(id),
  event_id uuid NOT NULL REFERENCES trigger_events(id),
  repository text NOT NULL,
  pr_number integer NOT NULL CHECK (pr_number > 0),
  mode text NOT NULL CHECK (mode IN ('live','test')),
  status text NOT NULL CHECK (status IN (
    'QUEUED','INVOICE_CREATING','INVOICE_UNCERTAIN','QUOTED','PENDING_APPROVAL',
    'READY_TO_PAY','PAYMENT_PROCESSING','PAYMENT_UNCERTAIN','DELIVERED','TEST_DELIVERED','FAILED'
  )),
  invoice_id text UNIQUE,
  amount_usd_cents integer CHECK (amount_usd_cents > 0),
  payment_attempted_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rule_id, repository, pr_number)
);
CREATE INDEX purchase_jobs ON purchases(next_attempt_at)
WHERE status NOT IN ('DELIVERED','TEST_DELIVERED','FAILED','INVOICE_UNCERTAIN');
CREATE TABLE spending_ledger (
  purchase_id uuid PRIMARY KEY REFERENCES purchases(id),
  rule_id uuid NOT NULL REFERENCES commerce_rules(id),
  mode text NOT NULL CHECK (mode IN ('live','test')),
  amount_usd_cents integer NOT NULL CHECK (amount_usd_cents > 0),
  state text NOT NULL CHECK (state IN ('reserved','committed','released')),
  reserved_at timestamptz NOT NULL DEFAULT now(),
  committed_at timestamptz
);
CREATE INDEX budget_lookup ON spending_ledger(rule_id,mode,state);
CREATE TABLE approvals (
  purchase_id uuid PRIMARY KEY REFERENCES purchases(id),
  status text NOT NULL CHECK (status IN ('pending','approved','rejected','expired')),
  amount_usd_cents integer NOT NULL CHECK (amount_usd_cents > 0),
  expires_at timestamptz NOT NULL,
  decided_at timestamptz
);
CREATE TABLE invoices (
  id text PRIMARY KEY,
  purchase_id uuid NOT NULL UNIQUE REFERENCES purchases(id),
  status text NOT NULL,
  order_statuses jsonb NOT NULL DEFAULT '[]',
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE notification_outbox (
  id uuid PRIMARY KEY,
  dedupe_key text NOT NULL UNIQUE,
  chat_id text NOT NULL,
  type text NOT NULL,
  text text NOT NULL,
  purchase_id uuid REFERENCES purchases(id),
  invoice_id text,
  approval_purchase_id uuid REFERENCES purchases(id),
  redemption_ciphertext text,
  created_at timestamptz NOT NULL DEFAULT now(),
  acked_at timestamptz
);
CREATE INDEX outbox_pending ON notification_outbox(created_at) WHERE acked_at IS NULL;
