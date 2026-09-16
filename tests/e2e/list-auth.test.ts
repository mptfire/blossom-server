/**
 * E2E tests for GET /list/:pubkey in SECURED mode (list.requireAuth = true,
 * allowListOthers = false) — the configuration intended for closed servers.
 *
 * Covers the senior-review checklist (2026-09-15):
 *   - unsigned → 401, A→A → 200, A→B → 403
 *   - upload-token reused for list → 403 (operation separation)
 *   - expired token → 401, forged signature → 400, wrong server scope → 401
 *   - unknown/foreign cursor → 400 (never silently restarts the list)
 *   - limit 1..1000 route validation
 *   - Cache-Control: private, no-store on success AND error responses
 *   - pagination via cursor yields every owned hash exactly once, no others
 *
 * sanitizeOps/sanitizeResources disabled: shared worker pool outlives tests.
 */

import type { Hono } from "@hono/hono";
import { assertEquals } from "@std/assert";
import { encodeBase64Url } from "@std/encoding/base64url";
import { join } from "@std/path";
import type { NostrEvent } from "nostr-tools";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure";
import { ConfigSchema } from "../../src/config/schema.ts";
import { initDb } from "../../src/db/client.ts";
import type { BlossomVariables } from "../../src/middleware/auth.ts";
import { buildApp } from "../../src/server.ts";
import { LocalStorage } from "../../src/storage/local.ts";
import { initPool } from "../../src/workers/pool.ts";

// ---------------------------------------------------------------------------
// Keys: A = gallery owner, B = other user
// ---------------------------------------------------------------------------

const skA = generateSecretKey();
const pkA = getPublicKey(skA);
const skB = generateSecretKey();
const pkB = getPublicKey(skB);

interface AuthOpts {
  tTag?: string;
  expiration?: number;
  server?: string;
  /** Sign with B but claim A's pubkey (forged event). */
  forgedPubkey?: string;
}

function makeAuth(sk: Uint8Array, opts: AuthOpts = {}): NostrEvent {
  const now = Math.floor(Date.now() / 1000);
  const tags: string[][] = [
    ["t", opts.tTag ?? "list"],
    ["expiration", String(opts.expiration ?? now + 600)],
  ];
  if (opts.server) tags.push(["server", opts.server]);
  const event = finalizeEvent(
    {
      kind: 24242,
      created_at: now,
      tags,
      content: "list auth",
    },
    sk,
  );
  if (opts.forgedPubkey) {
    return { ...event, pubkey: opts.forgedPubkey } as NostrEvent;
  }
  return event;
}

function encodeAuth(event: NostrEvent): string {
  return `Nostr ${
    encodeBase64Url(new TextEncoder().encode(JSON.stringify(event)))
  }`;
}

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let app: Hono<{ Variables: BlossomVariables }>;
let cleanup: () => Promise<void>;
const aHashes: string[] = [];
const bHashes: string[] = [];

const testOpts = { sanitizeOps: false, sanitizeResources: false } as const;

// ---------------------------------------------------------------------------
// Setup: secured list config; A owns 5 blobs, B owns 2
// ---------------------------------------------------------------------------

Deno.test({
  name: "list-auth e2e setup: seed blobs for A and B",
  async fn() {
    const tmpDir = await Deno.makeTempDir({ prefix: "blossom_e2e_listauth_" });
    const dbPath = join(tmpDir, "test.db");
    const storageDir = join(tmpDir, "blobs");
    const dbConfig = { path: dbPath };

    const db = await initDb(dbConfig);
    const storage = new LocalStorage(storageDir);
    await storage.setup();

    const pool = initPool(1, 4, 500, db, dbConfig);

    // Secured list: auth required, own-pubkey only. Upload auth REQUIRED —
    // with requireAuth:false the route treats uploads as anonymous (no owner
    // recorded even when an Authorization header is present), so seeded blobs
    // would be unowned and invisible to the list.
    const config = ConfigSchema.parse({
      publicDomain: "localhost",
      upload: { requireAuth: true, enabled: true },
      list: { enabled: true, requireAuth: true, allowListOthers: false },
    });

    app = await buildApp(db, storage, config);

    async function seed(
      sk: Uint8Array,
      label: string,
      into: string[],
    ): Promise<void> {
      const pk = getPublicKey(sk);
      for (let i = 0; i < (sk === skA ? 5 : 2); i++) {
        const body = new TextEncoder().encode(`${label} blob ${i}`);
        const auth = makeAuth(sk, { tTag: "upload" });
        const res = await app.fetch(
          new Request("http://localhost/upload", {
            method: "PUT",
            headers: {
              "Content-Length": String(body.byteLength),
              "Content-Type": "text/plain",
              Authorization: encodeAuth(auth),
            },
            body,
          }),
        );
        assertEquals(res.status, 201, `seed ${label} ${i} should succeed`);
        const descriptor = await res.json();
        into.push(descriptor.sha256);
        assertEquals(
          descriptor.sha256.length,
          64,
          "descriptor should carry sha256",
        );
        assertEquals(pk.length, 64);
      }
    }

    await seed(skA, "A-owned", aHashes);
    await seed(skB, "B-owned", bHashes);

    cleanup = async () => {
      pool.shutdown();
      db.close();
      await Deno.remove(tmpDir, { recursive: true });
    };
  },
  ...testOpts,
});

// ---------------------------------------------------------------------------
// Authorization matrix
// ---------------------------------------------------------------------------

Deno.test({
  name: "list-auth: unsigned request → 401",
  async fn() {
    const res = await app.fetch(new Request(`http://localhost/list/${pkA}`));
    assertEquals(res.status, 401);
    assertEquals(
      res.headers.get("Cache-Control"),
      "private, no-store",
      "error responses must not be cacheable",
    );
    await res.body?.cancel();
  },
  ...testOpts,
});

Deno.test({
  name: "list-auth: A listing A → 200 with only A's blobs",
  async fn() {
    const res = await app.fetch(
      new Request(`http://localhost/list/${pkA}`, {
        headers: { Authorization: encodeAuth(makeAuth(skA)) },
      }),
    );
    assertEquals(res.status, 200);
    assertEquals(
      res.headers.get("Cache-Control"),
      "private, no-store",
      "authenticated list responses must not be cacheable",
    );
    const descriptors = await res.json();
    const hashes = descriptors.map((d: { sha256: string }) => d.sha256);
    assertEquals(hashes.length, 5);
    for (const h of aHashes) assertEquals(hashes.includes(h), true);
    for (const h of bHashes) assertEquals(hashes.includes(h), false);
  },
  ...testOpts,
});

Deno.test({
  name: "list-auth: A listing B → 403 (allowListOthers=false)",
  async fn() {
    const res = await app.fetch(
      new Request(`http://localhost/list/${pkB}`, {
        headers: { Authorization: encodeAuth(makeAuth(skA)) },
      }),
    );
    assertEquals(res.status, 403);
    assertEquals(res.headers.get("Cache-Control"), "private, no-store");
    await res.body?.cancel();
  },
  ...testOpts,
});

Deno.test({
  name: "list-auth: upload-token reused for list → 403 (operation separation)",
  async fn() {
    const res = await app.fetch(
      new Request(`http://localhost/list/${pkA}`, {
        headers: {
          Authorization: encodeAuth(makeAuth(skA, { tTag: "upload" })),
        },
      }),
    );
    assertEquals(res.status, 403);
    await res.body?.cancel();
  },
  ...testOpts,
});

Deno.test({
  name: "list-auth: expired token → 401",
  async fn() {
    const res = await app.fetch(
      new Request(`http://localhost/list/${pkA}`, {
        headers: {
          Authorization: encodeAuth(
            makeAuth(skA, { expiration: Math.floor(Date.now() / 1000) - 10 }),
          ),
        },
      }),
    );
    assertEquals(res.status, 401);
    assertEquals(res.headers.get("Cache-Control"), "private, no-store");
    await res.body?.cancel();
  },
  ...testOpts,
});

Deno.test({
  name: "list-auth: forged signature (B-signed event claiming A) → 400",
  async fn() {
    const res = await app.fetch(
      new Request(`http://localhost/list/${pkA}`, {
        headers: {
          Authorization: encodeAuth(
            makeAuth(skB, { forgedPubkey: pkA }),
          ),
        },
      }),
    );
    assertEquals(res.status, 400);
    await res.body?.cancel();
  },
  ...testOpts,
});

Deno.test({
  name: "list-auth: wrong server scope → 401",
  async fn() {
    const res = await app.fetch(
      new Request(`http://localhost/list/${pkA}`, {
        headers: {
          Authorization: encodeAuth(
            makeAuth(skA, { server: "https://evil.example" }),
          ),
        },
      }),
    );
    assertEquals(res.status, 401);
    await res.body?.cancel();
  },
  ...testOpts,
});

// ---------------------------------------------------------------------------
// Cursor + limit validation
// ---------------------------------------------------------------------------

Deno.test({
  name: "list-auth: unknown cursor → 400 (never restarts list)",
  async fn() {
    const fake = "e".repeat(64);
    const res = await app.fetch(
      new Request(`http://localhost/list/${pkA}?cursor=${fake}`, {
        headers: { Authorization: encodeAuth(makeAuth(skA)) },
      }),
    );
    assertEquals(res.status, 400);
    const reason = res.headers.get("X-Reason") ?? "";
    assertEquals(reason.toLowerCase().includes("cursor"), true);
    await res.body?.cancel();
  },
  ...testOpts,
});

Deno.test({
  name: "list-auth: another user's blob as cursor → 400 (scoped lookup)",
  async fn() {
    const res = await app.fetch(
      new Request(`http://localhost/list/${pkA}?cursor=${bHashes[0]}`, {
        headers: { Authorization: encodeAuth(makeAuth(skA)) },
      }),
    );
    assertEquals(res.status, 400);
    await res.body?.cancel();
  },
  ...testOpts,
});

Deno.test({
  name: "list-auth: limit > 1000 → 400",
  async fn() {
    const res = await app.fetch(
      new Request(`http://localhost/list/${pkA}?limit=1001`, {
        headers: { Authorization: encodeAuth(makeAuth(skA)) },
      }),
    );
    assertEquals(res.status, 400);
    const reason = res.headers.get("X-Reason") ?? "";
    assertEquals(reason.toLowerCase().includes("limit"), true);
    await res.body?.cancel();
  },
  ...testOpts,
});

// ---------------------------------------------------------------------------
// Pagination: cursor pages cover every A hash exactly once, none of B's
// ---------------------------------------------------------------------------

Deno.test({
  name: "list-auth: pagination collects all owned hashes exactly once",
  async fn() {
    const collected: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const url = new URL(`http://localhost/list/${pkA}`);
      url.searchParams.set("limit", "2");
      if (cursor) url.searchParams.set("cursor", cursor);
      const res = await app.fetch(
        new Request(url, {
          headers: { Authorization: encodeAuth(makeAuth(skA)) },
        }),
      );
      assertEquals(res.status, 200);
      const descriptors = await res.json();
      for (const d of descriptors) collected.push(d.sha256);
      cursor = descriptors.length
        ? descriptors[descriptors.length - 1].sha256
        : undefined;
      pages++;
      assertEquals(pages < 20, true, "pagination must terminate");
    } while (collected.length < aHashes.length && cursor);
    assertEquals(collected.length, aHashes.length);
    assertEquals(new Set(collected).size, aHashes.length, "no duplicates");
    for (const h of bHashes) assertEquals(collected.includes(h), false);
  },
  ...testOpts,
});

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

Deno.test({
  name: "list-auth e2e teardown: shutdown shared server",
  async fn() {
    await cleanup();
  },
  ...testOpts,
});
