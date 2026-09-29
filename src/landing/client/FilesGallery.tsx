import { useEffect, useRef, useState } from "@hono/hono/jsx/dom";
import type { BlobDescriptor, GalleryError, NostrProvider } from "./types.ts";
import { getNostrProvider, signDeleteAuth, signListAuth } from "./auth.ts";
import { deleteBlob, ListHttpError, listMyBlobs } from "./api.ts";
import { clearFilenames, rememberedFilename } from "./helpers.ts";
import { type CopyFormat, copyTextFor } from "./copy-export.ts";
import { withTimeout } from "./with-timeout.ts";

/** Page size per senior review v1 decision. */
const PAGE_SIZE = 24;
/** Originals larger than this render as icons in the grid (no lazy full fetch). */
const INLINE_ORIGINAL_MAX_BYTES = 20 * 1024 * 1024;
/** User-interaction deadline for the nos2x approval (senior review round-3
 * §4: one long window with Cancel — not a short auto-reject). */
const APPROVAL_WINDOW_MS = 120000;

type Phase = "disconnected" | "connecting" | "ready";

type FilterKind = "all" | "image" | "video" | "audio" | "other";

type SortKey = "newest" | "oldest" | "name" | "size";

/** Marker: the session was superseded while work was in flight. */
class StaleSession extends Error {
  constructor() {
    super("stale session");
    this.name = "StaleSession";
  }
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

/** Only same-origin URLs may be rendered as media anywhere in the gallery. */
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

/** Filter/export category — follows the server's MIME truth: GIFs and SVGs
 * count as images for filtering (senior review C4). Preview policy is
 * deliberately more conservative and handled separately (previewKind). */
function categoryOf(d: BlobDescriptor): FilterKind {
  const type = d.type ?? "";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  if (type.startsWith("image/")) return "image";
  return "other";
}

/** Grid/preview policy — deliberately more conservative than the category:
 * GIF renders a static preview only, SVG/unknown never render inline. */
function previewKind(
  d: BlobDescriptor,
): "image" | "gif" | "video" | "audio" | "other" {
  const type = d.type ?? "";
  if (type === "image/gif") return "gif";
  // SVG served same-origin can carry scripts — never render inline (S6/S2).
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

function displayNameFor(d: BlobDescriptor): string {
  return rememberedFilename(d.sha256) ??
    `${shortHash(d.sha256)}${extFromUrl(d.url)}`;
}

export function FilesGallery({ listEnabled }: { listEnabled: boolean }) {
  const [phase, setPhase] = useState<Phase>("disconnected");
  const [error, setError] = useState<GalleryError | null>(null);
  const [pubkey, setPubkey] = useState<string | null>(null);
  // Session generation (senior review S3): bumped on disconnect and identity
  // change; async completions from an older generation are discarded.
  const sessionGen = useRef(0);
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
  // Operation ownership, separate from session generation (senior review
  // round-3 §3): exactly one operation owns loading; stale cleanups never
  // clear a newer operation's lock (fixes the disconnect/reconnect deadlock).
  const activeOp = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const opSeq = useRef(0);
  const [loading, setLoading] = useState(false);
  const [waitingApproval, setWaitingApproval] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [fallbackKey, setFallbackKey] = useState<string | null>(null);
  // Viewer is an index into the current visible list so prev/next can walk it.
  const [viewerIdx, setViewerIdx] = useState<number | null>(null);
  const [zoomed, setZoomed] = useState(false);
  const lastCardRef = useRef<HTMLElement | null>(null);
  // Restored — these were dropped during the security refactor, which made
  // the connected view throw ReferenceError after a successful sign-in.
  const [filter, setFilter] = useState<FilterKind>("all");
  const [sortKey, setSortKey] = useState<SortKey>("newest");
  // Sprint 1+2: search, bulk select, delete (client-side over loaded pages).
  const [query, setQuery] = useState("");
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmHashes, setConfirmHashes] = useState<string[] | null>(null);
  const [deleteProgress, setDeleteProgress] = useState<
    { done: number; total: number } | null
  >(null);
  const [notice, setNotice] = useState<
    { kind: "ok" | "err"; text: string } | null
  >(null);

  // Unmount cleanup: invalidate the session and abort in-flight work.
  useEffect(() => {
    return () => {
      sessionGen.current!++;
      abortRef.current?.abort();
      activeOp.current = null;
    };
  }, []);

  if (!listEnabled) {
    return (
      <div class="p-6 text-center">
        <p class="text-gray-500 text-sm">
          The file list is disabled on this server.
        </p>
      </div>
    );
  }
  /** Clear every piece of gallery state. Called on disconnect and identity
   * change — an atomic identity boundary (senior review item S3). */
  function resetGalleryState(): void {
    clearFilenames(); // names are identity-specific (r8 senior review, low)
    tokenRef.current = null;
    pubkeyRef.current = null;
    setPubkey(null);
    setDescriptors([]);
    seenHashes.current = new Set();
    nextCursor.current = null;
    lastCursor.current = null;
    finished.current = false;
    setError(null);
    setCopiedKey(null);
    setFallbackKey(null);
    setViewerIdx(null);
    setZoomed(false);
    setFilter("all");
    setSortKey("newest");
    setQuery("");
    setSelectMode(false);
    setSelected(new Set());
    setConfirmHashes(null);
    setDeleteProgress(null);
    setNotice(null);
  }

  function disconnect(): void {
    sessionGen.current!++; // invalidate all in-flight work (S3)
    abortRef.current?.abort();
    activeOp.current = null;
    abortRef.current = null;
    setLoading(false);
    resetGalleryState();
    setPhase("disconnected");
  }

  async function getToken(
    force: boolean,
    gen: number,
    opId: number | null,
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (
      !force && tokenRef.current &&
      tokenRef.current.expiresAt > now + 30 && gen === sessionGen.current!
    ) {
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
      globalThis.location.origin,
    );
    // Superseded while signing (disconnect/identity change) → discard; the
    // caller classifies and restarts as the current identity.
    if (
      gen !== sessionGen.current! ||
      (opId !== null && activeOp.current !== opId)
    ) {
      throw new StaleSession();
    }
    // Identity change = atomic boundary: bump the generation so any other
    // in-flight work from the previous identity is discarded too.
    if (pubkeyRef.current && signedPubkey !== pubkeyRef.current) {
      sessionGen.current!++;
      setDescriptors([]);
      seenHashes.current = new Set();
      nextCursor.current = null;
      lastCursor.current = null;
      finished.current = false;
      setCopiedKey(null);
      setFallbackKey(null);
      setViewerIdx(null);
      setZoomed(false);
      setFilter("all");
      setSortKey("newest");
      setQuery("");
      setSelectMode(false);
      setSelected(new Set());
      // r8 senior review (medium): identity-specific transient state must not
      // outlive the key that opened it.
      setConfirmHashes(null);
      setDeleteProgress(null);
      setNotice(null);
      clearFilenames();
    }
    pubkeyRef.current = signedPubkey;
    setPubkey(signedPubkey);
    tokenRef.current = { header, expiresAt };
    return header;
  }

  async function connect(): Promise<void> {
    setError(null);
    setPhase("connecting");
    setWaitingApproval(true);
    const gen = sessionGen.current!;
    const opId = ++opSeq.current!;
    activeOp.current = opId;
    try {
      // One long user-interaction window with Cancel — not a short
      // auto-reject (senior review round-3 §4).
      const header = await withTimeout(
        getToken(true, gen, opId),
        APPROVAL_WINDOW_MS,
        "Waiting for the nos2x approval timed out. Dismiss any old prompt and connect again.",
      );
      if (gen !== sessionGen.current! || activeOp.current !== opId) return;
      setWaitingApproval(false);
      setPhase("ready");
      await loadPage(true, opId);
    } catch (err) {
      // Only this attempt's owner may release the slot — an old cancelled
      // connect must never invalidate a newer connection's ownership
      // (round-5 finding: unconditional clear raced reconnect).
      if (activeOp.current === opId) activeOp.current = null;
      if (err instanceof StaleSession || gen !== sessionGen.current!) return;
      // This attempt still owns the UI — clear the approval gate or the
      // Retry link stays hidden behind `!waitingApproval` forever.
      setWaitingApproval(false);
      if ((err as GalleryError)?.kind === "noext") return; // already handled
      if ((err as Error).name === "AbortError") {
        setError({
          kind: "rejected",
          message: "Connect cancelled.",
          retryable: false,
        });
        setPhase("disconnected");
        return;
      }
      setError({
        kind: "rejected",
        message: err instanceof Error ? err.message : "Signing was rejected.",
        retryable: true,
      });
      setPhase("disconnected");
    }
  }

  function cancelConnect(): void {
    sessionGen.current!++; // invalidate in-flight signing (late signEvent must not write state)
    abortRef.current?.abort();
    activeOp.current = null;
    setWaitingApproval(false);
    setError({
      kind: "rejected",
      message: "Connect cancelled — dismiss any open nos2x prompt first.",
      retryable: false,
    });
    setPhase("disconnected");
  }

  /** Single-locked page load: one in-flight request, at most one forced
   * re-authorization — and the 401 retry happens INSIDE the loop with the
   * lock held (senior review round-3 §2). `opId` carries ownership from
   * connect(); standalone calls begin their own operation. */
  async function loadPage(reset = false, opId?: number): Promise<void> {
    let myOp = opId;
    if (myOp === undefined || activeOp.current !== myOp) {
      if (activeOp.current !== null) return; // another operation owns loading
      myOp = ++opSeq.current!;
      activeOp.current = myOp;
    }
    setLoading(true);
    setError(null);
    const ac = new AbortController();
    abortRef.current = ac;
    const gen = sessionGen.current!;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        let header: string;
        try {
          header = await getToken(attempt > 0, gen, myOp);
        } catch (err) {
          // Signer rejection, timeout, or stale session — show a clear
          // error instead of an unhandled rejection (senior review C6).
          classifyError(err);
          return;
        }
        if (gen !== sessionGen.current! || activeOp.current !== myOp) return;
        try {
          const page = await listMyBlobs(header, pubkeyRef.current ?? "", {
            limit: PAGE_SIZE,
            cursor: reset ? undefined : nextCursor.current ?? undefined,
            signal: ac.signal,
          });
          if (gen !== sessionGen.current! || activeOp.current !== myOp) return;
          commitPage(page, reset);
          if (page.length < PAGE_SIZE) {
            finished.current = true;
            nextCursor.current = null;
            return;
          }
          const newCursor = page[page.length - 1].sha256;
          // Repeated cursor is only meaningful for continuations, and it
          // means the dataset changed — surface it, never silently claim
          // completion (senior review C1).
          if (!reset && newCursor === lastCursor.current) {
            finished.current = true;
            nextCursor.current = null;
            setError({
              kind: "cursor",
              message: "Files changed while loading — refresh the list.",
              retryable: true,
              retryReset: true,
            });
            return;
          }
          nextCursor.current = newCursor;
          lastCursor.current = newCursor;
          return;
        } catch (err) {
          if (gen !== sessionGen.current! || activeOp.current !== myOp) return;
          // 401 → force re-sign ONCE, inside the loop (senior review §2).
          if (
            err instanceof ListHttpError && err.status === 401 && attempt === 0
          ) {
            tokenRef.current = null;
            continue;
          }
          classifyError(err);
          return;
        }
      }
      // Both attempts exhausted (second attempt also 401).
      setError({
        kind: "auth",
        message:
          "Authorization failed after retry. Disconnect and connect again.",
        retryable: true,
        retryReset: false,
      });
    } finally {
      // Only the owning operation releases the lock (stale cleanups never
      // clear a newer operation's slot — senior review round-3 §3).
      if (activeOp.current === myOp) {
        activeOp.current = null;
        setLoading(false);
      }
    }
  }

  function commitPage(page: BlobDescriptor[], reset: boolean): void {
    if (reset) {
      setDescriptors([]);
      seenHashes.current = new Set();
      nextCursor.current = null;
      lastCursor.current = null; // C1: full traversal reset (was retained →
      // the next page was mistaken for a repeat and pagination died)
      finished.current = false;
    }
    setDescriptors((prev) => {
      const next = reset ? [] : [...prev];
      for (const d of page) {
        if (!seenHashes.current!.has(d.sha256)) {
          seenHashes.current!.add(d.sha256);
          next.push(d);
        }
      }
      return next;
    });
  }

  function classifyError(err: unknown): void {
    if (err instanceof ListHttpError) {
      if (err.status === 401) {
        setError({
          kind: "auth",
          message: "Your list authorization expired. Reconnect to continue.",
          retryable: true,
          retryReset: false,
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
          retryReset: true,
        });
      } else if (err.name === "AbortError" || err.name === "TimeoutError") {
        setError({
          kind: "timeout",
          message: "The request timed out. Try again.",
          retryable: true,
        });
      } else {
        setError({
          kind: "server",
          message: `Server error (${err.status}). Try again.`,
          retryable: true,
        });
      }
      return;
    }
    const message = err instanceof Error && err.name === "TimeoutError"
      ? "The request timed out. Try again."
      : err instanceof Error
      ? err.message
      : "Network error.";
    setError({ kind: "server", message, retryable: true });
  }

  function refresh(): void {
    void loadPage(true);
  }

  async function copyVariant(
    d: BlobDescriptor,
    fmt: CopyFormat,
  ): Promise<void> {
    const key = `${d.sha256}:${fmt}`;
    const name = displayNameFor(d);
    const isImage = categoryOf(d) === "image" &&
      d.type !== "image/svg+xml";
    try {
      await navigator.clipboard.writeText(copyTextFor(d, fmt, name, isImage));
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
    const idx = computeVisible().findIndex((x) => x.sha256 === d.sha256);
    setZoomed(false);
    setViewerIdx(idx >= 0 ? idx : null);
  }

  function closeViewer(): void {
    setViewerIdx(null);
    setZoomed(false); // unmounts any <video>/<audio> → playback stops
    lastCardRef.current?.focus();
  }

  function stepViewer(dir: number): void {
    setZoomed(false);
    setViewerIdx((i) => {
      if (i === null) return null;
      const n = i + dir;
      return n >= 0 && n < computeVisible().length ? n : i;
    });
  }

  /** Shared visible-list computation — render body, select-all and viewer
   * navigation must all agree on what is currently shown. */
  function computeVisible(): BlobDescriptor[] {
    const q = query.trim().toLowerCase();
    const filtered = descriptors
      .filter((d) => filter === "all" || categoryOf(d) === filter)
      .filter((d) => {
        if (!q) return true;
        return displayNameFor(d).toLowerCase().includes(q) ||
          d.sha256.includes(q);
      });
    const by: Record<SortKey, (a: BlobDescriptor, b: BlobDescriptor) => number> =
      {
        newest: (a, b) => b.uploaded - a.uploaded,
        oldest: (a, b) => a.uploaded - b.uploaded,
        name: (a, b) => displayNameFor(a).localeCompare(displayNameFor(b)),
        size: (a, b) => b.size - a.size,
      };
    return filtered.sort(by[sortKey]);
  }

  function toggleSelected(hash: string, on: boolean): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(hash);
      else next.delete(hash);
      return next;
    });
  }

  function confirmDelete(hashes: string[]): void {
    if (hashes.length === 0 || deleteProgress) return;
    setConfirmHashes(hashes);
  }

  /** Plain clipboard write with a visible-failure notice (no silent loss). */
  function copy(text: string): void {
    navigator.clipboard?.writeText(text).then(() => {
      setNotice({ kind: "ok", text: "Copied to clipboard." });
    }, () => {
      setNotice({ kind: "err", text: "Clipboard blocked by the browser." });
    });
  }

  function exitSelectMode(): void {
    setSelectMode(false);
    setSelected(new Set());
  }

  /** Server contract: one signed delete event per blob (no multi-delete), so
   * a batch signs sequentially — one nos2x prompt per file, progress shown.
   * Stops at the first failure; un-deleted files stay selected for retry.
   * Every exit path reconciles the grid: blobs whose DELETE succeeded are
   * removed from view even when the batch stopped midway (r8 senior review,
   * medium finding — the old code only reconciled after full success). */
  async function performDelete(): Promise<void> {
    const hashes = confirmHashes;
    if (!hashes || hashes.length === 0 || deleteProgress) return;
    setConfirmHashes(null);
    setDeleteProgress({ done: 0, total: hashes.length });
    const gen = sessionGen.current!;
    const nostr = getNostrProvider();
    if (!nostr) {
      setDeleteProgress(null);
      setNotice({ kind: "err", text: "No Nostr extension found." });
      return;
    }
    let done = 0;
    const removed: string[] = [];
    /** Remove successfully deleted blobs from the grid + selection + viewer.
     * Captures the open viewer's hash BEFORE descriptor removal (descriptors
     * state still holds the pre-delete list in this closure). */
    const reconcile = (): void => {
      if (removed.length === 0) return;
      const openHash = viewerIdx !== null
        ? computeVisible()[viewerIdx]?.sha256 ?? null
        : null;
      const gone = new Set(removed);
      setDescriptors((prev) => prev.filter((d) => !gone.has(d.sha256)));
      for (const h of removed) seenHashes.current!.delete(h);
      setSelected((prev) => {
        const next = new Set(prev);
        for (const h of removed) next.delete(h);
        return next;
      });
      if (openHash && gone.has(openHash)) {
        setViewerIdx(null);
        setZoomed(false);
      }
    };
    let aborted: string | null = null;
    try {
      for (const hash of hashes) {
        if (gen !== sessionGen.current!) return; // superseded mid-batch
        try {
          const { header, pubkey: signedPubkey } = await withTimeout(
            signDeleteAuth(nostr, hash, globalThis.location.origin),
            APPROVAL_WINDOW_MS,
            "Waiting for the nos2x approval timed out. Dismiss any old prompt and try again.",
          );
          if (gen !== sessionGen.current!) return;
          // The extension may have switched accounts between prompts — a
          // token from a different key must never be sent (r8 senior review,
          // medium finding: shared blobs would lose the WRONG key's ownership).
          if (signedPubkey && pubkeyRef.current && signedPubkey !== pubkeyRef.current) {
            aborted = "the signer switched to a different Nostr key";
            break; // reconcile + failure notice run after the outer finally
          }
          await deleteBlob(hash, header);
          removed.push(hash);
        } catch (err) {
          if ((err as Error).name === "AbortError") return;
          aborted = err instanceof Error ? err.message : String(err);
          break; // reconcile + failure notice run after the outer finally
        } finally {
          done++;
          setDeleteProgress({ done, total: hashes.length });
        }
      }
    } finally {
      setDeleteProgress(null);
      reconcile();
    }
    setNotice(
      aborted
        ? {
          kind: "err",
          text: `Deleted ${removed.length} of ${hashes.length} — stopped: ${aborted}`,
        }
        : {
          kind: "ok",
          text:
            `Deleted ${removed.length} file${removed.length === 1 ? "" : "s"}.`,
        },
    );
  }

  useEffect(() => {
    // Confirm dialog open → Esc cancels, Enter confirms (destructive default
    // deliberately NOT on Enter for safety — Enter only confirms when the
    // dialog's own button holds focus). Viewer open → Esc/arrows/Z.
    if (confirmHashes) {
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") setConfirmHashes(null);
      };
      globalThis.addEventListener("keydown", onKey);
      return () => globalThis.removeEventListener("keydown", onKey);
    }
    if (viewerIdx === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeViewer();
      if (e.key === "ArrowLeft") stepViewer(-1);
      if (e.key === "ArrowRight") stepViewer(1);
      if (e.key === "z" || e.key === "Z") setZoomed((v) => !v);
      // Minimal focus containment: keep Tab cycling inside the dialog.
      if (e.key === "Tab") {
        const focusables = document.querySelectorAll<HTMLElement>(
          '[role="dialog"] button, [role="dialog"] a, [role="dialog"] input',
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    globalThis.addEventListener("keydown", onKey);
    return () => globalThis.removeEventListener("keydown", onKey);
  }, [viewerIdx, confirmHashes]);

  if (phase !== "ready") {
    return (
      <div class="p-8 text-center">
        {error && <p class="text-red-400 text-sm mb-3">{error.message}</p>}
        {waitingApproval && phase === "connecting" && (
          <p class="text-gray-400 text-sm mb-2">
            Waiting for nos2x approval… approve in the extension popup, or
            cancel and try again.
          </p>
        )}
        <div class="flex items-center justify-center gap-2">
          <button
            type="button"
            onClick={() => void connect()}
            disabled={phase === "connecting"}
            class="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium"
          >
            {phase === "connecting" ? "Connecting…" : "Connect with Nostr"}
          </button>
          {phase === "connecting" && (
            <button
              type="button"
              onClick={cancelConnect}
              class="px-3 py-2 rounded-lg border border-gray-700 text-gray-300 text-sm"
            >
              Cancel
            </button>
          )}
        </div>
        {error?.retryable && !waitingApproval && (
          <button
            type="button"
            onClick={() => void connect()}
            class="block mx-auto mt-3 text-gray-400 hover:text-gray-200 text-xs underline"
          >
            Retry
          </button>
        )}
        <p class="mt-6 text-gray-600 text-xs max-w-md mx-auto leading-relaxed">
          Blob URLs are public — anyone who knows a file's link can fetch it,
          and copies already cached or downloaded survive deletion. Don't
          upload anything sensitive unless it's encrypted first.
        </p>
      </div>
    );
  }

  const gridEmpty = descriptors.length === 0 && !loading && !error;
  // Filters/search/sort apply to loaded pages; server-side type filtering is
  // the ?type= param (upstream candidate for whole-library filtering).
  const visible = computeVisible();
  const viewer = viewerIdx !== null && viewerIdx < visible.length
    ? visible[viewerIdx]
    : null;
  const filterChips: Array<{ key: FilterKind; label: string }> = [
    { key: "all", label: "All" },
    { key: "image", label: "Images" },
    { key: "video", label: "Videos" },
    { key: "audio", label: "Audio" },
    { key: "other", label: "Other" },
  ];
  const sortOptions: Array<{ key: SortKey; label: string }> = [
    { key: "newest", label: "Newest first ↓" },
    { key: "oldest", label: "Oldest first ↑" },
    { key: "name", label: "Name A–Z" },
    { key: "size", label: "Size ↓" },
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
            onClick={() => selectMode ? exitSelectMode() : setSelectMode(true)}
            disabled={deleteProgress !== null}
            aria-pressed={selectMode ? "true" : "false"}
            class={`px-3 py-1.5 rounded-lg border text-xs font-medium disabled:opacity-50 ${
              selectMode
                ? "border-blue-500 text-blue-300 bg-blue-950/40"
                : "border-gray-700 hover:border-gray-500 text-gray-300"
            }`}
          >
            {selectMode ? "Cancel select" : "Select"}
          </button>
          <button
            type="button"
            onClick={refresh}
            disabled={loading || deleteProgress !== null}
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
        <input
          type="search"
          value={query}
          onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)}
          placeholder="Search by name or hash…"
          aria-label="Search loaded files by name or hash"
          class="flex-1 min-w-40 bg-gray-900 border border-gray-800 rounded-lg px-3 py-1.5 text-xs text-gray-200 placeholder:text-gray-600 focus:outline-none focus:border-blue-600"
        />
        {filterChips.map((chip) => (
          <button
            type="button"
            aria-pressed={filter === chip.key ? "true" : "false"}
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
        {/* Selection is driven by the options' `selected` prop — a controlled
        `value` on <select> breaks under linkedom-based test DOMs (getter-only
        select.value there); browsers sync the display from option.selected. */}
        <select
          onChange={(e) => setSortKey((e.currentTarget as HTMLSelectElement).value as SortKey)}
          aria-label="Sort loaded files"
          title="Sort applies to the files loaded so far — use Load more for the rest"
          class="px-2.5 py-1 rounded-full bg-gray-800 text-gray-400 hover:text-gray-200 text-xs border-none"
        >
          {sortOptions.map((o) => (
            <option key={o.key} value={o.key} selected={sortKey === o.key}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      {notice && (
        <div
          class={`mb-4 p-3 rounded-lg border text-sm flex items-center justify-between gap-3 ${
            notice.kind === "ok"
              ? "bg-green-950/50 border-green-900 text-green-300"
              : "bg-red-950/50 border-red-900 text-red-300"
          }`}
        >
          <span>{notice.text}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            aria-label="Dismiss message"
            class="text-gray-400 hover:text-gray-200 text-xs"
          >
            ✕
          </button>
        </div>
      )}

      {error && (
        <div class="mb-4 p-3 rounded-lg bg-red-950/50 border border-red-900 text-sm text-red-300 flex items-center justify-between gap-3">
          <span>{error.message}</span>
          {error.retryable && (
            <button
              type="button"
              onClick={() => {
                setError(null);
                // Cursor errors mean the dataset moved: replaying the same
                // request can never succeed — restart the traversal (C3).
                void loadPage(
                  error.retryReset ? true : descriptors.length === 0,
                );
              }}
              class="px-3 py-1 rounded bg-red-900/60 hover:bg-red-900 text-xs"
            >
              {error.retryReset ? "Refresh list" : "Retry"}
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
          {filter === "all" ? "" : filter + " "}files match — adjust the search,
          filter, or use Load more.
        </p>
      )}

      <div class={`grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 ${selectMode ? "pb-20" : ""}`}>
        {visible.map((d) => (
          <Card
            key={d.sha256}
            d={d}
            copiedKey={copiedKey}
            fallbackKey={fallbackKey}
            selectMode={selectMode}
            selected={selected.has(d.sha256)}
            onOpen={(el) => openViewer(d, el)}
            onCopy={(fmt) => void copyVariant(d, fmt)}
            onToggle={(on) => toggleSelected(d.sha256, on)}
            onDelete={() => confirmDelete([d.sha256])}
          />
        ))}
      </div>

      {!finished.current && !gridEmpty && (
        <div class="text-center mt-4">
          <button
            type="button"
            onClick={() => void loadPage(false)}
            disabled={loading || deleteProgress !== null}
            class="px-4 py-2 rounded-lg border border-gray-700 hover:border-gray-500 text-gray-300 text-sm disabled:opacity-50"
          >
            {loading ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
      {loading && descriptors.length === 0 && (
        <p class="text-center text-gray-500 text-sm mt-4">Loading files…</p>
      )}

      {selectMode && (
        <div class="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 bg-gray-900 border border-gray-700 rounded-xl px-4 py-2.5 shadow-2xl flex items-center gap-2 flex-wrap justify-center">
          <span class="text-xs text-gray-300 mr-1">
            {deleteProgress
              ? `Deleting ${deleteProgress.done}/${deleteProgress.total}… approve each prompt`
              : `${selected.size} selected`}
          </span>
          <button
            type="button"
            onClick={() => setSelected(new Set(visible.map((d) => d.sha256)))}
            disabled={deleteProgress !== null || visible.length === 0}
            class="px-3 py-1.5 rounded-lg border border-gray-700 hover:border-gray-500 text-gray-300 text-xs font-medium disabled:opacity-50"
          >
            Select all
          </button>
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            disabled={deleteProgress !== null || selected.size === 0}
            class="px-3 py-1.5 rounded-lg border border-gray-700 hover:border-gray-500 text-gray-300 text-xs font-medium disabled:opacity-50"
          >
            Clear
          </button>
          <button
            type="button"
            onClick={() =>
              copy(
                visible.filter((d) => selected.has(d.sha256)).map((d) => d.url)
                  .join("\n"),
              )}
            disabled={deleteProgress !== null || selected.size === 0}
            class="px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-200 text-xs font-medium disabled:opacity-50"
          >
            Copy URLs
          </button>
          <button
            type="button"
            onClick={() => confirmDelete(visible.filter((d) => selected.has(d.sha256)).map((d) => d.sha256))}
            disabled={deleteProgress !== null || selected.size === 0}
            class="px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-white text-xs font-medium disabled:opacity-50"
          >
            Delete
          </button>
        </div>
      )}

      {confirmHashes && (
        <div
          class="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Confirm delete"
        >
          <div class="bg-gray-900 rounded-xl border border-gray-800 max-w-md w-full p-6 text-center">
            <h3 class="text-base font-medium mb-2">
              {confirmHashes.length === 1
                ? "Delete this file?"
                : `Delete ${confirmHashes.length} files?`}
            </h3>
            <p class="text-xs text-gray-500 mb-1">
              {confirmHashes.length === 1
                ? "This removes your ownership of the blob — the file is purged only if no other owner remains."
                : "Each delete signs one nos2x prompt per file (server contract: one event per blob). The file is purged only if no other owner remains."}
            </p>
            <p class="text-xs text-gray-400 font-mono truncate mb-4">
              {confirmHashes.slice(0, 3).map(shortHash).join(", ")}
              {confirmHashes.length > 3
                ? ` +${confirmHashes.length - 3} more`
                : ""}
            </p>
            <div class="flex justify-center gap-2">
              <button
                type="button"
                autoFocus
                onClick={() => setConfirmHashes(null)}
                class="px-4 py-2 rounded-lg border border-gray-700 hover:border-gray-500 text-gray-300 text-xs font-medium"
              >
                Cancel (Esc)
              </button>
              <button
                type="button"
                onClick={() => void performDelete()}
                class="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-white text-xs font-medium"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {viewer && (
        <Viewer
          d={viewer}
          zoomed={zoomed}
          onZoomToggle={() => setZoomed((v) => !v)}
          position={{ index: viewerIdx ?? 0, total: visible.length }}
          hasPrev={(viewerIdx ?? 0) > 0}
          hasNext={(viewerIdx ?? 0) < visible.length - 1}
          onNav={(dir) => stepViewer(dir)}
          onDelete={() => confirmDelete([viewer.sha256])}
          onClose={closeViewer}
        />
      )}
    </div>
  );
}

function Card(
  { d, copiedKey, fallbackKey, selectMode, selected, onOpen, onCopy, onToggle, onDelete }: {
    d: BlobDescriptor;
    copiedKey: string | null;
    fallbackKey: string | null;
    selectMode: boolean;
    selected: boolean;
    onOpen: (el: HTMLElement) => void;
    onCopy: (fmt: CopyFormat) => void;
    onToggle: (on: boolean) => void;
    onDelete: () => void;
  },
) {
  const preview = previewKind(d);
  const category = categoryOf(d);
  const thumb = thumbUrl(d);
  const canInline = preview === "image" && d.size <= INLINE_ORIGINAL_MAX_BYTES;
  const candidate = thumb ?? (canInline ? d.url : null);
  // Every rendered media URL passes the same trust check (S4): thumbnails,
  // grid fallbacks and viewer originals are validated identically.
  const src = candidate && isTrustedUrl(candidate) ? candidate : null;
  const [imgFailed, setImgFailed] = useState(false);
  const name = displayNameFor(d);
  const formats: Array<{ fmt: CopyFormat; label: string }> = [
    { fmt: "url", label: "Copy link" },
    { fmt: "md", label: "MD" },
    { fmt: "html", label: "</>" },
  ];

  return (
    <div
      class={`bg-gray-900 rounded-xl border overflow-hidden flex flex-col relative ${
        selected ? "border-blue-500" : "border-gray-800"
      }`}
    >
      {/* Select-mode checkbox — top-left overlay */}
      {selectMode && (
        <input
          type="checkbox"
          checked={selected}
          onChange={(e) => onToggle((e.currentTarget as HTMLInputElement).checked)}
          aria-label={`Select ${name}`}
          class="absolute top-2 left-2 z-10 w-5 h-5 accent-blue-600 cursor-pointer"
        />
      )}
      {/* Single-file delete — top-right overlay, hidden in select mode */}
      {!selectMode && (
        <button
          type="button"
          onClick={onDelete}
          aria-label={`Delete ${name}`}
          title="Delete"
          class="absolute top-2 right-2 z-10 w-7 h-7 rounded-lg bg-gray-950/85 border border-gray-700 text-red-400 hover:text-red-300 hover:border-red-500 opacity-0 hover:opacity-100 focus:opacity-100 transition-opacity text-sm leading-none"
        >
          🗑
        </button>
      )}
      <button
        type="button"
        onClick={(e) => {
          // In select mode the thumbnail toggles selection instead of opening
          if (selectMode) {
            onToggle(!selected);
            return;
          }
          onOpen(e.currentTarget as HTMLElement);
        }}
        class="relative h-36 bg-gray-950 flex items-center justify-center cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-500"
        aria-label={`${selectMode ? "Toggle selection of" : "Open"} ${name}`}
        title={name}
      >
        {src && !imgFailed
          ? (
            <img
              src={src}
              alt={name}
              loading="lazy"
              onError={() => setImgFailed(true)}
              class="h-36 w-full object-cover"
            />
          )
          : (
            <span class="text-3xl" aria-hidden="true">
              {preview === "video"
                ? "🎞️"
                : preview === "audio"
                ? "🎧"
                : preview === "gif"
                ? "🖼️"
                : "📄"}
            </span>
          )}
        {preview === "video" && (
          <span
            class="absolute inset-0 flex items-center justify-center text-4xl drop-shadow"
            aria-hidden="true"
          >
            ▶️
          </span>
        )}
        {category === "image" && preview === "image" && src && imgFailed && (
          <span class="absolute text-[10px] text-gray-500">preview failed</span>
        )}
        {category === "image" && preview === "image" && !src && (
          <span class="absolute bottom-1 text-[10px] text-gray-500">
            click to load
          </span>
        )}
      </button>
      <div class="p-2.5 space-y-1.5">
        <p class="text-xs text-gray-300 font-mono truncate" title={name}>
          {name}
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
                  value={copyTextFor(
                    d,
                    fmt,
                    name,
                    category === "image" && preview !== "other",
                  )}
                  onFocus={(e) =>
                    (e.currentTarget as HTMLInputElement).select()}
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

function Viewer(
  { d, zoomed, onZoomToggle, position, hasPrev, hasNext, onNav, onDelete, onClose }: {
    d: BlobDescriptor;
    zoomed: boolean;
    onZoomToggle: () => void;
    position: { index: number; total: number };
    hasPrev: boolean;
    hasNext: boolean;
    onNav: (dir: number) => void;
    onDelete: () => void;
    onClose: () => void;
  },
) {
  const preview = previewKind(d);
  const trusted = isTrustedUrl(d.url);
  const zoomable = trusted && (preview === "image" || preview === "gif");
  return (
    <div
      class="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Viewing ${displayNameFor(d)}`}
    >
      {/* Prev/next arrows — overlay the backdrop edges */}
      {hasPrev && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onNav(-1);
          }}
          aria-label="Previous file (left arrow)"
          class="absolute left-3 top-1/2 -translate-y-1/2 z-10 w-11 h-11 rounded-full bg-gray-900/90 border border-gray-700 hover:border-gray-500 text-gray-200 text-xl"
        >
          ‹
        </button>
      )}
      {hasNext && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onNav(1);
          }}
          aria-label="Next file (right arrow)"
          class="absolute right-3 top-1/2 -translate-y-1/2 z-10 w-11 h-11 rounded-full bg-gray-900/90 border border-gray-700 hover:border-gray-500 text-gray-200 text-xl"
        >
          ›
        </button>
      )}
      <div
        class="bg-gray-900 rounded-xl border border-gray-800 max-w-3xl w-full max-h-[90vh] overflow-auto p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div class="flex items-center justify-between mb-3 gap-2">
          <p class="text-xs text-gray-300 font-mono truncate flex-1">
            {displayNameFor(d)}
            <span class="text-gray-600 ml-2">
              {position.index + 1}/{position.total}
            </span>
          </p>
          <button
            type="button"
            autoFocus
            onClick={onClose}
            class="px-3 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-200 text-xs"
          >
            Close (Esc)
          </button>
        </div>
        <div class="flex items-center justify-center bg-gray-950 rounded-lg mb-3 min-h-40 overflow-hidden">
          {!trusted
            ? <p class="text-gray-500 text-sm p-6">Untrusted file origin.</p>
            : preview === "image" || preview === "gif"
            ? (
              <img
                src={d.url}
                alt={displayNameFor(d)}
                class={`max-h-[60vh] transition-transform ${
                  zoomed ? "scale-[2.5] cursor-grab" : ""
                }`}
              />
            )
            : preview === "video"
            ? <video src={d.url} controls autoplay class="max-h-[60vh]" />
            : preview === "audio"
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
          <div class="flex gap-2 flex-wrap">
            {zoomable && (
              <button
                type="button"
                onClick={onZoomToggle}
                aria-pressed={zoomed ? "true" : "false"}
                class="px-3 py-1.5 rounded border border-gray-700 hover:border-gray-500 text-gray-300 text-xs font-medium"
              >
                {zoomed ? "Zoom out (Z)" : "Zoom in (Z)"}
              </button>
            )}
            <a
              href={trusted ? d.url : undefined}
              download={displayNameFor(d)}
              class="px-3 py-1.5 rounded border border-gray-700 hover:border-gray-500 text-gray-300 text-xs font-medium"
            >
              Download
            </a>
            <a
              href={trusted ? d.url : undefined}
              target="_blank"
              rel="noreferrer"
              class="px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium"
            >
              Open original ↗
            </a>
            <button
              type="button"
              onClick={onDelete}
              class="px-3 py-1.5 rounded bg-red-600 hover:bg-red-500 text-white text-xs font-medium"
            >
              Delete
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
