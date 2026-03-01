"""
Project Sentinel — Cryptographic Engine
Zero-Exposure Threat Detection via SSE + Bloom Filters

Provides:
  • AES-256-GCM authenticated encryption
  • HKDF-SHA256 per-patient key derivation (K_patient = HKDF(master, info=patient_id))
  • N-gram HMAC-SHA256 tokenisation for Searchable Symmetric Encryption
  • Bloom-filter-based ThreatDetectionEngine (never decrypts to compare)
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import math
import os
import re
import struct
from dataclasses import dataclass, field
from typing import Final, List

from bitarray import bitarray
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.hashes import SHA256
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

logger = logging.getLogger("sentinel.crypto")

# ──────────────────────────────────────────────────────────────────────────────
# Constants
# ──────────────────────────────────────────────────────────────────────────────

_GCM_NONCE_BYTES: Final[int] = 12   # 96-bit nonce — NIST SP 800-38D recommended
_TOKEN_PATTERN: Final[re.Pattern[str]] = re.compile(r"[a-zA-Z0-9]+")


# ──────────────────────────────────────────────────────────────────────────────
# AES-256-GCM helpers
# ──────────────────────────────────────────────────────────────────────────────

def derive_key(hex_key: str) -> bytes:
    """Convert a 64-char hex string to a 32-byte AES key."""
    raw = bytes.fromhex(hex_key)
    if len(raw) != 32:
        raise ValueError(f"AES key must be 32 bytes; got {len(raw)}")
    return raw


def derive_patient_key(master_key: bytes, patient_id: str) -> bytes:
    """
    Derive a per-patient AES-256 key using HKDF-SHA256.

        K_patient = HKDF(
            algorithm = SHA256,
            length    = 32,
            salt      = None,          # master_key already has full entropy
            info      = patient_id.encode("utf-8"),
        ).derive(master_key)

    Properties:
      • Each patient_id produces a *unique*, *deterministic* 32-byte key.
      • Knowing K_patient for one patient reveals nothing about another patient's key.
      • The master_key is never stored alongside the ciphertext.
      • Keys are derived on-the-fly — never persisted to the database.

    Args:
        master_key: 32-byte raw AES master key (from AES_MASTER_KEY env var).
        patient_id: UUID string identifying the patient (used as HKDF info).

    Returns:
        32-byte derived key unique to this patient.
    """
    hkdf = HKDF(
        algorithm=SHA256(),
        length=32,
        salt=None,
        info=patient_id.encode("utf-8"),
    )
    return hkdf.derive(master_key)


def encrypt_message(plaintext: str, key: bytes, *, patient_id: str | None = None) -> str:
    """
    Encrypt *plaintext* with AES-256-GCM.

    If *patient_id* is provided, a per-patient key is derived via HKDF-SHA256
    before encryption.  If *patient_id* is None the *key* is used directly
    (legacy / non-patient path — e.g. military chat logs).

    Returns a hex string:  <12-byte nonce> || <ciphertext+tag>
    The nonce is randomly generated per call — guaranteed unique under standard
    birthday-bound analysis for ≤2³² messages per key.

    Args:
        plaintext:  Raw string to encrypt.
        key:        32-byte master AES key.
        patient_id: Optional patient UUID string.  When set, HKDF derives
                    K_patient = HKDF(key, info=patient_id) before encrypting.
    """
    active_key = derive_patient_key(key, patient_id) if patient_id else key
    nonce = os.urandom(_GCM_NONCE_BYTES)
    aesgcm = AESGCM(active_key)
    ciphertext_with_tag = aesgcm.encrypt(nonce, plaintext.encode(), None)
    return (nonce + ciphertext_with_tag).hex()


def decrypt_message(ciphertext_hex: str, key: bytes, *, patient_id: str | None = None) -> str:
    """
    Decrypt an AES-256-GCM blob produced by *encrypt_message*.

    If *patient_id* is provided, the same HKDF derivation is applied before
    decryption so the correct K_patient is re-derived deterministically.
    If *patient_id* is None the *key* is used directly (legacy / backward-compat).

    Raises *cryptography.exceptions.InvalidTag* on tamper / wrong key.

    NOTE: This function exists only for authorised access — the detection
    pipeline never calls it.

    Args:
        ciphertext_hex: Hex string produced by encrypt_message.
        key:            32-byte master AES key.
        patient_id:     Optional patient UUID string.  Must match the value
                        used during encryption.
    """
    active_key = derive_patient_key(key, patient_id) if patient_id else key
    raw = bytes.fromhex(ciphertext_hex)
    nonce = raw[:_GCM_NONCE_BYTES]
    ciphertext_with_tag = raw[_GCM_NONCE_BYTES:]
    aesgcm = AESGCM(active_key)
    return aesgcm.decrypt(nonce, ciphertext_with_tag, None).decode()


# ──────────────────────────────────────────────────────────────────────────────
# N-gram SSE tokeniser
# ──────────────────────────────────────────────────────────────────────────────

def _tokenise(text: str) -> list[str]:
    """Lowercase alphanumeric tokens; strips punctuation."""
    return [t.lower() for t in _TOKEN_PATTERN.findall(text)]


def _ngrams(tokens: list[str], n: int) -> list[str]:
    """Sliding window n-grams over token list."""
    return [" ".join(tokens[i : i + n]) for i in range(len(tokens) - n + 1)]


def generate_ngram_hashes(text: str, secret: str, n: int = 3) -> list[str]:
    """
    Tokenise *text*, build character n-grams (unigrams + requested n-gram),
    and return a deduplicated list of HMAC-SHA256 hex digests.

    Using multiple gram sizes catches both exact matches and partial/evasion
    attempts (e.g. 'cl@ssified' or split tokens).

    Args:
        text:   Raw plaintext to tokenise.
        secret: HMAC secret (not the AES key — separate key domain).
        n:      N-gram width (default 3).

    Returns:
        Sorted, deduplicated list of hex-encoded HMAC digests.
    """
    secret_bytes = secret.encode()
    tokens = _tokenise(text)

    candidates: set[str] = set()

    # Unigrams (exact token match)
    for token in tokens:
        candidates.add(token)

    # N-grams (multi-token phrases)
    if n > 1 and len(tokens) >= n:
        candidates.update(_ngrams(tokens, n))

    # Character-level bigrams on each token (catches 'cl@ssified' → 'cl', 'la'…)
    for token in tokens:
        for i in range(len(token) - 1):
            candidates.add(token[i : i + 2])

    digests: list[str] = []
    for candidate in candidates:
        digest = hmac.new(
            secret_bytes,
            candidate.encode(),
            hashlib.sha256,
        ).hexdigest()
        digests.append(digest)

    return sorted(set(digests))


# ──────────────────────────────────────────────────────────────────────────────
# Bloom Filter
# ──────────────────────────────────────────────────────────────────────────────

def _bloom_hash_positions(item: str, size: int, k: int) -> list[int]:
    """
    Derive *k* independent bit-positions for *item* using double-hashing:
        pos_i = (h1 + i * h2) mod size
    h1 = SHA-256, h2 = SHA-512 (truncated).  No external library needed.
    """
    h1 = int(hashlib.sha256(item.encode()).hexdigest(), 16) % size
    h2 = int(hashlib.sha512(item.encode()).hexdigest(), 16) % size
    if h2 == 0:
        h2 = 1  # avoid degenerate case
    return [(h1 + i * h2) % size for i in range(k)]


@dataclass
class BloomFilter:
    """
    Deterministic Bloom filter backed by *bitarray* for memory efficiency.

    Serialises to/from raw bytes for PostgreSQL *bytea* storage.
    """

    size: int = 10_000
    k: int = 7
    _bits: bitarray = field(default_factory=bitarray, repr=False)

    def __post_init__(self) -> None:
        if not self._bits:
            self._bits = bitarray(self.size)
            self._bits.setall(0)

    # ------------------------------------------------------------------
    def add(self, item: str) -> None:
        for pos in _bloom_hash_positions(item, self.size, self.k):
            self._bits[pos] = 1

    def contains(self, item: str) -> bool:
        """Returns True if *item* is possibly in the set (may false-positive)."""
        return all(
            self._bits[pos]
            for pos in _bloom_hash_positions(item, self.size, self.k)
        )

    # ------------------------------------------------------------------
    def to_bytes(self) -> bytes:
        """Serialise filter state to bytes (size + k header + bitarray)."""
        header = struct.pack(">II", self.size, self.k)
        return header + self._bits.tobytes()

    @classmethod
    def from_bytes(cls, raw: bytes) -> "BloomFilter":
        """Deserialise a filter previously created by *to_bytes*."""
        size, k = struct.unpack(">II", raw[:8])
        bits = bitarray()
        bits.frombytes(raw[8:])
        bits = bits[:size]  # trim padding added by tobytes()
        bf = cls(size=size, k=k)
        bf._bits = bits
        return bf

    @property
    def estimated_false_positive_rate(self) -> float:
        """Theoretical FPR: (1 - e^(-k*n/m))^k."""
        ones = self._bits.count(1)
        n_estimated = -(self.size / self.k) * math.log(1 - ones / self.size + 1e-10)
        return (1 - math.exp(-self.k * n_estimated / self.size)) ** self.k


# ──────────────────────────────────────────────────────────────────────────────
# Threat Detection Engine
# ──────────────────────────────────────────────────────────────────────────────

SEVERITY_LEVELS = ("CLEAR", "LOW", "MEDIUM", "HIGH", "CRITICAL")


def classify_severity(match_count: int, num_nodes: int) -> str:
    """Deterministic severity from match count and number of intercepting nodes."""
    if match_count == 0:
        return "CLEAR"
    if num_nodes >= 2 and match_count >= 8:
        return "CRITICAL"
    if match_count >= 6:
        return "HIGH"
    if match_count >= 3:
        return "MEDIUM"
    return "LOW"


@dataclass
class InterceptionNode:
    """Per-filter match result — represents one detection node in the network."""
    node_id: str
    match_count: int
    matched_hashes: list[str]
    false_positive_rate: float


@dataclass
class AnalysisResult:
    """Rich result from the threat detection engine."""
    is_threat: bool
    total_matches: int
    max_false_positive_rate: float
    severity: str
    intercepting_nodes: list[InterceptionNode]


@dataclass
class WatchlistEntry:
    operation_name_encrypted: str   # AES-GCM encrypted operation name
    bloom_filter: BloomFilter


class ThreatDetectionEngine:
    """
    Zero-exposure threat detector.

    Workflow:
        1. Operator loads classified watchlist entries (each with a BloomFilter
           built from secret HMAC hashes of classified terms).
        2. Incoming chats are hashed in memory and probed against every filter.
        3. No decryption ever occurs during detection — only hash comparisons.

    The engine is *stateful* per-request: load watchlist once per worker startup.
    """

    def __init__(self, threshold: int = 2) -> None:
        self._watchlist: list[WatchlistEntry] = []
        self.threshold = threshold  # minimum matches to flag as threat

    # ------------------------------------------------------------------
    def load_watchlist_entry(self, entry: WatchlistEntry) -> None:
        self._watchlist.append(entry)

    def load_watchlist_from_db_rows(
        self,
        rows: list[dict],  # {"operation_name": str, "bloom_filter_data": bytes}
        aes_key: bytes,
    ) -> None:
        """
        Hydrate the engine from raw database rows.
        *operation_name* is re-encrypted here only to build a WatchlistEntry;
        the plaintext never leaves this function.
        """
        self._watchlist.clear()
        for row in rows:
            raw_filter = bytes(row["bloom_filter_data"])
            if len(raw_filter) < 8:
                logger.warning(
                    "Skipping malformed watchlist row: bloom_filter_data shorter than header."
                )
                continue
            try:
                bf = BloomFilter.from_bytes(raw_filter)
            except Exception as exc:
                logger.warning("Skipping malformed watchlist row: %s", exc)
                continue
            self._watchlist.append(
                WatchlistEntry(
                    operation_name_encrypted=row["operation_name"],
                    bloom_filter=bf,
                )
            )

    # ------------------------------------------------------------------
    def build_watchlist_filter(
        self,
        classified_terms: list[str],
        hmac_secret: str,
        operation_name: str,
        aes_key: bytes,
        bloom_size: int = 10_000,
        bloom_k: int = 7,
    ) -> WatchlistEntry:
        """
        Build and return a *WatchlistEntry* from a list of classified terms.
        The terms are immediately hashed — plaintext is never persisted.
        """
        bf = BloomFilter(size=bloom_size, k=bloom_k)
        for term in classified_terms:
            for h in generate_ngram_hashes(term, hmac_secret):
                bf.add(h)

        encrypted_name = encrypt_message(operation_name, aes_key)
        entry = WatchlistEntry(
            operation_name_encrypted=encrypted_name,
            bloom_filter=bf,
        )
        self._watchlist.append(entry)
        return entry

    # ------------------------------------------------------------------
    def analyze(self, ngram_hashes: list[str]) -> AnalysisResult:
        """
        Probe every watchlist Bloom filter with the chat's hashed N-grams.

        Returns an AnalysisResult with per-node interception details,
        severity classification, and overall threat flag.
        """
        total_matches = 0
        max_fpr: float = 0.0
        intercepting_nodes: List[InterceptionNode] = []

        for idx, entry in enumerate(self._watchlist):
            bf = entry.bloom_filter
            node_hits = 0
            matched: list[str] = []
            for h in ngram_hashes:
                if bf.contains(h):
                    node_hits += 1
                    if len(matched) < 8:
                        matched.append(h)

            fpr = bf.estimated_false_positive_rate
            if fpr > max_fpr:
                max_fpr = fpr

            if node_hits > 0:
                total_matches += node_hits
                intercepting_nodes.append(
                    InterceptionNode(
                        node_id=f"NODE-{idx + 1:02d}",
                        match_count=node_hits,
                        matched_hashes=matched,
                        false_positive_rate=round(fpr, 6),
                    )
                )

        is_threat = total_matches >= self.threshold
        severity = classify_severity(total_matches, len(intercepting_nodes))

        return AnalysisResult(
            is_threat=is_threat,
            total_matches=total_matches,
            max_false_positive_rate=round(max_fpr, 6),
            severity=severity,
            intercepting_nodes=intercepting_nodes,
        )
