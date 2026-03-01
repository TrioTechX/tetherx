import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Format AES-GCM hex blob as redacted intercept label */
export function formatEncryptedPreview(hex: string): string {
  const prefix = hex.slice(0, 8).toUpperCase();
  const suffix = hex.slice(-4).toUpperCase();
  return `AES-GCM[0x${prefix}…${suffix}]`;
}

/** Humanise a UTC timestamp to relative time */
export function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 1000) return "just now";
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}

/** Generate pseudo-random "junk" ciphertext string for visual effect */
export function glitchString(length = 16): string {
  const chars = "0123456789ABCDEF";
  return Array.from({ length }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

/** Retry a fetch request with exponential backoff */
export async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
  maxRetries = 3,
  delayMs = 1000
): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);
      // If response is ok or client error (4xx), don't retry
      if (response.ok || (response.status >= 400 && response.status < 500)) {
        return response;
      }
      // Server errors (5xx) will be retried
      throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      
      // Don't retry on last attempt
      if (attempt < maxRetries) {
        // Exponential backoff with jitter
        const jitter = Math.random() * 200;
        const delay = delayMs * Math.pow(2, attempt) + jitter;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError || new Error("Request failed after retries");
}
