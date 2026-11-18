/// <reference lib="deno.ns" />
// Real gallery rendering; only NIP-07, HTTP and browser focus/storage boundaries
// are controlled. Server JSX tests cannot execute these DOM hooks.
import { parseHTML } from "linkedom";
const dom = parseHTML("<html><body><div id='review'></div></body></html>");
const g = globalThis as unknown as Record<string, unknown>;
g.document = dom.document;
g.location = { origin: "http://localhost:3000" };
g.requestAnimationFrame = (cb: FrameRequestCallback) =>
  setTimeout(() => cb(Date.now()), 0);
const stored = new Map<string, string>();
g.sessionStorage = {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => stored.set(key, value),
  removeItem: (key: string) => stored.delete(key),
};
let focused: Element | null = null;
Object.defineProperty(dom.document, "activeElement", {
  configurable: true,
  get: () => focused,
});
dom.HTMLElement.prototype.focus = function () {
  focused = this;
};
const runtime = await import("@hono/hono/jsx/dom");
const render = runtime.render as unknown as (
  node: unknown,
  root: Element,
) => void;
const createElement = runtime.createElement as unknown as (
  type: unknown,
  props: Record<string, unknown>,
) => unknown;
const { FilesGallery } = await import(
  "../../src/landing/client/FilesGallery.tsx"
);
const filenames = await import("../../src/landing/client/helpers.ts");
const remember = filenames.rememberFilename as (
  hash: string,
  name: string,
  pubkey?: string,
) => void;
const root = dom.document.getElementById("review")!;
const KEY_A = "a".repeat(64), KEY_B = "b".repeat(64);
const records = [0, 1, 2].map((n) => ({
  sha256: String(n).repeat(64),
  size: 1000,
  type: "image/png",
  url: `http://localhost:3000/${String(n).repeat(64)}.png`,
  uploaded: 100 - n,
}));
type SigningEvent = {
  kind: number;
  created_at: number;
  content: string;
  tags: string[][];
};
type SignedEvent = SigningEvent & { pubkey?: string; sig: string; id: string };
let currentKey: string | undefined = KEY_A;
let sign: (event: SigningEvent) => Promise<SignedEvent>;
let request: (url: string, init?: RequestInit) => Promise<Response>;
const list = (values = records) =>
  new Response(JSON.stringify(values), {
    headers: { "Content-Type": "application/json" },
  });
const signed = (event: SigningEvent): SignedEvent => ({
  ...event,
  pubkey: currentKey,
  sig: "0".repeat(128),
  id: "0".repeat(64),
});
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function equal(actual: unknown, expected: unknown, message: string) {
  assert(
    Object.is(actual, expected),
    `${message}: expected ${expected}, got ${actual}`,
  );
}
const text = () => root.textContent ?? "";
const buttons = (
  scope: ParentNode = root,
) => [...scope.querySelectorAll("button")];
const button = (label: string, scope: ParentNode = root) =>
  buttons(scope).find((b) => b.textContent?.trim() === label)!;
const click = (element: Element) => {
  assert(element, "button exists");
  element.dispatchEvent(new dom.Event("click", { bubbles: true }));
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
async function until(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`condition timed out: ${text().slice(0, 200)}`);
}
const cards = () => root.querySelectorAll('button[aria-label^="Open "]');
const viewer = () => root.querySelector('[aria-label^="Viewing "]');
const confirm = () => root.querySelector('[aria-label="Confirm delete"]');
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => resolve = done);
  return { promise, resolve };
}
function keyboard(key: string, target?: Element) {
  const event = new Event("keydown", { cancelable: true });
  Object.defineProperty(event, "key", { value: key });
  if (target) Object.defineProperty(event, "target", { value: target });
  globalThis.dispatchEvent(event);
  return event;
}
async function mount() {
  render(createElement(FilesGallery, { listEnabled: true }), root);
  await settle();
  click(button("Connect with Nostr"));
  await until(() => cards().length === 3);
}
async function setup() {
  currentKey = KEY_A;
  focused = null;
  sign = (event) => Promise.resolve(signed(event));
  request = () => Promise.resolve(list());
  g.nostr = { signEvent: (event: SigningEvent) => sign(event) };
  g.fetch = (input: string | URL | Request, init?: RequestInit) =>
    request(String(input), init);
  await mount();
}
async function cleanup() {
  render(null, root);
  await settle();
  filenames.clearFilenames();
  stored.clear();
}
async function beginDelete() {
  click(root.querySelector('button[title="Delete"]')!);
  await until(() => !!confirm());
  click(button("Delete", confirm()!));
  await settle();
}

Deno.test("F9 old DELETE completion cannot change a reconnected identity", async () => {
  await setup();
  const pending = deferred<Response>();
  request = (_url, init) =>
    init?.method === "DELETE" ? pending.promise : Promise.resolve(list());
  try {
    await beginDelete();
    click(button("Disconnect"));
    await until(() => !!button("Connect with Nostr"));
    currentKey = KEY_B;
    click(button("Connect with Nostr"));
    await until(() => cards().length === 3 && text().includes("bbbbbbbb"));
    pending.resolve(new Response(null, { status: 204 }));
    await settle();
    equal(cards().length, 3, "B retains its independently owned files");
    assert(
      !text().includes("Deleted 1 file"),
      "A's completion notice stays out of B's session",
    );
  } finally {
    pending.resolve(new Response(null, { status: 204 }));
    await cleanup();
  }
});

Deno.test("F9 synchronous repeated confirmation starts only one delete", async () => {
  await setup();
  const approval = deferred<SignedEvent>();
  let prompts = 0;
  sign = () => {
    prompts++;
    return approval.promise;
  };
  try {
    click(root.querySelector('button[title="Delete"]')!);
    await until(() => !!confirm());
    const deletion = button("Delete", confirm()!);
    click(deletion);
    click(deletion);
    await settle();
    equal(prompts, 1, "only one signing request owns deletion");
  } finally {
    click(button("Disconnect"));
    approval.resolve(
      signed({ kind: 24242, created_at: 0, content: "", tags: [] }),
    );
    await cleanup();
  }
});

Deno.test("F10 fresh gallery cannot read another identity's filename", async () => {
  await setup();
  await cleanup();
  remember(records[0].sha256, "owner-a-document.png", KEY_A);
  currentKey = KEY_B;
  try {
    await mount();
    assert(
      !text().includes("owner-a-document.png"),
      "B must not render A's local filename",
    );
  } finally {
    await cleanup();
  }
});

Deno.test("F10 own filenames survive gallery remount and disappear on disconnect", async () => {
  await setup();
  await cleanup();
  remember(records[0].sha256, "owner-a-document.png", KEY_A);
  currentKey = KEY_A;
  try {
    await mount();
    assert(
      text().includes("owner-a-document.png"),
      "initial connection retains its own upload names",
    );
    render(null, root);
    await settle();
    await mount();
    assert(
      text().includes("owner-a-document.png"),
      "navigation retains own names",
    );
    click(button("Disconnect"));
    await until(() => !!button("Connect with Nostr"));
    click(button("Connect with Nostr"));
    await until(() => cards().length === 3);
    assert(
      !text().includes("owner-a-document.png"),
      "disconnect clears remembered names",
    );
  } finally {
    await cleanup();
  }
});

Deno.test("F11 viewer stays on its hash when a preceding deletion finishes", async () => {
  await setup();
  const pending = deferred<Response>();
  request = (_url, init) =>
    init?.method === "DELETE" ? pending.promise : Promise.resolve(list());
  try {
    await beginDelete();
    click(cards()[1]);
    await until(() => !!viewer());
    pending.resolve(new Response(null, { status: 204 }));
    await until(() => cards().length === 2);
    equal(
      viewer()?.getAttribute("aria-label"),
      "Viewing 11111111…1111.png",
      "viewer identity stays stable",
    );
  } finally {
    pending.resolve(new Response(null, { status: 204 }));
    await cleanup();
  }
});

Deno.test("F12 viewer delete presents one active confirmation dialog", async () => {
  await setup();
  try {
    click(cards()[0]);
    await until(() => !!viewer());
    click(button("Delete", viewer()!));
    await until(() => !!confirm());
    equal(
      root.querySelectorAll('[role="dialog"]').length,
      1,
      "confirmation owns the modal layer",
    );
    keyboard("Escape");
    await until(() => !confirm());
    assert(!!viewer(), "Escape cancels confirmation and restores viewer");
  } finally {
    await cleanup();
  }
});

Deno.test("F13 slash never focuses search behind a viewer", async () => {
  await setup();
  try {
    click(cards()[0]);
    await until(() => !!viewer());
    await settle();
    const close = button("Close (Esc)", viewer()!);
    close.focus();
    keyboard("/", close);
    equal(dom.document.activeElement, close, "focus stays in viewer");
    keyboard("Escape", close);
    await until(() => !viewer());
    keyboard("/");
    equal(
      dom.document.activeElement,
      root.querySelector('input[type="search"]'),
      "slash focuses search when no modal is open",
    );
  } finally {
    await cleanup();
  }
});

for (const invalidKey of [undefined, ""]) {
  Deno.test(`F9 ${String(invalidKey)} signer identity never sends DELETE`, async () => {
    await setup();
    let sent = 0;
    request = (_url, init) => {
      if (init?.method === "DELETE") sent++;
      return Promise.resolve(new Response(null, { status: 204 }));
    };
    sign = (event) => Promise.resolve({ ...signed(event), pubkey: invalidKey });
    try {
      await beginDelete();
      equal(sent, 0, "invalid signer is rejected before transport");
    } finally {
      await cleanup();
    }
  });
}

Deno.test("F10 uploaded filenames follow the signed event identity across navigation", async () => {
  await setup();
  render(null, root);
  await settle();
  const { UploadForm } = await import(
    "../../src/landing/client/UploadForm.tsx"
  );
  const oldXHR = g.XMLHttpRequest;
  g.XMLHttpRequest = class {
    upload = {};
    status = 201;
    responseText = JSON.stringify(records[0]);
    onload: (() => void) | null = null;
    open() {}
    setRequestHeader() {}
    send() {
      queueMicrotask(() => this.onload?.());
    }
  };
  request = (url) =>
    Promise.resolve(
      new Response(null, { status: url === "/upload" ? 200 : 404 }),
    );
  try {
    render(
      createElement(UploadForm, {
        requireAuth: true,
        mediaEnabled: false,
        mediaRequireAuth: true,
        optimizeByDefault: false,
        onQueueChange: () => {},
      }),
      root,
    );
    await settle();
    const input = root.querySelector('input[type="file"]')!;
    Object.defineProperty(input, "files", {
      value: [
        new File(["placeholder"], "signed-owner-file.png", {
          type: "image/png",
        }),
      ],
    });
    input.dispatchEvent(new dom.Event("input", { bubbles: true }));
    await until(() => !!button("Upload 1 file"));
    click(button("Upload 1 file"));
    await until(() => !!button("All done"));
    render(null, root);
    await settle();
    request = () => Promise.resolve(list());
    await mount();
    assert(
      text().includes("signed-owner-file.png"),
      "signer sees its uploaded name",
    );
    render(null, root);
    await settle();
    currentKey = KEY_B;
    await mount();
    assert(
      !text().includes("signed-owner-file.png"),
      "different signer cannot reuse uploaded filename",
    );
  } finally {
    g.XMLHttpRequest = oldXHR;
    await cleanup();
  }
});
