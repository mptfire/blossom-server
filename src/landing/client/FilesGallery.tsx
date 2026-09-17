import { useEffect, useRef, useState } from "@hono/hono/jsx/dom";
import type { BlobDescriptor, NostrProvider } from "./types.ts";
import { getNostrProvider, signListAuth } from "./auth.ts";
import { ListHttpError, listMyBlobs } from "./api.ts";
import { rememberedFilename } from "./helpers.ts";

/** Page size per senior review v1 decision. */
const PAGE_SIZE = 24;
/** Originals larger than this render as icons in the grid (no lazy full fetch). */
const INLINE_ORIGINAL_MAX_BYTES = 20 * 1024 * 1024;

type Phase = "disconnected" | "connecting" | "ready";

interface GalleryError {
  /** noext: no NIP-07 provider · rejected: signer refused · forbidden: 403 ·
   *  cursor: dataset changed, refresh needed · server: 5xx/network · auth: 401 */
  kind: "noext" | "rejected" | "forbidden" | "cursor" | "server" | "auth";
  message: string;
  retryable: boolean;
}

function shortHash(hash: string): string {
  return `${hash.slice(0, 8)}…${hash.slice(-4)}`;
}

function extFromUrl(url: string): string {
  try {
    const path = new URL(url).pathname;
    const dot = path.lastIndexOf(".");
    return dot === -1 ? "" : path.slice(dot).toLowerCase();
  } catch {
    return "";
  }
}

/** Only same-origin URLs may be rendered as media (senior review item 6). */
function isTrustedUrl(url: string): boolean {
  try {
    return new URL(url).origin === globalThis.location.origin;
  } catch {
    return false;
  }
}

function thumbUrl(d: BlobDescriptor): string | null {
  const thumb = d.nip94?.find((t) => t[0] === "thumb")?.[1];
  if (!thumb || !isTrustedUrl(thumb)) return null;
  return thumb;
}

function kindOf(
  d: BlobDescriptor,
): "image" | "gif" | "video" | "audio" | "other" {
  const type = d.type ?? "";
  if (type === "image/gif") return "gif";
  // SVG is never rendered inline (senior review: generic card even when the
  // type claims image/*) — SVG served same-origin can carry scripts.
  if (type === "image/svg+xml") return "other";
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  return "other";
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

export function FilesGallery({ listEnabled }: { listEnabled: boolean }) {
  const [phase, setPhase] = useState<Phase>("disconnected");
  const [error, setError] = useState<GalleryError | null>(null);
  const [pubkey, setPubkey] = useState<string | null>(null);
  // Auth token + pubkey live in refs (state updates don't apply within the
  // same tick — the first list request would otherwise request /list/ with an
  // empty pubkey). Token stays in memory only (senior review item 3).
  const pubkeyRef = useRef<string | null>(null);
  const tokenRef = useRef<{ header: string; expiresAt: number } | null>(null);
  const [descriptors, setDescriptors] = useState<BlobDescriptor[]>([]);
  const seenHashes = useRef<Set<string>>(new Set());
  const nextCursor = useRef<string | null>(null);
  const lastCursor = useRef<string | null>(null);
  const finished = useRef(false);
  const loadingRef = useRef(false);
  const [loading, setLoading] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [fallbackKey, setFallbackKey] = useState<string | null>(null);
  const [viewer, setViewer] = useState<BlobDescriptor | null>(null);
  const lastCardRef = useRef<HTMLElement | null>(null);
  // Filters apply to loaded pages; whole-library filtering needs a server
  // type param (upstream candidate). Sort re-orders the loaded set.
  const [filter, setFilter] = useState<
    "all" | "image" | "video" | "audio" | "other"
  >("all");
  const [newestFirst, setNewestFirst] = useState(true);

  if (!listEnabled) {
    return (
      <div class="p-6 text-center">
        <p class="text-gray-500 text-sm">
          The file list is disabled on this server.
        </p>
      </div>
    );
  }

  async function getToken(force = false): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (!force && tokenRef.current && tokenRef.current.expiresAt > now + 30) {
      return tokenRef.current.header;
    }
    const nostr: NostrProvider | undefined = getNostrProvider();
    if (!nostr) {
      const e: GalleryError = {
        kind: "noext",
        message:
          "No Nostr extension found. Install nos2x or similar to browse your files.",
        retryable: false,
      };
      setError(e);
      setPhase("disconnected");
      throw e;
    }
    const { header, pubkey: signedPubkey, expiresAt } = await signListAuth(
      nostr,
    );
    // Key changed underneath us → previous cards belong to another identity.
    if (pubkey && signedPubkey !== pubkey) {
      setDescriptors([]);
      seenHashes.current = new Set();
      nextCursor.current = null;
      finished.current = false;
    }
    pubkeyRef.current = signedPubkey;
    setPubkey(signedPubkey);
    tokenRef.current = { header, expiresAt };
    return header;
  }

  async function connect(): Promise<void> {
    setError(null);
    setPhase("connecting");
    try {
      await getToken(true);
      setPhase("ready");
      await loadPage(true);
    } catch (err) {
      if ((err as GalleryError)?.kind === "noext") return; // already handled
      setError({
        kind: "rejected",
        message: err instanceof Error ? err.message : "Signing was rejected.",
        retryable: true,
      });
      setPhase("disconnected");
    }
  }

  async function loadPage(reset = false, reauth = false): Promise<void> {
    if (loadingRef.current) return; // one request in flight, ever
    loadingRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const header = await getToken(reauth);
      const pk = pubkeyRef.current ?? "";
      const page = await listMyBlobs(header, pk, {
        limit: PAGE_SIZE,
        cursor: reset ? undefined : nextCursor.current ?? undefined,
      });
      if (reset) {
        setDescriptors([]);
        seenHashes.current = new Set();
        nextCursor.current = null;
        finished.current = false;
      }
      // Dedupe + append (dedupe hides client repeats; skipped files surface
      // as an incomplete page count, which the cursor error path handles).
      setDescriptors((prev) => {
        const next = reset ? [] : [...prev];
        for (const d of page) {
          if (!seenHashes.current.has(d.sha256)) {
            seenHashes.current.add(d.sha256);
            next.push(d);
          }
        }
        return next;
      });
      if (page.length < PAGE_SIZE) {
        finished.current = true;
      } else {
        const newCursor = page[page.length - 1].sha256;
        if (newCursor === lastCursor.current) {
          finished.current = true; // repeated cursor: stop instead of looping
        } else {
          nextCursor.current = newCursor;
          lastCursor.current = newCursor;
        }
        // Cursor only advances after a successful response (above).
      }
    } catch (err) {
      if (err instanceof ListHttpError) {
        if (err.status === 401) {
          // Token expired mid-session: re-sign exactly once, never loop.
          if (!reauth) {
            loadingRef.current = false;
            setLoading(false);
            return loadPage(reset, true);
          }
          setError({
            kind: "auth",
            message: "Your list authorization expired. Reconnect to continue.",
            retryable: true,
          });
        } else if (err.status === 403) {
          setError({
            kind: "forbidden",
            message: "This key is not allowed to list these files.",
            retryable: false,
          });
        } else if (err.status === 400) {
          setError({
            kind: "cursor",
            message: "Files changed while loading — refresh the list.",
            retryable: true,
          });
        } else {
          setError({
            kind: "server",
            message: `Server error (${err.status}). Try again.`,
            retryable: true,
          });
        }
      } else {
        setError({
          kind: "server",
          message: err instanceof Error ? err.message : "Network error.",
          retryable: true,
        });
      }
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }

  function disconnect(): void {
    tokenRef.current = null;
    setPubkey(null);
    setDescriptors([]);
    seenHashes.current = new Set();
    nextCursor.current = null;
    lastCursor.current = null;
    finished.current = false;
    setError(null);
    setPhase("disconnected");
  }

  function refresh(): void {
    void loadPage(true);
  }

  async function copyVariant(
    d: BlobDescriptor,
    fmt: CopyFormat,
  ): Promise<void> {
    const key = `${d.sha256}:${fmt}`;
    try {
      await navigator.clipboard.writeText(copyTextFor(d, fmt));
      setCopiedKey(key);
      setFallbackKey(null);
      setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1500);
    } catch {
      // Clipboard unavailable/blocked → selectable field instead (review v1).
      setFallbackKey(key);
      setCopiedKey(null);
    }
  }

  function openViewer(d: BlobDescriptor, el: HTMLElement): void {
    lastCardRef.current = el;
    setViewer(d);
  }

  function closeViewer(): void {
    setViewer(null); // unmounts any <video>/<audio> → playback stops
    lastCardRef.current?.focus();
  }

  useEffect(() => {
    if (!viewer) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeViewer();
    };
    globalThis.addEventListener("keydown", onKey);
    return () => globalThis.removeEventListener("keydown", onKey);
  }, [viewer]);

  if (phase !== "ready") {
    return (
      <div class="p-8 text-center">
        {error && <p class="text-red-400 text-sm mb-3">{error.message}</p>}
        <button
          type="button"
          onClick={() => void connect()}
          disabled={phase === "connecting"}
          class="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium"
        >
          {phase === "connecting" ? "Connecting…" : "Connect with Nostr"}
        </button>
        {error?.retryable && (
          <button
            type="button"
            onClick={() => void connect()}
            class="block mx-auto mt-3 text-gray-400 hover:text-gray-200 text-xs underline"
          >
            Retry
          </button>
        )}
      </div>
    );
  }

  const gridEmpty = descriptors.length === 0 && !loading && !error;
  // Filters apply to loaded pages; server-side type filtering is the
  // ?type= param (upstream candidate for whole-library filtering).
  const visible = descriptors
    .filter((d) => filter === "all" || kindOf(d) === filter)
    .sort((
      a,
      b,
    ) => (newestFirst ? b.uploaded - a.uploaded : a.uploaded - b.uploaded));
  const filterChips: Array<{
    key: typeof filter;
    label: string;
  }> = [
    { key: "all", label: "All" },
    { key: "image", label: "Images" },
    { key: "video", label: "Videos" },
    { key: "audio", label: "Audio" },
    { key: "other", label: "Other" },
  ];

  return (
    <div class="p-4">
      <div class="flex items-center justify-between mb-4 gap-2 flex-wrap">
        <span
          class="text-xs text-gray-500 font-mono"
          title="Connected pubkey — the gallery shows files uploaded with this key"
        >
          {pubkey ? `${pubkey.slice(0, 8)}…${pubkey.slice(-4)}` : ""}
        </span>
        <div class="flex gap-2">
          <button
            type="button"
            onClick={refresh}
            disabled={loading}
            class="px-3 py-1.5 rounded-lg border border-gray-700 hover:border-gray-500 text-gray-300 text-xs font-medium disabled:opacity-50"
          >
            Refresh
          </button>
          <button
            type="button"
            onClick={disconnect}
            class="px-3 py-1.5 rounded-lg border border-gray-700 hover:border-gray-500 text-gray-300 text-xs font-medium"
          >
            Disconnect
          </button>
        </div>
      </div>

      <div class="flex items-center gap-1.5 mb-3 flex-wrap">
        {filterChips.map((chip) => (
          <button
            type="button"
            onClick={() => setFilter(chip.key)}
            class={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
              filter === chip.key
                ? "bg-blue-600 text-white"
                : "bg-gray-800 text-gray-400 hover:text-gray-200"
            }`}
          >
            {chip.label}
          </button>
        ))}
        <span class="flex-1" />
        <button
          type="button"
          onClick={() => setNewestFirst((v) => !v)}
          class="px-2.5 py-1 rounded-full bg-gray-800 text-gray-400 hover:text-gray-200 text-xs"
        >
          {newestFirst ? "Newest first ↓" : "Oldest first ↑"}
        </button>
      </div>

      {error && (
        <div class="mb-4 p-3 rounded-lg bg-red-950/50 border border-red-900 text-sm text-red-300 flex items-center justify-between gap-3">
          <span>{error.message}</span>
          {error.retryable && (
            <button
              type="button"
              onClick={() => {
                setError(null);
                void loadPage(descriptors.length === 0);
              }}
              class="px-3 py-1 rounded bg-red-900/60 hover:bg-red-900 text-xs"
            >
              Retry
            </button>
          )}
        </div>
      )}

      {gridEmpty && (
        <div class="p-8 text-center">
          <p class="text-gray-500 text-sm">
            No files yet. Upload something in the Upload tab and refresh.
          </p>
        </div>
      )}
      {!gridEmpty && visible.length === 0 && (
        <p class="text-center text-gray-500 text-sm mt-4">
          No{" "}
          {filter === "all" ? "" : filter + " "}files loaded — try Load more or
          All.
        </p>
      )}

      <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        {visible.map((d) => (
          <Card
            key={d.sha256}
            d={d}
            copiedKey={copiedKey}
            fallbackKey={fallbackKey}
            onOpen={(el) => openViewer(d, el)}
            onCopy={(fmt) => void copyVariant(d, fmt)}
          />
        ))}
      </div>

      {!finished.current && !gridEmpty && (
        <div class="text-center mt-4">
          <button
            type="button"
            onClick={() => void loadPage(false)}
            disabled={loading}
            class="px-4 py-2 rounded-lg border border-gray-700 hover:border-gray-500 text-gray-300 text-sm disabled:opacity-50"
          >
            {loading ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
      {loading && descriptors.length === 0 && (
        <p class="text-center text-gray-500 text-sm mt-4">Loading files…</p>
      )}

      {viewer && <Viewer d={viewer} onClose={closeViewer} />}
    </div>
  );
}

type CopyFormat = "url" | "md" | "html";

function displayName(d: BlobDescriptor): string {
  return rememberedFilename(d.sha256) ??
    `${shortHash(d.sha256)}${extFromUrl(d.url)}`;
}

function copyTextFor(d: BlobDescriptor, fmt: CopyFormat): string {
  const name = rememberedFilename(d.sha256) ??
    `${shortHash(d.sha256)}${extFromUrl(d.url)}`;
  if (fmt === "md") {
    return kindOf(d) === "image"
      ? `![${name}](${d.url})`
      : `[${name}](${d.url})`;
  }
  if (fmt === "html") {
    return kindOf(d) === "image"
      ? `<img src="${d.url}" alt="${name}">`
      : `<a href="${d.url}">${name}</a>`;
  }
  return d.url;
}

function Card(
  { d, copiedKey, fallbackKey, onOpen, onCopy }: {
    d: BlobDescriptor;
    copiedKey: string | null;
    fallbackKey: string | null;
    onOpen: (el: HTMLElement) => void;
    onCopy: (fmt: CopyFormat) => void;
  },
) {
  const kind = kindOf(d);
  const thumb = thumbUrl(d);
  const canInline = kind === "image" &&
    d.size <= INLINE_ORIGINAL_MAX_BYTES;
  const showImage = kind === "image" && (thumb || canInline);
  const src = showImage ? (thumb ?? d.url) : null;
  const name = rememberedFilename(d.sha256);
  const formats: Array<{ fmt: CopyFormat; label: string }> = [
    { fmt: "url", label: "Copy link" },
    { fmt: "md", label: "MD" },
    { fmt: "html", label: "</>" },
  ];

  return (
    <div class="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden flex flex-col">
      <button
        type="button"
        onClick={(e) => onOpen(e.currentTarget)}
        class="relative h-36 bg-gray-950 flex items-center justify-center cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-500"
        aria-label={`Open ${name ?? shortHash(d.sha256)}`}
        title={name ?? d.sha256}
      >
        {src
          ? (
            <img
              src={src}
              alt={name ?? shortHash(d.sha256)}
              loading="lazy"
              class="h-36 w-full object-cover"
            />
          )
          : (
            <span class="text-3xl" aria-hidden="true">
              {kind === "video"
                ? "🎞️"
                : kind === "audio"
                ? "🎧"
                : kind === "gif"
                ? "🖼️"
                : "📄"}
            </span>
          )}
        {kind === "video" && (
          <span
            class="absolute inset-0 flex items-center justify-center text-4xl drop-shadow"
            aria-hidden="true"
          >
            ▶️
          </span>
        )}
        {kind === "image" && !src && (
          <span class="absolute bottom-1 text-[10px] text-gray-500">
            click to load
          </span>
        )}
      </button>
      <div class="p-2.5 space-y-1.5">
        <p
          class="text-xs text-gray-300 font-mono truncate"
          title={name ?? d.sha256}
        >
          {name ?? `${shortHash(d.sha256)}${extFromUrl(d.url)}`}
        </p>
        <p class="text-[11px] text-gray-500">
          {d.type ?? "unknown"} · {formatSize(d.size)} ·{" "}
          {new Date(d.uploaded * 1000).toLocaleString()}
        </p>
        <div class="flex gap-1.5">
          {formats.map(({ fmt, label }) => {
            const key = `${d.sha256}:${fmt}`;
            const isFallback = fallbackKey === key;
            const isCopied = copiedKey === key;
            if (isFallback) {
              return (
                <input
                  key={fmt}
                  readOnly
                  value={copyTextFor(d, fmt)}
                  onFocus={(e) => e.currentTarget.select()}
                  class="flex-1 min-w-0 text-[10px] bg-gray-950 border border-gray-700 rounded px-1.5 py-1 text-gray-300"
                />
              );
            }
            return (
              <button
                key={fmt}
                type="button"
                onClick={() => onCopy(fmt)}
                class={`${
                  fmt === "url"
                    ? "flex-1 px-2 py-1 bg-gray-800 hover:bg-gray-700 text-gray-200 text-xs font-medium"
                    : "px-2 py-1 bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200 text-xs"
                } rounded ${isCopied ? "text-green-400" : ""}`}
              >
                {isCopied ? "Copied ✓" : label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Viewer({ d, onClose }: { d: BlobDescriptor; onClose: () => void }) {
  const kind = kindOf(d);
  const trusted = isTrustedUrl(d.url);
  return (
    <div
      class="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Viewing ${shortHash(d.sha256)}`}
    >
      <div
        class="bg-gray-900 rounded-xl border border-gray-800 max-w-3xl w-full max-h-[90vh] overflow-auto p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div class="flex items-center justify-between mb-3">
          <p class="text-xs text-gray-300 font-mono truncate">{d.sha256}</p>
          <button
            type="button"
            autoFocus
            onClick={onClose}
            class="px-3 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-200 text-xs"
          >
            Close (Esc)
          </button>
        </div>
        <div class="flex items-center justify-center bg-gray-950 rounded-lg mb-3 min-h-40">
          {!trusted
            ? <p class="text-gray-500 text-sm p-6">Untrusted file origin.</p>
            : kind === "image" || kind === "gif"
            ? <img src={d.url} alt={shortHash(d.sha256)} class="max-h-[60vh]" />
            : kind === "video"
            ? <video src={d.url} controls autoplay class="max-h-[60vh]" />
            : kind === "audio"
            ? <audio src={d.url} controls autoplay class="w-full m-4" />
            : (
              <p class="text-gray-500 text-sm p-6">
                No inline preview for {d.type ?? "unknown type"}{" "}
                — use the link below.
              </p>
            )}
        </div>
        <div class="flex items-center justify-between gap-3 flex-wrap">
          <p class="text-xs text-gray-500">
            {d.type ?? "unknown"} · {formatSize(d.size)} ·{" "}
            {new Date(d.uploaded * 1000).toLocaleString()}
          </p>
          <a
            href={trusted ? d.url : undefined}
            target="_blank"
            rel="noreferrer"
            class="px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium"
          >
            Open original ↗
          </a>
        </div>
      </div>
    </div>
  );
}
