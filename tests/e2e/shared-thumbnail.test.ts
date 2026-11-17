/**
 * E2E: shared-thumbnail deletion semantics (r8b review F1).
 *
 * Thumbnails are shared derivatives: two different parent blobs can reference
 * the SAME thumbnail blob (distinct originals can render byte-identical
 * derivatives). Deleting one parent must keep the thumbnail alive while
 * another parent references it; the thumbnail is purged only with its last
 * reference. The old code wiped the thumbnail blob + file outright when the
 * first parent died, leaving the surviving parent with a dangling derivative.
 *
 * The blobs are seeded directly through the storage layer — the delete-route
 * behavior under test is independent of how they were created (the media
 * pipeline's own processing is covered separately).
 */

import { assertEquals } from "@std/assert";
import { encodeHex } from "@std/encoding/hex";
import { encodeBase64Url } from "@std/encoding/base64url";
import { join } from "@std/path";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure";
import { ConfigSchema } from "../../src/config/schema.ts";
import { initDb } from "../../src/db/client.ts";
import {
  countMediaThumbnailParents,
  countOwners,
  insertBlob,
  insertMediaThumbnail,
} from "../../src/db/blobs.ts";
import { buildApp } from "../../src/server.ts";
import { initPool } from "../../src/workers/pool.ts";
import { LocalStorage } from "../../src/storage/local.ts";

const skA = generateSecretKey();
const pkA = getPublicKey(skA);
const skB = generateSecretKey();
const pkB = getPublicKey(skB);

async function sha256Hex(data: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", data.buffer as ArrayBuffer);
  return encodeHex(new Uint8Array(buf));
}

function encodeAuth(event: unknown): string {
  return `Nostr ${
    encodeBase64Url(new TextEncoder().encode(JSON.stringify(event)))
  }`;
}

/** Two slightly different "PNG" parent payloads (distinct hashes). */
const PNG_PARENT1 = new Uint8Array([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  0x01,
  0x02,
  0x03,
  0x04,
]);
const PNG_PARENT2 = new Uint8Array([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  0x05,
  0x06,
  0x07,
  0x08,
]);

Deno.test({
  name:
    "DELETE: shared thumbnail survives one parent's delete, purges with the last",
  async fn() {
    const tmpDir = await Deno.makeTempDir({
      prefix: "blossom_e2e_sharedthumb_",
    });
    const dbConfig = { path: join(tmpDir, "sharedthumb.db") };
    const db = await initDb(dbConfig);
    const storage = new LocalStorage(join(tmpDir, "blobs"));
    await storage.setup();
    const config = ConfigSchema.parse({
      publicDomain: "localhost",
      delete: { requireAuth: true },
    });
    const pool = initPool(1, 4, 500, db, dbConfig);
    const app = await buildApp(db, storage, config);

    async function seedBlob(
      sk: Uint8Array,
      body: Uint8Array,
      type: string,
    ): Promise<string> {
      const hash = await sha256Hex(body);
      const now = Math.floor(Date.now() / 1000);
      const ev = finalizeEvent(
        {
          kind: 24242,
          created_at: now,
          tags: [
            ["t", "upload"],
            ["expiration", String(now + 600)],
            ["x", hash],
          ],
          content: "seed",
        },
        sk,
      );
      const session = await storage.beginWrite(body.byteLength);
      const writer = session.writable.getWriter();
      await writer.write(body);
      await writer.close();
      await session.done;
      await storage.commitWrite(session, hash, "");
      const res = await app.fetch(
        new Request("http://localhost/upload", {
          method: "PUT",
          headers: {
            "Content-Length": String(body.byteLength),
            "Content-Type": type,
            Authorization: encodeAuth(ev),
          },
          body: body.slice(),
        }),
      );
      if (![200, 201].includes(res.status)) {
        throw new Error(
          `seed upload failed: ${res.status} ${await res.text()} — x-auth: ${
            encodeAuth(ev).slice(0, 40)
          }`,
        );
      }
      await res.body?.cancel();
      return hash;
    }

    // Two distinct parent blobs (A and B) + one shared thumbnail blob.
    // The thumbnail has no owner rows — exactly the state the media route's
    // derivative path produces (blob row + parent link, no owner).
    const parent1 = await seedBlob(skA, PNG_PARENT1, "image/png");
    const parent2 = await seedBlob(skB, PNG_PARENT2, "image/png");
    const thumbBody = new TextEncoder().encode("shared-thumbnail-bytes");
    const thumbSha = await sha256Hex(thumbBody);
    {
      const session = await storage.beginWrite(thumbBody.byteLength);
      const writer = session.writable.getWriter();
      await writer.write(thumbBody);
      await writer.close();
      await session.done;
      await storage.commitWrite(session, thumbSha, "webp");
      await insertBlob(db, {
        sha256: thumbSha,
        size: thumbBody.byteLength,
        type: "image/webp",
        uploaded: Math.floor(Date.now() / 1000),
        nip94: null,
      }, pkA);
    }
    await insertMediaThumbnail(db, parent1, thumbSha);
    await insertMediaThumbnail(db, parent2, thumbSha);
    assertEquals(
      await countMediaThumbnailParents(db, thumbSha),
      2,
      "two parents reference the shared thumbnail",
    );

    // A deletes parent 1 — the shared thumbnail must SURVIVE (parent 2 still
    // references it). The old code purged it outright.
    const now = Math.floor(Date.now() / 1000);
    const del1ev = finalizeEvent(
      {
        kind: 24242,
        created_at: now,
        tags: [
          ["t", "delete"],
          ["expiration", String(now + 600)],
          ["x", parent1],
        ],
        content: "delete",
      },
      skA,
    );
    const del1 = await app.fetch(
      new Request(`http://localhost/${parent1}`, {
        method: "DELETE",
        headers: { Authorization: encodeAuth(del1ev) },
      }),
    );
    assertEquals(del1.status, 204, "owner delete of parent 1");
    await del1.body?.cancel();

    const parent1Gone = await app.fetch(
      new Request(`http://localhost/${parent1}`),
    );
    assertEquals(parent1Gone.status, 404, "parent 1 purged");
    await parent1Gone.body?.cancel();

    const thumbAfter1 = await app.fetch(
      new Request(`http://localhost/${thumbSha}`),
    );
    assertEquals(
      thumbAfter1.status,
      200,
      "shared thumbnail survives the first parent's delete",
    );
    await thumbAfter1.body?.cancel();
    assertEquals(
      await countMediaThumbnailParents(db, thumbSha),
      1,
      "parent 2 still references the thumbnail",
    );

    // B deletes parent 2 — last reference: parent AND thumbnail purge.
    const del2ev = finalizeEvent(
      {
        kind: 24242,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ["t", "delete"],
          ["expiration", String(Math.floor(Date.now() / 1000) + 600)],
          ["x", parent2],
        ],
        content: "delete",
      },
      skB,
    );
    const del2 = await app.fetch(
      new Request(`http://localhost/${parent2}`, {
        method: "DELETE",
        headers: { Authorization: encodeAuth(del2ev) },
      }),
    );
    assertEquals(del2.status, 204, "owner delete of parent 2");
    await del2.body?.cancel();

    const thumbAfter2 = await app.fetch(
      new Request(`http://localhost/${thumbSha}`),
    );
    assertEquals(
      thumbAfter2.status,
      404,
      "thumbnail purged once the last parent is gone",
    );
    await thumbAfter2.body?.cancel();

    assertEquals(
      await countMediaThumbnailParents(db, thumbSha),
      0,
      "no dangling parent links",
    );
    assertEquals(
      await countOwners(db, thumbSha),
      0,
      "no orphan thumbnail ownership rows",
    );

    pool.shutdown();
    await db.close();
    await Deno.remove(tmpDir, { recursive: true });
  },
});
