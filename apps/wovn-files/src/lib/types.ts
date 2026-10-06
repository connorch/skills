// Types shared by the host (server), the /api client, and the Banner. Names
// follow CONTEXT.md.

// The effective Visibility of a File: `shared` is public to the Share's
// emails (ADR 0005), and falls back to `private` once the Share expires.
export type Visibility = "public" | "private" | "shared";

// Who a File is shared with: Guests whose email is listed, until `expires`
// (null = never). Kept on the File after expiry so a renewal starts from the
// old list.
export interface Share {
  emails: string[];
  expires: string | null;
}

// One File as the collection endpoints describe it.
export interface FileEntry {
  key: string;
  size: number;
  uploaded: string;
  visibility: Visibility;
  stable: boolean;
  project?: string;
  branch?: string;
}

// The full metadata of one File (GET /api/files/<key>).
export interface FileMeta extends FileEntry {
  contentType: string;
  share?: Share;
  worktree?: string;
  dir?: string;
}

// The body of PATCH /api/files/<key>: flip to public or private (dropping
// any Share), or share with a list of emails.
export type VisibilityPatch =
  | { visibility: "public" | "private" }
  | { visibility: "shared"; emails: string[]; expires: string | null };

// One directory level under a prefix.
export interface Listing {
  prefix: string;
  directories: string[];
  files: FileEntry[];
}

export interface Version {
  // The storage Key, archive/<key>/<stamp>.
  key: string;
  size: number;
  uploaded: string;
}

export interface Versions {
  current: Version | null;
  versions: Version[];
}

// What a File Page renders: the File, its Versions (newest first), and,
// when the page shows a Version rather than the current File, which one.
export interface FilePage {
  kind: "file";
  file: FileMeta;
  versions: Version[];
  version: (Version & { contentType: string }) | null;
  // The panel opens on the versions tab (`?versions`).
  openVersions: boolean;
}

export interface DirectoryPage {
  kind: "directory";
  listing: Listing;
}

export type Page = FilePage | DirectoryPage;

// The stamp segment of a Version's storage Key.
export function versionStamp(versionKey: string): string {
  return versionKey.slice(versionKey.lastIndexOf("/") + 1);
}
