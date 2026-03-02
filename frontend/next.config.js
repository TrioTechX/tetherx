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
};

module.exports = nextConfig;
