# How to Connect the Backend to Supabase

When you see **"Database unreachable (e.g. no internet/DNS). Result not stored"**, the backend cannot reach your Supabase PostgreSQL server. Follow these steps to fix it.

---

## 1. Get the correct connection string from Supabase

1. Open [Supabase Dashboard](https://supabase.com/dashboard) and sign in.
2. Select your project (e.g. the one with ref `hyadxhamqdehlhvfoysh`).
3. Go to **Project Settings** (gear icon in the left sidebar).
4. Click **Database** in the left menu.
5. Under **Connection string**, choose **URI**.
6. Copy the connection string. It looks like:
   ```text
   postgresql://postgres.[PROJECT-REF]:[YOUR-PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres
   ```
   Or for **direct** connection (port 5432):
   ```text
   postgresql://postgres:[YOUR-PASSWORD]@db.[PROJECT-REF].supabase.co:5432/postgres
   ```

**Important:**

- Replace `[YOUR-PASSWORD]` with the **database password** you set when creating the project (or reset it under Database → Database password).
- If the password contains **`@`**, **`#`**, or **`%`**, you must **URL-encode** it in the connection string:
  - `@` → `%40`
  - `#` → `%23`
  - `%` → `%25`  
  Example: password `TarunGod@123` → use `TarunGod%40123` in the URL.

---

## 2. Set the backend `.env`

In **`backend/.env`** set:

```env
SUPABASE_DB_URL=postgresql://postgres:YOUR_PASSWORD_ENCODED@db.YOUR_PROJECT_REF.supabase.co:5432/postgres
```

- Use the **direct** host: `db.[PROJECT-REF].supabase.co` and port **5432** (not the pooler 6543 unless you switch the backend to use it).
- Use the same project ref as in your Supabase URL (e.g. `hyadxhamqdehlhvfoysh`).

Example (password `TarunGod@123`, ref `hyadxhamqdehlhvfoysh`):

```env
SUPABASE_DB_URL=postgresql://postgres:TarunGod%40123@db.hyadxhamqdehlhvfoysh.supabase.co:5432/postgres
```

Save the file and **restart the backend** (`python main.py`).

---

## 3. Check internet and DNS

The error **"failed to resolve host ... getaddrinfo failed"** means your machine could not resolve `db.xxxx.supabase.co` to an IP address.

**On Windows (PowerShell):**

```powershell
# Test DNS resolution
nslookup db.hyadxhamqdehlhvfoysh.supabase.co
```

- If it **fails**: DNS problem. Try:
  1. **Use Google DNS:**  
     Settings → Network & Internet → Ethernet/Wi‑Fi → your connection → Edit → IP settings → DNS: **8.8.8.8** (and optionally 8.8.4.4).
  2. **Flush DNS:**  
     Open PowerShell as Administrator and run:  
     `ipconfig /flushdns`
  3. **Try from another network** (e.g. mobile hotspot) to rule out firewall/corporate blocking.

- If **nslookup succeeds** but the app still says unreachable, the next step is a connectivity test (e.g. the backend **Check DB** endpoint below).

---

## 4. Firewall and VPN

- **Firewall:** Allow **outbound** connections to `*.supabase.co` on port **5432** (PostgreSQL) and **443** (HTTPS for dashboard).
- **VPN / corporate proxy:** Some block direct DB connections. Try disconnecting VPN or using a different network to see if the backend can connect.
- **Antivirus:** Temporarily allow your Python/backend process to access the network.

---

## 5. Verify from the backend

After updating `.env` and restarting the backend:

1. **Check DB endpoint (if available):**  
   Open in browser:  
   **http://localhost:8000/api/check-db**  
   - If it returns `{"ok": true, ...}` → DB connection works.  
   - If it returns `{"ok": false, "error": "..."}` → use the error message to fix URL, password, or network.

2. **Send a message again** from the app. If the DB is reachable, you should **not** see the “Database unreachable” message and new rows should appear in Supabase (Table Editor → `chat_logs`).

---

## 6. Supabase project status

- In the [Supabase Dashboard](https://supabase.com/dashboard), check that the project is **Active** (not paused).
- Free-tier projects can be **paused** after inactivity; if paused, click **Restore project**.

---

## Quick checklist

| Step | What to do |
|------|------------|
| 1 | Get Database password from Supabase → Project Settings → Database. |
| 2 | Copy **URI** (direct, port 5432) and replace password; encode `@` as `%40` if needed. |
| 3 | Put it in `backend/.env` as `SUPABASE_DB_URL=...`. |
| 4 | Restart backend (`python main.py`). |
| 5 | Run `nslookup db.YOUR_PROJECT_REF.supabase.co`; fix DNS if it fails. |
| 6 | Open http://localhost:8000/api/check-db to confirm connection. |
| 7 | Send a message again; confirm no “Database unreachable” and rows in `chat_logs`. |
