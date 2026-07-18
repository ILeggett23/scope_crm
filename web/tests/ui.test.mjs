import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { debounce, yieldToBrowser } from "../src/ui.js";

test("debounce coalesces rapid transaction filter updates", () => {
  let nextID = 0;
  const callbacks = new Map();
  const timers = {
    setTimeout(callback) {
      const id = ++nextID;
      callbacks.set(id, callback);
      return id;
    },
    clearTimeout(id) {
      callbacks.delete(id);
    }
  };
  const values = [];
  const update = debounce(value => values.push(value), 120, timers);

  update("first");
  update("latest");

  assert.equal(callbacks.size, 1);
  [...callbacks.values()][0]();
  assert.deepEqual(values, ["latest"]);
});

test("debounced updates can be cancelled when a view is replaced", () => {
  const callbacks = new Map();
  const timers = {
    setTimeout(callback) {
      callbacks.set(1, callback);
      return 1;
    },
    clearTimeout(id) {
      callbacks.delete(id);
    }
  };
  const update = debounce(() => assert.fail("cancelled callback ran"), 120, timers);
  update();
  update.cancel();
  assert.equal(callbacks.size, 0);
});

test("yieldToBrowser resolves outside a browser runtime", async () => {
  await yieldToBrowser();
});

test("mobile UI contract prevents toolbar overflow and duplicate primary actions", async () => {
  const [css, app, html] = await Promise.all([
    readFile(new URL("../styles.css", import.meta.url), "utf8"),
    readFile(new URL("../src/app.js", import.meta.url), "utf8"),
    readFile(new URL("../index.html", import.meta.url), "utf8")
  ]);

  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /id="mobile-more-button"/);
  assert.match(app, /function openMoreMenu\(\)/);
  assert.match(app, /\["mileage", "Mileage"/);
  assert.match(app, /\["reports", "Reports"/);
  assert.match(app, /\["import", "Import"/);
  assert.match(app, /section-toolbar transaction-toolbar/);
  assert.match(app, /mobile-redundant-action/);
  assert.match(css, /\.transaction-toolbar \.mobile-redundant-action\s*\{\s*display:\s*none/);
  assert.match(css, /\.filter-row\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(css, /\.section-toolbar\s*\{[^}]*flex-direction:\s*column/s);
  assert.match(css, /button, input, select, textarea\s*\{\s*min-width:\s*0/);
  assert.doesNotMatch(app, /No events yet[\s\S]{0,220}data-action="add-event"/);

  const budgetView = app.slice(app.indexOf("function renderBudget()"), app.indexOf("function renderEvents()"));
  assert.equal(budgetView.match(/data-action="add-budget"/g)?.length, 1);
  assert.match(budgetView, /budget-toolbar/);
  assert.match(css, /\.budget-toolbar\s*\{[^}]*gap:\s*22px/s);
});

test("assistant UI and response code are fully removed", async () => {
  const [html, app, finance, css, icons] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../src/app.js", import.meta.url), "utf8"),
    readFile(new URL("../src/finance.js", import.meta.url), "utf8"),
    readFile(new URL("../styles.css", import.meta.url), "utf8"),
    readFile(new URL("../assets/icons.svg", import.meta.url), "utf8")
  ]);

  for (const source of [html, app, finance, css]) {
    assert.doesNotMatch(source, /assistant|openai|chatgpt/i);
  }
  assert.doesNotMatch(icons, /icon-(sparkles|send)/);
  assert.equal((html.match(/id="quick-add-button"/g) || []).length, 1);
});
