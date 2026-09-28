export type FileStatus =
  | "pending"
  | "hashing"
  | "checking"
  | "signing"
  | "uploading"
  | "done"
  | "exists"
  | "skipped"
  | "retrying"
  | "error";

export type MirrorStatus =
  | "pending"
  | "signing"
  | "mirroring"
  | "done"
  | "exists"
  | "retrying"
  | "error";

/** Landing-page tabs. "My Files" moved to its own page (GET /files) and is a
 * plain link in the tab bar — not an in-card tab anymore. */
export type Tab = "upload" | "mirror";

export interface GalleryError {
  kind:
    | "noext"
    | "rejected"
    | "forbidden"
    | "cursor"
    | "server"
    | "auth"
    | "timeout";
  message: string;
  retryable: boolean;
  /** Retry must restart the traversal instead of replaying the failed request. */
  retryReset?: boolean;
}

export interface BlobDescriptor {
  sha256: string;
  size: number;
  type: string;
  url: string;
  /** Unix seconds of first upload (BUD-02 descriptor field). */
  uploaded: number;
  nip94?: [name: string, value: string, ...rest: string[]][];
}

export interface UploadResult {
  descriptor: BlobDescriptor;
  /** HTTP status: 200 = already existed, 201 = newly created */
  status: number;
}

export interface UploadFile {
  id: string;
  file: File;
  status: FileStatus;
  /** Upload byte progress 0–100 */
  progress: number;
  result?: BlobDescriptor;
  error?: string;
  /** Whether to route this file through /media */
  optimize: boolean;
}

export interface MirrorItem {
  id: string;
  /** Original string the user pasted — shown in the UI */
  displayUrl: string;
  /** HTTP/S URL sent to PUT /mirror body (resolved from xs hint for blossom: URIs) */
  mirrorUrl: string;
  /** Primary 64-char sha256 hex (last hash found in the URL path) */
  sha256: string;
  /** All unique hashes found in the URL — used in auth event x-tags */
  allHashes: string[];
  status: MirrorStatus;
  result?: BlobDescriptor;
  error?: string;
}

export interface NostrProvider {
  signEvent(event: UnsignedNostrEvent): Promise<unknown>;
}

export interface UnsignedNostrEvent {
  kind: number;
  content: string;
  created_at: number;
  tags: string[][];
}

declare global {
  var nostr: NostrProvider | undefined;
}
