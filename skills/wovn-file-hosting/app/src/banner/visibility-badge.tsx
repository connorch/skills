import { Select as SelectPrimitive } from "@base-ui/react/select"

import { SelectContent, SelectItem } from "@/components/ui/select"
import { useSetVisibility } from "@/lib/queries"
import type { FileMeta, Visibility } from "@/lib/types"
import { cn } from "@/lib/utils"

// The Visibility indicator in the strip: a dot and a word. For the current
// File it opens a two-option select and flips in place; a Version is always
// private, so its badge is static.
export function VisibilityBadge({
  file,
  readOnly,
}: {
  file: FileMeta
  readOnly?: boolean
}) {
  const flip = useSetVisibility()
  const value: Visibility = readOnly ? "private" : file.visibility

  if (readOnly) return <VisibilityLabel value={value} />

  return (
    <SelectPrimitive.Root
      value={value}
      onValueChange={(next) => {
        if (next && next !== value)
          flip.mutate({ key: file.key, visibility: next })
      }}
    >
      <SelectPrimitive.Trigger
        className="cursor-pointer rounded px-1 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
        title="change visibility"
        disabled={flip.isPending}
      >
        <VisibilityLabel value={value} />
      </SelectPrimitive.Trigger>
      <SelectContent
        align="start"
        className="font-mono text-[12.5px]"
        alignItemWithTrigger={false}
      >
        <SelectItem value="public">
          <VisibilityLabel value="public" />
        </SelectItem>
        <SelectItem value="private">
          <VisibilityLabel value="private" />
        </SelectItem>
      </SelectContent>
    </SelectPrimitive.Root>
  )
}

export function VisibilityLabel({ value }: { value: Visibility }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
      <span
        className={cn(
          "inline-block size-[7px] rounded-full",
          value === "public" ? "bg-public" : "bg-private"
        )}
      />
      {value}
    </span>
  )
}
