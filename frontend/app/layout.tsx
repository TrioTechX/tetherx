import type { Metadata } from "next";
import "./globals.css";
import { AuthProvider } from "./auth-context";

export const metadata: Metadata = {
  title: {
    default: "Project Sentinel — Zero-Exposure Threat Detection",
    template: "%s | Project Sentinel",
  },
  description:
    "Military-grade encrypted communications threat detection system. " +
    "Powered by Searchable Symmetric Encryption and Bloom Filters.",
  icons: { 
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon.ico", sizes: "any" },
    ],
    apple: "/apple-touch-icon.png",
  },
  applicationName: "Project Sentinel",
  keywords: [
    "encryption",
    "threat detection",
    "AES-256",
    "bloom filter",
    "SSE",
    "searchable encryption",
    "military communications",
  ],
  authors: [{ name: "Project Sentinel Team" }],
  creator: "Project Sentinel",
  viewport: {
    width: "device-width",
    initialScale: 1,
    maximumScale: 1,
  },
  themeColor: "#040608",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body className="bg-sentinel-black min-h-screen antialiased">
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
