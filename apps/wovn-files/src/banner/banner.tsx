import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";

import { fileUrl, rawUrl } from "@/lib/api";
import { copyUrl, fileQuery } from "@/lib/queries";
import type { FilePage } from "@/lib/types";
import { versionStamp } from "@/lib/types";
import { Finder } from "./finder";
import { Crumbs, Dot, Strip } from "./strip";
import { Time } from "./time";
import { ShareNote, VisibilityBadge } from "./visibility-badge";

// The Banner (CONTEXT.md): the strip and its Finder panel above a File. One
// component, two mounts - the React tree of an app page, and the shadow root
// the host injects into an HTML File. The File's Visibility is read through
// the query cache so a flip anywhere updates the badge.
export function Banner({ page }: { page: FilePage }) {
  const file = useQuery({
    ...fileQuery(page.file.key),
    initialData: page.file,
  }).data;
  useRefetchAtShareExpiry(file.key, file.share?.expires ?? null);
  const [open, setOpen] = useState(page.openVersions);
  // Bumped to reopen the Finder on the page's own File.
  const [finderKey, setFinderKey] = useState(0);
  const panelId = useId();
  const segments = file.key.split("/");
  const name = segments.pop() ?? file.key;
  const stamp = page.version ? versionStamp(page.version.key) : undefined;
  const count = page.versions.length;

  const tail = page.version ? (
    <>
      <a className="truncate text-muted-foreground hover:underline" href={fileUrl(file.key)}>
        {name}
      </a>
      <span className="text-muted-foreground/60">›</span>
      <span className="truncate font-semibold text-private">
        version <Time iso={page.version.uploaded} show="stamp" />
      </span>
      <span className="pl-1.5">
        <VisibilityBadge file={file} readOnly />
      </span>
      <span className="text-muted-foreground">{newerThan(page)}</span>
    </>
  ) : (
    <>
      <span className="truncate font-semibold">{name}</span>
      <span className="pl-1.5">
        <VisibilityBadge file={file} />
      </span>
      <span className="max-sm:hidden">
        <ShareNote file={file} />
      </span>
    </>
  );

  return (
    <div className="text-foreground">
      <Strip
        crumbs={<Crumbs segments={segments} tail={tail} />}
        prefix={`${segments.join("/")}${segments.length ? "/" : ""}`}
        panel={{ open, onToggle: () => setOpen((value) => !value), id: panelId }}
      >
        {/* On a phone the File name needs the room, so the times and the
            version count give way. */}
        {page.version ? (
          <>
            <span className="contents max-sm:hidden">
              <span className="has-[[data-fresh]]:text-foreground">
                uploaded <Time iso={page.version.uploaded} show="ago" />
              </span>
              <Dot />
            </span>
            <a className="text-primary hover:underline" href={fileUrl(file.key)}>
              current
            </a>
            <Dot />
          </>
        ) : (
          <span className="contents max-sm:hidden">
            <span className="has-[[data-fresh]]:text-foreground">
              {count ? "updated" : "uploaded"} <Time iso={file.uploaded} show="ago" />
            </span>
            {file.stable && (
              <>
                <Dot />
                <button
                  type="button"
                  className="cursor-pointer text-primary hover:underline"
                  onClick={() => {
                    setOpen(true);
                    setFinderKey((key) => key + 1);
                  }}
                >
                  {count} version{count === 1 ? "" : "s"}
                </button>
              </>
            )}
            <Dot />
          </span>
        )}
        {/* The link a Guest opens is the File's own URL (ADR 0005). */}
        {!page.version && file.visibility === "shared" && (
          <>
            <button
              type="button"
              className="cursor-pointer text-primary hover:underline"
              onClick={() => copyUrl(fileUrl(file.key))}
            >
              copy link
            </button>
            <Dot />
          </>
        )}
        <a className="text-primary hover:underline" href={rawUrl(file.key, stamp)}>
          raw
        </a>
      </Strip>
      {open && <Finder key={finderKey} id={panelId} page={page} file={file} />}
    </div>
  );
}

// A page left open past its Share's expiry refetches the File then, so the
// badge turns private when the host does rather than showing a stale share.
function useRefetchAtShareExpiry(key: string, expires: string | null) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (expires === null) return;
    const delay = Date.parse(expires) - Date.now() + 1000;
    // setTimeout overflows past ~24.8 days; a Share that far out is covered
    // by the next page load.
    if (delay <= 0 || delay > 0x7fffffff) return;
    const id = setTimeout(() => {
      void queryClient.invalidateQueries({ queryKey: fileQuery(key).queryKey });
    }, delay);
    return () => clearTimeout(id);
  }, [key, expires, queryClient]);
}

// "2 versions newer than current" style note for a Version page.
function newerThan(page: FilePage): string {
  if (!page.version) return "";
  const index = page.versions.findIndex((v) => v.key === page.version!.key);
  const newer = index < 0 ? 0 : index;
  return newer === 0
    ? "the previous version"
    : `${newer} version${newer === 1 ? "" : "s"} newer than this one`;
}
