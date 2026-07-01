---
name: code-trust-pragma
description: >-
  Use top-line `@airef` pragmas to control how AI models reference a file or
  snippet when selecting implementation examples. Always add an `@airef caution`
  pragma when generating new files or significantly remodeling existing code.
  Applies when annotating code quality, weighting context examples, or marking
  files as preferred or ignored reference material.
---

# Code Reference Pragmas

## Core Rules

**Read:** Check the first comment line of a file or snippet for an `@airef`
pragma before borrowing patterns from it.

**Write:** Add `@airef caution` as the first comment line when creating a new
file or significantly remodeling existing code. Do not add or change pragmas
for small edits. Only a human should promote to `preferred` or demote to
`ignore`.

## Reference Levels

| Pragma             | Meaning                                              |
| ------------------ | ---------------------------------------------------- |
| `@airef preferred` | Preferred reference. Borrow patterns freely.         |
| `@airef caution`   | Cross-check against docs or preferred sources first. |
| `@airef ignore`    | Skip entirely. Do not borrow patterns.               |

No pragma = **unannotated**. Ranking: `preferred` > unannotated > `caution` > `ignore`.

## Syntax

Use the file's native comment style on the first line:

```
// @airef caution        ← JS/TS/C/Go/Java/Rust
#  @airef preferred          ← Python/Ruby/Shell
/* @airef ignore */        ← CSS
-- @airef caution          ← SQL/Lua
<!-- @airef preferred -->  ← HTML
```
