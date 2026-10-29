"use client";

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <html lang="en"><body style={{ background: "#0b0507", color: "#f6eef2", padding: "3rem", fontFamily: "system-ui" }}><main role="alert"><h1>PulseGrid could not load.</h1><p>Reload the application to try again.</p><button onClick={reset}>Try again</button><p>Teaching model, not clinical software.</p></main></body></html>;
}
