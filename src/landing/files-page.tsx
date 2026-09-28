import type { FC } from "@hono/hono/jsx";
import type { Config } from "../config/schema.ts";

/**
 * Full-page file manager — hosts the My Files gallery at GET /files.
 *
 * Deliberately separate from the landing Layout (which constrains content to
 * max-w-3xl): a media manager needs the whole viewport for the card grid, the
 * search/sort toolbar, and the floating bulk-action bar. Shares the same
 * Tailwind runtime and the same client bundle as the landing page — the bundle
 * mounts FilesGallery when it finds #files-root instead of #upload-root.
 */
export const FilesPage: FC<{ config: Config }> = ({ config }) => (
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>{`My Files · ${config.landing.title}`}</title>
      <script src="https://cdn.tailwindcss.com/3.4.17" />
    </head>
    <body class="bg-gray-950 text-gray-100 min-h-screen antialiased">
      <div class="max-w-6xl mx-auto px-4 py-8">
        <header class="flex items-center justify-between gap-3 mb-6 flex-wrap">
          <h1 class="text-2xl font-bold tracking-tight">My Files</h1>
          <a
            href="/"
            class="text-sm text-gray-400 hover:text-gray-200 underline"
          >
            ← Back to server
          </a>
        </header>
        <div
          id="files-root"
          data-list-enabled={String(config.list.enabled)}
          class="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden"
        >
          {/* Static fallback shown before JS loads */}
          <div class="p-6 flex items-center justify-center min-h-40">
            <p class="text-gray-500 text-sm">Loading file manager…</p>
          </div>
        </div>
        <script src="/client.js" defer />
      </div>
    </body>
  </html>
);
