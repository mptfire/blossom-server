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
 * Build a BUD-11 list authorization — a kind 24242 event with t="list" and a
 * short-lived expiration. Separate operation authorization from upload: a
 * list token never authorizes uploads and vice versa.
 * Returns the Authorization header value, the signer's pubkey, and the
 * expiration (unix seconds) so the caller can re-sign before expiry.
 */
export async function signListAuth(
  nostr: NostrProvider,
): Promise<{ header: string; pubkey: string; expiresAt: number }> {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + 300;
  const event = (await nostr.signEvent({
    kind: 24242,
    content: "list my files",
    created_at: now,
    tags: [["t", "list"], ["expiration", String(expiresAt)]],
  })) as { pubkey?: string; sig?: string };
  return {
    header: "Nostr " + btoa(JSON.stringify(event)),
    pubkey: event.pubkey ?? "",
    expiresAt,
  };
}
