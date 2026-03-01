-- =============================================================================
-- Project Sentinel — Operators (pre-existing accounts, UUID + password)
-- Military-grade channel: no self-registration; accounts are provisioned.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.operators (
    id             UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    operator_uuid  TEXT        NOT NULL UNIQUE,
    password_hash  TEXT        NOT NULL,
    role           TEXT        NOT NULL CHECK (role IN ('sender', 'receiver')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_operators_uuid ON public.operators (operator_uuid);

ALTER TABLE public.operators ENABLE ROW LEVEL SECURITY;

-- Only service role (backend) can read operators for login verification
CREATE POLICY "service_role_operators"
    ON public.operators
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- No anon/authenticated access to operators table
-- (backend uses service role for login check)
