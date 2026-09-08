import { createContext, useContext } from "react"

// Where Base UI portals (dialogs, the search palette, the visibility select)
// render. On app pages this is null, meaning document.body; inside an HTML
// File the Banner lives in a shadow root and its portals must land there
// too, or the app stylesheet cannot reach them.
const PortalContainerContext = createContext<HTMLElement | ShadowRoot | null>(
  null
)

export const PortalContainerProvider = PortalContainerContext.Provider

export function usePortalContainer(): HTMLElement | ShadowRoot | undefined {
  return useContext(PortalContainerContext) ?? undefined
}
