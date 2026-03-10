"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html>
      <body>
        <div style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#0D0D0D",
          color: "#fff",
        }}>
          <div style={{ textAlign: "center", padding: "32px" }}>
            <h2 style={{ fontSize: "20px", fontWeight: "bold", marginBottom: "16px" }}>
              Something went wrong
            </h2>
            <p style={{ color: "#8C8C8C", marginBottom: "24px" }}>
              {error.message || "A critical error occurred"}
            </p>
            <button
              onClick={reset}
              style={{
                padding: "8px 16px",
                backgroundColor: "#A3E635",
                color: "#000",
                fontWeight: "bold",
                borderRadius: "8px",
                border: "none",
                cursor: "pointer",
              }}
            >
              Try again
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
