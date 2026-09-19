/// <reference lib="deno.ns" />
/**
 * Component-render tests for the My Files gallery (senior-review follow-up):
 * renders the real component in a real (linkedom) DOM and exercises the
 * disconnected → connecting → connected lifecycle with a fake NIP-07 signer
 * and a fake list endpoint. No JSX in this file — elements are built via
 * createElement because the root config compiles TSX in precompile mode for
 * the server runtime, which is incompatible with the dom runtime's hooks.
 */

import { parseHTML } from "npm:linkedom";

const dom = parseHTML("<html><body><div id='r'></div></body></html>");
const g = globalThis as Record<string, unknown>;
g.document = dom.document;
// hono's dom runtime schedules renders via rAF — Deno tests have none.
if (typeof globalThis.requestAnimationFrame !== "function") {
  (globalThis as Record<string, unknown>).requestAnimationFrame = (
    cb: FrameRequestCallback,
  ) => setTimeout(() => cb(Date.now()), 0) as unknown as number;
}

const domRuntime = await import("@hono/hono/jsx/dom");
const render = domRuntime.render as unknown as (
  node: unknown,
  root: Element,
) => void;
const createElement = domRuntime.createElement as unknown as (
  type: unknown,
  props: Record<string, unknown> | null,
  ...children: unknown[]
) => unknown;
const galleryModule = await import("../../src/landing/client/FilesGallery.tsx");
const FilesGallery = galleryModule.FilesGallery as unknown;

const PK = "aa".repeat(32); // fake signer pubkey (64 hex)

function fakeDescriptor(i: number) {
  const hash = (String(i).padStart(4, "0") + "a".repeat(60)).slice(0, 64);
  return {
    sha256: hash,
    size: 1000 + i,
    type: "image/png",
    url: `http://localhost:3000/${hash}.png`,
    uploaded: 1700000000 + i,
  };
}

function text(): string {
  return dom.document.body?.textContent ?? "";
}

function findButton(label: string): Element | null {
  return [...dom.document.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes(label)
  ) ?? null;
}

Deno.test("gallery render: disconnected state offers Connect", () => {
  const root = dom.document.getElementById("r");
  if (!root) throw new Error("missing root");
  render(createElement(FilesGallery, { listEnabled: true }), root);
  if (!findButton("Connect with Nostr")) {
    throw new Error("Connect button missing in disconnected state");
  }
});

Deno.test("gallery render: list-disabled state explains itself", () => {
  const root = dom.document.getElementById("r");
  if (!root) throw new Error("missing root");
  render(createElement(FilesGallery, { listEnabled: false }), root);
  if (!text().includes("The file list is disabled")) {
    throw new Error("disabled message missing");
  }
});

Deno.test("gallery render: connect → signed fetch → connected grid", async () => {
  // signer + location + fetch stubs for the full connect flow
  const calls: string[] = [];
  g.nostr = {
    signEvent: (ev: { kind: number }) =>
      Promise.resolve({ ...ev, pubkey: PK, sig: "00", id: "00" }),
  };
  const prevLocation = g.location;
  g.location = { origin: "http://localhost:3000" };
  const prevFetch = g.fetch;
  g.fetch = ((input: unknown) => {
    calls.push(String(input));
    const descriptors = Array.from({ length: 24 }, (_, i) => fakeDescriptor(i));
    return Promise.resolve(
      new Response(JSON.stringify(descriptors), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;

  try {
    const root = dom.document.getElementById("r");
    if (!root) throw new Error("missing root");
    render(createElement(FilesGallery, { listEnabled: true }), root);

    const connect = findButton("Connect with Nostr");
    if (!connect) throw new Error("Connect button missing");
    connect.dispatchEvent(new dom.Event("click", { bubbles: true }));

    // signer → token → fetch → commit → re-render
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 25));
      if (text().includes("Load more") || text().includes("aaaa")) break;
    }

    const openCards = [...dom.document.querySelectorAll("button")].filter(
      (b) => (b.getAttribute("aria-label") ?? "").startsWith("Open "),
    ).length;
    const chipShown = text().includes(PK.slice(0, 8));

    if (calls.length < 1 || !calls[0].includes(`/list/${PK}`)) {
      throw new Error(`list request missing or wrong target: ${calls[0]}`);
    }
    if (openCards !== 24) {
      throw new Error(`expected 24 cards, rendered ${openCards}`);
    }
    if (!chipShown) throw new Error("connected pubkey chip missing");
  } finally {
    delete g.nostr;
    g.location = prevLocation;
    g.fetch = prevFetch;
  }
});
