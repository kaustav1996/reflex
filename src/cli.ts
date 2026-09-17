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

	if (sub === "connect") {
		const { runConnectCli } = await import("./extensions/mcp/connect.js");
		await runConnectCli(args.slice(1));
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
  reflex connect [id]                          enable a built-in MCP connector (gmail, slack, atlassian, linear)
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
