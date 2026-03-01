"""
Project Sentinel — Dual-Authorization Access Control Routes

Endpoints:
  POST /api/access/request/{record_id}     — Request CRITICAL record access (inserts pending)
  POST /api/access/approve/{request_id}    — Second doctor approves a pending request
  POST /api/access/deny/{request_id}       — Second doctor denies a pending request
  GET  /api/access/pending                 — List all PENDING requests (doctor/admin)
  GET  /api/access/my-requests             — List operator's own access requests
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Annotated
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from api.deps import (
    OperatorClaims,
    get_current_operator,
    insert_audit_log,
    get_client_ip,
    check_patient_access,
    require_role,
)
from models.database import get_db

logger = logging.getLogger("sentinel.access")

router = APIRouter(prefix="/api/access", tags=["dual-auth"])


# ──────────────────────────────────────────────────────────────────────────────
# Pydantic Schemas
# ──────────────────────────────────────────────────────────────────────────────


class PendingRequestOut(BaseModel):
    id: str
    operator_id: str
    patient_id: str
    record_id: str
    status: str
    approved_by: str | None
    created_at: str
    approved_at: str | None


class ApproveResponse(BaseModel):
    request_id: str
    status: str
    approved_by: str
    approved_at: str
    message: str


# ──────────────────────────────────────────────────────────────────────────────
# POST /api/access/request/{record_id} — Create a pending access request
# Called internally by the decrypt endpoint for CRITICAL records
# Also exposed so the frontend can directly create one.
# ──────────────────────────────────────────────────────────────────────────────


@router.post(
    "/request/{record_id}",
    response_model=PendingRequestOut,
    status_code=status.HTTP_202_ACCEPTED,
    summary="Request access to a CRITICAL patient record (returns 202 PENDING)",
    description=(
        "Creates a pending access request for a CRITICAL-level record. "
        "A second, different authorized doctor must approve before decryption is allowed. "
        "Returns the pending request details immediately."
    ),
)
async def request_critical_access(
    record_id: str,
    operator: Annotated[OperatorClaims, Depends(get_current_operator)],
    db: Annotated[AsyncSession, Depends(get_db)],
    request: Request,
) -> PendingRequestOut:
    ip = get_client_ip(request)

    # Fetch the record to validate it exists and is CRITICAL
    row = await db.execute(
        text(
            "SELECT id, patient_id, sensitivity_level "
            "FROM public.patient_records WHERE id = :id"
        ),
        {"id": record_id},
    )
    rec = row.mappings().first()
    if not rec:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Record not found")

    patient_id = str(rec["patient_id"])

    # Validate access for this operator
    try:
        await check_patient_access(patient_id, operator, db)
    except HTTPException:
        await insert_audit_log(
            db,
            operator_id=operator.sub,
            patient_id=patient_id,
            action="CRITICAL_REQUEST_DENIED_ACCESS",
            ip_address=ip,
        )
        raise

    # Check for an existing PENDING request from this operator for this record
    existing = await db.execute(
        text(
            "SELECT id FROM public.pending_access_requests "
            "WHERE operator_id = :op AND record_id = :rec AND status = 'PENDING' "
            "LIMIT 1"
        ),
        {"op": operator.sub, "rec": record_id},
    )
    if existing.first():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="You already have a pending access request for this record. "
                   "Await a second doctor's approval.",
        )

    request_id = str(uuid4())
    created_at = datetime.now(timezone.utc)

    await db.execute(
        text(
            """
            INSERT INTO public.pending_access_requests
                (id, operator_id, patient_id, record_id, status, created_at)
            VALUES
                (:id, :operator_id, :patient_id, :record_id, 'PENDING', :created_at)
            """
        ),
        {
            "id": request_id,
            "operator_id": operator.sub,
            "patient_id": patient_id,
            "record_id": record_id,
            "created_at": created_at,
        },
    )
    await db.commit()

    await insert_audit_log(
        db,
        operator_id=operator.sub,
        patient_id=patient_id,
        action="CRITICAL_ACCESS_REQUESTED",
        ip_address=ip,
    )

    logger.info(
        "CRITICAL access request created | request=%s operator=%s record=%s",
        request_id, operator.sub, record_id,
    )

    return PendingRequestOut(
        id=request_id,
        operator_id=operator.sub,
        patient_id=patient_id,
        record_id=record_id,
        status="PENDING",
        approved_by=None,
        created_at=created_at.isoformat(),
        approved_at=None,
    )


# ──────────────────────────────────────────────────────────────────────────────
# POST /api/access/approve/{request_id} — Second doctor approves
# ──────────────────────────────────────────────────────────────────────────────


@router.post(
    "/approve/{request_id}",
    response_model=ApproveResponse,
    summary="Approve a pending CRITICAL access request (doctor only, must be different operator)",
    description=(
        "A second authorized doctor approves the access request. "
        "The approver MUST be different from the requester and must also be "
        "assigned to the same patient. After approval the requester can decrypt."
    ),
)
async def approve_access_request(
    request_id: str,
    operator: Annotated[OperatorClaims, Depends(require_role(["doctor"]))],
    db: Annotated[AsyncSession, Depends(get_db)],
    request: Request,
) -> ApproveResponse:
    ip = get_client_ip(request)

    row = await db.execute(
        text(
            "SELECT id, operator_id, patient_id, record_id, status "
            "FROM public.pending_access_requests WHERE id = :id"
        ),
        {"id": request_id},
    )
    req_row = row.mappings().first()
    if not req_row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Request not found")

    if req_row["status"] != "PENDING":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Request is already {req_row['status']} — cannot approve again.",
        )

    # Approver must be a different operator
    if req_row["operator_id"] == operator.sub:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You cannot approve your own access request.",
        )

    # Approver must also be assigned to the same patient
    patient_id = str(req_row["patient_id"])
    try:
        await check_patient_access(patient_id, operator, db)
    except HTTPException:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You are not assigned to this patient and cannot approve this request.",
        )

    approved_at = datetime.now(timezone.utc)

    await db.execute(
        text(
            """
            UPDATE public.pending_access_requests
            SET status = 'APPROVED', approved_by = :approved_by, approved_at = :approved_at
            WHERE id = :id
            """
        ),
        {"approved_by": operator.sub, "approved_at": approved_at, "id": request_id},
    )
    await db.commit()

    await insert_audit_log(
        db,
        operator_id=operator.sub,
        patient_id=patient_id,
        action="CRITICAL_ACCESS_APPROVED",
        ip_address=ip,
    )

    logger.info(
        "CRITICAL access APPROVED | request=%s approver=%s requester=%s",
        request_id, operator.sub, req_row["operator_id"],
    )

    return ApproveResponse(
        request_id=request_id,
        status="APPROVED",
        approved_by=operator.sub,
        approved_at=approved_at.isoformat(),
        message="Access request approved. The requesting operator may now decrypt the record.",
    )


# ──────────────────────────────────────────────────────────────────────────────
# POST /api/access/deny/{request_id} — Second doctor denies
# ──────────────────────────────────────────────────────────────────────────────


@router.post(
    "/deny/{request_id}",
    response_model=ApproveResponse,
    summary="Deny a pending CRITICAL access request (doctor only)",
)
async def deny_access_request(
    request_id: str,
    operator: Annotated[OperatorClaims, Depends(require_role(["doctor"]))],
    db: Annotated[AsyncSession, Depends(get_db)],
    request: Request,
) -> ApproveResponse:
    ip = get_client_ip(request)

    row = await db.execute(
        text(
            "SELECT id, operator_id, patient_id, status "
            "FROM public.pending_access_requests WHERE id = :id"
        ),
        {"id": request_id},
    )
    req_row = row.mappings().first()
    if not req_row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Request not found")

    if req_row["status"] != "PENDING":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Request is already {req_row['status']}.",
        )

    if req_row["operator_id"] == operator.sub:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You cannot deny your own access request.",
        )

    denied_at = datetime.now(timezone.utc)
    patient_id = str(req_row["patient_id"])

    await db.execute(
        text(
            """
            UPDATE public.pending_access_requests
            SET status = 'DENIED', approved_by = :denied_by, approved_at = :denied_at
            WHERE id = :id
            """
        ),
        {"denied_by": operator.sub, "denied_at": denied_at, "id": request_id},
    )
    await db.commit()

    await insert_audit_log(
        db,
        operator_id=operator.sub,
        patient_id=patient_id,
        action="CRITICAL_ACCESS_DENIED",
        ip_address=ip,
    )

    return ApproveResponse(
        request_id=request_id,
        status="DENIED",
        approved_by=operator.sub,
        approved_at=denied_at.isoformat(),
        message="Access request denied.",
    )


# ──────────────────────────────────────────────────────────────────────────────
# GET /api/access/pending — List PENDING requests (for approver dashboard)
# ──────────────────────────────────────────────────────────────────────────────


@router.get(
    "/pending",
    response_model=list[PendingRequestOut],
    summary="List all PENDING access requests (doctor / admin)",
    description=(
        "Returns all requests with status=PENDING. Doctors see requests they can approve "
        "(i.e., not their own). Admins see all."
    ),
)
async def list_pending_requests(
    operator: Annotated[OperatorClaims, Depends(require_role(["doctor", "admin"]))],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> list[PendingRequestOut]:
    if operator.role == "admin":
        result = await db.execute(
            text(
                "SELECT id, operator_id, patient_id, record_id, status, "
                "approved_by, created_at, approved_at "
                "FROM public.pending_access_requests "
                "WHERE status = 'PENDING' ORDER BY created_at DESC LIMIT 200"
            )
        )
    else:
        # Doctors only see requests they did not initiate (i.e., ones they can approve)
        result = await db.execute(
            text(
                "SELECT id, operator_id, patient_id, record_id, status, "
                "approved_by, created_at, approved_at "
                "FROM public.pending_access_requests "
                "WHERE status = 'PENDING' AND operator_id != :me "
                "ORDER BY created_at DESC LIMIT 200"
            ),
            {"me": operator.sub},
        )
    rows = result.mappings().all()

    return [
        PendingRequestOut(
            id=str(r["id"]),
            operator_id=str(r["operator_id"]),
            patient_id=str(r["patient_id"]),
            record_id=str(r["record_id"]),
            status=r["status"],
            approved_by=str(r["approved_by"]) if r["approved_by"] else None,
            created_at=r["created_at"].isoformat(),
            approved_at=r["approved_at"].isoformat() if r["approved_at"] else None,
        )
        for r in rows
    ]


# ──────────────────────────────────────────────────────────────────────────────
# GET /api/access/my-requests — Operator's own request history
# ──────────────────────────────────────────────────────────────────────────────


@router.get(
    "/my-requests",
    response_model=list[PendingRequestOut],
    summary="List the current operator's own access request history",
)
async def my_access_requests(
    operator: Annotated[OperatorClaims, Depends(get_current_operator)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> list[PendingRequestOut]:
    result = await db.execute(
        text(
            "SELECT id, operator_id, patient_id, record_id, status, "
            "approved_by, created_at, approved_at "
            "FROM public.pending_access_requests "
            "WHERE operator_id = :me ORDER BY created_at DESC LIMIT 100"
        ),
        {"me": operator.sub},
    )
    rows = result.mappings().all()

    return [
        PendingRequestOut(
            id=str(r["id"]),
            operator_id=str(r["operator_id"]),
            patient_id=str(r["patient_id"]),
            record_id=str(r["record_id"]),
            status=r["status"],
            approved_by=str(r["approved_by"]) if r["approved_by"] else None,
            created_at=r["created_at"].isoformat(),
            approved_at=r["approved_at"].isoformat() if r["approved_at"] else None,
        )
        for r in rows
    ]
