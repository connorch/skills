// The event ledger both commands print: one line per event, append-only.
//
//    1.0s  connors-mac-studio   PLAN  origin/main a1b2c3d · 15 skills · wovn-cli
//    6.8s  connors-mac-studio   OK    15 skills (-1) · wovn-cli
//
// Only the tag and the time are styled, and styleText drops styling when
// stdout is not a terminal or NO_COLOR is set, so a piped ledger stays
// grep-able (`grep FAIL`).

import { styleText } from "node:util";

export type Tag = "INFO" | "PLAN" | "RUN" | "SKIP" | "OK" | "FAIL" | "DONE";

type Style = Parameters<typeof styleText>[0];

const TAG_STYLE: Record<Tag, Style> = {
  INFO: "bold",
  PLAN: "dim",
  RUN: "blue",
  SKIP: "yellow",
  OK: "green",
  FAIL: ["red", "bold"],
  DONE: "bold",
};

export interface Ledger {
  line(who: string, tag: Tag, message: string): void;
  // A FAIL line for the first line of `details`, with the rest as a block
  // under it, aligned with the message column.
  fail(who: string, details: string[]): void;
}

// `width` is the widest name that will appear in the second column.
export function createLedger(width: number): Ledger {
  const start = performance.now();
  const paint = (style: Style, text: string) => styleText(style, text, { stream: process.stdout });
  const indent = " ".repeat(5 + 2 + width + 2 + 4 + 2);

  const line = (who: string, tag: Tag, message: string) => {
    const elapsed = `${((performance.now() - start) / 1000).toFixed(1)}s`.padStart(5);
    console.log(
      `${paint("dim", elapsed)}  ${who.padEnd(width)}  ${paint(TAG_STYLE[tag], tag.padEnd(4))}  ${message}`,
    );
  };
  return {
    line,
    fail(who, [reason = "failed", ...rest]) {
      line(who, "FAIL", reason);
      for (const text of rest) console.log(`${indent}${text}`);
    },
  };
}
