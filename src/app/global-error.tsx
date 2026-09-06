"use client";

export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          background: "#101b2b",
          color: "#edf3fb",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        <main style={{ maxWidth: 690, margin: "12vh auto", padding: 28 }}>
          <p style={{ color: "#f7ce78", fontSize: 13 }}>
            EDGAR Terminal · Recovery
          </p>
          <h1 style={{ fontSize: 34, lineHeight: 1.15 }}>
            The application could not finish loading.
          </h1>
          <p style={{ color: "#c4d1e2", lineHeight: 1.8 }}>
            Retry the current page. This action does not clear your saved
            browser research. Unsaved edits may need to be entered again.
          </p>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 18,
              alignItems: "center",
              marginTop: 25,
            }}
          >
            <button
              type="button"
              onClick={reset}
              style={{
                background: "#f7ce78",
                color: "#102136",
                padding: "12px 18px",
                borderRadius: 9,
                border: 0,
                fontSize: 15,
                cursor: "pointer",
              }}
            >
              Retry this page
            </button>
            {/* Native links recover without depending on the failed router shell. */}
            <a href="/workspace" style={{ color: "#e5edfa" }}>
              Open workspace
            </a>
            <a href="/help#recovery" style={{ color: "#e5edfa" }}>
              Research help
            </a>
          </div>
        </main>
      </body>
    </html>
  );
}
