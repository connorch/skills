import { Select as SelectPrimitive } from "@base-ui/react/select";
import { useRef, useState } from "react";

import { SelectContent, SelectItem } from "@/components/ui/select";
import { useSetVisibility } from "@/lib/queries";
import { isShareExpired } from "@/lib/share";
import type { FileMeta, Visibility } from "@/lib/types";
import { cn } from "@/lib/utils";
import { SharePopover } from "./share-popover";
import { Time } from "./time";

// The Visibility indicator in the strip: a dot and a word. For the current
// File it opens a three-option select: public and private flip in place,
// shared opens the share form anchored here (ADR 0005), and while shared
// the same item reads "shared · edit". A Version is always private, so its
// badge is static.
export function VisibilityBadge({ file, readOnly }: { file: FileMeta; readOnly?: boolean }) {
  const flip = useSetVisibility();
  const [sharing, setSharing] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const value: Visibility = readOnly ? "private" : file.visibility;

  if (readOnly) return <VisibilityLabel value={value} />;

  return (
    <>
      <SelectPrimitive.Root<Visibility>
        value={value}
        onValueChange={(next) => {
          if (next === "shared") setSharing(true);
          else if (next && next !== value) flip.mutate({ key: file.key, visibility: next });
        }}
      >
        <SelectPrimitive.Trigger
          ref={trigger}
          className="cursor-pointer rounded px-1 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
          title="change visibility"
          disabled={flip.isPending}
        >
          <VisibilityLabel value={value} count={file.share?.emails.length} />
        </SelectPrimitive.Trigger>
        <SelectContent
          align="start"
          className="font-mono text-[12.5px]"
          alignItemWithTrigger={false}
        >
          <SelectItem value="public">
            <VisibilityLabel value="public" />
          </SelectItem>
          {/* Re-picking the current value fires no change, so the click
              opens the form too. */}
          <SelectItem value="shared" onClick={() => setSharing(true)}>
            <VisibilityLabel value="shared" />
            {value === "shared" && <span className="text-muted-foreground/70">· edit</span>}
          </SelectItem>
          <SelectItem value="private">
            <VisibilityLabel value="private" />
          </SelectItem>
        </SelectContent>
      </SelectPrimitive.Root>
      <SharePopover file={file} anchor={trigger} open={sharing} onOpenChange={setSharing} />
    </>
  );
}

// "shared with 2" when a count is given for a shared File, else the word.
export function VisibilityLabel({ value, count }: { value: Visibility; count?: number }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
      <VisibilityDot value={value} />
      {value === "shared" && count !== undefined ? `shared with ${count}` : value}
    </span>
  );
}

// The Share's time beside the badge: "expires in 6d" while shared, "share
// expired 3d ago" once it lapsed (the File is private again, the list kept).
export function ShareNote({ file }: { file: FileMeta }) {
  const share = file.share;
  if (!share || share.expires === null) return null;
  if (file.visibility !== "shared" && !isShareExpired(share)) return null;
  return (
    <span className="text-muted-foreground">
      {isShareExpired(share) ? (
        <>
          share expired <Time iso={share.expires} show="ago" />
        </>
      ) : (
        <>
          expires <Time iso={share.expires} show="in" />
        </>
      )}
    </span>
  );
}

export function VisibilityDot({ value }: { value: Visibility }) {
  return (
    <span
      className={cn(
        "inline-block size-[7px] shrink-0 rounded-full",
        value === "public" ? "bg-public" : value === "shared" ? "bg-shared" : "bg-private",
      )}
    />
  );
}
