// Runner for the trimming eval: reads a case on stdin, trims a generated output with live Jev,
// and prints what survived. Used by tests/fixtures/trim-eval.json.
import { readFileSync } from "node:fs";
import { createKeyResolver, loadDotEnv, loadReflexConfig } from "../../dist/config.js";
import { buildTrimQuestions, TRIM_KEEP_THRESHOLD } from "../../dist/extensions/typesafe/policy.js";
import { createJevClient } from "../../dist/extensions/typesafe/provider.js";
import { piStoredApiKey } from "../../dist/extensions/typesafe/state.js";
import { applyTrim, planTrim } from "../../dist/extensions/typesafe/trim.js";

const { task, command, output } = JSON.parse(readFileSync(0, "utf8"));
loadDotEnv();
const cfg = loadReflexConfig();
// Keys can come from the environment, keys.json or Pi's own sign-in: resolve all three.
const made = createJevClient(cfg, createKeyResolver(piStoredApiKey), { timeoutMs: 20000 });
if (!made) { console.error("no key"); process.exit(2); }
const plan = planTrim(output);
if (plan.skip) { console.log(output); process.exit(0); }
const askable = plan.chunks.filter((c) => !c.pinned);
const res = await made.client.systemOne({
  purpose: "eval:trim",
  state: { task, command, ...Object.fromEntries(askable.map((c) => [`chunk_${c.index}`, c.text])) },
  questions: buildTrimQuestions(askable.map((c) => c.index)),
});
const out = applyTrim(output, plan, (c) => (res.answers[`chunk_${c.index}`]?.noul ?? 1) >= TRIM_KEEP_THRESHOLD);
console.log(out.text);
