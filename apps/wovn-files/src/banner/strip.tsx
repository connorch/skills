import { Fragment, useEffect, useState, type MouseEvent, type ReactNode } from "react";

import { SearchPalette } from "@/components/search-palette";
import { cn } from "@/lib/utils";

// A panel the strip opens and closes: the Banner's Finder.
export interface StripPanel {
  open: boolean;
  onToggle: () => void;
  // The panel element's id, for aria-controls.
  id: string;
}

// The one-line strip at the top of every app surface: the breadcrumb on the
// left, page-specific controls on the right, and the ⌘K search that also
// answers the keyboard from anywhere on the page. With a `panel`, a click on
// any part of the strip that is not a control toggles it; a visually hidden
// button (shown on keyboard focus) does the same for keyboards and screen
// readers.
export function Strip({
  crumbs,
  prefix,
  children,
  panel,
}: {
  crumbs: ReactNode;
  // The Directory Route the search palette offers as an `in:` chip.
  prefix: string;
  // Controls before the ⌘K hint.
  children?: ReactNode;
  panel?: StripPanel;
}) {
  const [searchOpen, setSearchOpen] = useState(false);

  // ⌘K / Ctrl+K toggles the search palette; `/` opens it unless a text field
  // already has focus. Listens on window so it works over an HTML File too.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setSearchOpen((open) => !open);
      } else if (event.key === "/" && !isEditable(event)) {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Drop the ?wovn-authed=1 marker the /login flow appends, so copied URLs
  // stay clean.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.has("wovn-authed")) {
      url.searchParams.delete("wovn-authed");
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    }
  }, []);

  // Clicks inside portals (the palette, the visibility select) bubble here
  // through the React tree; only clicks on the strip's own DOM count.
  const onStripClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as Element;
    if (!panel || !event.currentTarget.contains(target)) return;
    if (target.closest("a, button, input, select, [role='combobox']")) return;
    panel.onToggle();
  };

  return (
    <div
      className={cn(
        "flex h-8 items-center gap-2.5 border-b border-border bg-card px-3 font-ui text-[13px] whitespace-nowrap tabular-nums select-none",
        panel &&
          "cursor-pointer [&:hover:not(:has(:is(a,button,[role=combobox]):hover))]:bg-accent/50",
      )}
      onClick={onStripClick}
    >
      {panel && (
        <button
          type="button"
          className="sr-only focus-visible:not-sr-only focus-visible:rounded focus-visible:px-1.5 focus-visible:ring-2 focus-visible:ring-ring/50"
          aria-expanded={panel.open}
          aria-controls={panel.id}
          onClick={panel.onToggle}
        >
          {panel.open ? "hide details" : "show details"}
        </button>
      )}
      {crumbs}
      <div className="ml-auto flex items-center gap-2.5 text-muted-foreground">
        {children}
        <button
          type="button"
          className="cursor-pointer rounded border border-border px-1.5 text-[11px] hover:bg-accent"
          title="search all files"
          onClick={() => setSearchOpen(true)}
        >
          ⌘K
        </button>
      </div>
      <SearchPalette open={searchOpen} onOpenChange={setSearchOpen} prefix={prefix} />
    </div>
  );
}

// Inside an HTML File the event target can be in the File's own document or
// in the Banner's shadow root; composedPath sees both.
function isEditable(event: KeyboardEvent): boolean {
  return event
    .composedPath()
    .some(
      (node) =>
        node instanceof HTMLElement &&
        (node.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName)),
    );
}

// Paths deeper than this keep the first folder and the last 2 in the strip;
// the rest fold into "…" (the full path is its tooltip).
const MAX_CRUMBS = 3;

// "files.wovn.org › a › b": every crumb but the last is a link to its
// Directory Route; `tail` renders the last one (a File name, or a Version).
// On a narrow strip the folder links shrink first, so the name stays readable.
export function Crumbs({ segments, tail }: { segments: string[]; tail: ReactNode }) {
  const folded = segments.length > MAX_CRUMBS ? segments.slice(1, -2) : [];
  return (
    <nav className="flex min-w-0 items-center gap-1.5 overflow-hidden">
      {segments.length === 0 && tail === null ? (
        <span className="font-semibold">files.wovn.org</span>
      ) : (
        <a className="shrink-[4] truncate text-muted-foreground hover:underline" href="/">
          files.wovn.org
        </a>
      )}
      {segments.map((segment, index) => {
        const directory = `/${segments.slice(0, index + 1).join("/")}/`;
        const last = tail === null && index === segments.length - 1;
        if (folded.length && index >= 1 && index <= folded.length) {
          return index === 1 ? (
            <Fragment key="folded">
              <Sep />
              <span
                className="text-muted-foreground"
                title={`/${segments.slice(0, -2).join("/")}/`}
              >
                …
              </span>
            </Fragment>
          ) : null;
        }
        return (
          <Fragment key={directory}>
            <Sep />
            {last ? (
              <span className="truncate font-semibold">{segment}</span>
            ) : (
              <a
                className="shrink-[4] truncate text-muted-foreground hover:underline"
                href={directory}
              >
                {segment}
              </a>
            )}
          </Fragment>
        );
      })}
      {tail !== null && (
        <>
          <Sep />
          {tail}
        </>
      )}
    </nav>
  );
}

export function Sep() {
  return <span className="text-muted-foreground/60">›</span>;
}

// A muted "·" between controls in the strip's right side.
export function Dot() {
  return <span className="text-muted-foreground/40">·</span>;
}
