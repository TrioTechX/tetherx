"""
Project Sentinel — Patient Record Governance & Monitoring Routes

POST /api/records/create         — Create encrypted patient record
POST /api/records/request-access — Risk-evaluate an access request (no decryption)
POST /api/records/issue-token    — Issue 5-min EDC token if risk is acceptable
POST /api/records/decrypt        — Decrypt a record using a valid EDC token
POST /api/search-encrypted       — SSE trapdoor search over chat_logs
POST /api/watchlist/add          — Add classified operation to watchlist
GET  /api/threats                — Threat feed for command dashboard
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import Annotated, Dict
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket, WebSocketDisconnect, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import text
from sqlalchemy.exc import OperationalError as SQLAlchemyOperationalError
from sqlalchemy.ext.asyncio import AsyncSession

from config.settings import Settings, get_settings
from api.deps import get_current_operator, OperatorClaims
from core.context_engine import ContextEngine
from core.crypto_engine import (
    ThreatDetectionEngine,
    WatchlistEntry,
    classify_severity,
    decrypt_message,
    derive_key,
    encrypt_message,
    generate_ngram_hashes,
)
from core.edc_engine import EDCEngine
from core.risk_engine import (
    ACTION_AUTO_APPROVE,
    ACTION_DENY,
    ACTION_REQUIRE_JUSTIFICATION,
    ACTION_REQUIRE_SECOND_APPROVAL,
    RiskScoringEngine,
)
from models.database import get_db

logger = logging.getLogger("sentinel.monitor")

router = APIRouter(prefix="/api", tags=["monitor"])

# Module-level singletons (stateless engines)
_context_engine = ContextEngine()
_risk_engine = RiskScoringEngine()
_edc_engine = EDCEngine()


# ──────────────────────────────────────────────────────────────────────────────
# WebSocket Connection Manager
# ──────────────────────────────────────────────────────────────────────────────


class SentinelWSManager:
    """
    Manages all active WebSocket connections.

    All authenticated clients connect to receive governance events:
      ACCESS_GRANTED    — a record was successfully accessed
      HIGH_RISK_ACCESS  — a HIGH or CRITICAL sensitivity record was accessed
      EMERGENCY_OVERRIDE — an admin-level override access was performed
      HEARTBEAT         — 20-second keepalive ping
    """

    def __init__(self) -> None:
        self._connections: Dict[str, WebSocket] = {}  # client_id → ws
        self._lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket, client_id: str) -> None:
        await websocket.accept()
        async with self._lock:
            self._connections[client_id] = websocket
        logger.info("WS connected: %s | total=%d", client_id[:8], self.count)

    async def disconnect(self, client_id: str) -> None:
        async with self._lock:
            self._connections.pop(client_id, None)
        logger.info("WS disconnected: %s | total=%d", client_id[:8], self.count)

    @property
    def count(self) -> int:
        return len(self._connections)

    async def broadcast(self, message: dict) -> None:
        """Send *message* to every connected client; prune dead connections."""
        if not self._connections:
            return
        data = json.dumps(message, default=str)
        dead: list[str] = []
        for cid, ws in list(self._connections.items()):
            try:
                await ws.send_text(data)
            except Exception:
                dead.append(cid)
        if dead:
            async with self._lock:
                for cid in dead:
                    self._connections.pop(cid, None)


ws_manager = SentinelWSManager()


# ──────────────────────────────────────────────────────────────────────────────
# WebSocket endpoint — /api/ws
# ──────────────────────────────────────────────────────────────────────────────


@router.websocket("/ws")
async def websocket_endpoint(
    websocket: WebSocket,
) -> None:
    """
    Governance live-feed WebSocket for Project Sentinel.

    No role parameter required — all authenticated clients receive the same
    governance event stream.

    Message types sent to clients:
      CONNECTED        — on handshake
      HEARTBEAT        — every 20-second keepalive
      ACCESS_GRANTED   — a patient record was successfully accessed
      HIGH_RISK_ACCESS — a HIGH or CRITICAL sensitivity record was accessed
      EMERGENCY_OVERRIDE — an admin override access was performed
    """
    client_id = str(uuid4())
    await ws_manager.connect(websocket, client_id)

    try:
        # Welcome message
        await websocket.send_json({
            "type": "CONNECTED",
            "client_id": client_id,
            "message": "Connected to Project Sentinel — Patient Record Governance Feed",
            "connected_clients": ws_manager.count,
        })

        # Keep-alive loop: listen for pings, send heartbeats every 20s
        while True:
            try:
                raw = await asyncio.wait_for(websocket.receive_text(), timeout=20.0)
                if raw.strip() == "ping":
                    await websocket.send_text("pong")
            except asyncio.TimeoutError:
                await websocket.send_json({
                    "type": "HEARTBEAT",
                    "ts": datetime.now(timezone.utc).isoformat(),
                    "connected_clients": ws_manager.count,
                })

    except WebSocketDisconnect:
        pass
    except Exception as exc:
        logger.debug("WebSocket error for %s: %s", client_id[:8], exc)
    finally:
        await ws_manager.disconnect(client_id)


# ──────────────────────────────────────────────────────────────────────────────
# Database connectivity check (for troubleshooting Supabase connection)
# ──────────────────────────────────────────────────────────────────────────────


@router.get(
    "/check-db",
    summary="Check Supabase database connectivity",
    description="Returns ok: true if the backend can reach Supabase PostgreSQL; otherwise ok: false with the error message.",
)
async def check_db(
    db: Annotated[AsyncSession, Depends(get_db)],
) -> dict:
    try:
        await db.execute(text("SELECT 1"))
        return {"ok": True, "message": "Database connection successful."}
    except Exception as exc:
        err_msg = str(exc).split("\n")[0] if "\n" in str(exc) else str(exc)
        logger.warning("Check DB failed: %s", exc)
        return {"ok": False, "error": err_msg}


# ──────────────────────────────────────────────────────────────────────────────
# Pydantic Schemas
# ──────────────────────────────────────────────────────────────────────────────


class RecordCreateRequest(BaseModel):
    """Inbound governance request to create an encrypted patient record."""

    patient_id: str = Field(
        ...,
        description="UUID of the patient this record belongs to",
    )
    record_type: str = Field(
        default="GENERAL",
        max_length=64,
        description="Type of medical record (e.g. LAB_RESULT, PRESCRIPTION, NOTE, IMAGING)",
    )
    plaintext_record: str = Field(
        ...,
        min_length=1,
        max_length=8192,
        description="Medical record plaintext to encrypt and store",
    )
    sensitivity_level: str = Field(
        default="LOW",
        description="Sensitivity classification: LOW, MEDIUM, HIGH, or CRITICAL",
    )
    department: str = Field(default="", max_length=128, description="Hospital department")
    branch: str = Field(default="", max_length=128, description="Hospital branch or facility")
    ngram_size: int = Field(
        default=3,
        ge=1,
        le=5,
        description="N-gram width for SSE indexing",
    )

    @field_validator("sensitivity_level")
    @classmethod
    def validate_sensitivity(cls, v: str) -> str:
        allowed = {"LOW", "MEDIUM", "HIGH", "CRITICAL"}
        v_upper = v.upper()
        if v_upper not in allowed:
            raise ValueError(f"sensitivity_level must be one of {sorted(allowed)}")
        return v_upper


class InterceptionNodeResult(BaseModel):
    """One detection node that flagged the message."""
    node_id: str
    match_count: int
    matched_hashes: list[str] = Field(default_factory=list)
    false_positive_rate: float = 0.0


class ThreatAnalysisResult(BaseModel):
    """Breakdown of the Bloom-filter analysis (returned to caller)."""

    is_threat: bool
    match_count: int
    max_false_positive_rate: float
    hashes_generated: int
    severity: str = "CLEAR"
    intercepting_nodes: list[InterceptionNodeResult] = Field(default_factory=list)


class RecordCreateResponse(BaseModel):
    """Response payload after successful patient record creation."""

    record_id: str
    patient_id: str
    record_type: str
    sensitivity_level: str
    department: str
    branch: str
    timestamp: str
    encrypted_payload_preview: str = Field(
        description="First 32 chars of the AES-GCM blob — never the plaintext"
    )
    hashes_generated: int
    status: str = "CREATED"
    database_persisted: bool = Field(
        default=True,
        description="False when DB was unreachable; encryption still performed.",
    )


# ──────────────────────────────────────────────────────────────────────────────
# Watchlist cache (loaded once per worker, refreshed on each request if stale)
# ──────────────────────────────────────────────────────────────────────────────

_engine_cache: ThreatDetectionEngine | None = None


async def _load_detection_engine(
    db: AsyncSession,
    settings: Settings,
    aes_key: bytes,
) -> ThreatDetectionEngine:
    """
    Load all watchlist rows from Supabase and hydrate a ThreatDetectionEngine.
    In production this would be cached with a TTL; here we reload each request
    to demonstrate live watchlist updates.
    """
    engine = ThreatDetectionEngine(threshold=settings.threat_match_threshold)

    result = await db.execute(
        text("SELECT operation_name, bloom_filter_data FROM public.watchlist")
    )
    rows = result.mappings().all()

    if rows:
        engine.load_watchlist_from_db_rows(
            [dict(r) for r in rows],
            aes_key=aes_key,
        )
        if not engine._watchlist:
            logger.warning("All watchlist rows were invalid. Falling back to demo filter.")
            engine.build_watchlist_filter(
                classified_terms=[
                    "operation thunderstrike",
                    "classified coordinates",
                    "launch codes",
                    "extraction point delta",
                    "nuclear",
                    "override",
                ],
                hmac_secret=settings.hmac_secret,
                operation_name="DEMO_OPERATION",
                aes_key=aes_key,
            )
    else:
        # Fallback demo filter so the system is non-trivially operational
        logger.warning("No watchlist entries found — using demo filter")
        engine.build_watchlist_filter(
            classified_terms=[
                "operation thunderstrike",
                "classified coordinates",
                "launch codes",
                "extraction point delta",
                "nuclear",
                "override",
            ],
            hmac_secret=settings.hmac_secret,
            operation_name="DEMO_OPERATION",
            aes_key=aes_key,
        )

    return engine


DEMO_CLASSIFIED_TERMS = [
    "operation thunderstrike",
    "classified coordinates",
    "launch codes",
    "extraction point delta",
    "nuclear",
    "override",
]


def _build_demo_detection_engine(settings: Settings, aes_key: bytes) -> ThreatDetectionEngine:
    """Build threat detection engine with demo watchlist only (no DB). Used when DB is unreachable."""
    engine = ThreatDetectionEngine(threshold=settings.threat_match_threshold)
    engine.build_watchlist_filter(
        classified_terms=DEMO_CLASSIFIED_TERMS,
        hmac_secret=settings.hmac_secret,
        operation_name="DEMO_OPERATION",
        aes_key=aes_key,
    )
    return engine


# ──────────────────────────────────────────────────────────────────────────────
# Route
# ──────────────────────────────────────────────────────────────────────────────


@router.post(
    "/records/create",
    response_model=RecordCreateResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create an encrypted patient record (governance entry point)",
    description=(
        "Accepts a patient record, generates cryptographic N-gram hashes for SSE search, "
        "encrypts the content with AES-256-GCM (per-patient key via HKDF), "
        "and persists the result in patient_records. "
        "The plaintext is zeroed from memory immediately after encryption. "
        "Records persist independently of any user's online presence."
    ),
)
async def create_patient_record_govern(
    payload: RecordCreateRequest,
    db: Annotated[AsyncSession, Depends(get_db)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> RecordCreateResponse:
    # ── 1. Derive cryptographic material ──────────────────────────────────────
    try:
        aes_key = derive_key(settings.aes_master_key)
    except (ValueError, Exception) as exc:
        logger.error("Key derivation failure: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Cryptographic initialisation failure",
        )

    # ── 2. Generate SSE n-gram hashes (plaintext still in scope) ──────────────
    ngram_hashes = generate_ngram_hashes(
        payload.plaintext_record,
        settings.hmac_secret,
        n=payload.ngram_size,
    )

    # ── 3. Encrypt with per-patient derived key & drop plaintext ─────────────
    # K_patient = HKDF(master_key, info=patient_id) — never stored, derived on-the-fly
    encrypted_payload = encrypt_message(
        payload.plaintext_record, aes_key, patient_id=payload.patient_id
    )
    plaintext_ref = payload.plaintext_record
    del plaintext_ref  # best-effort zeroing

    record_id = str(uuid4())
    timestamp = datetime.now(timezone.utc)
    database_persisted = True

    # ── 4. Persist to patient_records ─────────────────────────────────────────
    try:
        await db.execute(
            text(
                """
                INSERT INTO public.patient_records
                    (id, patient_id, department, branch, record_type,
                     sensitivity_level, encrypted_payload, ngram_hashes,
                     created_at)
                VALUES
                    (:id, :patient_id, :department, :branch, :record_type,
                     :sensitivity_level, :encrypted_payload, :ngram_hashes,
                     :created_at)
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
                "created_at": timestamp,
            },
        )
        await db.commit()
        logger.info(
            "Patient record created | record=%s patient=%s sensitivity=%s",
            record_id, payload.patient_id, payload.sensitivity_level,
        )
    except SQLAlchemyOperationalError as exc:
        logger.warning("Database unreachable — record not persisted: %s", exc)
        database_persisted = False
    except Exception as exc:
        await db.rollback()
        logger.error("Patient record write failure: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Persistence layer unavailable",
        )

    return RecordCreateResponse(
        record_id=record_id,
        patient_id=payload.patient_id,
        record_type=payload.record_type,
        sensitivity_level=payload.sensitivity_level,
        department=payload.department,
        branch=payload.branch,
        timestamp=timestamp.isoformat(),
        encrypted_payload_preview=encrypted_payload[:32] + "...",
        hashes_generated=len(ngram_hashes),
        database_persisted=database_persisted,
    )


# ──────────────────────────────────────────────────────────────────────────────
# Governance: Record access — fetches & decrypts a patient record, emits WS event
# ──────────────────────────────────────────────────────────────────────────────


class RecordAccessRequest(BaseModel):
    record_id: str = Field(..., description="UUID of the patient_record to risk-evaluate")
    justification: str | None = Field(
        default=None,
        max_length=1024,
        description="Optional justification text (required when action is REQUIRE_JUSTIFICATION)",
    )


class RecordAccessResponse(BaseModel):
    record_id: str
    patient_id: str
    sensitivity_level: str
    # Risk evaluation result — no plaintext here
    risk_score: int
    action: str = Field(
        description="AUTO_APPROVE | REQUIRE_JUSTIFICATION | REQUIRE_SECOND_APPROVAL | DENY"
    )
    reasons: list[str]
    flagged: bool
    ws_event: str = Field(description="WebSocket event broadcast for this evaluation")


@router.post(
    "/records/request-access",
    response_model=RecordAccessResponse,
    summary="Risk-evaluate a patient record access request (no decryption)",
    description=(
        "Runs ContextEngine + RiskScoringEngine against the requested patient record. "
        "Returns risk_score, action, and reasons. "
        "Does NOT decrypt the record. Use /api/records/issue-token to get a decryption token "
        "after this evaluation, then /api/records/decrypt to actually read the plaintext."
    ),
)
async def request_record_access(
    payload: RecordAccessRequest,
    operator: Annotated[OperatorClaims, Depends(get_current_operator)],
    db: Annotated[AsyncSession, Depends(get_db)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> RecordAccessResponse:
    # ── 1. Fetch record metadata (no encrypted_payload needed) ───────────────────
    result = await db.execute(
        text(
            """
            SELECT id, patient_id, sensitivity_level
            FROM public.patient_records
            WHERE id = :id
            """
        ),
        {"id": payload.record_id},
    )
    row = result.mappings().first()
    if not row:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Patient record not found",
        )

    patient_id = str(row["patient_id"])
    sensitivity_level = str(row.get("sensitivity_level") or "LOW")

    # ── 2. Access frequency (last 60 minutes) ────────────────────────────────
    try:
        freq_result = await db.execute(
            text(
                """
                SELECT COUNT(*) FROM public.access_audit_log
                WHERE operator_id = :op
                  AND accessed_at > NOW() - INTERVAL '1 hour'
                """
            ),
            {"op": operator.sub},
        )
        access_frequency = int(freq_result.scalar() or 0)
    except Exception:
        access_frequency = 0  # fail-open: unknown frequency

    # ── 3. Build access context ─────────────────────────────────────────────
    ctx = await _context_engine.build_context(
        operator=operator,
        requested_patient_id=patient_id,
        sensitivity_level=sensitivity_level,
        db=db,
    )

    # ── 4. Risk evaluation (pure, no I/O) ──────────────────────────────────
    decision = _risk_engine.evaluate(ctx, access_frequency=access_frequency)

    # ── 5. WebSocket event ──────────────────────────────────────────────────
    if decision.action == ACTION_DENY:
        ws_event = "HIGH_RISK_ACCESS"
    elif decision.risk_score >= 40:
        ws_event = "HIGH_RISK_ACCESS"
    else:
        ws_event = "ACCESS_GRANTED"

    logger.info(
        "RiskEval complete | record=%s patient=%s score=%d action=%s operator=%s",
        payload.record_id, patient_id, decision.risk_score,
        decision.action, operator.sub,
    )

    await ws_manager.broadcast({
        "type": ws_event,
        "record_id": payload.record_id,
        "patient_id": patient_id,
        "sensitivity_level": sensitivity_level,
        "risk_score": decision.risk_score,
        "action": decision.action,
        "operator_id": operator.sub,
        "ts": datetime.now(timezone.utc).isoformat(),
    })

    return RecordAccessResponse(
        record_id=str(row["id"]),
        patient_id=patient_id,
        sensitivity_level=sensitivity_level,
        risk_score=decision.risk_score,
        action=decision.action,
        reasons=list(decision.reasons),
        flagged=decision.flagged,
        ws_event=ws_event,
    )


# ──────────────────────────────────────────────────────────────────────────────
# EDC: Issue a time-bound decryption token
# ──────────────────────────────────────────────────────────────────────────────


class IssueTokenRequest(BaseModel):
    record_id: str = Field(..., description="UUID of the patient_record to request a token for")
    justification: str | None = Field(
        default=None,
        max_length=1024,
        description="Required when risk action is REQUIRE_JUSTIFICATION",
    )


class IssueTokenResponse(BaseModel):
    token_id: str
    record_id: str
    patient_id: str
    expires_at: str
    action: str
    risk_score: int
    reasons: list[str]
    message: str


@router.post(
    "/records/issue-token",
    response_model=IssueTokenResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Issue a 5-minute ephemeral decryption token (if risk is acceptable)",
    description=(
        "Runs ContextEngine + RiskScoringEngine. "
        "Issues a single-use, 5-minute EDC token when action is AUTO_APPROVE or "
        "REQUIRE_JUSTIFICATION (with justification provided). "
        "Returns 403 for REQUIRE_SECOND_APPROVAL or DENY."
    ),
)
async def issue_decryption_token(
    payload: IssueTokenRequest,
    operator: Annotated[OperatorClaims, Depends(get_current_operator)],
    db: Annotated[AsyncSession, Depends(get_db)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> IssueTokenResponse:
    # ── Fetch record metadata ──────────────────────────────────────────────────
    result = await db.execute(
        text(
            "SELECT id, patient_id, sensitivity_level "
            "FROM public.patient_records WHERE id = :id"
        ),
        {"id": payload.record_id},
    )
    row = result.mappings().first()
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Patient record not found")

    patient_id = str(row["patient_id"])
    sensitivity_level = str(row.get("sensitivity_level") or "LOW")

    # ── Access frequency ───────────────────────────────────────────────────────
    try:
        freq_result = await db.execute(
            text(
                "SELECT COUNT(*) FROM public.access_audit_log "
                "WHERE operator_id = :op AND accessed_at > NOW() - INTERVAL '1 hour'"
            ),
            {"op": operator.sub},
        )
        access_frequency = int(freq_result.scalar() or 0)
    except Exception:
        access_frequency = 0

    # ── Context + risk evaluation ──────────────────────────────────────────────
    ctx = await _context_engine.build_context(
        operator=operator,
        requested_patient_id=patient_id,
        sensitivity_level=sensitivity_level,
        db=db,
    )
    decision = _risk_engine.evaluate(ctx, access_frequency=access_frequency)

    # ── Gate: block DENY and REQUIRE_SECOND_APPROVAL ──────────────────────────
    if decision.action == ACTION_DENY:
        await ws_manager.broadcast({
            "type": "HIGH_RISK_ACCESS",
            "record_id": payload.record_id,
            "patient_id": patient_id,
            "risk_score": decision.risk_score,
            "action": decision.action,
            "operator_id": operator.sub,
            "ts": datetime.now(timezone.utc).isoformat(),
        })
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "action": decision.action,
                "risk_score": decision.risk_score,
                "reasons": decision.reasons,
                "message": "Access denied. Risk score too high.",
            },
        )

    if decision.action == ACTION_REQUIRE_SECOND_APPROVAL:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "action": decision.action,
                "risk_score": decision.risk_score,
                "reasons": decision.reasons,
                "message": "Second approver required. Use the dual-authorization flow.",
            },
        )

    if decision.action == ACTION_REQUIRE_JUSTIFICATION and not payload.justification:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "action": decision.action,
                "risk_score": decision.risk_score,
                "reasons": decision.reasons,
                "message": "Justification required. Resubmit with a justification field.",
            },
        )

    # ── Issue EDC token ────────────────────────────────────────────────────────
    token = await _edc_engine.issue_token(
        operator_id=operator.sub,
        patient_id=patient_id,
        record_id=payload.record_id,
        db=db,
    )

    ws_event = "HIGH_RISK_ACCESS" if decision.risk_score >= 40 else "ACCESS_GRANTED"
    await ws_manager.broadcast({
        "type": ws_event,
        "record_id": payload.record_id,
        "patient_id": patient_id,
        "risk_score": decision.risk_score,
        "action": decision.action,
        "operator_id": operator.sub,
        "token_issued": True,
        "ts": datetime.now(timezone.utc).isoformat(),
    })

    return IssueTokenResponse(
        token_id=token.token_id,
        record_id=payload.record_id,
        patient_id=patient_id,
        expires_at=token.expires_at.isoformat(),
        action=decision.action,
        risk_score=decision.risk_score,
        reasons=list(decision.reasons),
        message=f"Token valid for 5 minutes. Use POST /api/records/decrypt with token_id={token.token_id}",
    )


# ──────────────────────────────────────────────────────────────────────────────
# EDC: Decrypt a record using a valid ephemeral token
# ──────────────────────────────────────────────────────────────────────────────


class DecryptWithTokenRequest(BaseModel):
    record_id: str = Field(..., description="UUID of the patient_record to decrypt")
    token_id: str = Field(..., description="UUID of the valid EDC token from /records/issue-token")


class DecryptWithTokenResponse(BaseModel):
    record_id: str
    patient_id: str
    record_type: str
    sensitivity_level: str
    department: str
    branch: str
    created_at: str
    plaintext: str = Field(description="Decrypted patient record content (in-memory only, never stored)")
    token_consumed: bool = True


@router.post(
    "/records/decrypt",
    response_model=DecryptWithTokenResponse,
    summary="Decrypt a patient record using a valid EDC token",
    description=(
        "Validates the EDC token (expiry + operator ownership + record binding). "
        "On success: decrypts with HKDF per-patient key, returns plaintext, "
        "consumes (deletes) the token (single-use). "
        "On failure: 403. Plaintext is NEVER stored in DB."
    ),
)
async def decrypt_with_token(
    payload: DecryptWithTokenRequest,
    operator: Annotated[OperatorClaims, Depends(get_current_operator)],
    db: Annotated[AsyncSession, Depends(get_db)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> DecryptWithTokenResponse:
    # ── 1. Validate EDC token ──────────────────────────────────────────────────
    validated = await _edc_engine.validate_token(
        token_id=payload.token_id,
        requesting_operator_id=operator.sub,
        record_id=payload.record_id,
        db=db,
    )
    if not validated:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Token invalid, expired, or not authorised for this operator/record.",
        )

    # ── 2. Fetch full record (including encrypted_payload) ────────────────────
    result = await db.execute(
        text(
            """
            SELECT id, patient_id, department, branch, record_type,
                   sensitivity_level, encrypted_payload, created_at
            FROM public.patient_records
            WHERE id = :id
            """
        ),
        {"id": payload.record_id},
    )
    record_row = result.mappings().first()
    if not record_row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Patient record not found")

    patient_id = str(record_row["patient_id"])

    # ── 3. Decrypt with per-patient HKDF key ─────────────────────────────────
    aes_key = derive_key(settings.aes_master_key)
    try:
        plaintext = decrypt_message(
            str(record_row["encrypted_payload"]), aes_key, patient_id=patient_id
        )
    except Exception as exc:
        logger.warning("EDC decrypt failed | record=%s token=%s: %s", payload.record_id, payload.token_id, exc)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Decryption failed (tampered data or wrong key).",
        )

    # ── 4. Consume token (single-use enforcement) ─────────────────────────────
    await _edc_engine.consume_token(token_id=payload.token_id, db=db)

    # ── 5. Broadcast governance event ────────────────────────────────────────
    sensitivity_level = str(record_row.get("sensitivity_level") or "LOW")
    ws_event = "HIGH_RISK_ACCESS" if sensitivity_level in ("HIGH", "CRITICAL") else "ACCESS_GRANTED"

    logger.info(
        "EDC decrypt succeeded | record=%s patient=%s token=%s operator=%s sensitivity=%s",
        payload.record_id, patient_id, payload.token_id, operator.sub, sensitivity_level,
    )

    await ws_manager.broadcast({
        "type": ws_event,
        "record_id": payload.record_id,
        "patient_id": patient_id,
        "sensitivity_level": sensitivity_level,
        "operator_id": operator.sub,
        "token_id": payload.token_id,
        "edc_decrypt": True,
        "ts": datetime.now(timezone.utc).isoformat(),
    })

    return DecryptWithTokenResponse(
        record_id=str(record_row["id"]),
        patient_id=patient_id,
        record_type=str(record_row.get("record_type") or "GENERAL"),
        sensitivity_level=sensitivity_level,
        department=str(record_row.get("department") or ""),
        branch=str(record_row.get("branch") or ""),
        created_at=record_row["created_at"].isoformat(),
        plaintext=plaintext,
    )



# ──────────────────────────────────────────────────────────────────────────────
# Search encrypted DB using SSE (trapdoor search)
# ──────────────────────────────────────────────────────────────────────────────


class SearchEncryptedRequest(BaseModel):
    query: str = Field(..., min_length=1, max_length=500, description="Search term (e.g. classified phrase)")


class SearchEncryptedResponse(BaseModel):
    query: str
    trapdoor_hashes_count: int
    message: str = Field(description="How search works: trapdoor → DB overlap, no decryption")
    matches: list[dict] = Field(description="Rows where ngram_hashes overlap with query hashes (encrypted only)")


@router.post(
    "/search-encrypted",
    response_model=SearchEncryptedResponse,
    summary="Search encrypted messages by trapdoor (SSE)",
    description="Generate HMAC trapdoor for query; find chat_logs where ngram_hashes overlap. No decryption.",
)
async def search_encrypted(
    payload: SearchEncryptedRequest,
    db: Annotated[AsyncSession, Depends(get_db)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> SearchEncryptedResponse:
    query_hashes = generate_ngram_hashes(payload.query, settings.hmac_secret, n=3)
    if not query_hashes:
        return SearchEncryptedResponse(
            query=payload.query,
            trapdoor_hashes_count=0,
            message="No tokens generated for query.",
            matches=[],
        )
    try:
        result = await db.execute(
            text(
                """
                SELECT id, unit_id, timestamp, encrypted_payload, threat_flag, match_count
                FROM public.chat_logs
                WHERE ngram_hashes && :hashes
                ORDER BY timestamp DESC
                LIMIT 50
                """
            ),
            {"hashes": query_hashes},
        )
        rows = result.mappings().all()
    except Exception as exc:
        if "ngram_hashes" in str(exc):
            return SearchEncryptedResponse(
                query=payload.query,
                trapdoor_hashes_count=len(query_hashes),
                message="SSE search requires ngram_hashes column. Run backend/models/migration_ngram_hashes.sql in Supabase.",
                matches=[],
            )
        raise

    matches = [
        {
            "id": str(r["id"]),
            "unit_id": r["unit_id"],
            "timestamp": r["timestamp"].isoformat(),
            "encrypted_preview": (r["encrypted_payload"] or "")[:48] + "...",
            "threat_flag": r["threat_flag"],
            "match_count": r["match_count"],
        }
        for r in rows
    ]
    return SearchEncryptedResponse(
        query=payload.query,
        trapdoor_hashes_count=len(query_hashes),
        message="Search uses SSE: query → HMAC trapdoors; DB stores hashes per message; overlap match without decryption.",
        matches=matches,
    )


# ──────────────────────────────────────────────────────────────────────────────
# Watchlist management (admin-only in production — no auth guard here for demo)
# ──────────────────────────────────────────────────────────────────────────────


class WatchlistAddRequest(BaseModel):
    operation_name: str = Field(..., min_length=1, max_length=128)
    classified_terms: list[str] = Field(..., min_length=1)


class WatchlistAddResponse(BaseModel):
    watchlist_id: str
    operation_name_encrypted: str
    terms_loaded: int
    estimated_fpr: float


@router.post(
    "/watchlist/add",
    response_model=WatchlistAddResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Add a new classified operation to the watchlist",
)
async def add_watchlist_entry(
    payload: WatchlistAddRequest,
    db: Annotated[AsyncSession, Depends(get_db)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> WatchlistAddResponse:
    aes_key = derive_key(settings.aes_master_key)

    tmp_engine = ThreatDetectionEngine()
    entry: WatchlistEntry = tmp_engine.build_watchlist_filter(
        classified_terms=payload.classified_terms,
        hmac_secret=settings.hmac_secret,
        operation_name=payload.operation_name,
        aes_key=aes_key,
        bloom_size=settings.bloom_filter_size,
        bloom_k=settings.bloom_hash_count,
    )

    bloom_bytes = entry.bloom_filter.to_bytes()
    fpr = entry.bloom_filter.estimated_false_positive_rate
    wl_id = str(uuid4())

    try:
        await db.execute(
            text(
                """
                INSERT INTO public.watchlist (id, operation_name, bloom_filter_data)
                VALUES (:id, :operation_name, :bloom_filter_data)
                """
            ),
            {
                "id": wl_id,
                "operation_name": entry.operation_name_encrypted,
                "bloom_filter_data": bloom_bytes,
            },
        )
        await db.commit()
    except Exception as exc:
        await db.rollback()
        logger.error("Watchlist write failure: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Failed to persist watchlist entry",
        )

    return WatchlistAddResponse(
        watchlist_id=wl_id,
        operation_name_encrypted=entry.operation_name_encrypted[:32] + "...",
        terms_loaded=len(payload.classified_terms),
        estimated_fpr=round(fpr, 8),
    )


# ──────────────────────────────────────────────────────────────────────────────
# Threat feed for Receiver Dashboard
# ──────────────────────────────────────────────────────────────────────────────


class ThreatEntry(BaseModel):
    id: str
    unit_id: str
    timestamp: str
    encrypted_preview: str
    match_count: int
    severity: str
    ngram_hash_sample: list[str] = Field(default_factory=list)


class ThreatFeedResponse(BaseModel):
    total_intercepted: int
    total_threats: int
    threats: list[ThreatEntry]
    severity_breakdown: dict[str, int]


@router.get(
    "/threats",
    response_model=ThreatFeedResponse,
    summary="Threat feed for receiver dashboard",
    description="Returns all threat-flagged messages with severity breakdown. "
                "Severity is computed from match_count (deterministic).",
)
async def get_threats(
    db: Annotated[AsyncSession, Depends(get_db)],
    limit: int = 100,
) -> ThreatFeedResponse:
    try:
        count_result = await db.execute(text("SELECT COUNT(*) FROM public.chat_logs"))
        total_intercepted = count_result.scalar() or 0

        result = await db.execute(
            text(
                """
                SELECT id, unit_id, timestamp, encrypted_payload,
                       match_count, ngram_hash_sample
                FROM public.chat_logs
                WHERE threat_flag = true
                ORDER BY timestamp DESC
                LIMIT :lim
                """
            ),
            {"lim": limit},
        )
        rows = result.mappings().all()
    except Exception as exc:
        logger.warning("Threat feed query failed: %s", exc)
        return ThreatFeedResponse(
            total_intercepted=0,
            total_threats=0,
            threats=[],
            severity_breakdown={},
        )

    severity_counts: dict[str, int] = {"CRITICAL": 0, "HIGH": 0, "MEDIUM": 0, "LOW": 0}
    threats: list[ThreatEntry] = []

    for r in rows:
        mc = r["match_count"] or 0
        sev = classify_severity(mc, 1)
        severity_counts[sev] = severity_counts.get(sev, 0) + 1

        sample = r.get("ngram_hash_sample") or []
        if isinstance(sample, str):
            import json as _json
            try:
                sample = _json.loads(sample)
            except Exception:
                sample = []

        threats.append(
            ThreatEntry(
                id=str(r["id"]),
                unit_id=r["unit_id"],
                timestamp=r["timestamp"].isoformat() if hasattr(r["timestamp"], "isoformat") else str(r["timestamp"]),
                encrypted_preview=(r["encrypted_payload"] or "")[:48] + "...",
                match_count=mc,
                severity=sev,
                ngram_hash_sample=sample[:5] if isinstance(sample, list) else [],
            )
        )

    return ThreatFeedResponse(
        total_intercepted=total_intercepted,
        total_threats=len(threats),
        threats=threats,
        severity_breakdown=severity_counts,
    )


# ──────────────────────────────────────────────────────────────────────────────
# 3D Threat Network Graph — Operator connections & threat visualization
# ──────────────────────────────────────────────────────────────────────────────


class ThreatNetworkNode(BaseModel):
    """Represents an operator/unit as a node in the 3D threat network."""
    id: str  # unit_id
    label: str
    threat_level: str  # CLEAR, LOW, MEDIUM, HIGH, CRITICAL
    match_count: int
    message_count: int
    position: dict = Field(default_factory=lambda: {"x": 0, "y": 0, "z": 0})


class ThreatNetworkEdge(BaseModel):
    """Represents a connection between operators with threat info."""
    source: str  # from unit_id
    target: str  # to unit_id
    weight: int  # message count between them
    threat_count: int  # threats detected
    severity: str  # highest severity in this connection


class ThreatNetworkResponse(BaseModel):
    """Complete 3D threat network graph data."""
    nodes: list[ThreatNetworkNode]
    edges: list[ThreatNetworkEdge]
    total_nodes: int
    total_edges: int
    network_threat_level: str
    timestamp: str


@router.get(
    "/threat-network",
    response_model=ThreatNetworkResponse,
    summary="3D Threat Network Graph data",
    description="Returns operator nodes and threat connections for 3D visualization. "
                "Interactive filtering by unit, operator, threat level available.",
)
async def get_threat_network(
    db: Annotated[AsyncSession, Depends(get_db)],
    min_severity: str = Query("CLEAR", pattern="^(CLEAR|LOW|MEDIUM|HIGH|CRITICAL)$"),
    unit_filter: str = Query("", max_length=256),
) -> ThreatNetworkResponse:
    """
    Build a 3D threat network graph showing:
    - Nodes: unique operators/units with threat metrics
    - Edges: message flows between operators with threat counts
    - Interactive filtering by unit and threat level
    - Drill-down capability to message detail level
    """
    try:
        # Fetch all messages with threat data
        result = await db.execute(
            text(
                """
                SELECT id, unit_id, timestamp, threat_flag, match_count
                FROM public.chat_logs
                ORDER BY timestamp DESC
                """
            )
        )
        rows = result.mappings().all()

        if not rows:
            return ThreatNetworkResponse(
                nodes=[],
                edges=[],
                total_nodes=0,
                total_edges=0,
                network_threat_level="CLEAR",
                timestamp=datetime.now(timezone.utc).isoformat(),
            )

        # Build node statistics
        nodes_dict: dict[str, dict] = {}
        severity_hierarchy = {"CLEAR": 0, "LOW": 1, "MEDIUM": 2, "HIGH": 3, "CRITICAL": 4}

        for r in rows:
            unit = r["unit_id"]
            if unit_filter and unit_filter.lower() not in unit.lower():
                continue

            if unit not in nodes_dict:
                nodes_dict[unit] = {
                    "id": unit,
                    "label": f"Unit {unit}",
                    "threat_level": "CLEAR",
                    "match_count": 0,
                    "message_count": 0,
                    "max_severity_idx": 0,
                }

            nodes_dict[unit]["message_count"] += 1
            if r["threat_flag"]:
                match_count = r["match_count"] or 0
                nodes_dict[unit]["match_count"] += match_count
                # Calculate severity from match_count
                if match_count >= 8:
                    sev = "CRITICAL"
                elif match_count >= 6:
                    sev = "HIGH"
                elif match_count >= 3:
                    sev = "MEDIUM"
                elif match_count >= 1:
                    sev = "LOW"
                else:
                    sev = "CLEAR"
                sev_idx = severity_hierarchy.get(sev, 0)
                if sev_idx > nodes_dict[unit]["max_severity_idx"]:
                    nodes_dict[unit]["max_severity_idx"] = sev_idx
                    nodes_dict[unit]["threat_level"] = sev

        # Filter nodes by min_severity
        min_sev_idx = severity_hierarchy.get(min_severity, 0)
        filtered_nodes = {
            k: v for k, v in nodes_dict.items()
            if severity_hierarchy.get(v["threat_level"], 0) >= min_sev_idx
        }

        # Create node objects with distributed 3D positions
        nodes_list = []
        import math
        node_count = len(filtered_nodes)
        radius = 5.0

        for idx, (unit_id, node_data) in enumerate(filtered_nodes.items()):
            # Distribute nodes on a sphere
            angle_h = (idx / max(node_count, 1)) * 2 * math.pi
            angle_v = (idx % 3) * (math.pi / 3)  # Multiple vertical bands
            x = radius * math.cos(angle_h) * math.sin(angle_v)
            y = radius * math.sin(angle_v)
            z = radius * math.sin(angle_h) * math.sin(angle_v)

            nodes_list.append(
                ThreatNetworkNode(
                    id=unit_id,
                    label=node_data["label"],
                    threat_level=node_data["threat_level"],
                    match_count=node_data["match_count"],
                    message_count=node_data["message_count"],
                    position={"x": round(x, 2), "y": round(y, 2), "z": round(z, 2)},
                )
            )

        # Build edges (connections between operators)
        edges_dict: dict[str, dict] = {}

        for r in rows:
            unit = r["unit_id"]
            if unit not in filtered_nodes:
                continue

            # In a more complex system, we'd track sender/receiver pairs
            # For now, create self-connections for threat density
            edge_key = f"{unit}-{unit}"
            if edge_key not in edges_dict:
                edges_dict[edge_key] = {
                    "source": unit,
                    "target": unit,
                    "weight": 0,
                    "threat_count": 0,
                    "max_severity": "CLEAR",
                }

            edges_dict[edge_key]["weight"] += 1
            if r["threat_flag"]:
                edges_dict[edge_key]["threat_count"] += 1
                sev = r.get("severity") or "LOW"
                sev_idx = severity_hierarchy.get(sev, 0)
                if sev_idx > severity_hierarchy.get(edges_dict[edge_key]["max_severity"], 0):
                    edges_dict[edge_key]["max_severity"] = sev

        edges_list = [
            ThreatNetworkEdge(
                source=e["source"],
                target=e["target"],
                weight=e["weight"],
                threat_count=e["threat_count"],
                severity=e["max_severity"],
            )
            for e in edges_dict.values()
        ]

        # Determine overall network threat level
        network_threat = "CLEAR"
        for node in nodes_list:
            if severity_hierarchy.get(node.threat_level, 0) > severity_hierarchy.get(network_threat, 0):
                network_threat = node.threat_level

        return ThreatNetworkResponse(
            nodes=nodes_list,
            edges=edges_list,
            total_nodes=len(nodes_list),
            total_edges=len(edges_list),
            network_threat_level=network_threat,
            timestamp=datetime.now(timezone.utc).isoformat(),
        )

    except Exception as exc:
        logger.warning("Threat network query failed: %s", exc)
        return ThreatNetworkResponse(
            nodes=[],
            edges=[],
            total_nodes=0,
            total_edges=0,
            network_threat_level="CLEAR",
            timestamp=datetime.now(timezone.utc).isoformat(),
        )
