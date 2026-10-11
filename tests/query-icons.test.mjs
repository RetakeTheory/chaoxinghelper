import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { transpileModule, JsxEmit, ModuleKind, ScriptTarget } from "typescript";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { QUERY_ICON_PATHS } from "../lib/query-icons.ts";

test("every query icon renders local SVG paths, inherits color and remains decorative/non-focusable", async () => {
  const source = await readFile(new URL("../app/query/QueryIcon.tsx", import.meta.url), "utf8");
  const result = transpileModule(source, { compilerOptions: { jsx: JsxEmit.ReactJSX, module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } });
  const module = result.outputText
    .replace('"react/jsx-runtime"', JSON.stringify(import.meta.resolve("react/jsx-runtime")))
    .replace('"../../lib/query-icons"', JSON.stringify(new URL("../lib/query-icons.ts", import.meta.url).href));
  const { QueryIcon } = await import(`data:text/javascript;base64,${Buffer.from(module).toString("base64")}`);
  for (const name of Object.keys(QUERY_ICON_PATHS)) {
    const svg = renderToStaticMarkup(createElement(QueryIcon, { name, className: "test-icon" }));
    assert.match(svg, /^<svg /);
    assert.match(svg, /class="cx-query-icon test-icon"/);
    assert.ok(svg.includes(`data-query-icon="${name}"`));
    assert.match(svg, /viewBox="0 0 24 24"/);
    assert.match(svg, /stroke="currentColor"/);
    assert.match(svg, /aria-hidden="true" focusable="false"/);
    assert.match(svg, /<path /);
    assert.doesNotMatch(svg, /<text|<image|<use|https?:|foreignObject|[✓✔✕×⚠ℹ]/);
  }
});

test("verification, feedback, close and copy icons no longer use text glyphs", async () => {
  const [page, feedback, css] = await Promise.all(["app/query/page.tsx", "app/query/QueryFeedback.tsx", "app/query/query.css"].map(path => readFile(new URL(`../${path}`, import.meta.url), "utf8")));
  assert.doesNotMatch(page + feedback, /[✓✔✕✖×✗⚠ℹ]/);
  assert.match(page, /challenge \? <QueryIcon name="check"/);
  assert.match(feedback, /<QueryIcon name=\{toast.kind\}/);
  assert.match(feedback, /aria-label="关闭提示"><QueryIcon name="close"/);
  assert.match(feedback, /aria-label="复制错误日志"><QueryIcon name=\{copied \? "check" : "copy"\}/);
  assert.doesNotMatch(page, /<span className="cx-query-spinner"/);
  assert.match(page, /<QueryIcon name="loader" className="cx-query-spinner"/);
  assert.match(css, /\.cx-query-spinner\{width:14px;height:14px;animation:cx-spin/);
  assert.match(css, /prefers-reduced-motion:reduce/);
  assert.match(feedback, /setTimeout\(\(\) => dismiss\(toast.id\), 3000\)/);
});
