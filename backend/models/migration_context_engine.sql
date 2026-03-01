-- ============================================================================
-- Project Sentinel — Context Engine Migration
-- Run in Supabase SQL Editor AFTER operators_schema.sql
-- ============================================================================
-- Adds identity metadata columns to public.operators to support contextual
-- access evaluation: department, branch, clearance_level, and shift hours.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Step 1: Add contextual identity columns to operators
-- ----------------------------------------------------------------------------
ALTER TABLE public.operators
  ADD COLUMN IF NOT EXISTS department      TEXT    DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS branch         TEXT    DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS clearance_level INT     NOT NULL DEFAULT 1
    CHECK (clearance_level BETWEEN 1 AND 5),
  ADD COLUMN IF NOT EXISTS shift_start    TIME    DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS shift_end      TIME    DEFAULT NULL;

COMMENT ON COLUMN public.operators.department      IS 'Hospital department the operator belongs to (e.g. Cardiology, ICU, Radiology)';
COMMENT ON COLUMN public.operators.branch          IS 'Hospital branch or facility location';
COMMENT ON COLUMN public.operators.clearance_level IS 'Numeric clearance tier 1–5; controls access to sensitivity levels';
COMMENT ON COLUMN public.operators.shift_start     IS 'Start of authorised working hours (UTC); NULL = no restriction';
COMMENT ON COLUMN public.operators.shift_end       IS 'End of authorised working hours (UTC); NULL = no restriction';


-- ----------------------------------------------------------------------------
-- Step 2: Indexes for common context-evaluation lookups
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_operators_department
  ON public.operators (department);

CREATE INDEX IF NOT EXISTS idx_operators_branch
  ON public.operators (branch);

CREATE INDEX IF NOT EXISTS idx_operators_clearance_level
  ON public.operators (clearance_level);


-- ----------------------------------------------------------------------------
-- Step 3: Verify doctor_patient_map exists (created by healthcare_schema.sql)
-- This table is the source-of-truth for the `assigned` context flag.
-- No changes needed — listed here for documentation only.
--
-- Expected schema:
--   doctor_id   UUID NOT NULL
--   patient_id  UUID NOT NULL
--   assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
--   PRIMARY KEY (doctor_id, patient_id)
-- ----------------------------------------------------------------------------


-- ----------------------------------------------------------------------------
-- Step 4: Final operators schema after this migration
-- ----------------------------------------------------------------------------
-- id               UUID        PRIMARY KEY
-- operator_uuid    TEXT        NOT NULL UNIQUE    (used as sub in JWT)
-- password_hash    TEXT        NOT NULL
-- role             TEXT        NOT NULL
-- department       TEXT        DEFAULT NULL
-- branch           TEXT        DEFAULT NULL
-- clearance_level  INT         NOT NULL DEFAULT 1 CHECK (1–5)
-- shift_start      TIME        DEFAULT NULL
-- shift_end        TIME        DEFAULT NULL
-- created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
