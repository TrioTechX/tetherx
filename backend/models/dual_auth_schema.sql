-- ============================================================================
-- Project Sentinel — Dual-Authorization Schema
-- Run in Supabase SQL Editor after healthcare_schema.sql
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Step 1: Add sensitivity_level to patient_records
-- ----------------------------------------------------------------------------
ALTER TABLE public.patient_records
  ADD COLUMN IF NOT EXISTS sensitivity_level TEXT NOT NULL DEFAULT 'LOW'
  CHECK (sensitivity_level IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL'));

CREATE INDEX IF NOT EXISTS idx_patient_records_sensitivity
  ON public.patient_records (sensitivity_level);


-- ----------------------------------------------------------------------------
-- Step 2: Dual-authorization pending requests table
--   Created when CRITICAL record decrypt is attempted.
--   A second (different) doctor must approve before decryption proceeds.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pending_access_requests (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id UUID        NOT NULL,        -- who wants to decrypt
  patient_id  UUID        NOT NULL,        -- which patient's record
  record_id   UUID        NOT NULL,        -- the specific patient_record id
  status      TEXT        NOT NULL DEFAULT 'PENDING'
              CHECK (status IN ('PENDING', 'APPROVED', 'DENIED')),
  approved_by UUID,                        -- which other doctor approved (NULL until decided)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_at TIMESTAMPTZ                  -- NULL until approved/denied
);

CREATE INDEX IF NOT EXISTS idx_pending_access_requests_status
  ON public.pending_access_requests (status);

CREATE INDEX IF NOT EXISTS idx_pending_access_requests_operator_id
  ON public.pending_access_requests (operator_id);

CREATE INDEX IF NOT EXISTS idx_pending_access_requests_record_id
  ON public.pending_access_requests (record_id);
