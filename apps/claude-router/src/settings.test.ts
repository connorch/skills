import { describe, expect, it } from "vite-plus/test";
import { diff, withoutRouter, withRouter } from "./settings.ts";

const URL = "http://127.0.0.1:47880";
const original = `{
  "enabledPlugins": {
    "warp@claude-code-warp": true
  },
  "theme": "dark"
}
`;

describe("settings", () => {
  it("adds only env.ANTHROPIC_BASE_URL and removes it byte for byte", () => {
    const on = withRouter(original, URL);
    expect(on).toContain(`"ANTHROPIC_BASE_URL": "${URL}"`);
    expect(diff(original, on)).toEqual([
      `-   "theme": "dark"`,
      `+   "theme": "dark",`,
      `+   "env": {`,
      `+     "ANTHROPIC_BASE_URL": "${URL}"`,
      "+   }",
    ]);
    expect(withoutRouter(on)).toBe(original);
  });

  it("keeps other env keys and the file's indent", () => {
    const four = `{\n    "env": {\n        "FOO": "1"\n    }\n}\n`;
    const on = withRouter(four, URL);
    expect(on).toBe(
      `{\n    "env": {\n        "FOO": "1",\n        "ANTHROPIC_BASE_URL": "${URL}"\n    }\n}\n`,
    );
    expect(withoutRouter(on)).toBe(four);
  });

  it("refuses to replace a base URL that is not the router's", () => {
    const foreign = `{"env":{"ANTHROPIC_BASE_URL":"https://proxy.example"}}`;
    expect(() => withRouter(foreign, URL)).toThrow(/already sets env.ANTHROPIC_BASE_URL/);
    expect(withRouter(withRouter("", URL), URL)).toBe(withRouter("", URL));
  });

  it("handles a missing file and a settings.json without a trailing newline", () => {
    expect(withRouter("", URL)).toBe(`{\n  "env": {\n    "ANTHROPIC_BASE_URL": "${URL}"\n  }\n}\n`);
    expect(withoutRouter(withRouter(`{"theme":"dark"}`, URL))).toBe(`{\n  "theme": "dark"\n}`);
    expect(withoutRouter(`{"theme":"dark"}`)).toBe(`{"theme":"dark"}`);
  });
});
