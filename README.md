# Project Sentinel
### Zero-Exposure Threat Detection System for Military Communications

> Detects classified keyword leaks in encrypted chat logs using **Searchable Symmetric Encryption (SSE)** and **Bloom Filters** — without ever decrypting the underlying messages.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     PROJECT SENTINEL                            │
│                                                                 │
│  ┌──────────────┐   plaintext   ┌──────────────────────────┐   │
│  │  Internal    │ ───────────►  │   FastAPI Backend        │   │
│  │  Relay Sys   │               │                          │   │
│  └──────────────┘               │  1. N-gram HMAC hashing  │   │
│                                 │  2. AES-256-GCM encrypt  │   │
│                                 │  3. Bloom filter probe   │   │
│                                 │  4. Drop plaintext       │   │
│                                 └──────────┬───────────────┘   │
│                                            │ encrypted +       │
│                                            │ threat_flag       │
│                                            ▼                   │
│                                 ┌──────────────────────┐       │
│                                 │   Supabase           │       │
│                                 │   PostgreSQL + RLS   │       │
│                                 │   Realtime Pub/Sub   │       │
│                                 └──────────┬───────────┘       │
│                                            │ WebSocket         │
│                                            ▼                   │
│                                 ┌──────────────────────┐       │
│                                 │  Next.js 14 UI       │       │
│                                 │  Command Center      │       │
│                                 │  Framer Motion       │       │
│                                 └──────────────────────┘       │
└─────────────────────────────────────────────────────────────────┘
```

---

## Stack

| Layer | Technology |
|-------|-----------|
| Backend API | Python 3.11+, FastAPI, Uvicorn |
| Cryptography | `cryptography` (AES-256-GCM), `hmac` (HMAC-SHA256) |
| Bloom Filter | `bitarray` (memory-efficient bit arrays) |
| Database | Supabase (PostgreSQL 15) + Row Level Security |
| ORM | SQLAlchemy 2.0 async (asyncpg driver) |
| Realtime | Supabase Realtime (postgres_changes) |
| Frontend | Next.js 14 App Router, React 18, TypeScript |
| Styling | Tailwind CSS, Framer Motion, shadcn/ui |
| Validation | Pydantic v2 (backend), TypeScript strict mode (frontend) |

---

## Quick Start

### Prerequisites
- Python 3.11+
- Node.js 18+
- A Supabase project

---

### 1. Supabase Setup

1. Go to your Supabase project → **SQL Editor**
2. Run the entire contents of `backend/models/schema.sql`
3. Note your **Project URL** and **anon key** from Project Settings → API  
4. **If the backend shows "Database unreachable":** see **[docs/CONNECT_SUPABASE.md](docs/CONNECT_SUPABASE.md)** for connection string, password encoding, DNS, and firewall.

---

### 2. Backend

```bash
cd backend

# Copy environment template
cp .env.example .env

# Edit .env with your values:
# SUPABASE_DB_URL=postgresql://postgres:PASSWORD@db.PROJECT_REF.supabase.co:5432/postgres
# AES_MASTER_KEY=<64 hex chars, generate with: python -c "import os; print(os.urandom(32).hex())">
# HMAC_SECRET=<any strong secret>

# Install dependencies
pip install -r requirements.txt

# Run
python main.py
# → http://localhost:8000
# → Swagger UI: http://localhost:8000/docs
```

---

### 3. Frontend

```bash
cd frontend

# Copy environment template
cp .env.local.example .env.local

# Edit .env.local with your Supabase project URL and anon key

# Install dependencies
npm install

# Run
npm run dev
# → http://localhost:3000
```

---

## Key Endpoints

### `POST /api/ingest-chat`
Ingests a plaintext message through the full zero-exposure pipeline.

```json
{
  "unit_id": "ALPHA-7",
  "message": "Requesting status at extraction point delta",
  "ngram_size": 3
}
```

Response:
```json
{
  "log_id": "uuid",
  "unit_id": "ALPHA-7",
  "timestamp": "2026-02-21T...",
  "encrypted_payload_preview": "a3f2c1b8...",
  "threat_analysis": {
    "is_threat": true,
    "match_count": 4,
    "max_false_positive_rate": 0.000082,
    "hashes_generated": 47
  },
  "status": "INGESTED"
}
```

### `POST /api/watchlist/add`
Add a new classified operation's terms to the watchlist.

```json
{
  "operation_name": "OPERATION THUNDERSTRIKE",
  "classified_terms": ["thunderstrike", "extraction point delta", "launch codes"]
}
```

### `POST /api/decrypt`
Authorised receiver: decrypt a stored message by log ID (fetches ciphertext from DB, decrypts with AES key).

```json
{ "log_id": "uuid-from-ingest-response" }
```

### `POST /api/search-encrypted`
Search encrypted messages using SSE: query → HMAC trapdoors; find rows where `ngram_hashes` overlaps (no decryption).

```json
{ "query": "classified" }
```

**Note:** Run `backend/models/migration_ngram_hashes.sql` in Supabase (once) to add the `ngram_hashes` column for search.

### `GET /health`
Returns operational status.

---

## Client / Receiver / Search UI
- **Client — Encryption:** Send a message; see how it’s encrypted (steps 1–5) and the resulting ciphertext (hex).
- **Receiver — Decryption:** Enter a log ID and decrypt to show plaintext at the receiver.
- **Search encrypted DB (SSE):** Enter a search term; see trapdoor count and matching rows (encrypted preview only).

---

## Cryptographic Design

### AES-256-GCM Encryption
- 256-bit key, random 96-bit nonce per message
- GCM mode provides **authenticated encryption** — any tampering is detected
- Serialised as `nonce || ciphertext+tag` hex string

### HMAC-SHA256 N-gram Tokenisation (SSE)
- Tokenises text into unigrams + N-grams + character bigrams
- Each token is hashed with `HMAC-SHA256(secret, token)`
- Hash domain is completely separate from the AES key
- Catches typo evasion (`cl@ssified`, split tokens)

### Bloom Filter
- **Size:** 10,000 bits | **Hash functions k:** 7 (double-hashing scheme)
- **Estimated FPR:** ~0.008% at 100 classified terms
- Serialised as `[4B size][4B k][bitarray bytes]` for PostgreSQL `bytea`
- Detection: probe every watchlist filter with each chat hash — **O(k·n)** where n = watchlist size

### Zero-Exposure Guarantee
1. Plaintext enters the backend
2. N-gram hashes generated **in-memory**
3. Plaintext **immediately encrypted** → AES-GCM blob
4. Python variable reference deleted
5. Only the ciphertext and threat flag reach the database
6. Detection compares **hashes against hashes** — no decryption path exists

---

## Row Level Security

The `chat_logs` table enforces that authenticated frontend users can only read rows where `unit_id` matches the `unit_id` claim in their Supabase Auth JWT. The backend uses the `service_role` key (bypasses RLS) for writing.

---

## Frontend UI Features

- **Live Intercept Feed:** Terminal-style scrolling feed showing AES-GCM blobs
- **Threat Matrix Visualiser:** Animated Bloom filter collision map (Framer Motion)
- **Alert Panel:** Aggressive red flash on `threat_flag = true`
- **Stats Bar:** Live counters for intercepted messages and threat count
- **Simulator Panel:** Inject demo messages into the backend pipeline
- **Crypto Parameters:** Live display of cipher config

---

---

## Project Structure

```
AIT/
├── backend/             # FastAPI Backend
│   ├── core/           # Security & Cryptography Engine
│   ├── api/            # API Endpoints
│   ├── models/         # Database Schema & Models
│   ├── .env            # Local configuration (Ignored)
│   └── .gitignore      # Backend-specific ignores
├── frontend/            # Next.js Frontend
│   ├── app/            # App Router Pages
│   ├── components/     # UI Components
│   ├── .env.local      # Local configuration (Ignored)
│   └── .gitignore      # Frontend-specific ignores
└── README.md            # Project Overview
```

> [!NOTE]
> Local `.gitignore` files are maintained in both `backend/` and `frontend/` folders to ensure environment-specific files and dependencies are not committed.
