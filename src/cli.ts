#!/usr/bin/env node
/**
 * Reflex CLI entry point.
 *
 * Wraps the Pi coding agent (`main`) with:
 *  - an isolated config dir (~/.reflex/agent) so Reflex never touches ~/.pi
 *  - .env loading (cwd/.env and ~/.reflex/.env)
 *  - first-run onboarding for LLM / TypeSafe / voice keys
 *  - Reflex extensions: TypeSafe reflex layer, voice input, computer use, branding
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { getPiAgentDir, loadDotEnv, loadReflexConfig } from "./config.js";

import { ensureBrandShim } from "./brand.js";

const dotenvKeys = loadDotEnv();
process.env.REFLEX_DOTENV_KEYS = dotenvKeys.join(",");
// Config dir: with the brand shim Pi reads REFLEX_CODING_AGENT_DIR (and defaults to ~/.reflex/agent);
// without it (shim failed) it reads PI_CODING_AGENT_DIR. Set both.
process.env.REFLEX_CODING_AGENT_DIR ||= getPiAgentDir();
process.env.PI_CODING_AGENT_DIR ||= getPiAgentDir();
process.env.PI_SKIP_VERSION_CHECK ||= "1"; // our version is not pi's; don't nag about updates
const shim = ensureBrandShim(readOwnVersion());
if (shim) process.env.PI_PACKAGE_DIR ||= shim;

function readOwnVersion(): string {
	try {
		const require = createRequire(import.meta.url);
		return (require("../package.json") as { version: string }).version;
	} catch {
		return "0.0.0";
	}
}

const args = process.argv.slice(2);

async function run(): Promise<void> {
	const sub = args[0];

	if (sub === "setup" || sub === "onboard") {
		const { runOnboarding } = await import("./onboarding.js");
		const { validateTypesafeKey } = await import("./extensions/typesafe/client.js");
		await runOnboarding({ force: true, validateTypesafe: validateTypesafeKey });
		return;
	}

	if (sub === "web") {
		const { runWeb } = await import("./web/server.js");
		const portArg = args.indexOf("--port");
		await runWeb({ port: portArg >= 0 ? Number(args[portArg + 1]) : undefined, open: !args.includes("--no-open") });
		return;
	}

	if (sub === "agent" || sub === "agents") {
		const { runAgentCli } = await import("./agents/cli.js");
		await runAgentCli(args.slice(1));
		return;
	}

	if (sub === "artifact" || sub === "artifacts") {
		const { runArtifactCli } = await import("./artifacts/cli.js");
		await runArtifactCli(args.slice(1));
		return;
	}

	if (sub === "connect") {
		const { runConnectCli } = await import("./extensions/mcp/connect.js");
		await runConnectCli(args.slice(1));
		return;
	}

	if (sub === "jev" || sub === "decide") {
		const { runJevCli } = await import("./jevcli.js");
		await runJevCli(args.slice(1));
		return;
	}

	// The decision log, as a table: every Jev decision with its numbers, what code did, and what came of it.
	if (sub === "decisions") {
		const { readDecisions, decisionLogStats } = await import("./logs/decisions.js");
		const rest = args.slice(1);
		const flag = (name: string) => {
			const i = rest.indexOf(name);
			return i >= 0 ? rest[i + 1] : undefined;
		};
		const rows = readDecisions({
			limit: Number(flag("--limit") ?? 40),
			sources: (flag("--source") ?? "").split(",").filter(Boolean) as never,
			withOutcome: rest.includes("--with-outcome"),
		});
		const stats = decisionLogStats();
		if (!rows.length) {
			console.log(`no decisions logged yet (${stats.decisions} in the log)`);
			return;
		}
		for (const d of rows) {
			const when = new Date(d.at).toISOString().slice(5, 19).replace("T", " ");
			const numbers = Object.entries(d.signals)
				.map(([k, v]) => `${k}${v.pick ? `=${v.pick}` : ""} ${v.primitive === "score" ? v.value.toFixed(2) : `${Math.round(v.value * 100)}%`}${v.threshold === undefined ? "" : `/${v.threshold}`}`)
				.join(" · ");
			console.log(`${when}  ${d.source.padEnd(10)} ${d.action.padEnd(16)} ${d.summary.slice(0, 60)}`);
			console.log(`${" ".repeat(14)}${numbers}${d.band ? `  [${d.band}]` : ""}${d.model ? `  ${d.model}` : ""}${d.outcome ? `  → ${d.outcome.label}` : ""}`);
		}
		console.log(`\n${rows.length} shown · ${stats.decisions} decisions, ${stats.outcomes} outcomes, ${(stats.bytes / 1024).toFixed(0)} KB`);
		return;
	}

	// Climb against an eval: one change per round, held-out split, revert anything that doesn't hold up.
	if (sub === "hillclimb") {
		const rest = args.slice(1);
		const flag = (name: string) => {
			const i = rest.indexOf(name);
			return i >= 0 ? rest[i + 1] : undefined;
		};
		const specFile = rest.find((a) => !a.startsWith("--") && a.endsWith(".json")) ?? "reflex-eval.json";
		const surfaces = (flag("--surface") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
		if (!surfaces.length) throw new Error("--surface is required: the file(s) the climb may change, e.g. --surface prompts/system.md");
		const { loadSpec } = await import("./evals/spec.js");
		const { runEval } = await import("./evals/project.js");
		const { CLIMB_INSTRUCTIONS, climbReport, hillclimb } = await import("./evals/hillclimb.js");
		const spec = loadSpec(specFile);
		const goal = flag("--goal") ?? "performance";
		const rounds = Number(flag("--rounds") ?? 5);

		// The noise floor comes first: without it, a round can "win" by chance.
		let noise = Number(flag("--noise") ?? Number.NaN);
		if (Number.isNaN(noise)) {
			console.log(`measuring the noise floor: running "${spec.name}" twice, unchanged …`);
			const twice = await runEval(spec, { repeats: 2 });
			noise = twice.noise ?? 0;
			console.log(`  the score moved ${(noise * 100).toFixed(1)}% between identical runs; nothing smaller than that counts as a change\n`);
		}

		const propose = async (brief: string, round: number) => {
			const prompt = [
				CLIMB_INSTRUCTIONS,
				`\nRound ${round}. Goal: ${goal === "cost" ? "reduce cost while the score holds" : "improve the score"}.`,
				`Surfaces you may change: ${surfaces.join(", ")}`,
				flag("--notes") ? `\nHow the surface is used: ${flag("--notes")}` : "",
				`\nFailures on the training split:\n${brief}`,
			].join("\n");
			const { spawnSync } = await import("node:child_process");
			const r = spawnSync(process.execPath, [process.argv[1], "--mode", "text", "--reflex", "balanced", "-p", prompt], { cwd: spec.dir, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
			return (r.stdout ?? "").trim().split("\n").slice(-3).join(" ") || "(no reply)";
		};

		const result = await hillclimb(spec, {
			surfaces,
			rounds,
			noise,
			propose,
			onRound: (log) => console.log(`round ${log.round}: ${log.decision.keep ? "kept" : "reverted"} — ${log.decision.reason}`),
		});
		console.log(`\n${climbReport(result, noise)}`);
		const out = flag("--report");
		if (out) {
			const { writeClimbReport } = await import("./evals/hillclimb.js");
			writeClimbReport(out, result, noise);
			console.log(`\nwritten to ${out}`);
		}
		return;
	}

	// The labelled gate set: replay recorded answers (free, offline) or ask Jev now (needs a key).
	if (sub === "eval") {
		const rest = args.slice(1);
		const flag = (name: string) => {
			const i = rest.indexOf(name);
			return i >= 0 ? rest[i + 1] : undefined;
		};
		const config = flag("--config") ?? (rest.find((a) => !a.startsWith("--") && a.endsWith(".json")));
		if (config) {
			// A user's own eval: their cases, their runner, their grader.
			const { loadSpec } = await import("./evals/spec.js");
			const { runEval } = await import("./evals/project.js");
			const spec = loadSpec(config);
			const split = flag("--split");
			const repeats = Number(flag("--repeats") ?? spec.repeats ?? 1);
			const r = await runEval(spec, { split: split === "train" || split === "test" ? split : undefined, repeats, onCase: rest.includes("--quiet") ? undefined : (id, n) => process.stdout.write(`\r  ${id}${repeats > 1 ? ` (run ${n})` : ""}${" ".repeat(20)}`) });
			process.stdout.write("\r");
			for (const x of r.results.filter((x) => !x.pass)) console.log(`  ✗ ${x.id.padEnd(28)} ${(x.detail ?? x.error ?? "failed").slice(0, 90)}`);
			const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
			console.log(`\n${spec.name}: ${r.results.length} cases · score ${pct(r.score.all)} [${pct(r.interval[0])}–${pct(r.interval[1])}]`);
			console.log(`train ${pct(r.score.train)} · held-out ${pct(r.score.test)}${r.errors ? ` · ${r.errors} errored` : ""}`);
			if (r.noise !== undefined) console.log(`noise between identical runs: ${pct(r.noise)} — a change smaller than this is not a change`);
			return;
		}
		const { loadCases, scoreOffline, splitOf } = await import("./evals/gate.js");
		let cases = loadCases();
		const split = flag("--split");
		if (split === "train" || split === "test") cases = cases.filter((c) => splitOf(c.id) === split);
		const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
		let report: ReturnType<typeof scoreOffline>;
		let noise: Record<string, { maxSpread: number; meanSpread: number }> | undefined;
		if (rest.includes("--live")) {
			const { recordInto, runLive } = await import("./evals/run.js");
			const repeats = Number(flag("--repeats") ?? 1);
			console.log(`asking Jev about ${cases.length} cases${repeats > 1 ? ` × ${repeats} runs (to measure noise)` : ""} …`);
			const live = await runLive(cases, { repeats });
            report = live.report;
			noise = live.noise;
			for (const e of live.errors) console.log(`  ! ${e.id}: ${e.error}`);
			if (rest.includes("--record")) console.log(`recorded answers for ${recordInto(cases, live.signals)} cases`);
		} else {
			report = scoreOffline(cases);
			if (report.missingRecordings.length) console.log(`${report.missingRecordings.length} cases have no recorded answers (run with --live --record)`);
		}
		for (const r of report.results.filter((x) => !x.ok)) console.log(`  ✗ ${r.id.padEnd(30)} want ${r.label.padEnd(5)} got ${r.got.padEnd(5)} [${r.rule}]`);
		console.log(`\n${report.results.length} cases · accuracy ${pct(report.accuracy.all)} [${pct(report.interval[0])}–${pct(report.interval[1])}]`);
		console.log(`train ${pct(report.accuracy.train)} · held-out test ${pct(report.accuracy.test)}${report.accuracy.train - report.accuracy.test > 0.1 ? "   ← train far ahead of test: that is what overfitting looks like" : ""}`);
		console.log(Object.entries(report.byDecision).map(([k, v]) => `${k} ${v.correct}/${v.n}`).join(" · "));
		if (noise) {
			console.log("\nnoise between identical runs (a change smaller than this is not a change):");
			for (const [k, v] of Object.entries(noise)) console.log(`  ${k.padEnd(20)} max ${v.maxSpread.toFixed(3)} · mean ${v.meanSpread.toFixed(3)}`);
		}
		return;
	}

	if (sub === "doctor") {
		const { runDoctor } = await import("./doctor.js");
		await runDoctor();
		return;
	}

	if (sub === "help" || sub === "--help" || sub === "-h") {
		printHelp();
		return;
	}

	// Package commands go straight to Pi's package manager. They must reach it with the command as the
	// first argument: the flags added below (--use-theme, --model) would otherwise turn
	// `reflex install <source>` into a chat prompt.
	if (sub === "install" || sub === "remove" || sub === "uninstall" || sub === "update" || sub === "list" || sub === "config") {
		const { main } = await import("@earendil-works/pi-coding-agent");
		const { createReflexExtensions } = await import("./extensions/index.js");
		await main(args, { extensionFactories: createReflexExtensions(loadReflexConfig()) });
		return;
	}

	let config = loadReflexConfig();
	const interactive = process.stdin.isTTY && !args.includes("-p") && !args.includes("--print") && !args.includes("--mode");
	if (!config.onboarded && interactive) {
		const { runOnboarding } = await import("./onboarding.js");
		const { validateTypesafeKey } = await import("./extensions/typesafe/client.js");
		config = await runOnboarding({ validateTypesafe: validateTypesafeKey });
	}

	syncBundledSkills();
	const { main, SettingsManager } = await import("@earendil-works/pi-coding-agent");
	const { createReflexExtensions } = await import("./extensions/index.js");
	// Default model: Pi's settings win (Ctrl+S in /model); otherwise fall back to reflex.json, unless the user passed one.
	const userPickedModel = args.some((a) => a === "--model" || a === "--provider" || a.startsWith("--model=") || a.startsWith("--provider="));
	if (!userPickedModel && config.llm.provider && config.llm.model) {
		const settings = SettingsManager.create(process.cwd(), getPiAgentDir());
		if (!settings.getDefaultModel()) args.unshift("--model", `${config.llm.provider}/${config.llm.model}`);
	}
	// Look: reflex.json `ui.theme` wins over Pi's auto-detected built-in ("dark"/"light"); a theme the
	// user picked in /settings (anything else) is respected. --use-theme on the command line wins over both.
	if (!args.some((a) => a === "--use-theme" || a === "--theme")) {
		const settings = SettingsManager.create(process.cwd(), getPiAgentDir());
		const saved = settings.getThemeSetting();
		const wanted = config.ui?.theme ?? "typesafe";
		if (!saved || saved === "dark" || saved === "light") args.unshift("--use-theme", wanted);
	}
	await main(args, { extensionFactories: createReflexExtensions(config) });
}

/** Copy bundled skills and themes into ~/.reflex/agent so Pi discovers them. */
function syncBundledSkills(): void {
	try {
		const require = createRequire(import.meta.url);
		const pkgDir = dirname(require.resolve("../package.json"));
		const { readdirSync } = require("node:fs") as typeof import("node:fs");
		const copyIfChanged = (from: string, to: string) => {
			const content = readFileSync(from, "utf8");
			if (existsSync(to) && readFileSync(to, "utf8") === content) return;
			mkdirSync(dirname(to), { recursive: true });
			writeFileSync(to, content);
		};
		const skills = join(pkgDir, "skills");
		if (existsSync(skills)) {
			for (const name of readdirSync(skills)) {
				const from = join(skills, name, "SKILL.md");
				if (existsSync(from)) copyIfChanged(from, join(getPiAgentDir(), "skills", name, "SKILL.md"));
			}
		}
		const themes = join(pkgDir, "themes");
		if (existsSync(themes)) {
			for (const file of readdirSync(themes)) if (file.endsWith(".json")) copyIfChanged(join(themes, file), join(getPiAgentDir(), "themes", file));
		}
	} catch {
		/* skills and themes are a nicety; never block startup */
	}
}

function printHelp(): void {
	console.log(`reflex — a coding agent & assistant with System One reflexes

Usage:
  reflex [pi options] [@files...] [message]   start the agent (interactive)
  reflex -p "prompt"                          non-interactive, print and exit
  reflex setup                                (re)run onboarding for keys & preferences
  reflex doctor                               check keys, ffmpeg, TypeSafe reachability
  reflex web [--port 7331] [--no-open]        browser interface: sessions, agents (cron/webhooks), settings
  reflex agent list|run|runs|create|delete    scheduled / webhook agents (see skill reflex-agents)
  reflex agent run <id> --trial               trial run: external steps are reported, not run
  reflex agent export <id> | import <file>     share an agent as a .reflex-agent.json; import opens a review session
  reflex decisions [--source gate] [--limit 40]  every Jev decision: its numbers, what code did, what came of it
  reflex eval [--live] [--repeats 2] [--split test]  the labelled gate set: accuracy, held-out split, noise
  reflex eval <your-eval.json>                 run your own eval (cases, runner, grader; see skill reflex-evals)
  reflex hillclimb <your-eval.json> --surface prompts/system.md [--notes "how the file is used"]
  reflex jev --state <text|@file> --questions <json|@file>   ask TypeSafe Jev directly (typed decisions in ~100ms)
  reflex connect [id]                          enable a built-in MCP connector (gmail, slack, atlassian, linear)
  reflex install <source> | remove <source>    install or remove a Pi package (e.g. git:github.com/affaan-m/ECC)
  reflex list | update                         list installed packages, or update them
  reflex install <npm:pkg|git:repo>           install a Pi package (extensions, skills, prompts, themes)

Inside the agent:
  /reflex            show / change the reflex policy (risk appetite, gating, routing)
  /reflex stats      what Jev decided this session (auto-allowed, asked, blocked)
  /voice             push-to-talk: record, transcribe, send   (also ctrl+shift+v)
  /computer          toggle the macOS computer-use tools
  /setup             re-run onboarding inside the TUI
  /model             switch LLM (any OpenRouter model, Anthropic, OpenAI, ...)

All Pi flags work (e.g. --model openrouter/anthropic/claude-sonnet-4.6, -c, --thinking high).
Config: ~/.reflex/reflex.json · keys: ~/.reflex/agent/auth.json · env: OPENROUTER_API_KEY, TYPESAFE_API_KEY, SARVAM_API_KEY
`);
}

run().catch((err) => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
});
