import { createClient } from "@supabase/supabase-js";

const rawSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();

if (!rawSupabaseUrl || !supabaseAnonKey) {
  throw new Error(
    "Missing Supabase environment variables. " +
      "Copy .env.local.example → .env.local and fill in your project credentials."
  );
}

// Guard against common placeholder mistakes like [YOUR-PROJECT-REF].
if (
  rawSupabaseUrl.includes("[") ||
  rawSupabaseUrl.includes("]") ||
  rawSupabaseUrl.includes("YOUR-PROJECT-REF")
) {
  throw new Error(
    "Invalid NEXT_PUBLIC_SUPABASE_URL: placeholder value detected. " +
      "Use your real Supabase project URL, e.g. https://abcxyzcompany.supabase.co"
  );
}

let supabaseUrl: string;
try {
  const parsed = new URL(rawSupabaseUrl);
  if (parsed.protocol !== "https:") {
    throw new Error("Supabase URL must start with https://");
  }
  supabaseUrl = parsed.toString().replace(/\/$/, "");
} catch {
  throw new Error(
    "Invalid NEXT_PUBLIC_SUPABASE_URL format. " +
      "Expected: https://<project-ref>.supabase.co"
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  realtime: {
    params: { eventsPerSecond: 20 },
  },
});
