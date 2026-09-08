import { cn } from "@/lib/utils"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      // No pulse: continuously repainting animations peg the GPU on
      // high-refresh displays, and the listing loads fast enough without one.
      className={cn("rounded-md bg-muted", className)}
      {...props}
    />
  )
}

export { Skeleton }
