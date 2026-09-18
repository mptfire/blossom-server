/**
 * Client-side entry point — runs in the browser.
 *
 * Built ahead of time into public/client.js with `deno task build`.
 * Hydrates the #upload-root div rendered by upload-island.tsx (SSR).
 *
 * Nostr signing requires a NIP-07 extension (nos2x, Alby, …). The
 * window.nostr.js NIP-46 fallback was removed for v1: without a configured
 * bunker its signEvent never resolves, which left the gallery stuck on
 * "Connecting…" with no way to recover (senior review 2026-09-18, C6/S-findings).
 */
import { render } from "@hono/hono/jsx/dom";
import { App } from "./App.tsx";

const root = document.getElementById("upload-root");
if (root) {
  render(
    <App
      requireAuth={root.dataset.requireAuth === "true"}
      mediaEnabled={root.dataset.mediaEnabled === "true"}
      mediaRequireAuth={root.dataset.mediaRequireAuth === "true"}
      optimizeByDefault={root.dataset.optimizeByDefault === "true"}
      mirrorEnabled={root.dataset.mirrorEnabled === "true"}
      mirrorRequireAuth={root.dataset.mirrorRequireAuth === "true"}
      listEnabled={root.dataset.listEnabled === "true"}
    />,
    root,
  );
}
