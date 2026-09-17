import assert from "node:assert/strict";
import { test } from "node:test";
import type { PageAction, PageState } from "../src/extensions/browser/browser.ts";
import { actionSpace, buildBrowserRequest, parseFieldText, resolveDecision } from "../src/extensions/browser/policy.ts";

const actions: PageAction[] = [
	{ id: "e1", kind: "fill", node: 1, role: "searchbox", label: "Search", value: "" },
	{ id: "e2", kind: "click", node: 1, role: "searchbox", label: "Open Search", value: "" },
	{ id: "e3", kind: "click", node: 2, role: "button", label: "Go" },
	{ id: "e4", kind: "select", node: 3, role: "combobox", label: "Language → English", value: "en", current_value: "Deutsch" },
	{ id: "e5", kind: "select", node: 3, role: "combobox", label: "Language → Français", value: "fr", current_value: "Deutsch" },
	{ id: "scroll_down", kind: "scroll", label: "Scroll down", delta: 560 },
	{ id: "wait", kind: "wait", label: "Wait for the page to update" },
];

const page: PageState = { url: "https://example.org", title: "Example", w: 1120, h: 780, text: "hello", scroll: { y: 0, height: 2000 }, actions, marker: [], page_key: [], guards: {}, omitted_actions: 0, fingerprint: "f" };

test("actionSpace gives one index per node and per-operation targets", () => {
	const { elements, targets, controls } = actionSpace(actions);
	assert.equal(elements.length, 3);
	assert.deepEqual(elements[0].operations, ["TYPE_TEXT", "CLICK"]);
	assert.equal(Object.keys(targets.TYPE_TEXT).join(), "1");
	assert.equal(Object.keys(targets.CLICK).join(), "1,2");
	assert.deepEqual(Object.keys(targets.SELECT), ["3:1", "3:2"]);
	assert.equal(elements[2].value, "Deutsch");
	assert.deepEqual(Object.keys(controls), ["SCROLL_DOWN", "WAIT"]);
});

test("buildBrowserRequest fans out operation, target heads and Reflex safety heads", () => {
	const built = buildBrowserRequest(page, "search for cats", []);
	assert.deepEqual(Object.keys(built.questions).sort(), ["click_target", "irreversible", "needs_credentials", "operation", "select_target", "type_text_target"].sort());
	assert.ok("DONE" in built.operations && "BLOCKED" in built.operations && "SCROLL_DOWN" in built.operations);
});

test("resolveDecision consumes only the head of the chosen operation and rejects malformed answers", () => {
	const built = buildBrowserRequest(page, "search for cats", []);
	const answers = {
		operation: { type: "choice", choice: "TYPE_TEXT", probabilities: { TYPE_TEXT: 0.8, CLICK: 0.1, SELECT: 0.05, SCROLL_DOWN: 0.02, WAIT: 0.01, DONE: 0.01, BLOCKED: 0.01 }, confidence: 0.9 },
		type_text_target: { type: "choice", choice: "1", probabilities: { "1": 1 }, confidence: 1 },
		click_target: { type: "choice", choice: "2", probabilities: { "1": 0.2, "2": 0.8 }, confidence: 0.7 },
		select_target: { type: "choice", choice: "3:1", probabilities: { "3:1": 0.6, "3:2": 0.4 }, confidence: 0.3 },
		irreversible: { type: "noul", noul: 0.05 },
		needs_credentials: { type: "noul", noul: 0.02 },
	} as const;
	const d = resolveDecision(answers as never, built, 150, "jev-test");
	assert.equal(d.choice, "e1");
	assert.equal(d.operation, "TYPE_TEXT");
	assert.equal(d.probability, 1);
	assert.equal(d.irreversible, 0.05);
	const bad = { ...answers, type_text_target: { type: "choice", choice: "9", probabilities: { "1": 1 }, confidence: 1 } };
	assert.throws(() => resolveDecision(bad as never, built, 1, "x"), /Invalid TypeSafe target/);
});

test("parseFieldText is strict", () => {
	assert.equal(parseFieldText('{"text": "Zürich"}'), "Zürich");
	assert.equal(parseFieldText('Sure! {"text": null}'), null);
	assert.throws(() => parseFieldText('{"text": "a", "extra": 1}'));
	assert.throws(() => parseFieldText('{"value": "a"}'));
	assert.throws(() => parseFieldText("nothing"));
});
