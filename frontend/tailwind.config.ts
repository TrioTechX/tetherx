import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./pages/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./app/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Sentinel palette
        sentinel: {
          black: "#040608",
          deep: "#080c10",
          surface: "#0d1117",
          border: "#1a2332",
          muted: "#1e2d3d",
          panel: "#111827",
          green: "#00ff41",
          "green-dim": "#00cc34",
          "green-glow": "#00ff4133",
          teal: "#0ff",
          "teal-dim": "#00cccc",
          red: "#ff2222",
          "red-dim": "#cc1111",
          "red-glow": "#ff222244",
          amber: "#ffaa00",
          "amber-glow": "#ffaa0033",
          text: "#8b9ab0",
          "text-dim": "#4a5568",
        },
      },
      fontFamily: {
        mono: ["'JetBrains Mono'", "'Fira Code'", "Consolas", "monospace"],
        sans: ["'Inter'", "system-ui", "sans-serif"],
      },
      boxShadow: {
        "green-glow": "0 0 20px rgba(0,255,65,0.2), 0 0 40px rgba(0,255,65,0.1)",
        "red-glow": "0 0 20px rgba(255,34,34,0.4), 0 0 60px rgba(255,34,34,0.2)",
        "teal-glow": "0 0 15px rgba(0,255,255,0.2)",
        "panel": "0 0 0 1px rgba(26,35,50,0.8), 0 4px 24px rgba(0,0,0,0.6)",
      },
      animation: {
        "pulse-red": "pulse-red 1s cubic-bezier(0.4,0,0.6,1) infinite",
        "scan": "scan 3s linear infinite",
        "flicker": "flicker 0.15s infinite",
        "matrix-fall": "matrix-fall 2s linear infinite",
      },
      keyframes: {
        "pulse-red": {
          "0%, 100%": { opacity: "1", boxShadow: "0 0 20px rgba(255,34,34,0.6)" },
          "50%": { opacity: "0.5", boxShadow: "0 0 5px rgba(255,34,34,0.2)" },
        },
        scan: {
          "0%": { transform: "translateY(-100%)" },
          "100%": { transform: "translateY(100vh)" },
        },
        flicker: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.85" },
        },
        "matrix-fall": {
          "0%": { transform: "translateY(-20px)", opacity: "0" },
          "10%": { opacity: "1" },
          "90%": { opacity: "1" },
          "100%": { transform: "translateY(20px)", opacity: "0" },
        },
      },
    },
  },
  plugins: [],
};

export default config;
