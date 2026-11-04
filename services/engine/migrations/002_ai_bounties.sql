ALTER TABLE commerce_rules ADD COLUMN kind text NOT NULL DEFAULT 'fixed' CHECK (kind IN ('fixed','bounty'));
CREATE TABLE github_identity_links (
  telegram_user_id text PRIMARY KEY CHECK (telegram_user_id ~ '^[1-9][0-9]{0,14}$'),
  github_user_id bigint NOT NULL UNIQUE CHECK (github_user_id > 0),
  github_login text NOT NULL,
  verification_source text NOT NULL CHECK (verification_source='github_oauth'),
  verified_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE connected_repositories (
  repository_id bigint PRIMARY KEY CHECK (repository_id > 0),
  owner_telegram_user_id text NOT NULL REFERENCES github_identity_links(telegram_user_id),
  owner_github_user_id bigint NOT NULL REFERENCES github_identity_links(github_user_id),
  repository_full_name text NOT NULL,
  installation_id bigint NOT NULL CHECK (installation_id > 0),
  repository_private boolean NOT NULL DEFAULT true,
  authorization_source text NOT NULL DEFAULT 'trusted_github_app_adapter',
  verified_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE bounty_rules (
  rule_id uuid PRIMARY KEY REFERENCES commerce_rules(id),
  repository_id bigint NOT NULL UNIQUE REFERENCES connected_repositories(repository_id),
  policy_version integer NOT NULL DEFAULT 1 CHECK (policy_version > 0),
  mode text NOT NULL CHECK (mode='ai_contribution_bounty'),
  require_merged boolean NOT NULL CHECK (require_merged),
  require_successful_ci boolean NOT NULL,
  score_threshold integer NOT NULL CHECK (score_threshold BETWEEN 0 AND 100),
  minimum_confidence numeric NOT NULL CHECK (minimum_confidence BETWEEN 0 AND 1),
  allow_self_reward boolean NOT NULL DEFAULT false,
  tiers jsonb NOT NULL
);
CREATE TABLE contribution_reviews (
  id uuid PRIMARY KEY,
  sequence bigserial UNIQUE,
  rule_id uuid NOT NULL REFERENCES bounty_rules(rule_id),
  repository_id bigint NOT NULL REFERENCES connected_repositories(repository_id),
  installation_id bigint NOT NULL,
  pr_number integer NOT NULL CHECK (pr_number > 0),
  head_sha text NOT NULL,
  author_github_user_id bigint NOT NULL,
  evidence_hash text NOT NULL,
  state text NOT NULL CHECK (state IN ('QUEUED','REVIEWING','REVIEWED','NEEDS_REVIEW','LOW_CONFIDENCE','STALE')),
  eligibility_state text NOT NULL DEFAULT 'HOLD',
  hold_reasons jsonb NOT NULL DEFAULT '[]',
  result jsonb,
  model text NOT NULL,
  valid_until timestamptz NOT NULL,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rule_id,repository_id,pr_number,head_sha,evidence_hash)
);
CREATE INDEX review_jobs ON contribution_reviews(state,created_at);
CREATE TABLE review_evidence (
  review_id uuid PRIMARY KEY REFERENCES contribution_reviews(id),
  snapshot jsonb NOT NULL,
  reference_ids text[] NOT NULL,
  redactions_applied boolean NOT NULL
);
CREATE TABLE bounty_awards (
  id uuid PRIMARY KEY,
  rule_id uuid NOT NULL REFERENCES bounty_rules(rule_id),
  repository_id bigint NOT NULL,
  pr_number integer NOT NULL,
  review_id uuid NOT NULL UNIQUE REFERENCES contribution_reviews(id),
  reviewed_head_sha text NOT NULL,
  author_github_user_id bigint NOT NULL REFERENCES github_identity_links(github_user_id),
  recipient_chat_id text NOT NULL REFERENCES github_identity_links(telegram_user_id),
  tier integer NOT NULL CHECK (tier > 0),
  score integer NOT NULL CHECK (score BETWEEN 0 AND 100),
  face_value_inr integer NOT NULL CHECK (face_value_inr > 0),
  policy_version integer NOT NULL,
  purchase_id uuid NOT NULL UNIQUE REFERENCES purchases(id) DEFERRABLE INITIALLY DEFERRED,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(rule_id,repository_id,pr_number)
);
CREATE TABLE bounty_finalization_events (
  delivery_id text PRIMARY KEY,
  review_id uuid NOT NULL REFERENCES contribution_reviews(id),
  head_sha text NOT NULL,
  award_id uuid REFERENCES bounty_awards(id),
  state text NOT NULL DEFAULT 'HOLD' CHECK(state IN ('HOLD','QUEUED')),
  reasons jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE bounty_purchase_receipts (
  purchase_id uuid PRIMARY KEY REFERENCES purchases(id),
  award_id uuid NOT NULL UNIQUE REFERENCES bounty_awards(id),
  evidence_receipt jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE purchases ADD COLUMN reward_product_id text;
ALTER TABLE purchases ADD COLUMN reward_package_id text;
ALTER TABLE purchases ADD COLUMN reward_recipient_chat_id text;
ALTER TABLE purchases ADD COLUMN reward_face_value_inr integer;
ALTER TABLE purchases ADD COLUMN requires_owner_approval boolean NOT NULL DEFAULT false;
ALTER TABLE purchases ADD CONSTRAINT bounty_snapshot_complete CHECK (
  (reward_product_id IS NULL AND reward_package_id IS NULL AND reward_recipient_chat_id IS NULL AND reward_face_value_inr IS NULL)
  OR (reward_product_id IS NOT NULL AND reward_package_id IS NOT NULL AND reward_recipient_chat_id IS NOT NULL AND reward_face_value_inr IS NOT NULL AND reward_recipient_chat_id ~ '^[1-9][0-9]{0,14}$' AND reward_face_value_inr > 0)
);
CREATE FUNCTION protect_bounty_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.rule_id,NEW.reward_product_id,NEW.reward_package_id,NEW.reward_recipient_chat_id,NEW.reward_face_value_inr,NEW.requires_owner_approval)
    IS DISTINCT FROM ROW(OLD.rule_id,OLD.reward_product_id,OLD.reward_package_id,OLD.reward_recipient_chat_id,OLD.reward_face_value_inr,OLD.requires_owner_approval)
  THEN RAISE EXCEPTION 'Purchase authorization snapshot is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bounty_snapshot_immutable BEFORE UPDATE ON purchases FOR EACH ROW EXECUTE FUNCTION protect_bounty_snapshot();
