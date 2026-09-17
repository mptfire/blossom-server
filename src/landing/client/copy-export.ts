/**
 * Copy/export serialization for the My Files gallery.
 *
 * Filenames originate from uploaded File objects — fully attacker-controllable
 * content. Everything interpolated into exported HTML or Markdown must be
 * escaped contextually (senior review 2026-09-18, item S2). Pure functions,
 * no DOM — unit-testable with hostile inputs.
 */

export type CopyFormat = "url" | "md" | "html";

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Backslash-escape Markdown link-label metacharacters. */
export function escapeMdLabel(value: string): string {
  return value.replace(/([\\[\]()])/g, "\\$1");
}

export interface CopySource {
  sha256: string;
  url: string;
  type: string | null;
}

export function copyTextFor(
  d: CopySource,
  fmt: CopyFormat,
  name: string,
  isImage: boolean,
): string {
  const label = escapeMdLabel(name);
  if (fmt === "md") {
    return isImage
      ? `![${label}](${escapeHtml(d.url)})`
      : `[${label}](${escapeHtml(d.url)})`;
  }
  if (fmt === "html") {
    return isImage
      ? `<img src="${escapeHtml(d.url)}" alt="${escapeHtml(name)}">`
      : `<a href="${escapeHtml(d.url)}">${escapeHtml(name)}</a>`;
  }
  return d.url;
}
