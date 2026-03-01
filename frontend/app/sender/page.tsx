"use client";
import { useEffect } from "react";
export default function SenderRedirect() {
  useEffect(() => { window.location.replace("/command-center"); }, []);
  return (
    <div className="min-h-screen bg-sentinel-black flex items-center justify-center">
      <span className="text-sentinel-teal animate-pulse font-mono text-sm">REDIRECTING…</span>
    </div>
  );
}
