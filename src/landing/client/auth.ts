import type { FileStatus, NostrProvider, UploadFile } from "./types.ts";
import { sha256Hex } from "./helpers.ts";

export const MAX_X_TAGS_PER_EVENT = 60;

export function getNostrProvider(): NostrProvider | undefined {
  return globalThis.nostr;
}

/**
 * Hash all files in the batch sequentially, reporting status as each starts.
 * Returns a map of upload-file id → hex sha256.
 */
export async function hashBatch(
  files: UploadFile[],
  onFileStatus: (id: string, status: FileStatus) => void,
): Promise<Map<string, string>> {
  const results = new Map<string, string>();
  for (const uf of files) {
    onFileStatus(uf.id, "hashing");
    const hash = await sha256Hex(uf.file);
    results.set(uf.id, hash);
  }
  return results;
}

/** Build a BUD-11 kind 24242 auth event covering a batch of hashes. */
export async function signBatch(
  nostr: NostrProvider,
  hashes: string[],
  authVerb: string,
  content: string,
): Promise<string> {
  const expiration = Math.floor(Date.now() / 1000) + 300;
  const authEvent = await nostr.signEvent({
    kind: 24242,
    content,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["t", authVerb], ...hashes.map((h) => ["x", h]), [
      "expiration",
      String(expiration),
    ]],
  });
  return "Nostr " + btoa(JSON.stringify(authEvent));
}

/**
 * Build a BUD-02 delete authorization — a kind 24242 event with t="delete"
 * carrying the target blob's x tag, a server scope, and a short-lived
 * expiration. The server rejects multi-delete semantics: one event covers
 * exactly one blob, so a bulk delete signs once per blob (sequential nos2x
 * prompts with progress shown in the gallery).
 * Returns the Authorization header value and the signer's pubkey.
 */
export async function signDeleteAuth(
  nostr: NostrProvider,
  sha256: string,
  serverOrigin: string,
): Promise<{ header: string; pubkey: string }> {
  const now = Math.floor(Date.now() / 1000);
  const event = (await nostr.signEvent({
    kind: 24242,
    content: `delete blob ${sha256.slice(0, 12)}`,
    created_at: now,
    tags: [
      ["t", "delete"],
      ["x", sha256],
      ["server", serverOrigin],
      ["expiration", String(now + 300)],
    ],
  })) as { pubkey?: string };
  return {
    header: "Nostr " + btoa(JSON.stringify(event)),
    pubkey: event.pubkey ?? "",
  };
}

/**
 * Build a BUD-11 list authorization — a kind 24242 event with t="list",
 * a server scope, and a short-lived expiration. Separate operation
 * authorization from upload: a list token never authorizes uploads and vice
 * versa. The server tag scopes the token to this deployment so a leaked token
 * cannot be replayed against another accepting Blossom server (senior review
 * 2026-09-18, item S5).
 * Returns the Authorization header value, the signer's pubkey, and the
 * expiration (unix seconds) so the caller can re-sign before expiry.
 */
export async function signListAuth(
  nostr: NostrProvider,
  serverOrigin: string,
): Promise<{ header: string; pubkey: string; expiresAt: number }> {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + 300;
  const event = (await nostr.signEvent({
    kind: 24242,
    content: "list my files",
    created_at: now,
    tags: [
      ["t", "list"],
      ["server", serverOrigin],
      ["expiration", String(expiresAt)],
    ],
  })) as { pubkey?: string; sig?: string };
  return {
    header: "Nostr " + btoa(JSON.stringify(event)),
    pubkey: event.pubkey ?? "",
    expiresAt,
  };
}
