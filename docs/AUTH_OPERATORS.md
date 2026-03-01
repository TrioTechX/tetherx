# Operator authentication (UUID + password)

Project Sentinel uses **pre-provisioned operator accounts**. There is no self-registration; operators are added to the database by an administrator.

## Setup

1. **Create the operators table**  
   In the Supabase SQL Editor, run the contents of:
   ```
   backend/models/operators_schema.sql
   ```

2. **Configure JWT (optional)**  
   In `backend/.env` you can set:
   - `JWT_SECRET` — secret used to sign tokens (defaults to a dev value; set a strong secret in production).
   - `JWT_EXPIRE_MINUTES` — token lifetime (default: 1440 = 24 hours).

3. **Seed demo operators**  
   From the backend directory:
   ```bash
   cd backend
   python scripts/seed_operators.py
   ```
   This inserts two operators (sender and receiver) with known passwords.

## Demo credentials (after seed)

| Role     | Operator UUID                             | Password              |
|----------|-------------------------------------------|------------------------|
| Sender   | `550e8400-e29b-41d4-a716-446655440001`   | `sentinel-sender-01`   |
| Receiver | `550e8400-e29b-41d4-a716-446655440002`   | `sentinel-receiver-01` |

## Flow

- **Landing** (`/`): Choose Sender or Receiver → go to the role-specific login page.
- **Login** (`/login/sender` or `/login/receiver`): Enter Operator UUID and password → backend validates against `operators` and returns a JWT; frontend stores it and redirects to the dashboard.
- No “Create account” option; all accounts already exist in the database.
