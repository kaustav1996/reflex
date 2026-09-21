/**
 * Assemble all Reflex extensions as inline Pi extensions.
 */
import { createRequire } from "node:module";
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { getReflexConfigPath, type ReflexConfig, storeKey } from "../config.js";
import { createAgentsExtension } from "./agents/index.js";
import { createArtifactsExtension } from "./artifacts/index.js";
import { createHooksExtension } from "./hooks/index.js";
import { createLogsExtension } from "./logs.js";
import { createBrowserExtension } from "./browser/index.js";
import { createComputerExtension } from "./computer/index.js";
import { createMcpExtension } from "./mcp/index.js";
import { createSecretsExtension } from "./secrets/index.js";
import { createTypesafeExtension } from "./typesafe/index.js";
import type { ReflexState } from "./typesafe/state.js";
import { createUiExtension } from "./ui/header.js";
import { createModelsExtension } from "./ui/models.js";
import { createPresenceExtension } from "./ui/presence.js";
import { createVoiceExtension } from "./voice/index.js";

const require = createRequire(import.meta.url);
const VERSION: string = (() => {
	try {
		return (require("../../package.json") as { version: string }).version;
	} catch {
		return "0.0.0";
	}
})();

export function createReflexExtensions(config: ReflexConfig): InlineExtension[] {
	const shared: { state?: ReflexState } = {};
	return [
		{ name: "reflex-ui", factory: createUiExtension(config, VERSION), hidden: true },
		{ name: "reflex-logs", factory: createLogsExtension(), hidden: true },
		{ name: "reflex-models", factory: createModelsExtension(), hidden: true },
		{ name: "reflex-presence", factory: createPresenceExtension(), hidden: true },
		{
			name: "reflex-typesafe",
			factory: (pi: ExtensionAPI) => {
				shared.state = createTypesafeExtension(config)(pi);
			},
		},
		{ name: "reflex-voice", factory: createVoiceExtension(config, () => shared.state) },
		{ name: "reflex-computer", factory: createComputerExtension(config) },
		{ name: "reflex-browser", factory: createBrowserExtension(config, () => shared.state) },
		{ name: "reflex-agents", factory: createAgentsExtension() },
		{ name: "reflex-mcp", factory: createMcpExtension() },
		{ name: "reflex-secrets", factory: createSecretsExtension(config, () => shared.state) },
		{ name: "reflex-artifacts", factory: createArtifactsExtension(() => shared.state) },
		{ name: "reflex-hooks", factory: createHooksExtension(() => shared.state) },
		{ name: "reflex-setup", factory: createSetupExtension(config, () => shared.state), hidden: true },
	];
}

/** In-TUI key management: /setup lets you add TypeSafe / voice keys without leaving the agent. */
function createSetupExtension(config: ReflexConfig, getReflex: () => ReflexState | undefined): (pi: ExtensionAPI) => void {
	return (pi) => {
		pi.registerCommand("setup", {
			description: "Reflex setup: add or replace TypeSafe / voice API keys (LLM keys: use /login)",
			handler: async (_args, ctx) => {
				const choice = await ctx.ui.select("What do you want to set up?", [
					"TypeSafe API key (reflex layer)",
					"Sarvam API key (voice)",
					"OpenAI key for voice",
					"Groq key for voice",
					"Deepgram key for voice",
					"LLM provider key (opens /login)",
					"Show config paths",
				]);
				if (!choice) return;
				const map: Record<string, string> = {
					"TypeSafe API key (reflex layer)": "typesafe",
					"Sarvam API key (voice)": "sarvam",
					"OpenAI key for voice": "openai",
					"Groq key for voice": "groq",
					"Deepgram key for voice": "deepgram",
				};
				if (choice.startsWith("LLM provider")) {
					ctx.ui.notify("Type /login to add an LLM provider key (stored in ~/.reflex/agent/auth.json). Or run `reflex setup` in a terminal.", "info");
					return;
				}
				if (choice.startsWith("Show config")) {
					ctx.ui.notify(`config: ${getReflexConfigPath()} · keys: ~/.reflex/keys.json · pi: ~/.reflex/agent/`, "info");
					return;
				}
				const service = map[choice];
				const key = await ctx.ui.input(`${service} API key (stored 0600 in ~/.reflex/keys.json)`, "paste key");
				if (!key?.trim()) return;
				storeKey(service, key.trim());
				if (service === "typesafe") {
					config.reflex.enabled = true;
					getReflex()?.reload();
				}
				if (service !== "typesafe" && config.voice.provider === "none") config.voice.provider = service as ReflexConfig["voice"]["provider"];
				ctx.ui.notify(`Saved ${service} key. ${service === "typesafe" ? "Reflex layer is now active." : "Voice ready: /voice"}`, "info");
			},
		});
	};
}
