import { Popover as PopoverPrimitive } from "@base-ui/react/popover";

import { usePortalContainer } from "@/components/portal-container";
import { cn } from "@/lib/utils";

const Popover = PopoverPrimitive.Root;

// A popup positioned against `anchor` (or the Popover's own Trigger), rendered
// through the portal container so it reaches the Banner's shadow root.
function PopoverContent({
  className,
  anchor,
  side = "bottom",
  sideOffset = 4,
  align = "start",
  ...props
}: PopoverPrimitive.Popup.Props &
  Pick<PopoverPrimitive.Positioner.Props, "anchor" | "side" | "sideOffset" | "align">) {
  return (
    <PopoverPrimitive.Portal container={usePortalContainer()}>
      <PopoverPrimitive.Positioner
        anchor={anchor}
        side={side}
        sideOffset={sideOffset}
        align={align}
        className="isolate z-50"
      >
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          className={cn(
            "origin-(--transform-origin) rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            className,
          )}
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

export { Popover, PopoverContent };
