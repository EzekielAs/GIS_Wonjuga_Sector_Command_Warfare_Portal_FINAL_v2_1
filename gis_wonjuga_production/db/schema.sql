CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN CREATE TYPE user_role AS ENUM ('MAIN_ADMIN','FINANCE_OFFICER','WELFARE_OFFICER','MEMBER_MANAGER','REPORT_VIEWER','MEMBER'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE member_status AS ENUM ('PENDING_ACTIVATION','ACTIVE','SUSPENDED','INACTIVE'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE payment_channel AS ENUM ('MTN_MOMO','TELECEL','AIRTELTIGO','BANK'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE payment_type AS ENUM ('ACTIVATION','MONTHLY_WELFARE','WELFARE_CLAIM_REFUND','OTHER'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE payment_status AS ENUM ('PENDING','SUCCESS','FAILED','REVERSED','RECONCILED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS members (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 service_number VARCHAR(80) UNIQUE,
 full_name VARCHAR(200) NOT NULL,
 rank VARCHAR(120),
 unit VARCHAR(200) NOT NULL DEFAULT 'Wonjuga Sector Command',
 station VARCHAR(200),
 phone VARCHAR(30),
 momo_number VARCHAR(30),
 email VARCHAR(255),
 status member_status NOT NULL DEFAULT 'PENDING_ACTIVATION',
 activation_paid BOOLEAN NOT NULL DEFAULT FALSE,
 activated_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 member_id UUID UNIQUE REFERENCES members(id) ON DELETE SET NULL,
 username VARCHAR(120) UNIQUE NOT NULL,
 display_name VARCHAR(200) NOT NULL,
 password_hash TEXT NOT NULL,
 role user_role NOT NULL,
 enabled BOOLEAN NOT NULL DEFAULT TRUE,
 last_login_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS settings (
 key VARCHAR(100) PRIMARY KEY,
 value_json JSONB NOT NULL,
 updated_by UUID REFERENCES users(id),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS contribution_periods (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 period_month DATE UNIQUE NOT NULL,
 amount NUMERIC(12,2) NOT NULL DEFAULT 100.00 CHECK(amount >= 0),
 due_date DATE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payments (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 member_id UUID REFERENCES members(id),
 contribution_period_id UUID REFERENCES contribution_periods(id),
 type payment_type NOT NULL,
 channel payment_channel NOT NULL,
 amount NUMERIC(12,2) NOT NULL CHECK(amount >= 0),
 provider_reference VARCHAR(255),
 internal_reference VARCHAR(100) UNIQUE NOT NULL,
 status payment_status NOT NULL DEFAULT 'PENDING',
 raw_provider_event JSONB,
 paid_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(channel, provider_reference)
);

CREATE TABLE IF NOT EXISTS welfare_claims (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 member_id UUID NOT NULL REFERENCES members(id),
 category VARCHAR(120) NOT NULL,
 amount_requested NUMERIC(12,2) NOT NULL CHECK(amount_requested > 0),
 status VARCHAR(40) NOT NULL DEFAULT 'PENDING',
 description TEXT,
 reviewed_by UUID REFERENCES users(id),
 reviewed_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS announcements (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 title VARCHAR(200) NOT NULL,
 body TEXT NOT NULL,
 published BOOLEAN NOT NULL DEFAULT FALSE,
 created_by UUID REFERENCES users(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_logs (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 actor_user_id UUID REFERENCES users(id),
 action VARCHAR(120) NOT NULL,
 entity_type VARCHAR(80),
 entity_id UUID,
 metadata JSONB,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_members_service_number ON members(service_number);
CREATE INDEX IF NOT EXISTS idx_members_status ON members(status);
CREATE INDEX IF NOT EXISTS idx_payments_member ON payments(member_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
CREATE INDEX IF NOT EXISTS idx_payments_created_at ON payments(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_successful_monthly_payment ON payments(member_id, contribution_period_id) WHERE type='MONTHLY_WELFARE' AND status IN ('SUCCESS','RECONCILED');

INSERT INTO settings(key,value_json) VALUES
 ('institution', '{"name":"GHANA IMMIGRATION SERVICE WONJUGA SECTOR COMMAND WARFARE","motto":"Friendship with Vigilance"}'),
 ('monthly_contribution', '{"amount":100,"currency":"GHS"}'),
 ('activation_fee', '{"amount":0,"currency":"GHS","configured":false}'),
 ('bank_details', '{"bank_name":"","account_name":"","account_number":"","branch":"","instructions":"Use your Service Number or the system payment reference as the transfer narration."}')
ON CONFLICT (key) DO NOTHING;
