"use client";

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <section className="panel empty-state" role="alert"><p className="eyebrow">WORKSPACE UNAVAILABLE</p><h1>This view could not be loaded.</h1><p>No operation has been confirmed. Try loading the view again.</p><button className="button button-primary" onClick={reset}>Try again</button></section>;
}
