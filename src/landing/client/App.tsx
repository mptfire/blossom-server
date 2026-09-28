import { useEffect, useState } from "@hono/hono/jsx/dom";
import type { Tab } from "./types.ts";
import { UploadForm } from "./UploadForm.tsx";
import { MirrorForm } from "./MirrorForm.tsx";

export function App({
  requireAuth,
  mediaEnabled,
  mediaRequireAuth,
  optimizeByDefault,
  mirrorEnabled,
  mirrorRequireAuth,
  listEnabled,
}: {
  requireAuth: boolean;
  mediaEnabled: boolean;
  mediaRequireAuth: boolean;
  optimizeByDefault: boolean;
  mirrorEnabled: boolean;
  mirrorRequireAuth: boolean;
  listEnabled: boolean;
}) {
  const [activeTab, setActiveTab] = useState<Tab>("upload");
  // Each tab reports whether it has active items so we can hide server-info
  const [uploadHasItems, setUploadHasItems] = useState(false);
  const [mirrorHasItems, setMirrorHasItems] = useState(false);

  const hasItems = uploadHasItems || mirrorHasItems;

  useEffect(() => {
    const el = document.getElementById("server-info");
    if (!el) return;
    el.style.display = hasItems ? "none" : "";
  }, [hasItems]);

  const tabClass = (tab: Tab) =>
    `px-4 py-2 text-sm font-medium transition-colors border-b-2 ${
      activeTab === tab
        ? "border-blue-500 text-white"
        : "border-transparent text-gray-500 hover:text-gray-300"
    }`;

  const showTabBar = mirrorEnabled || listEnabled;

  return (
    <div>
      {/* Tab bar — rendered when any secondary tab exists. My Files moved to
      its own full-width page (GET /files); the tab is an outbound link now. */}
      {showTabBar && (
        <div class="flex border-b border-gray-800 px-6 pt-4">
          <button
            type="button"
            class={tabClass("upload")}
            onClick={() => setActiveTab("upload")}
          >
            Upload
          </button>
          {mirrorEnabled && (
            <button
              type="button"
              class={tabClass("mirror")}
              onClick={() => setActiveTab("mirror")}
            >
              Mirror
            </button>
          )}
          {listEnabled && (
            <a
              href="/files"
              class="px-4 py-2 text-sm font-medium transition-colors border-b-2 border-transparent text-gray-500 hover:text-gray-300"
            >
              My Files ↗
            </a>
          )}
        </div>
      )}

      {/* Tab panels */}
      {activeTab === "upload" && (
        <UploadForm
          requireAuth={requireAuth}
          mediaEnabled={mediaEnabled}
          mediaRequireAuth={mediaRequireAuth}
          optimizeByDefault={optimizeByDefault}
          onQueueChange={setUploadHasItems}
        />
      )}
      {activeTab === "mirror" && mirrorEnabled && (
        <MirrorForm
          requireAuth={mirrorRequireAuth}
          onQueueChange={setMirrorHasItems}
        />
      )}
    </div>
  );
}
