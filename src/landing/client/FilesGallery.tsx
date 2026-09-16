import { useEffect, useRef, useState } from "@hono/hono/jsx/dom";
import type { BlobDescriptor, NostrProvider } from "./types.ts";
import { getNostrProvider, signListAuth } from "./auth.ts";
import { ListHttpError, listMyBlobs } from "./api.ts";

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

function kindOf(d: BlobDescriptor): "image" | "gif" | "video" | "audio" | "other" {
  const type = d.type ?? "";
  if (type === "image/gif") return "gif";
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
  // Authorization token lives in memory only (senior review item 3).
  const tokenRef = useRef<{ header: string; expiresAt: number } | null>(null);
  const [descriptors, setDescriptors] = useState<BlobDescriptor[]>([]);
  const seenHashes = useRef<Set<string>>(new Set());
  const nextCursor = useRef<string | null>(null);
  const lastCursor = useRef<string | null>(null);
  const finished = useRef(false);
  const loadingRef = useRef(false);
  const [loading, setLoading] = useState(false);
  const [copiedHash, setCopiedHash] = useState<string | null>(null);
  const [fallbackCopy, setFallbackCopy] = useState<string | null>(null);
  const [viewer, setViewer] = useState<BlobDescriptor | null>(null);
  const lastCardRef = useRef<HTMLElement | null>(null);

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
        message: "No Nostr extension found. Install nos2x or similar to browse your files.",
        retryable: false,
      };
      setError(e);
      setPhase("disconnected");
      throw e;
    }
    const { header, pubkey: signedPubkey, expiresAt } = await signListAuth(nostr);
    // Key changed underneath us → previous cards belong to another identity.
    if (pubkey && signedPubkey !== pubkey) {
      setDescriptors([]);
      seenHashes.current = new Set();
      nextCursor.current = null;
      finished.current = false;
    }
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
      const pk = pubkey ?? "";
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

  async function copyUrl(d: BlobDescriptor): Promise<void> {
    try {
      await navigator.clipboard.writeText(d.url);
      setCopiedHash(d.sha256);
      setFallbackCopy(null);
      setTimeout(() => setCopiedHash((h) => (h === d.sha256 ? null : h)), 1500);
    } catch {
      // Clipboard unavailable/blocked → selectable field instead (review v1).
      setFallbackCopy(d.sha256);
      setCopiedHash(null);
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
        {error && (
          <p class="text-red-400 text-sm mb-3">{error.message}</p>
        )}
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

      <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        {descriptors.map((d) => (
          <Card
            key={d.sha256}
            d={d}
            copied={copiedHash === d.sha256}
            showFallbackInput={fallbackCopy === d.sha256}
            onOpen={(el) => openViewer(d, el)}
            onCopy={() => void copyUrl(d)}
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

function Card(
  { d, copied, showFallbackInput, onOpen, onCopy }: {
    d: BlobDescriptor;
    copied: boolean;
    showFallbackInput: boolean;
    onOpen: (el: HTMLElement) => void;
    onCopy: () => void;
  },
) {
  const kind = kindOf(d);
  const thumb = thumbUrl(d);
  const canInline = kind === "image" &&
      d.size <= INLINE_ORIGINAL_MAX_BYTES;
  const showImage = kind === "image" && (thumb || canInline);
  const src = showImage ? (thumb ?? d.url) : null;

  return (
    <div class="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden flex flex-col">
      <button
        type="button"
        onClick={(e) => onOpen(e.currentTarget)}
        class="relative h-36 bg-gray-950 flex items-center justify-center cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-500"
        aria-label={`Open ${shortHash(d.sha256)}`}
      >
        {src
          ? (
            <img
              src={src}
              alt={shortHash(d.sha256)}
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
        <p class="text-xs text-gray-300 font-mono truncate" title={d.sha256}>
          {shortHash(d.sha256)}
          {extFromUrl(d.url)}
        </p>
        <p class="text-[11px] text-gray-500">
          {d.type ?? "unknown"} · {formatSize(d.size)} ·{" "}
          {new Date(d.uploaded * 1000).toLocaleString()}
        </p>
        {showFallbackInput
          ? (
            <input
              readOnly
              value={d.url}
              onFocus={(e) => e.currentTarget.select()}
              class="w-full text-[10px] bg-gray-950 border border-gray-700 rounded px-1.5 py-1 text-gray-300"
            />
          )
          : (
            <button
              type="button"
              onClick={onCopy}
              class="w-full px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-200 text-xs font-medium"
            >
              {copied ? "Copied ✓" : "Copy link"}
            </button>
          )}
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
                No inline preview for {d.type ?? "unknown type"} — use the link
                below.
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
