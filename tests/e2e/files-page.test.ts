/**
 * E2E: full-page file manager route (GET /files).
 *
 * The page is served by the landing router when landing.enabled — it must be
 * claimed before the blob catch-all ("files" can never collide with a 64-hex
 * hash, but the mount order matters for every other path shape). The page is
 * a pure SSR shell: the gallery itself hydrates client-side, so the tests
 * assert the shell contract the client bundle depends on:
 *   - #files-root present with data-list-enabled mirroring config.list.enabled
 *   - /client.js script tag present
 *   - landing disabled → /files falls through (404 from the blob router)
 */

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { ConfigSchema } from "../../src/config/schema.ts";
import { initDb } from "../../src/db/client.ts";
import { buildApp } from "../../src/server.ts";
import { LocalStorage } from "../../src/storage/local.ts";

Deno.test("GET /files renders the file manager shell", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "blossom_e2e_files_" });
  const db = await initDb({ path: join(tmpDir, "test.db") });
  const storage = new LocalStorage(tmpDir);
  const config = ConfigSchema.parse({
    publicDomain: "localhost",
    list: { enabled: true, requireAuth: true, allowListOthers: false },
  });
  const app = await buildApp(db, storage, config);

  const res = await app.fetch(new Request("http://localhost/files"));
  assertEquals(res.status, 200);

  const html = await res.text();
  if (!html.includes('id="files-root"')) {
    throw new Error("files-root mount point missing");
  }
  if (!html.includes('data-list-enabled="true"')) {
    throw new Error("data-list-enabled must mirror config.list.enabled");
  }
  if (!html.includes('src="/client.js"')) {
    throw new Error("client bundle script tag missing");
  }
  if (!html.includes("My Files")) {
    throw new Error("page header missing");
  }
  await db.close();
  await Deno.remove(tmpDir, { recursive: true });
});

Deno.test("GET /files reflects list.enabled=false to the client", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "blossom_e2e_files_" });
  const db = await initDb({ path: join(tmpDir, "test.db") });
  const storage = new LocalStorage(tmpDir);
  const config = ConfigSchema.parse({
    publicDomain: "localhost",
    list: { enabled: false },
  });
  const app = await buildApp(db, storage, config);

  const res = await app.fetch(new Request("http://localhost/files"));
  assertEquals(res.status, 200);
  const html = await res.text();
  if (!html.includes('data-list-enabled="false"')) {
    throw new Error("data-list-enabled must mirror config.list.enabled");
  }
  await db.close();
  await Deno.remove(tmpDir, { recursive: true });
});

Deno.test("GET /files falls through when landing is disabled", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "blossom_e2e_files_" });
  const db = await initDb({ path: join(tmpDir, "test.db") });
  const storage = new LocalStorage(tmpDir);
  const config = ConfigSchema.parse({
    publicDomain: "localhost",
    landing: { enabled: false },
    list: { enabled: true, requireAuth: true, allowListOthers: false },
  });
  const app = await buildApp(db, storage, config);

  const res = await app.fetch(
    new Request("http://localhost/files", { method: "GET" }),
  );
  // No landing router → the blob catch-all rejects the non-hash path
  assertEquals(res.status, 404);
  await db.close();
  await Deno.remove(tmpDir, { recursive: true });
});

Deno.test("GET / still works alongside /files", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "blossom_e2e_files_" });
  const db = await initDb({ path: join(tmpDir, "test.db") });
  const storage = new LocalStorage(tmpDir);
  const config = ConfigSchema.parse({
    publicDomain: "localhost",
    list: { enabled: true, requireAuth: true, allowListOthers: false },
  });
  const app = await buildApp(db, storage, config);

  const res = await app.fetch(new Request("http://localhost/"));
  assertEquals(res.status, 200);
  const html = await res.text();
  if (!html.includes('id="upload-root"')) {
    throw new Error("landing page lost its upload island");
  }
  // The My Files link is client-rendered from the tab bar, but the SSR shell
  // must still carry the island that hosts it.
  await db.close();
  await Deno.remove(tmpDir, { recursive: true });
});
