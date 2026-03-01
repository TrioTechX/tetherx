# Project Sentinel — Working Reference

> **Classification:** RESTRICTED · Zero-Exposure Threat Detection System for Military Communications

---

## Overview

**Project Sentinel** is a full-stack military-grade encrypted communication & threat detection system. It detects classified keyword leaks in chat messages using **Searchable Symmetric Encryption (SSE)** and **Bloom Filters** — without ever decrypting the message content. The system has two operator roles:

- **Sender** — encrypts and transmits messages
- **Receiver** — monitors, decrypts (when authorised), and searches messages

---

## Project Structure

```
HackOps-GAT-main/
├── backend/                   # Python FastAPI backend (Project Sentinel API)
│   ├── main.py                # FastAPI app entry point
│   ├── requirements.txt       # Python dependencies
│   ├── .env                   # Environment variables (secrets, DB URL)
│   ├── .env.example           # Template for environment variables
│   ├── api/
│   │   └── routes/
│   │       ├── auth.py        # Authentication route (/api/auth/login)
│   │       └── monitor.py     # Core detection & monitoring routes
│   ├── core/
│   │   └── crypto_engine.py   # AES-256-GCM, SSE n-gram hashing, Bloom Filter engine
│   ├── config/
│   │   └── settings.py        # Pydantic settings (loaded from .env)
│   ├── models/
│   │   ├── database.py        # SQLAlchemy async DB session setup
│   │   ├── schema.sql         # Main Supabase PostgreSQL schema
│   │   ├── operators_schema.sql  # Operators table schema
│   │   └── migration_ngram_hashes.sql  # Migration for SSE search column
│   └── scripts/
│       └── seed_operators.py  # Script to seed operator accounts into DB
│
├── frontend/                  # Next.js 14 TypeScript frontend
│   ├── app/
│   │   ├── page.tsx           # Landing page (role selection)
│   │   ├── layout.tsx         # Root layout with AuthProvider
│   │   ├── globals.css        # Global styles (Tailwind + custom CSS vars)
│   │   ├── auth-context.tsx   # React context for JWT auth state
│   │   ├── command-center.tsx # Main receiver dashboard / command center UI
│   │   ├── threat-network-3d.tsx    # 3D threat network visualisation component
│   │   ├── threat-network-canvas.tsx # Canvas-based 2D threat network visualisation
│   │   ├── threat-network-stats.tsx  # Threat statistics panel
│   │   ├── icon.tsx           # Custom SVG icon component
│   │   ├── login/
│   │   │   └── [role]/
│   │   │       └── page.tsx   # Dynamic login page for sender/receiver
│   │   ├── sender/
│   │   │   └── page.tsx       # Sender dashboard (compose & send messages)
│   │   └── receiver/
│   │       └── page.tsx       # Receiver dashboard (live feed, decrypt, search)
│   ├── hooks/
│   │   └── useWebSocket.ts    # Custom hook for WebSocket connection with auto-reconnect
│   ├── lib/
│   │   ├── supabase.ts        # Supabase client initialisation
│   │   ├── types.ts           # Shared TypeScript types (ThreatAnalysis, etc.)
│   │   └── utils.ts           # Utility functions (cn, formatters, etc.)
│   ├── next.config.js         # Next.js configuration
│   ├── tailwind.config.ts     # Tailwind CSS config with Sentinel theme colours
│   └── package.json           # Frontend dependencies
│
├── docs/
│   ├── AUTH_OPERATORS.md      # How operator accounts work
│   └── CONNECT_SUPABASE.md    # Supabase setup guide
│
├── README.md                  # Project overview and setup guide
└── working.md                 # This file
```

---

## Features

### 1. Zero-Exposure Threat Detection (Core Feature)
- Messages are **tokenised and HMAC-SHA256 hashed** before encryption
- Hashes are probed against **Bloom Filters** loaded from the classified watchlist
- **The plaintext is never compared against threat terms** — only hash comparisons occur
- Severity levels: `CLEAR`, `LOW`, `MEDIUM`, `HIGH`, `CRITICAL`
- Multi-node interception tracking (multiple Bloom filters = multiple watchlist operations)

### 2. AES-256-GCM Encryption
- Every message is encrypted with AES-256-GCM using a 32-byte master key
- A **random 96-bit nonce** is generated per message (NIST SP 800-38D)
- Ciphertext stored as: `<12-byte nonce> || <ciphertext+tag>` (hex encoded)
- The plaintext reference is deleted from memory immediately after encryption

### 3. Searchable Symmetric Encryption (SSE Trapdoor Search)
- Receivers can search the encrypted database without decryption
- A search query generates HMAC trapdoor hashes, matched against stored `ngram_hashes` column using PostgreSQL array overlap (`&&`)
- Up to 50 matching results returned with encrypted previews only

### 4. Bloom Filter Watchlist
- Each classified operation is stored as a serialised `BloomFilter` in PostgreSQL (`bytea` column)
- Bloom filter uses **double-hashing** (SHA-256 + SHA-512) to derive `k` bit positions
- Filters serialise to bytes with a header: `>II` (size + k) + bitarray
- Theoretical false positive rate is computed and reported per node

### 5. N-gram HMAC Tokenisation
- `generate_ngram_hashes(text, secret, n=3)` tokenises text and produces:
  - **Unigrams** (exact token match)
  - **N-grams** (multi-token phrase match, default n=3)
  - **Character bigrams** (catches obfuscation like `cl@ssified`)
- All candidates are HMAC-SHA256 hashed with the server secret before comparison

### 6. Role-Based Authentication (Operator Model)
- No self-registration — accounts are pre-provisioned by administrators
- Login via **Operator UUID + password** (`POST /api/auth/login`)
- Passwords stored as **bcrypt hashes** in the `operators` table
- Issues a **JWT token** (HS256, 24h expiry) carrying `sub` (UUID) and `role`
- Frontend stores JWT in `localStorage` under key `sentinel_auth` and checks expiry on load

### 7. Real-Time WebSocket Live Feed
- Backend: `SentinelWSManager` in `monitor.py` manages all connections by role
- Every new ingestion broadcasts an `INGEST` event to all connected receivers
- Presence events: `CONNECTED`, `STATUS`, `HEARTBEAT` (every 20s keepalive)
- Frontend: `useWebSocket` hook with **exponential backoff reconnection** (1.5s → 30s max) and 18s ping interval

### 8. Sender Dashboard
- **File:** `frontend/app/sender/page.tsx`
- Compose and send plaintext messages (POST to `/api/ingest-chat`)
- Shows encryption steps, ngram hash sample, and threat analysis result after send
- Displays live receiver presence count via WebSocket

### 9. Receiver Command Center
- **File:** `frontend/app/command-center.tsx` + `frontend/app/receiver/page.tsx`
- Live feed of all ingested messages with threat highlighting
- **Decrypt** any stored message by log ID (`POST /api/decrypt`)
- **SSE search** across the encrypted database (`POST /api/search-encrypted`)
- Threat network 3D visualisation (`threat-network-3d.tsx`, Three.js-based) and canvas 2D fallback
- Threat statistics summary panel

### 10. Offline / Demo Mode
- If Supabase is unreachable, the backend falls back to a built-in demo watchlist
- Demo classified terms: `"operation thunderstrike"`, `"classified coordinates"`, `"launch codes"`, `"extraction point delta"`, `"nuclear"`, `"override"`
- Ingestion still works; `database_persisted: false` is set in the response

---

## Key Files & Important Code Details

### `backend/main.py`
- **Entry point** — creates `FastAPI` app named "Project Sentinel"
- Registers `auth_router` and `monitor_router`
- `EnsureCORSHeadersMiddleware`: custom middleware that adds CORS headers even to 500 error responses (so browser can read error details)
- CORS allows LAN IPs `10.53.222.69` and `10.53.222.108` in addition to localhost
- `GET /health` → `{"status": "OPERATIONAL", "system": "Project Sentinel"}`
- Run: `uvicorn main:app --host 0.0.0.0 --port 8000 --reload`

### `backend/core/crypto_engine.py`
Key functions and classes:

| Symbol | Purpose |
|--------|---------|
| `derive_key(hex_key)` | Converts 64-char hex string → 32-byte AES key |
| `encrypt_message(plaintext, key)` | AES-256-GCM encryption, returns hex string |
| `decrypt_message(ciphertext_hex, key)` | AES-256-GCM decryption (receiver only) |
| `generate_ngram_hashes(text, secret, n)` | HMAC-SHA256 tokenisation (unigrams + n-grams + char bigrams) |
| `BloomFilter` | Bitarray-backed Bloom filter; serialises to/from bytes |
| `ThreatDetectionEngine` | Loads watchlist, runs `.analyze(hashes)` → `AnalysisResult` |
| `classify_severity(match_count, num_nodes)` | Returns `CLEAR/LOW/MEDIUM/HIGH/CRITICAL` |

- `BloomFilter._bloom_hash_positions()` uses double-hashing: `pos_i = (h1 + i*h2) mod size`
- `BloomFilter.to_bytes()` format: `struct.pack(">II", size, k)` + `bitarray.tobytes()`

### `backend/api/routes/auth.py`
- `POST /api/auth/login` — accepts `{uuid, password}`, queries `operators` table, bcrypt-verifies, returns JWT
- JWT payload: `{sub: uuid, role: "sender"|"receiver", exp, iat}`
- No signup endpoint — operator provisioning is done via `backend/scripts/seed_operators.py`

### `backend/api/routes/monitor.py`
Key API endpoints:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/ws` | WS | Live feed WebSocket (`?role=sender\|receiver`) |
| `/api/connections` | GET | REST fallback for WS presence counts |
| `/api/ingest-chat` | POST | Ingest + encrypt + threat-detect a message |
| `/api/decrypt` | POST | Decrypt stored message by `log_id` |
| `/api/search-encrypted` | POST | SSE trapdoor search across encrypted DB |
| `/api/watchlist/add` | POST | Add new classified operation Bloom filter |
| `/api/threats` | GET | Threat feed for receiver dashboard |
| `/api/check-db` | GET | Supabase connectivity check |
| `/health` | GET | Health check |

- `_load_detection_engine()`: loads all watchlist rows from Supabase, hydrates `ThreatDetectionEngine`
- `ingest_chat()` pipeline: derive key → tokenise & hash → encrypt → drop plaintext → load engine → analyze → persist → broadcast WebSocket

### `backend/config/settings.py`
Environment variables loaded from `.env`:

| Variable | Description |
|----------|-------------|
| `SUPABASE_DB_URL` | PostgreSQL connection string for Supabase |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key |
| `AES_MASTER_KEY` | 64-char hex string (32-byte AES-256 key) |
| `HMAC_SECRET` | Secret for HMAC-SHA256 n-gram tokenisation |
| `BLOOM_FILTER_SIZE` | Bloom filter bit-array size (default: 10,000) |
| `BLOOM_HASH_COUNT` | Number of hash functions k (default: 7) |
| `THREAT_MATCH_THRESHOLD` | Min matches to flag as threat (default: 2) |
| `JWT_SECRET` | Secret for JWT signing |
| `JWT_ALGORITHM` | JWT algorithm (default: HS256) |
| `JWT_EXPIRE_MINUTES` | JWT expiry (default: 1440 = 24 hours) |

### `backend/models/`
- `database.py` — SQLAlchemy async engine + `get_db()` dependency
- `schema.sql` — Supabase tables: `operators`, `chat_logs`, `watchlist`
- `operators_schema.sql` — Operators table with UUID, password_hash, role
- `migration_ngram_hashes.sql` — Adds `ngram_hashes text[]` column to `chat_logs` for SSE search

### `frontend/app/auth-context.tsx`
- `AuthProvider` React context wraps the entire app
- `useAuth()` hook exposes: `user`, `role`, `loading`, `signIn()`, `signOut()`
- JWT stored in `localStorage` as `sentinel_auth` JSON blob
- On load, checks JWT expiry; auto-clears expired tokens
- `signIn()` calls `POST /api/auth/login`, validates returned role matches requested role

### `frontend/hooks/useWebSocket.ts`
- `useWebSocket({ apiUrl, role, onMessage, enabled })` hook
- Manages WebSocket lifecycle: connect, ping/pong (18s), exponential backoff reconnect (1.5s–30s)
- Handles message types: `CONNECTED`, `STATUS`, `HEARTBEAT`, `INGEST`
- Exposes: `{ connected, receiverCount, senderCount, totalClients }`
- Auto-derives `ws://` or `wss://` from the API base URL

### `frontend/lib/types.ts`
- `ThreatAnalysis` type used across frontend for threat result payloads

### `frontend/app/command-center.tsx`
- Large (81 KB) component — the full receiver UI
- Includes live log feed, decryption panel, SSE search, threat network visualisation toggle

### `frontend/tailwind.config.ts`
Custom Sentinel design tokens:
- `sentinel-black`, `sentinel-surface`, `sentinel-green`, `sentinel-teal`, `sentinel-red`
- `text-sentinel-text`, `text-sentinel-text-dim`
- `text-glow-green` — text shadow glow effect

---

## Database Schema (Supabase PostgreSQL)

**`public.operators`**
- `operator_uuid` (PK), `password_hash`, `role` (`sender` | `receiver`)

**`public.chat_logs`**
- `id` (UUID PK), `unit_id`, `timestamp`, `encrypted_payload` (hex AES-GCM blob)
- `threat_flag` (bool), `match_count` (int)
- `ngram_hash_sample` (text[], first 5 hashes), `ngram_hashes` (text[], all hashes for SSE search)

**`public.watchlist`**
- `id` (UUID PK), `operation_name` (AES-GCM encrypted), `bloom_filter_data` (bytea)

---

## Running the Project

### Backend
```bash
cd backend
pip install -r requirements.txt
# Copy and fill in .env.example → .env
python main.py
# Server runs on http://localhost:8000
# API docs: http://localhost:8000/docs
```

### Frontend
```bash
cd frontend
npm install
# Copy and fill in .env.local.example → .env.local
npm run dev
# App runs on http://localhost:3000
```

### Seed Operators
```bash
cd backend
python scripts/seed_operators.py
```

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | Next.js 14, TypeScript, Tailwind CSS, Framer Motion |
| Backend | Python 3.11+, FastAPI, Uvicorn |
| Crypto | `cryptography` (AES-GCM), `bitarray` (Bloom Filter), `bcrypt`, `PyJWT` |
| Database | Supabase (PostgreSQL), SQLAlchemy (async) |
| Real-time | WebSocket (native FastAPI + browser WebSocket API) |
| 3D Visualisation | Three.js (via React) |

---

## Security Design Notes

1. **Zero-decryption detection** — threat analysis runs entirely on HMAC hashes, never plaintext
2. **Separate key domains** — AES key and HMAC secret are different secrets
3. **Per-message nonces** — AES-GCM nonce is freshly randomised for every encrypt call
4. **Pre-provisioned operators** — no public registration, accounts seeded by admin
5. **Role-locked JWTs** — login page enforces that returned role matches the requested login portal
6. **Best-effort plaintext zeroing** — `del plaintext_ref` after encryption in `ingest_chat()`
