import { useQuery } from "@tanstack/react-query";
import { useCallback, useRef, useState, type MouseEvent, type ReactNode } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { fileUrl, parentUrl, rawUrl, versionUrl } from "@/lib/api";
import { formatDelta, formatSize, formatWhen } from "@/lib/format";
import { isShareExpired } from "@/lib/share";
import {
  copyUrl,
  fileQuery,
  listingQuery,
  useDeleteFile,
  useSetVisibility,
  versionsQuery,
} from "@/lib/queries";
import type { FileMeta, FilePage, Share, Version, Visibility } from "@/lib/types";
import { versionStamp } from "@/lib/types";
import { cn } from "@/lib/utils";
import { SharePopover } from "./share-popover";
import { Time } from "./time";
import { VisibilityDot, VisibilityLabel } from "./visibility-badge";

// The Banner's panel: Finder columns from the root down to one directory,
// then an info column for the selected File. It opens on the File the page
// shows; a click on another File shows that File's info, a second click (or
// "open") goes to it. Deep paths scroll sideways, starting at the deepest
// column, and the left edge fades while columns are scrolled out of view.
// Capped below the strip at the viewport height and scrolled within, since
// in an HTML File the Banner is fixed and the page cannot scroll to it.
export function Finder({ page, file, id }: { page: FilePage; file: FileMeta; id: string }) {
  const [openDir, setOpenDir] = useState(dirOf(page.file.key));
  const [selected, setSelected] = useState(page.file.key);
  const [scrolled, setScrolled] = useState(false);
  const prefixes = prefixesOf(openDir);

  // Keep the deepest column in view: React calls this (a stable callback)
  // only when a different column becomes the last one - a folder opened, or
  // an ancestor picked - so other re-renders keep the reader's scroll.
  const showDeepest = useCallback((column: HTMLDivElement | null) => {
    const row = column?.parentElement;
    if (!row) return;
    row.scrollLeft = row.scrollWidth;
    setScrolled(row.scrollLeft > 2);
  }, []);

  return (
    <div
      id={id}
      className="@container max-h-[calc(100dvh-2rem)] overflow-y-auto border-b border-border bg-background font-ui text-[13px] tabular-nums"
    >
      <div className="flex h-[440px] @max-[760px]:h-auto @max-[760px]:flex-col">
        <div
          className={cn(
            "flex min-w-0 flex-1 overflow-x-auto @max-[760px]:h-[260px] @max-[760px]:flex-none",
            scrolled && "[mask-image:linear-gradient(to_right,transparent,black_40px)]",
          )}
          onScroll={(event) => setScrolled(event.currentTarget.scrollLeft > 2)}
        >
          {prefixes.map((prefix, index) => (
            <Column
              key={prefix}
              ref={index === prefixes.length - 1 ? showDeepest : undefined}
              prefix={prefix}
              openDir={prefixes[index + 1]}
              selected={selected}
              currentKey={page.file.key}
              onOpenDir={setOpenDir}
              onSelect={setSelected}
            />
          ))}
        </div>
        <div className="w-[360px] shrink-0 overflow-y-auto border-l border-border px-1.5 py-2 @max-[760px]:w-auto @max-[760px]:border-t @max-[760px]:border-l-0">
          {selected === page.file.key ? (
            <Info
              page={page}
              file={file}
              versions={page.versions}
              current
              onDeleted={(key) => window.location.assign(parentUrl(key))}
            />
          ) : (
            <OtherInfo
              key={selected}
              fileKey={selected}
              page={page}
              onDeleted={() => setSelected(page.file.key)}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// One directory level: folders, then Files. `openDir` is the folder open in
// the next column, if any.
function Column({
  ref,
  prefix,
  openDir,
  selected,
  currentKey,
  onOpenDir,
  onSelect,
}: {
  ref?: (column: HTMLDivElement | null) => void;
  prefix: string;
  openDir: string | undefined;
  selected: string;
  currentKey: string;
  onOpenDir: (prefix: string) => void;
  onSelect: (key: string) => void;
}) {
  const listing = useQuery(listingQuery(prefix));
  let body: ReactNode;
  if (listing.isError) body = <Note>failed to load</Note>;
  else if (!listing.data) body = <RowsSkeleton />;
  else {
    const { directories, files } = listing.data;
    body = (
      <>
        {directories.map((dir) => (
          <Row
            key={dir}
            href={`/${dir}`}
            active={dir === openDir}
            follow={false}
            onPick={() => onOpenDir(dir)}
          >
            <span className="truncate">{dir.slice(prefix.length, -1)}</span>
            <span className="text-muted-foreground">›</span>
          </Row>
        ))}
        {files.map((entry) => (
          <Row
            key={entry.key}
            href={fileUrl(entry.key)}
            active={entry.key === selected}
            follow={entry.key === selected}
            onPick={() => onSelect(entry.key)}
            className={cn(entry.key === currentKey && "font-semibold")}
          >
            <span className="flex min-w-0 items-center gap-1.5" title={nameOf(entry.key)}>
              <VisibilityDot value={entry.visibility} />
              <span className="truncate">{nameOf(entry.key)}</span>
            </span>
            <Time iso={entry.uploaded} show="ago" className="text-muted-foreground" />
          </Row>
        ))}
        {directories.length === 0 && files.length === 0 && <Note>empty</Note>}
      </>
    );
  }
  return (
    <div
      ref={ref}
      className="w-[220px] shrink-0 overflow-y-auto border-r border-border px-1 py-1.5"
    >
      {body}
    </div>
  );
}

// A real link, so ⌘-click and middle-click open it in a new tab. A plain click
// picks the row instead of following the link, unless `follow` is set (a
// File's second click).
function Row({
  href,
  active,
  follow,
  onPick,
  className,
  children,
}: {
  href: string;
  active: boolean;
  follow: boolean;
  onPick: () => void;
  className?: string;
  children: ReactNode;
}) {
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (follow || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    onPick();
  };
  return (
    <a
      href={href}
      className={cn(
        "grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-[5px] px-2 py-[3px] hover:bg-accent",
        active && "bg-accent",
        className,
      )}
      onClick={onClick}
    >
      {children}
    </a>
  );
}

// Info for a File other than the page's: its metadata and Versions come from
// the API on selection.
function OtherInfo({
  fileKey,
  page,
  onDeleted,
}: {
  fileKey: string;
  page: FilePage;
  onDeleted: () => void;
}) {
  const meta = useQuery(fileQuery(fileKey));
  const stable = meta.data?.stable === true;
  const versions = useQuery({ ...versionsQuery(fileKey), enabled: stable });
  if (meta.isError || versions.isError) return <Note>failed to load {nameOf(fileKey)}</Note>;
  if (!meta.data || (stable && !versions.data)) return <InfoSkeleton />;
  return (
    <Info
      page={page}
      file={meta.data}
      versions={versions.data?.versions ?? []}
      current={false}
      onDeleted={onDeleted}
    />
  );
}

// Everything about one File: visibility, actions, facts, and its uploads.
// For the page's own File on a Version page, the facts, raw, and copy
// describe that Version.
function Info({
  page,
  file,
  versions,
  current,
  onDeleted,
}: {
  page: FilePage;
  file: FileMeta;
  versions: Version[];
  current: boolean;
  onDeleted: (key: string) => void;
}) {
  const version = current ? page.version : null;
  const shown = version ?? file;
  const stamp = version ? versionStamp(version.key) : undefined;
  const first = versions.at(-1)?.uploaded ?? file.uploaded;
  const uploads = versions.length + 1;
  const facts: [string, ReactNode][] = [
    ["key", file.key],
    ...(stamp ? [["version", stamp] as [string, ReactNode]] : []),
    ["size", `${formatSize(shown.size)}, ${shown.contentType}`],
    ["uploaded", <Time key="uploaded" iso={shown.uploaded} show="long" />],
    [
      "history",
      file.stable
        ? `${uploads} upload${uploads === 1 ? "" : "s"} since ${formatWhen(first)}`
        : "generated key, one upload",
    ],
    ...optional("shared", file.share && shareFact(file.share)),
    ...optional("project", file.project),
    ...optional("branch", file.branch),
    ...optional("worktree", file.worktree),
    ...optional("dir", file.dir),
  ];
  return (
    <>
      <div className="flex items-center gap-2 px-2 pb-1">
        <span className="truncate font-semibold">{nameOf(file.key)}</span>
        {current ? (
          <span className="shrink-0 text-muted-foreground">this File</span>
        ) : (
          <a
            className="ml-auto shrink-0 rounded-[5px] border border-border px-2.5 hover:bg-accent"
            href={fileUrl(file.key)}
          >
            open
          </a>
        )}
      </div>
      {version ? (
        <p className="flex items-center gap-2 px-2 py-0.5">
          <VisibilityLabel value="private" />
          <span className="text-muted-foreground">Versions are always private</span>
        </p>
      ) : (
        <VisibilityToggle file={file} />
      )}
      <Actions file={file} stamp={stamp} onDeleted={onDeleted} />
      <hr className="mx-2 my-1.5 border-border" />
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3.5 gap-y-0.5 px-2">
        {facts.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="break-words">{value}</dd>
          </div>
        ))}
      </dl>
      <hr className="mx-2 my-1.5 border-border" />
      <Uploads page={page} file={file} versions={versions} current={current} />
    </>
  );
}

const optional = (label: string, value: string | undefined): [string, ReactNode][] =>
  value ? [[label, value]] : [];

// "2 emails, expires Oct 13" / "2 emails, never expires" / "share expired Oct 3".
function shareFact(share: Share): string {
  const count = `${share.emails.length} email${share.emails.length === 1 ? "" : "s"}`;
  if (share.expires === null) return `${count}, never expires`;
  if (isShareExpired(share)) return `share expired ${formatWhen(share.expires)}`;
  return `${count}, expires ${formatWhen(share.expires)}`;
}

// The current state then every Version, newest first, each with its time,
// size, and the size change from the upload before it.
function Uploads({
  page,
  file,
  versions,
  current,
}: {
  page: FilePage;
  file: FileMeta;
  versions: Version[];
  current: boolean;
}) {
  if (!file.stable) {
    return <Note>Generated key. It is never overwritten.</Note>;
  }
  const showing = current ? (page.version?.key ?? page.file.key) : null;
  const rows = [
    { key: file.key, href: fileUrl(file.key), size: file.size, uploaded: file.uploaded },
    ...versions.map((v) => ({
      key: v.key,
      href: versionUrl(file.key, versionStamp(v.key)),
      size: v.size,
      uploaded: v.uploaded,
    })),
  ];
  return (
    <>
      <h3 className="flex items-baseline gap-2 px-2 pb-1 text-[12px] font-semibold">
        versions
        <span className="font-normal text-muted-foreground">
          {rows.length} upload{rows.length === 1 ? "" : "s"}
        </span>
      </h3>
      {rows.map((row, index) => {
        const older = rows[index + 1];
        return (
          <a
            key={row.key}
            href={row.href}
            className={cn(
              "grid grid-cols-[minmax(0,1fr)_auto_auto_64px] items-center gap-3.5 rounded-[5px] px-2 py-[3px] hover:bg-accent",
              row.key === showing && "font-semibold",
            )}
          >
            {index === 0 ? <span>current</span> : <Time iso={row.uploaded} show="day" />}
            <Time iso={row.uploaded} show="ago" className="text-right text-muted-foreground" />
            <span className="text-right text-muted-foreground">{formatSize(row.size)}</span>
            <span className="text-right text-[12px] text-muted-foreground">
              {older ? formatDelta(row.size - older.size) : "first"}
            </span>
          </a>
        );
      })}
      {versions.length === 0 && <Note>No earlier uploads.</Note>}
    </>
  );
}

// public / shared / private. Public and private flip at once; shared opens
// the share form anchored to its button (and edits the Share while shared).
function VisibilityToggle({ file }: { file: FileMeta }) {
  const flip = useSetVisibility();
  const [sharing, setSharing] = useState(false);
  const shareButton = useRef<HTMLButtonElement>(null);
  const options: Visibility[] = ["public", "shared", "private"];
  return (
    <div className="flex gap-0.5 px-0.5 py-0.5" role="radiogroup" aria-label="visibility">
      {options.map((value) => (
        <button
          key={value}
          ref={value === "shared" ? shareButton : undefined}
          type="button"
          role="radio"
          aria-checked={file.visibility === value}
          disabled={flip.isPending}
          className={cn(
            "inline-flex cursor-pointer items-center gap-1.5 rounded-[5px] border px-2 py-0.5 disabled:opacity-50",
            file.visibility === value
              ? "border-border text-foreground"
              : "border-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
          onClick={() => {
            if (value === "shared") setSharing(true);
            else if (value !== file.visibility) flip.mutate({ key: file.key, visibility: value });
          }}
        >
          <VisibilityDot value={value} />
          {value}
          {value === "shared" && file.visibility === "shared" && (
            <span className="text-muted-foreground/70">· edit</span>
          )}
        </button>
      ))}
      <SharePopover file={file} anchor={shareButton} open={sharing} onOpenChange={setSharing} />
    </div>
  );
}

// copy url, raw, download, and delete (confirmed). `stamp` points the first
// three at a Version.
function Actions({
  file,
  stamp,
  onDeleted,
}: {
  file: FileMeta;
  stamp: string | undefined;
  onDeleted: (key: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const remove = useDeleteFile(onDeleted);
  const name = nameOf(file.key);
  const action = "cursor-pointer rounded-[5px] px-2 py-0.5 hover:bg-accent";
  return (
    <>
      <div className="flex flex-wrap gap-0.5 px-0.5 py-0.5">
        <button
          type="button"
          className={action}
          onClick={() => copyUrl(stamp ? versionUrl(file.key, stamp) : fileUrl(file.key))}
        >
          copy url
        </button>
        <a className={action} href={rawUrl(file.key, stamp)}>
          raw
        </a>
        <a className={action} href={rawUrl(file.key, stamp)} download={name}>
          download
        </a>
        <button
          type="button"
          className={cn(action, "text-destructive")}
          onClick={() => setConfirming(true)}
        >
          delete
        </button>
      </div>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {name}?</AlertDialogTitle>
            <AlertDialogDescription>
              The File and all its Versions are deleted permanently.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                remove.mutate(file.key);
                setConfirming(false);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className="px-2 py-1 text-muted-foreground">{children}</p>;
}

function RowsSkeleton() {
  return (
    <div className="space-y-2.5 px-2 py-1.5">
      {[28, 40, 34, 24].map((width) => (
        <Skeleton key={width} className="h-3" style={{ width: `${width * 4}px` }} />
      ))}
    </div>
  );
}

function InfoSkeleton() {
  return (
    <div className="space-y-2.5 px-2 py-1">
      <Skeleton className="h-3.5 w-40" />
      <Skeleton className="h-3 w-56" />
      <Skeleton className="h-3 w-64" />
      <Skeleton className="h-3 w-48" />
    </div>
  );
}

const nameOf = (key: string) => key.slice(key.lastIndexOf("/") + 1);
const dirOf = (key: string) => key.replace(/[^/]*$/, "");

// "a/b/" -> ["", "a/", "a/b/"]: the root and every directory down to it.
function prefixesOf(dir: string): string[] {
  const parts = dir.split("/").filter(Boolean);
  return ["", ...parts.map((_, index) => `${parts.slice(0, index + 1).join("/")}/`)];
}
