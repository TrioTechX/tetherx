-- ============================================================================
-- Project Sentinel — Healthcare RBAC Schema
-- Run this in Supabase SQL Editor (Settings → SQL Editor → New Query)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Step 1: Migrate operators role constraint to accept 5 healthcare roles
-- ----------------------------------------------------------------------------
ALTER TABLE public.operators
  DROP CONSTRAINT IF EXISTS operators_role_check;

ALTER TABLE public.operators
  ADD CONSTRAINT operators_role_check
  CHECK (role IN ('doctor', 'nurse', 'admin', 'patient', 'auditor'));


-- ----------------------------------------------------------------------------
-- Step 2: Patient records
--   Encrypted records scoped to a specific patient UUID.
--   ngram_hashes stores HMAC-SHA256 trapdoors for SSE search.
--   Governance model: records persist independently of user presence.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.patient_records (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id        UUID        NOT NULL,                          -- the patient this record belongs to
  department        TEXT        NOT NULL DEFAULT '',              -- hospital department
  branch            TEXT        NOT NULL DEFAULT '',              -- hospital branch / facility
  record_type       TEXT        NOT NULL DEFAULT 'GENERAL',       -- e.g. LAB_RESULT, PRESCRIPTION, NOTE
  sensitivity_level TEXT        NOT NULL DEFAULT 'LOW'            -- LOW, MEDIUM, HIGH, CRITICAL
                    CHECK (sensitivity_level IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  encrypted_payload TEXT        NOT NULL,                          -- AES-256-GCM hex blob
  ngram_hashes      TEXT[],                                        -- HMAC trapdoor hashes for SSE search
  created_by        UUID        NOT NULL,                          -- operator UUID who created the record
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_patient_records_patient_id
  ON public.patient_records (patient_id);

CREATE INDEX IF NOT EXISTS idx_patient_records_created_by
  ON public.patient_records (created_by);

CREATE INDEX IF NOT EXISTS idx_patient_records_department
  ON public.patient_records (department);

CREATE INDEX IF NOT EXISTS idx_patient_records_record_type
  ON public.patient_records (record_type);

CREATE INDEX IF NOT EXISTS idx_patient_records_sensitivity
  ON public.patient_records (sensitivity_level);


-- ----------------------------------------------------------------------------
-- Step 3: Doctor / nurse ↔ patient assignment map
--   Admins INSERT rows here to grant doctors/nurses access to patients.
--   The /api/patients/decrypt endpoint cross-checks this table.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.doctor_patient_map (
  doctor_id   UUID NOT NULL,   -- operator UUID (doctor or nurse)
  patient_id  UUID NOT NULL,   -- patient operator UUID
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (doctor_id, patient_id)
);

CREATE INDEX IF NOT EXISTS idx_doctor_patient_map_doctor_id
  ON public.doctor_patient_map (doctor_id);

CREATE INDEX IF NOT EXISTS idx_doctor_patient_map_patient_id
  ON public.doctor_patient_map (patient_id);


-- ----------------------------------------------------------------------------
-- Step 4: Access audit log
--   Every decrypt attempt (granted or denied) inserts a row here.
--   Auditors and admins can query this via GET /api/audit-log.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.access_audit_log (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id UUID        NOT NULL,                  -- who attempted the action
  patient_id  UUID,                                  -- which patient record was targeted
  action      TEXT        NOT NULL,                  -- e.g. DECRYPT_SUCCESS, DECRYPT_DENIED
  timestamp   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip_address  TEXT                                   -- client IP for forensics
);

CREATE INDEX IF NOT EXISTS idx_access_audit_log_operator_id
  ON public.access_audit_log (operator_id);

CREATE INDEX IF NOT EXISTS idx_access_audit_log_patient_id
  ON public.access_audit_log (patient_id);

CREATE INDEX IF NOT EXISTS idx_access_audit_log_timestamp
  ON public.access_audit_log (timestamp DESC);
