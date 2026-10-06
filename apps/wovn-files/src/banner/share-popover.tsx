import { Select as SelectPrimitive } from "@base-ui/react/select";
import { useRef, useState, type KeyboardEvent, type RefObject } from "react";

import { Popover, PopoverContent } from "@/components/ui/popover";
import { SelectContent, SelectItem } from "@/components/ui/select";
import { formatWhen } from "@/lib/format";
import { useSetVisibility } from "@/lib/queries";
import { isEmail, isShareExpired, MAX_SHARE_EMAILS, normalizeEmails } from "@/lib/share";
import type { FileMeta } from "@/lib/types";
import { cn } from "@/lib/utils";

// The share form (ADR 0005), anchored to whichever control opened it: the
// emails as chips, an expiry, and one "share" button that replaces the
// File's Share. Prefilled from the current Share, even an expired one, so a
// renewal is one click. The form's state lives only while it is open.
export function SharePopover({
  file,
  anchor,
  open,
  onOpenChange,
}: {
  file: FileMeta;
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverContent
        anchor={anchor}
        initialFocus={input}
        // No Trigger element, so focus returns to the control that opened it.
        finalFocus={anchor}
        className="w-[360px] max-w-[calc(100vw-1rem)] p-2.5 font-ui text-[13px] text-foreground"
      >
        {open && <ShareForm file={file} input={input} onDone={() => onOpenChange(false)} />}
      </PopoverContent>
    </Popover>
  );
}

// Expiry choices. "keep" (the current expiry, unchanged) appears only while
// the File has an unexpired Share and is then the default; a new Share
// defaults to 7 days.
const DURATIONS = { "1d": 1, "7d": 7, "30d": 30 } as const;
type Expiry = keyof typeof DURATIONS | "never" | "keep";

function ShareForm({
  file,
  input,
  onDone,
}: {
  file: FileMeta;
  input: RefObject<HTMLInputElement | null>;
  onDone: () => void;
}) {
  const share = useSetVisibility();
  const current = file.share;
  const keepable = current !== undefined && !isShareExpired(current);
  const [emails, setEmails] = useState<string[]>(current?.emails ?? []);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [expiry, setExpiry] = useState<Expiry>(keepable ? "keep" : "7d");
  // The clock the form opened at, so the "until" preview is stable across
  // re-renders; the submitted expiry counts from the click itself.
  const [openedAt] = useState(() => Date.now());

  // Moves the typed text (one address, or several separated by commas or
  // spaces) into the chips; reports the first bad one and keeps it typed.
  const commit = (): boolean => {
    const typed = normalizeEmails(draft.split(/[\s,]+/));
    const bad = typed.find((email) => !isEmail(email));
    if (bad) {
      setError(`${bad} is not an email address`);
      return false;
    }
    const next = normalizeEmails([...emails, ...typed]);
    if (next.length > MAX_SHARE_EMAILS) {
      setError(`at most ${MAX_SHARE_EMAILS} emails`);
      return false;
    }
    setEmails(next);
    setDraft("");
    setError(null);
    return true;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === "," || event.key === "Tab") {
      if (draft.trim()) {
        event.preventDefault();
        if (commit() && event.key === "Enter" && emails.length > 0) return;
      }
    } else if (event.key === "Backspace" && draft === "" && emails.length > 0) {
      setEmails(emails.slice(0, -1));
    }
  };

  const submit = () => {
    let list = emails;
    if (draft.trim()) {
      if (!commit()) return;
      list = normalizeEmails([...emails, ...draft.split(/[\s,]+/)]);
    }
    if (list.length === 0) {
      setError("add at least one email");
      return;
    }
    const expires =
      expiry === "keep"
        ? (current?.expires ?? null)
        : expiry === "never"
          ? null
          : new Date(Date.now() + DURATIONS[expiry] * 86_400_000).toISOString();
    share.mutate(
      { key: file.key, visibility: "shared", emails: list, expires },
      { onSuccess: onDone },
    );
  };

  const expiryLabel = (value: Expiry) =>
    value === "keep"
      ? `keep (${formatWhen(current!.expires!)})`
      : value === "never"
        ? "never"
        : `${DURATIONS[value]} day${DURATIONS[value] === 1 ? "" : "s"}`;
  const until =
    expiry === "never" || expiry === "keep"
      ? null
      : formatWhen(new Date(openedAt + DURATIONS[expiry] * 86_400_000).toISOString());
  const button = "cursor-pointer rounded-[5px] border px-2.5 py-0.5 disabled:opacity-50";

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <p className="pb-1.5 font-semibold">Share {file.key.split("/").pop()}</p>
      {/* The chips and the input share one bordered box; a click anywhere in it focuses the input. */}
      <div
        className={cn(
          "flex min-h-7 cursor-text flex-wrap items-center gap-1 rounded-[5px] border border-input px-1.5 py-1 font-mono text-[12.5px] focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/50",
          error && "border-destructive",
        )}
        onClick={() => input.current?.focus()}
      >
        {emails.map((email) => (
          <span
            key={email}
            className="inline-flex items-center gap-1 rounded border border-border bg-muted/50 px-1"
          >
            {email}
            <button
              type="button"
              className="cursor-pointer text-muted-foreground hover:text-foreground"
              aria-label={`remove ${email}`}
              onClick={() => setEmails(emails.filter((e) => e !== email))}
            >
              ×
            </button>
          </span>
        ))}
        <input
          ref={input}
          type="text"
          inputMode="email"
          autoComplete="off"
          spellCheck={false}
          className="min-w-24 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
          placeholder={emails.length ? "add another" : "add an email, Enter"}
          aria-label="emails to share with"
          aria-invalid={error !== null}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            if (error) setError(null);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => draft.trim() && commit()}
        />
      </div>
      {error && <p className="pt-1 text-[12px] text-destructive">{error}</p>}
      <div className="flex items-center gap-2 pt-2">
        <span className="text-muted-foreground">expires</span>
        <SelectPrimitive.Root<Expiry>
          value={expiry}
          onValueChange={(next) => next && setExpiry(next)}
        >
          <SelectPrimitive.Trigger
            className={cn(button, "border-input hover:bg-accent")}
            aria-label="expires"
          >
            {expiryLabel(expiry)} ▾
          </SelectPrimitive.Trigger>
          <SelectContent align="start" alignItemWithTrigger={false}>
            {([...(keepable ? ["keep" as const] : []), "1d", "7d", "30d", "never"] as Expiry[]).map(
              (value) => (
                <SelectItem key={value} value={value}>
                  {expiryLabel(value)}
                </SelectItem>
              ),
            )}
          </SelectContent>
        </SelectPrimitive.Root>
        {until && <span className="text-[12px] text-muted-foreground">until {until}</span>}
        <span className="flex-1" />
        <button
          type="button"
          className={cn(button, "border-transparent text-muted-foreground hover:bg-accent")}
          onClick={onDone}
        >
          cancel
        </button>
        <button
          type="submit"
          className={cn(button, "border-primary bg-primary text-primary-foreground")}
          disabled={share.isPending}
        >
          share
        </button>
      </div>
      <p className="pt-2 text-[12px] text-muted-foreground">
        Guests enter their email at files.wovn.org and the code Cloudflare emails them. The link is
        the File's own URL.
      </p>
    </form>
  );
}
