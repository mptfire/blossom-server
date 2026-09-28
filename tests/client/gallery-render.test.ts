/// <reference lib="deno.ns" />
/**
 * Component-render tests for the My Files gallery (senior-review follow-up):
 * renders the real component in a real (linkedom) DOM and exercises the
 * disconnected → connecting → connected lifecycle with a fake NIP-07 signer
 * and a fake list endpoint. No JSX in this file — elements are built via
 * createElement because the root config compiles TSX in precompile mode for
 * the server runtime, which is incompatible with the dom runtime's hooks.
 */

import { parseHTML } from "linkedom";

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

Deno.test("gallery render: error state shows message and Retry", async () => {
  const prevFetch = g.fetch;
  const prevLocation = g.location;
  g.location = { origin: "http://localhost:3000" };
  g.nostr = {
    signEvent: () => Promise.reject(new Error("User rejected")),
  };
  g.fetch = () => Promise.reject(new Error("network error"));

  try {
    const root = dom.document.getElementById("r");
    if (!root) throw new Error("missing root");
    render(createElement(FilesGallery, { listEnabled: true }), root);

    const connect = findButton("Connect with Nostr");
    if (!connect) throw new Error("Connect button missing");
    connect.dispatchEvent(new dom.Event("click", { bubbles: true }));

    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 25));
      if (text().includes("User rejected") || text().includes("Retry")) {
        break;
      }
    }

    const hasError = text().includes("User rejected");
    const hasRetry = findButton("Retry") !== null;
    if (!hasError) {
      throw new Error("error message not shown after signer rejection");
    }
    if (!hasRetry) {
      throw new Error("Retry button not shown after signer rejection");
    }
  } finally {
    delete g.nostr;
    g.fetch = prevFetch;
    g.location = prevLocation;
    dom.document.getElementById("r")!.innerHTML = "";
  }
});

Deno.test("gallery render: filter chips render with aria-pressed in connected state", async () => {
  // Chips live in the connected grid, so this drives the full connect flow.
  const prevLocation = g.location;
  const prevFetch = g.fetch;
  g.location = { origin: "http://localhost:3000" };
  g.nostr = {
    signEvent: (ev: { kind: number }) =>
      Promise.resolve({ ...ev, pubkey: PK, sig: "00", id: "00" }),
  };
  g.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify([fakeDescriptor(0)]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )) as typeof fetch;

  try {
    const root = dom.document.getElementById("r");
    if (!root) throw new Error("missing root");
    render(createElement(FilesGallery, { listEnabled: true }), root);

    const connect = findButton("Connect with Nostr");
    if (!connect) throw new Error("Connect button missing");
    connect.dispatchEvent(new dom.Event("click", { bubbles: true }));

    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 25));
      if (findButton("All")) break;
    }

    const chipLabels = ["All", "Images", "Videos", "Audio", "Other"];
    for (const label of chipLabels) {
      const chip = [...dom.document.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === label,
      );
      if (!chip) throw new Error(`chip "${label}" missing`);
      // All chips render (aria-pressed state tested at the unit level)
      if (typeof chip.getAttribute("aria-pressed") !== "string") {
        throw new Error(`chip "${label}" missing aria-pressed attribute`);
      }
    }
    const all = [...dom.document.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "All",
    );
    if (all?.getAttribute("aria-pressed") !== "true") {
      throw new Error('"All" chip not pressed by default');
    }
  } finally {
    delete g.nostr;
    g.location = prevLocation;
    g.fetch = prevFetch;
    dom.document.getElementById("r")!.innerHTML = "";
  }
});

/** Shared connect harness: 4 descriptors, controllable fetch. */
function setupConnected(
  fetchImpl: (input: unknown, init?: { method?: string }) => Promise<Response>,
): { prevFetch: unknown; prevLocation: unknown } {
  const prevFetch = g.fetch;
  const prevLocation = g.location;
  g.location = { origin: "http://localhost:3000" };
  g.nostr = {
    signEvent: (ev: { kind: number }) =>
      Promise.resolve({ ...ev, pubkey: PK, sig: "00", id: "00" }),
  };
  g.fetch = fetchImpl as typeof fetch;
  return { prevFetch, prevLocation };
}

function teardown(prev: { prevFetch: unknown; prevLocation: unknown }): void {
  delete g.nostr;
  g.location = prev.prevLocation;
  g.fetch = prev.prevFetch;
  dom.document.getElementById("r")!.innerHTML = "";
}

function listResponse(): Response {
  const descriptors = Array.from({ length: 4 }, (_, i) => fakeDescriptor(i));
  return new Response(JSON.stringify(descriptors), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function connectAndWaitGrid(): Promise<void> {
  const root = dom.document.getElementById("r");
  if (!root) throw new Error("missing root");
  render(createElement(FilesGallery, { listEnabled: true }), root);
  const connect = findButton("Connect with Nostr");
  if (!connect) throw new Error("Connect button missing");
  connect.dispatchEvent(new dom.Event("click", { bubbles: true }));
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 25));
    if (findButton("Disconnect")) break;
  }
  if (!findButton("Disconnect")) throw new Error("gallery did not connect");
}

/** hono's dom runtime schedules re-renders — assert after a poll, never
 * synchronously after a dispatched event. */
async function waitUntil(fn: () => boolean): Promise<void> {
  for (let i = 0; i < 40; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  if (!fn()) throw new Error("condition not met after polling");
}

Deno.test("gallery render: toolbar has search, sort select, and Select button", async () => {
  const prev = setupConnected(() => Promise.resolve(listResponse()));
  try {
    await connectAndWaitGrid();

    const search = dom.document.querySelector('input[type="search"]');
    if (!search) throw new Error("search box missing in connected toolbar");
    const sort = dom.document.querySelector("select");
    if (!sort) throw new Error("sort dropdown missing in connected toolbar");
    if (!findButton("Select")) throw new Error("Select button missing");
  } finally {
    teardown(prev);
  }
});

Deno.test("gallery render: search box filters loaded cards", async () => {
  const prev = setupConnected(() => Promise.resolve(listResponse()));
  try {
    await connectAndWaitGrid();

    const before = [...dom.document.querySelectorAll("button")].filter(
      (b) => (b.getAttribute("aria-label") ?? "").startsWith("Open "),
    ).length;
    if (before !== 4) throw new Error(`expected 4 cards, got ${before}`);

    const search = dom.document.querySelector(
      'input[type="search"]',
    ) as HTMLInputElement | null;
    if (!search) throw new Error("search box missing");
    // descriptor hash for i=1 is "0001aaa…", search by hash prefix
    search.value = "0001";
    search.dispatchEvent(new dom.Event("input", { bubbles: true }));

    await waitUntil(() =>
      [...dom.document.querySelectorAll("button")].filter(
        (b) => (b.getAttribute("aria-label") ?? "").startsWith("Open "),
      ).length === 1
    );
  } finally {
    teardown(prev);
  }
});

Deno.test("gallery render: select mode shows bulk bar and toggles cards", async () => {
  const prev = setupConnected(() => Promise.resolve(listResponse()));
  try {
    await connectAndWaitGrid();

    const selectBtn = findButton("Select");
    if (!selectBtn) throw new Error("Select button missing");
    selectBtn.dispatchEvent(new dom.Event("click", { bubbles: true }));

    await waitUntil(() => text().includes("0 selected"));

    // Click the first thumbnail → toggles selection in select mode
    const thumb = [...dom.document.querySelectorAll("button")].find(
      (b) =>
        (b.getAttribute("aria-label") ?? "").startsWith("Toggle selection of "),
    );
    if (!thumb) throw new Error("select-mode thumbnail missing");
    thumb.dispatchEvent(new dom.Event("click", { bubbles: true }));

    await waitUntil(() => text().includes("1 selected"));

    const cancel = findButton("Cancel select");
    if (!cancel) throw new Error("Cancel select missing");
    cancel.dispatchEvent(new dom.Event("click", { bubbles: true }));
    await waitUntil(() => !text().includes("selected"));
  } finally {
    teardown(prev);
  }
});

Deno.test("gallery render: delete flow signs and sends DELETE, card removed", async () => {
  const deleteCalls: string[] = [];
  const prev = setupConnected((input, init) => {
    if ((init?.method ?? "GET") === "DELETE") {
      deleteCalls.push(String(input));
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    return Promise.resolve(listResponse());
  });
  try {
    await connectAndWaitGrid();

    const before = [...dom.document.querySelectorAll("button")].filter(
      (b) => (b.getAttribute("aria-label") ?? "").startsWith("Open "),
    ).length;
    if (before !== 4) throw new Error(`expected 4 cards, got ${before}`);

    // Hover-revealed trash button — always in DOM, first card first
    const del = [...dom.document.querySelectorAll("button")].find(
      (b) => (b.getAttribute("aria-label") ?? "").startsWith("Delete "),
    );
    if (!del) throw new Error("card delete button missing");
    del.dispatchEvent(new dom.Event("click", { bubbles: true }));

    await waitUntil(() => text().includes("Delete this file?"));

    const confirm = [...dom.document.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Delete",
    );
    if (!confirm) throw new Error("confirm Delete button missing");
    confirm.dispatchEvent(new dom.Event("click", { bubbles: true }));

    await waitUntil(() => deleteCalls.length === 1);
    if (!/[0-9a-f]{64}/.test(deleteCalls[0])) {
      throw new Error(`DELETE target is not a blob hash: ${deleteCalls[0]}`);
    }

    await waitUntil(() =>
      [...dom.document.querySelectorAll("button")].filter(
        (b) => (b.getAttribute("aria-label") ?? "").startsWith("Open "),
      ).length === 3
    );
    if (!text().includes("Deleted 1 file")) {
      throw new Error("success notice missing after delete");
    }
  } finally {
    teardown(prev);
  }
});
