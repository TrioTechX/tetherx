"""
Project Sentinel — Ephemeral Decryption Capability (EDC) Engine

Issues and validates short-lived (5-minute) single-use access tokens that
gate decryption of patient records.  Plaintext is NEVER stored in the DB —
it is only returned in-memory to the requesting operator.

Classes / functions:
    IssuedToken     — dataclass returned by issue_token()
    ValidatedToken  — dataclass returned by validate_token() on success
    EDCEngine       — async engine for issuing and validating tokens
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger("sentinel.edc_engine")

# ---------------------------------------------------------------------------
# Token TTL
# ---------------------------------------------------------------------------

TOKEN_TTL_SECONDS: int = 300  # 5 minutes


# ---------------------------------------------------------------------------
# Result dataclasses
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class IssuedToken:
    """Token returned to the operator after a successful issue."""
    token_id: str
    operator_id: str
    patient_id: str
    record_id: str
    expires_at: datetime
    approved_by: str | None


@dataclass(frozen=True)
class ValidatedToken:
    """Token returned by validate_token() when the token is valid and live."""
    token_id: str
    operator_id: str
    patient_id: str
    record_id: str
    expires_at: datetime
    approved_by: str | None


# ---------------------------------------------------------------------------
# EDCEngine
# ---------------------------------------------------------------------------


class EDCEngine:
    """
    Stateless async engine for ephemeral decryption tokens.

    Tokens are:
      • uuid-identified
      • operator-scoped (token.operator_id must match requester)
      • time-limited (TOKEN_TTL_SECONDS = 5 min)
      • single-use (deleted on successful decrypt via calling layer, or via
        natural expiry for un-used tokens)

    The engine never decrypts payloads — it only manages the token lifecycle.
    """

    # ── Public API ────────────────────────────────────────────────────────────

    async def issue_token(
        self,
        *,
        operator_id: str,
        patient_id: str,
        record_id: str,
        db: AsyncSession,
        approved_by: str | None = None,
    ) -> IssuedToken:
        """
        Issue a new ephemeral decryption token.

        Inserts a row into `temporary_access_tokens` and returns the token
        metadata.  Caller is responsible for returning `token_id` to the
        operator (it is never retrievable again after first response).

        Parameters
        ----------
        operator_id : str
            UUID/identifier of the operator the token is bound to.
        patient_id : str
            UUID of the patient whose record this token permits access to.
        record_id : str
            UUID of the specific patient record this token is for.
        db : AsyncSession
            Active DB session.
        approved_by : str | None
            UUID of a second approver (for REQUIRE_SECOND_APPROVAL flow).
            None for AUTO_APPROVE or REQUIRE_JUSTIFICATION flows.

        Returns
        -------
        IssuedToken
            Newly created token metadata.
        """
        token_id = str(uuid4())
        now = datetime.now(timezone.utc)
        expires_at = now + timedelta(seconds=TOKEN_TTL_SECONDS)

        await db.execute(
            text(
                """
                INSERT INTO public.temporary_access_tokens
                    (id, operator_id, patient_id, record_id,
                     expires_at, approved_by, created_at)
                VALUES
                    (:id, :operator_id, :patient_id, :record_id,
                     :expires_at, :approved_by, :created_at)
                """
            ),
            {
                "id": token_id,
                "operator_id": operator_id,
                "patient_id": patient_id,
                "record_id": record_id,
                "expires_at": expires_at,
                "approved_by": approved_by,
                "created_at": now,
            },
        )
        await db.commit()

        logger.info(
            "EDC token issued | token=%s operator=%s patient=%s record=%s expires=%s",
            token_id, operator_id, patient_id, record_id,
            expires_at.isoformat(),
        )

        return IssuedToken(
            token_id=token_id,
            operator_id=operator_id,
            patient_id=patient_id,
            record_id=record_id,
            expires_at=expires_at,
            approved_by=approved_by,
        )

    async def validate_token(
        self,
        *,
        token_id: str,
        requesting_operator_id: str,
        record_id: str,
        db: AsyncSession,
    ) -> ValidatedToken | None:
        """
        Validate a previously issued token.

        Returns ValidatedToken if ALL conditions pass:
          • Token exists in DB
          • Token belongs to requesting_operator_id
          • Token is for the specified record_id
          • Token has not expired (expires_at > NOW() UTC)

        Returns None on any failure (not found, wrong operator, wrong record,
        expired).  The caller should treat None as a 403 — no information
        is leaked about *why* the token is invalid.

        Parameters
        ----------
        token_id : str
            UUID of the token to validate.
        requesting_operator_id : str
            Must match the operator_id stored on the token.
        record_id : str
            Must match the record_id stored on the token.
        db : AsyncSession
            Active DB session.
        """
        try:
            result = await db.execute(
                text(
                    """
                    SELECT id, operator_id, patient_id, record_id,
                           expires_at, approved_by
                    FROM public.temporary_access_tokens
                    WHERE id = :token_id
                    """
                ),
                {"token_id": token_id},
            )
            row = result.mappings().first()
        except Exception as exc:
            logger.warning("EDC token DB lookup failed: %s", exc)
            return None

        if not row:
            logger.warning("EDC token not found | token=%s", token_id)
            return None

        # Operator ownership check
        if str(row["operator_id"]) != requesting_operator_id:
            logger.warning(
                "EDC token operator mismatch | token=%s expected=%s got=%s",
                token_id, row["operator_id"], requesting_operator_id,
            )
            return None

        # Record binding check
        if str(row["record_id"]) != record_id:
            logger.warning(
                "EDC token record mismatch | token=%s expected=%s got=%s",
                token_id, row["record_id"], record_id,
            )
            return None

        # Expiry check — compare in UTC
        expires_at: datetime = row["expires_at"]
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)

        now = datetime.now(timezone.utc)
        if now >= expires_at:
            logger.warning(
                "EDC token expired | token=%s expired_at=%s now=%s",
                token_id, expires_at.isoformat(), now.isoformat(),
            )
            return None

        logger.info(
            "EDC token valid | token=%s operator=%s patient=%s record=%s",
            token_id, row["operator_id"], row["patient_id"], row["record_id"],
        )

        return ValidatedToken(
            token_id=str(row["id"]),
            operator_id=str(row["operator_id"]),
            patient_id=str(row["patient_id"]),
            record_id=str(row["record_id"]),
            expires_at=expires_at,
            approved_by=row.get("approved_by"),
        )

    async def consume_token(
        self,
        *,
        token_id: str,
        db: AsyncSession,
    ) -> None:
        """
        Delete a token after successful use (single-use enforcement).

        Soft-failure: if the token is already gone (race condition), log and
        continue — the caller already completed the decrypt operation.
        """
        try:
            await db.execute(
                text(
                    "DELETE FROM public.temporary_access_tokens WHERE id = :id"
                ),
                {"id": token_id},
            )
            await db.commit()
            logger.info("EDC token consumed (deleted) | token=%s", token_id)
        except Exception as exc:
            logger.warning("EDC token consume failed (non-critical): %s", exc)
