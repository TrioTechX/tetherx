"""
Project Sentinel — Healthcare RBAC Routes

Endpoints:
  POST /api/patients/records          — create encrypted patient record (doctor, nurse)
  POST /api/patients/decrypt          — per-role decrypt with mandatory audit logging
  POST /api/patients/search           — SSE trapdoor search, no decryption (doctor, nurse, auditor)
  GET  /api/patients/{patient_id}/records — list record metadata (doctor, nurse, admin)
  GET  /api/audit-log                 — view access audit log (auditor, admin)
  POST /api/doctor-patient-map        — assign doctor/nurse to patient (admin only)
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Annotated
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from api.deps import (
    OperatorClaims,
    check_patient_access,
    get_client_ip,
    get_current_operator,
    insert_audit_log,
    require_role,
)
from config.settings import Settings, get_settings
from core.crypto_engine import (
    decrypt_message,
    derive_key,
    derive_patient_key,
    encrypt_message,
    generate_ngram_hashes,
)
from models.database import get_db

logger = logging.getLogger("sentinel.healthcare")

router = APIRouter(prefix="/api", tags=["healthcare"])


# ──────────────────────────────────────────────────────────────────────────────
# Pydantic Schemas
# ──────────────────────────────────────────────────────────────────────────────


class CreatePatientRecordRequest(BaseModel):
    patient_id: str = Field(..., description="UUID of the patient this record belongs to")
    plaintext_record: str = Field(..., min_length=1, max_length=8192, description="Medical record plaintext")
    record_type: str = Field(default="GENERAL", max_length=64, description="Record type (e.g. LAB_RESULT, PRESCRIPTION, NOTE, IMAGING)")
    sensitivity_level: str = Field(default="LOW", description="Sensitivity: LOW, MEDIUM, HIGH, or CRITICAL")
    department: str = Field(default="", max_length=128, description="Hospital department")
    branch: str = Field(default="", max_length=128, description="Hospital branch or facility")
    ngram_size: int = Field(default=3, ge=1, le=5)

    @field_validator("sensitivity_level")
    @classmethod
    def validate_sensitivity(cls, v: str) -> str:
        allowed = {"LOW", "MEDIUM", "HIGH", "CRITICAL"}
        v_upper = v.upper()
        if v_upper not in allowed:
            raise ValueError(f"sensitivity_level must be one of {sorted(allowed)}")
        return v_upper


class CreatePatientRecordResponse(BaseModel):
    record_id: str
    patient_id: str
    record_type: str
    sensitivity_level: str
    department: str
    branch: str
    encrypted_preview: str  # first 48 chars of ciphertext hex — never plaintext
    created_by: str
    created_at: str
    hashes_generated: int


class DecryptPatientRecordRequest(BaseModel):
    record_id: str = Field(..., description="UUID of the patient_record to decrypt")


class DecryptPatientRecordResponse(BaseModel):
    record_id: str
    patient_id: str
    sensitivity_level: str
    plaintext: str | None = Field(
        default=None,
        description="Decrypted plaintext — null for roles not permitted to view sensitive fields",
    )
    metadata_only: bool = Field(
        default=False,
        description="True when caller's role has metadata-only access (nurse)",
    )
    requires_approval: bool = Field(
        default=False,
        description="True when record is CRITICAL and a second doctor must approve first",
    )
    pending_request_id: str | None = Field(
        default=None,
        description="UUID of the pending_access_request created (CRITICAL flow only)",
    )
    created_by: str
    created_at: str
    role_accessed_as: str


class SearchPatientRecordsRequest(BaseModel):
    query: str = Field(..., min_length=1, max_length=500)


class SearchPatientRecordsResponse(BaseModel):
    query: str
    trapdoor_hashes_count: int
    matches: list[dict]
    message: str


class PatientRecordMeta(BaseModel):
    """Record metadata row (no payload)."""
    record_id: str
    patient_id: str
    encrypted_preview: str
    created_by: str
    created_at: str


class AuditLogEntry(BaseModel):
    id: str
    operator_id: str
    patient_id: str | None
    action: str
    timestamp: str
    ip_address: str | None


class AssignDoctorPatientRequest(BaseModel):
    doctor_id: str = Field(..., description="UUID of the doctor or nurse operator")
    patient_id: str = Field(..., description="UUID of the patient operator")


class AssignDoctorPatientResponse(BaseModel):
    doctor_id: str
    patient_id: str
    assigned_at: str


# ──────────────────────────────────────────────────────────────────────────────
# POST /api/patients/records — Create encrypted patient record
# ──────────────────────────────────────────────────────────────────────────────


@router.post(
    "/patients/records",
    response_model=CreatePatientRecordResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create an encrypted patient record (doctor, nurse)",
    description=(
        "Encrypts the plaintext using AES-256-GCM, generates HMAC-SHA256 n-gram hashes "
        "for SSE search, and persists the record. The plaintext is dropped immediately "
        "after encryption."
    ),
)
async def create_patient_record(
    request: Request,
    payload: CreatePatientRecordRequest,
    operator: Annotated[OperatorClaims, Depends(require_role(["doctor", "nurse"]))],
    db: Annotated[AsyncSession, Depends(get_db)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> CreatePatientRecordResponse:
    # ── Enforce assignment: doctor/nurse must be assigned to this patient ──────
    # Admins cannot create records (not in require_role above), so no admin check needed.
    # This mirrors the same guard on the decrypt endpoint — admin assignment now
    # gates both write (create) and read (decrypt) access.
    await check_patient_access(payload.patient_id, operator, db)

    aes_key = derive_key(settings.aes_master_key)

    # Generate n-gram hashes (uses HMAC_SECRET — fully separate from AES key domain)
    ngram_hashes = generate_ngram_hashes(payload.plaintext_record, settings.hmac_secret, n=payload.ngram_size)

    # Derive per-patient key via HKDF-SHA256 and encrypt
    # K_patient = HKDF(master_key, info=patient_id) — never stored, derived on-the-fly
    aes_key = derive_key(settings.aes_master_key)
    encrypted_payload = encrypt_message(payload.plaintext_record, aes_key, patient_id=payload.patient_id)
    del payload.plaintext_record  # type: ignore[attr-defined]  # best-effort zeroing

    record_id = str(uuid4())
    created_at = datetime.now(timezone.utc)

    await db.execute(
        text(
            """
            INSERT INTO public.patient_records
                (id, patient_id, department, branch, record_type,
                 sensitivity_level, encrypted_payload, ngram_hashes,
                 created_by, created_at)
            VALUES
                (:id, :patient_id, :department, :branch, :record_type,
                 :sensitivity_level, :encrypted_payload, :ngram_hashes,
                 :created_by, :created_at)
            """
        ),
        {
            "id": record_id,
            "patient_id": payload.patient_id,
            "department": payload.department,
            "branch": payload.branch,
            "record_type": payload.record_type,
            "sensitivity_level": payload.sensitivity_level,
            "encrypted_payload": encrypted_payload,
            "ngram_hashes": ngram_hashes,
            "created_by": operator.sub,
            "created_at": created_at,
        },
    )
    await db.commit()

    logger.info(
        "Patient record created | record=%s patient=%s by=%s role=%s",
        record_id, payload.patient_id, operator.sub, operator.role,
    )

    return CreatePatientRecordResponse(
        record_id=record_id,
        patient_id=payload.patient_id,
        record_type=payload.record_type,
        sensitivity_level=payload.sensitivity_level,
        department=payload.department,
        branch=payload.branch,
        encrypted_preview=encrypted_payload[:48] + "...",
        created_by=operator.sub,
        created_at=created_at.isoformat(),
        hashes_generated=len(ngram_hashes),
    )


# ──────────────────────────────────────────────────────────────────────────────
# POST /api/patients/decrypt — Per-role decrypt with mandatory audit logging
# ──────────────────────────────────────────────────────────────────────────────


@router.post(
    "/patients/decrypt",
    response_model=DecryptPatientRecordResponse,
    summary="Decrypt a patient record (per-role access control + audit log)",
    description=(
        "Doctor: decrypt if assigned to patient. "
        "Nurse: metadata only (no plaintext). "
        "Patient: decrypt own records only. "
        "Admin/Auditor: always 403. "
        "Every attempt (success or failure) is logged in access_audit_log."
    ),
)
async def decrypt_patient_record(
    request: Request,
    payload: DecryptPatientRecordRequest,
    operator: Annotated[OperatorClaims, Depends(get_current_operator)],
    db: Annotated[AsyncSession, Depends(get_db)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> DecryptPatientRecordResponse:
    ip = get_client_ip(request)

    # ── 1. Fetch the record (need patient_id for access checks) ───────────────
    result = await db.execute(
        text(
            "SELECT id, patient_id, encrypted_payload, sensitivity_level, created_by, created_at "
            "FROM public.patient_records WHERE id = :id"
        ),
        {"id": payload.record_id},
    )
    row = result.mappings().first()
    if not row:
        await insert_audit_log(
            db,
            operator_id=operator.sub,
            patient_id=None,
            action="DECRYPT_DENIED_NOT_FOUND",
            ip_address=ip,
        )
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Record not found")

    patient_id = str(row["patient_id"])
    sensitivity_level = str(row.get("sensitivity_level") or "LOW")

    # ── 2. Admin / Auditor — always denied ────────────────────────────────────
    if operator.role in ("admin", "auditor"):
        await insert_audit_log(
            db,
            operator_id=operator.sub,
            patient_id=patient_id,
            action="DECRYPT_DENIED_ROLE_PROHIBITED",
            ip_address=ip,
        )
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Role '{operator.role}' is not permitted to decrypt medical records.",
        )

    # ── 3. Nurse — metadata-only access (no decryption) ───────────────────────
    if operator.role == "nurse":
        # Nurse must still be assigned to the patient
        try:
            await check_patient_access(patient_id, operator, db)
        except HTTPException:
            await insert_audit_log(
                db,
                operator_id=operator.sub,
                patient_id=patient_id,
                action="METADATA_DENIED_NOT_ASSIGNED",
                ip_address=ip,
            )
            raise

        await insert_audit_log(
            db,
            operator_id=operator.sub,
            patient_id=patient_id,
            action="METADATA_VIEW_SUCCESS",
            ip_address=ip,
        )
        logger.info("Nurse metadata access | record=%s nurse=%s", payload.record_id, operator.sub)
        return DecryptPatientRecordResponse(
            record_id=payload.record_id,
            patient_id=patient_id,
            sensitivity_level=sensitivity_level,
            plaintext=None,
            metadata_only=True,
            requires_approval=False,
            pending_request_id=None,
            created_by=str(row["created_by"]),
            created_at=row["created_at"].isoformat(),
            role_accessed_as=operator.role,
        )

    # ── 4. Doctor / Patient — access check ───────────────────────────────────
    try:
        await check_patient_access(patient_id, operator, db)
    except HTTPException:
        await insert_audit_log(
            db,
            operator_id=operator.sub,
            patient_id=patient_id,
            action="DECRYPT_DENIED_ACCESS_CHECK_FAILED",
            ip_address=ip,
        )
        raise

    # ── 4b. CRITICAL dual-authorization gate ─────────────────────────────────
    # CRITICAL records require a second, different authorized doctor to approve
    # before decryption proceeds. Non-critical records fall straight to step 5.
    if sensitivity_level == "CRITICAL":
        from uuid import uuid4 as _uuid4
        from datetime import datetime as _dt, timezone as _tz

        approved_check = await db.execute(
            text(
                "SELECT id FROM public.pending_access_requests "
                "WHERE operator_id = :op AND record_id = :rec AND status = 'APPROVED' "
                "ORDER BY approved_at DESC LIMIT 1"
            ),
            {"op": operator.sub, "rec": payload.record_id},
        )
        if not approved_check.first():
            pending_check = await db.execute(
                text(
                    "SELECT id FROM public.pending_access_requests "
                    "WHERE operator_id = :op AND record_id = :rec AND status = 'PENDING' LIMIT 1"
                ),
                {"op": operator.sub, "rec": payload.record_id},
            )
            pending_row = pending_check.first()
            if pending_row:
                req_id = str(pending_row[0])
            else:
                req_id = str(_uuid4())
                await db.execute(
                    text(
                        "INSERT INTO public.pending_access_requests "
                        "(id, operator_id, patient_id, record_id, status, created_at) "
                        "VALUES (:id, :op, :pat, :rec, 'PENDING', :ts)"
                    ),
                    {"id": req_id, "op": operator.sub, "pat": patient_id,
                     "rec": payload.record_id, "ts": _dt.now(_tz.utc)},
                )
                await db.commit()
                await insert_audit_log(
                    db, operator_id=operator.sub, patient_id=patient_id,
                    action="CRITICAL_ACCESS_REQUESTED", ip_address=ip,
                )
                logger.info(
                    "CRITICAL dual-auth required | request=%s operator=%s record=%s",
                    req_id, operator.sub, payload.record_id,
                )
            return DecryptPatientRecordResponse(
                record_id=payload.record_id,
                patient_id=patient_id,
                sensitivity_level=sensitivity_level,
                plaintext=None,
                metadata_only=False,
                requires_approval=True,
                pending_request_id=req_id,
                created_by=str(row["created_by"]),
                created_at=row["created_at"].isoformat(),
                role_accessed_as=operator.role,
            )
        # APPROVED — fall through to decrypt

    # ── 5. Decrypt using per-patient derived key ───────────────────────────────
    try:
        aes_key = derive_key(settings.aes_master_key)
        # Re-derive K_patient = HKDF(master_key, info=patient_id) deterministically.
        # Legacy records (no patient_id) fall back to master key via patient_id=None.
        plaintext = decrypt_message(str(row["encrypted_payload"]), aes_key, patient_id=patient_id)
    except Exception as exc:
        logger.warning("Decryption failure for record %s: %s", payload.record_id, exc)
        await insert_audit_log(
            db,
            operator_id=operator.sub,
            patient_id=patient_id,
            action="DECRYPT_FAILED_CRYPTO_ERROR",
            ip_address=ip,
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Decryption failed (tampered data or wrong key)",
        )

    # ── 6. Audit success ───────────────────────────────────────────────────────
    await insert_audit_log(
        db,
        operator_id=operator.sub,
        patient_id=patient_id,
        action="DECRYPT_SUCCESS",
        ip_address=ip,
    )
    logger.info(
        "DECRYPT_SUCCESS | record=%s patient=%s operator=%s role=%s",
        payload.record_id, patient_id, operator.sub, operator.role,
    )

    return DecryptPatientRecordResponse(
        record_id=payload.record_id,
        patient_id=patient_id,
        sensitivity_level=sensitivity_level,
        plaintext=plaintext,
        metadata_only=False,
        requires_approval=False,
        pending_request_id=None,
        created_by=str(row["created_by"]),
        created_at=row["created_at"].isoformat(),
        role_accessed_as=operator.role,
    )


# ──────────────────────────────────────────────────────────────────────────────
# POST /api/patients/search — SSE trapdoor search (no decryption)
# ──────────────────────────────────────────────────────────────────────────────


@router.post(
    "/patients/search",
    response_model=SearchPatientRecordsResponse,
    summary="Search encrypted patient records via SSE trapdoor (no decryption)",
    description=(
        "Generates HMAC trapdoor hashes for the query and finds patient_records "
        "with overlapping ngram_hashes. No decryption occurs. "
        "Allowed roles: doctor, nurse, auditor."
    ),
)
async def search_patient_records(
    request: Request,
    payload: SearchPatientRecordsRequest,
    operator: Annotated[OperatorClaims, Depends(require_role(["doctor", "nurse", "auditor"]))],
    db: Annotated[AsyncSession, Depends(get_db)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> SearchPatientRecordsResponse:
    query_hashes = generate_ngram_hashes(payload.query, settings.hmac_secret, n=3)
    if not query_hashes:
        return SearchPatientRecordsResponse(
            query=payload.query,
            trapdoor_hashes_count=0,
            matches=[],
            message="No tokens generated for query.",
        )

    try:
        result = await db.execute(
            text(
                """
                SELECT id, patient_id, encrypted_payload, created_by, created_at
                FROM public.patient_records
                WHERE ngram_hashes && :hashes
                ORDER BY created_at DESC
                LIMIT 50
                """
            ),
            {"hashes": query_hashes},
        )
        rows = result.mappings().all()
    except Exception as exc:
        logger.warning("Patient record SSE search failed: %s", exc)
        raise HTTPException(status_code=503, detail="Search unavailable")

    matches = [
        {
            "id": str(r["id"]),
            "patient_id": str(r["patient_id"]),
            "encrypted_preview": (r["encrypted_payload"] or "")[:48] + "...",
            "created_by": str(r["created_by"]),
            "created_at": r["created_at"].isoformat(),
        }
        for r in rows
    ]

    return SearchPatientRecordsResponse(
        query=payload.query,
        trapdoor_hashes_count=len(query_hashes),
        matches=matches,
        message=(
            "Search uses SSE: query → HMAC trapdoors; DB stores hashes per record; "
            "overlap match without any decryption."
        ),
    )


# ──────────────────────────────────────────────────────────────────────────────
# GET /api/patients/my-records — Records created by the current operator
# ──────────────────────────────────────────────────────────────────────────────


class MyRecordMeta(BaseModel):
    """Full metadata for a record created by this operator — no payload, no plaintext."""
    record_id: str
    patient_id: str
    record_type: str
    sensitivity_level: str
    department: str
    branch: str
    created_at: str


@router.get(
    "/patients/my-records",
    response_model=list[MyRecordMeta],
    summary="List metadata for all records I created (doctor, nurse)",
    description=(
        "Returns metadata (record_id, patient_id, sensitivity, type, department, branch, "
        "created_at) for every patient_record created by the authenticated operator. "
        "No encrypted payload or plaintext is ever returned — zero-exposure compliant."
    ),
)
async def list_my_records(
    operator: Annotated[OperatorClaims, Depends(require_role(["doctor", "nurse"]))],
    db: Annotated[AsyncSession, Depends(get_db)],
    limit: int = 100,
) -> list[MyRecordMeta]:
    result = await db.execute(
        text(
            """
            SELECT id, patient_id, record_type, sensitivity_level,
                   department, branch, created_at
            FROM public.patient_records
            WHERE created_by = :creator
            ORDER BY created_at DESC
            LIMIT :limit
            """
        ),
        {"creator": operator.sub, "limit": limit},
    )
    rows = result.mappings().all()
    return [
        MyRecordMeta(
            record_id=str(r["id"]),
            patient_id=str(r["patient_id"]),
            record_type=str(r.get("record_type") or "GENERAL"),
            sensitivity_level=str(r.get("sensitivity_level") or "LOW"),
            department=str(r.get("department") or ""),
            branch=str(r.get("branch") or ""),
            created_at=r["created_at"].isoformat(),
        )
        for r in rows
    ]


# ──────────────────────────────────────────────────────────────────────────────
# GET /api/patients/{patient_id}/records — List record metadata
# ──────────────────────────────────────────────────────────────────────────────


@router.get(
    "/patients/{patient_id}/records",
    response_model=list[PatientRecordMeta],
    summary="List metadata for a patient's records (doctor, nurse, admin)",
    description="Returns record metadata (no encrypted payloads or plaintext).",
)
async def list_patient_records(
    patient_id: str,
    operator: Annotated[OperatorClaims, Depends(require_role(["doctor", "nurse", "admin", "patient"]))],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> list[PatientRecordMeta]:
    # Doctors and nurses must be assigned; admins have unrestricted metadata view
    if operator.role in ("doctor", "nurse"):
        try:
            await check_patient_access(patient_id, operator, db)
        except HTTPException:
            raise

    result = await db.execute(
        text(
            """
            SELECT id, patient_id, encrypted_payload, created_by, created_at
            FROM public.patient_records
            WHERE patient_id = :patient_id
            ORDER BY created_at DESC
            """
        ),
        {"patient_id": patient_id},
    )
    rows = result.mappings().all()

    return [
        PatientRecordMeta(
            record_id=str(r["id"]),
            patient_id=str(r["patient_id"]),
            encrypted_preview=(r["encrypted_payload"] or "")[:48] + "...",
            created_by=str(r["created_by"]),
            created_at=r["created_at"].isoformat(),
        )
        for r in rows
    ]


# ──────────────────────────────────────────────────────────────────────────────
# GET /api/audit-log — View access audit log
# ──────────────────────────────────────────────────────────────────────────────


@router.get(
    "/audit-log",
    response_model=list[AuditLogEntry],
    summary="View access audit log (auditor, admin)",
    description=(
        "Returns the most recent 200 audit log entries. "
        "Every decrypt attempt (success or failure) is recorded here."
    ),
)
async def get_audit_log(
    operator: Annotated[OperatorClaims, Depends(require_role(["auditor", "admin"]))],
    db: Annotated[AsyncSession, Depends(get_db)],
    limit: int = 200,
) -> list[AuditLogEntry]:
    result = await db.execute(
        text(
            """
            SELECT id, operator_id, patient_id, action, timestamp, ip_address
            FROM public.access_audit_log
            ORDER BY timestamp DESC
            LIMIT :limit
            """
        ),
        {"limit": min(limit, 1000)},
    )
    rows = result.mappings().all()

    return [
        AuditLogEntry(
            id=str(r["id"]),
            operator_id=str(r["operator_id"]),
            patient_id=str(r["patient_id"]) if r["patient_id"] else None,
            action=r["action"],
            timestamp=r["timestamp"].isoformat(),
            ip_address=r["ip_address"],
        )
        for r in rows
    ]


# ──────────────────────────────────────────────────────────────────────────────
# POST /api/doctor-patient-map — Admin assigns doctor/nurse to patient
# ──────────────────────────────────────────────────────────────────────────────


@router.post(
    "/doctor-patient-map",
    response_model=AssignDoctorPatientResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Assign a doctor or nurse to a patient (admin only)",
    description=(
        "Creates a doctor_patient_map entry granting a doctor/nurse access "
        "to the specified patient's records. Only admins may call this endpoint. "
        "Duplicate assignments are silently ignored (ON CONFLICT DO NOTHING)."
    ),
)
async def assign_doctor_to_patient(
    payload: AssignDoctorPatientRequest,
    operator: Annotated[OperatorClaims, Depends(require_role(["admin"]))],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> AssignDoctorPatientResponse:
    # Verify the doctor_id actually exists and is a doctor/nurse
    result = await db.execute(
        text(
            "SELECT role FROM public.operators WHERE operator_uuid = :uuid"
        ),
        {"uuid": payload.doctor_id},
    )
    row = result.mappings().first()
    if not row:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Operator {payload.doctor_id!r} not found.",
        )
    if row["role"] not in ("doctor", "nurse"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Operator has role '{row['role']}' — only doctor/nurse can be assigned to patients.",
        )

    assigned_at = datetime.now(timezone.utc)
    await db.execute(
        text(
            """
            INSERT INTO public.doctor_patient_map (doctor_id, patient_id, assigned_at)
            VALUES (:doctor_id, :patient_id, :assigned_at)
            ON CONFLICT (doctor_id, patient_id) DO NOTHING
            """
        ),
        {
            "doctor_id": payload.doctor_id,
            "patient_id": payload.patient_id,
            "assigned_at": assigned_at,
        },
    )
    await db.commit()

    logger.info(
        "Doctor-patient assignment | doctor=%s patient=%s by_admin=%s",
        payload.doctor_id, payload.patient_id, operator.sub,
    )

    return AssignDoctorPatientResponse(
        doctor_id=payload.doctor_id,
        patient_id=payload.patient_id,
        assigned_at=assigned_at.isoformat(),
    )
