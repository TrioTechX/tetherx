/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Allow requests from both laptops in the same LAN
  allowedDevOrigins: [
    "http://10.53.222.69:3000",
    "http://10.53.222.69:3001",
    "http://10.53.222.108:3000",
    "http://10.53.222.108:3001",
  ],
  env: {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000",
  },
};

module.exports = nextConfig;
