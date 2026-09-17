/**
 * Unit tests for gallery copy/export serialization (senior review 2026-09-18,
 * item S2): filenames originate from uploaded File objects and are fully
 * attacker-controllable — every interpolated value must be escaped
 * contextually so exported snippets cannot carry injected markup.
 */

import { assertEquals } from "@std/assert";
import {
  copyTextFor,
  escapeHtml,
  escapeMdLabel,
} from "../../src/landing/client/copy-export.ts";

const d = {
  sha256: "d2bc896dd1c5bd2764daa03ea4f18a5c828c3998deddaf41e64ed0e25d113bf3",
  url:
    "http://localhost:3000/d2bc896dd1c5bd2764daa03ea4f18a5c828c3998deddaf41e64ed0e25d113bf3.svg",
  type: "image/svg+xml",
};

Deno.test("escapeHtml: escapes all HTML-significant characters", () => {
  assertEquals(
    escapeHtml(`a&b<c>d"e'f`),
    "a&amp;b&lt;c&gt;d&quot;e&#39;f",
  );
});

Deno.test("escapeMdLabel: backslash-escapes label delimiters", () => {
  assertEquals(escapeMdLabel("a[b](c)\\d"), "a\\[b\\]\\(c\\)\\\\d");
});

Deno.test("copyTextFor: html image export escapes hostile filenames", () => {
  const html = copyTextFor(d, "html", `photo" onerror="alert(1)`, true);
  assertEquals(
    html,
    `<img src="${d.url}" alt="photo&quot; onerror=&quot;alert(1)">`,
  );
  // The output must not contain an unescaped quote that could close the attribute.
  assertEquals(/alt="[^"]*"/.test(html), true);
});

Deno.test("copyTextFor: html anchor export escapes hostile names", () => {
  const html = copyTextFor(d, "html", `<script>alert(1)</script>`, false);
  assertEquals(
    html,
    `<a href="${d.url}">&lt;script&gt;alert(1)&lt;/script&gt;</a>`,
  );
});

Deno.test("copyTextFor: markdown export escapes label delimiters", () => {
  const md = copyTextFor(d, "md", `weird](name)[x`, false);
  assertEquals(
    md,
    `[weird\\]\\(name\\)\\[x](${d.url})`,
  );
});

Deno.test("copyTextFor: url format returns the raw blob URL", () => {
  assertEquals(copyTextFor(d, "url", "anything", false), d.url);
});

Deno.test("copyTextFor: names without metacharacters pass through unchanged", () => {
  assertEquals(
    copyTextFor(d, "html", "photo.png", true),
    `<img src="${d.url}" alt="photo.png">`,
  );
  assertEquals(
    copyTextFor(d, "md", "photo.png", true),
    `![photo.png](${d.url})`,
  );
});
