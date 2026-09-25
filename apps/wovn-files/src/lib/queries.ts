// React Query definitions shared by app pages and the injected Banner. The
// File a page was rendered for lives in the cache under fileQuery(key), so a
// visibility flip updates every place that shows it.
import {
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query"
import { toast } from "sonner"

import {
  deleteFile,
  fetchAllFiles,
  fetchFile,
  fetchListing,
  fetchVersions,
  setVisibility,
} from "./api"
import type { FileMeta, Visibility } from "./types"

export const listingQuery = (prefix: string) =>
  queryOptions({
    queryKey: ["listing", prefix],
    queryFn: () => fetchListing(prefix),
  })

export const allFilesQuery = queryOptions({
  queryKey: ["files"],
  queryFn: fetchAllFiles,
})

export const fileQuery = (key: string) =>
  queryOptions({ queryKey: ["file", key], queryFn: () => fetchFile(key) })

export const versionsQuery = (key: string) =>
  queryOptions({
    queryKey: ["versions", key],
    queryFn: () => fetchVersions(key),
  })

// The text of a File small enough to show inline (see Preview).
export const textQuery = (url: string) =>
  queryOptions({
    queryKey: ["text", url],
    queryFn: async () => {
      const res = await fetch(url)
      if (!res.ok)
        throw new Error(`${res.status}: ${(await res.text()).trim()}`)
      return res.text()
    },
    staleTime: Infinity,
  })

// Flips a File's Visibility and refreshes every view that shows it.
export function useSetVisibility() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      key,
      visibility,
    }: {
      key: string
      visibility: Visibility
    }) => setVisibility(key, visibility),
    onSuccess: (meta: FileMeta) => {
      queryClient.setQueryData(fileQuery(meta.key).queryKey, meta)
      void queryClient.invalidateQueries({ queryKey: ["listing"] })
      void queryClient.invalidateQueries({ queryKey: ["files"] })
      toast.success(`${meta.key.split("/").pop()} is now ${meta.visibility}`)
    },
    onError: (cause) =>
      toast.error(cause instanceof Error ? cause.message : "flip failed"),
  })
}

// Deletes a File (and its Versions) and refreshes the listings. `onDeleted`
// runs after the toast, for a page that must navigate away from the File it
// was showing.
export function useDeleteFile(onDeleted?: (key: string) => void) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (key: string) =>
      deleteFile(key).then(({ deleted }) => ({ key, deleted })),
    onSuccess: ({ key, deleted }) => {
      queryClient.removeQueries({ queryKey: fileQuery(key).queryKey })
      void queryClient.invalidateQueries({ queryKey: ["listing"] })
      void queryClient.invalidateQueries({ queryKey: ["files"] })
      toast.success(
        `deleted ${key} (${deleted.length} object${deleted.length === 1 ? "" : "s"})`
      )
      onDeleted?.(key)
    },
    onError: (cause) =>
      toast.error(cause instanceof Error ? cause.message : "delete failed"),
  })
}

export function copyUrl(path: string) {
  navigator.clipboard.writeText(`${window.location.origin}${path}`).then(
    () => toast.success("URL copied"),
    () => toast.error("copy failed")
  )
}
