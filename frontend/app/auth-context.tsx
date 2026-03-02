"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type AuthRole = "doctor" | "nurse" | "admin" | "patient" | "auditor" | null;

interface Session {
  uuid: string;
  role: AuthRole;
  assignedPatientIds: string[];
}

interface AuthState {
  user: { uuid: string } | null;
  role: AuthRole;
  assignedPatientIds: string[];
  loading: boolean;
  signIn: (
    uuid: string,
    password: string,
    requestedRole: AuthRole
  ) => Promise<{ error: Error | null }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function getApiUrl(): string {
  return typeof window !== "undefined"
    ? (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000")
    : "http://localhost:8000";
}

/**
 * Fetch the current session from /api/me.
 * The browser automatically sends the HttpOnly sentinel_auth cookie.
 * Returns null if the cookie is absent or expired (401).
 */
async function fetchSession(apiUrl: string): Promise<Session | null> {
  try {
    const res = await fetch(`${apiUrl}/api/me`, {
      method: "GET",
      credentials: "include", // sends the HttpOnly cookie automatically
    });
    if (!res.ok) return null;
    const data = await res.json() as {
      sub: string;
      role: string;
      assigned_patient_ids: string[];
    };
    return {
      uuid: data.sub,
      role: data.role as AuthRole,
      assignedPatientIds: data.assigned_patient_ids ?? [],
    };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider
// ─────────────────────────────────────────────────────────────────────────────

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  // On mount: hydrate auth state by calling /api/me (reads HttpOnly cookie).
  // No localStorage read, no JWT parsing — the cookie is invisible to JS.
  useEffect(() => {
    const apiUrl = getApiUrl();
    fetchSession(apiUrl)
      .then(setSession)
      .finally(() => setLoading(false));
  }, []);

  const role: AuthRole = session?.role ?? null;
  const user = session ? { uuid: session.uuid } : null;
  const assignedPatientIds = session?.assignedPatientIds ?? [];

  const signIn = useCallback(
    async (uuid: string, password: string, requestedRole: AuthRole) => {
      const apiUrl = getApiUrl();
      try {
        // credentials: "include" is required so the browser accepts the
        // Set-Cookie header that the backend sends in the response.
        const res = await fetch(`${apiUrl}/api/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ uuid: uuid.trim(), password }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          return { error: new Error(data.detail ?? "Login failed") };
        }

        // Guard: ensure the operator's actual role matches the requested portal
        if (requestedRole && data.role !== requestedRole) {
          // Clear the cookie the backend just set — wrong role portal
          await fetch(`${apiUrl}/api/auth/logout`, {
            method: "POST",
            credentials: "include",
          });
          return {
            error: new Error(
              `This operator is registered as '${data.role}'. Use the ${data.role} login.`
            ),
          };
        }

        // Refresh session state from /api/me (single source of truth)
        const fresh = await fetchSession(apiUrl);
        setSession(fresh);
        return { error: null };
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Network error";
        const isNetwork = /failed to fetch|network error|load failed/i.test(msg);
        return {
          error: new Error(
            isNetwork
              ? "Cannot reach the backend API. Please try again later."
              : msg
          ),
        };
      }
    },
    []
  );

  const signOut = useCallback(async () => {
    const apiUrl = getApiUrl();
    try {
      // Ask the backend to clear the HttpOnly cookie
      await fetch(`${apiUrl}/api/auth/logout`, {
        method: "POST",
        credentials: "include",
      });
    } catch {
      // Best-effort — clear local state regardless
    }
    setSession(null);
    router.push("/");
  }, [router]);

  return (
    <AuthContext.Provider
      value={{
        user,
        role,
        assignedPatientIds,
        loading,
        signIn,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
