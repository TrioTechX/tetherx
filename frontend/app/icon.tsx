import { ImageResponse } from "next/og";

/**
 * Project Sentinel Favicon Generator
 * 
 * Note: ImageResponse uses Satori which ONLY supports inline styles.
 * External CSS is not supported in this context. The linting warnings
 * about inline styles can be safely ignored for this file.
 */

export const size = {
  width: 32,
  height: 32,
};

export const contentType = "image/png";

export default function Icon() {
  /* eslint-disable @next/next/no-img-element */
  /* eslint-disable react/no-unknown-property */
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "linear-gradient(135deg, #040608 0%, #0d1117 100%)",
        }}
      >
        <div
          style={{
            fontSize: 20,
            fontWeight: 700,
            color: "#00ff41",
            textShadow: "0 0 10px rgba(0, 255, 65, 0.8)",
          }}
        >
          S
        </div>
      </div>
    ),
    {
      ...size,
    }
  );
}
