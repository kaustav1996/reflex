/**
 * Reflex configuration: brand constants, config directory, key resolution.
 *
 * Reflex is a Pi coding agent with a "System One" reflex layer (TypeSafe Jev).
 * Pi's own config lives under ~/.reflex/agent (auth.json, settings.json, sessions/…)
 * because we set PI_CODING_AGENT_DIR before Pi loads. Reflex-specific settings
 * live in ~/.reflex/reflex.json.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const BRAND = "Reflex";
export const BRAND_CLI = "reflex";
export const BRAND_TAGLINE = "a coding agent & assistant with System One reflexes";

export function getReflexHome(): string {
	const env = process.env.REFLEX_HOME;
	if (env) return env.startsWith("~/") ? join(homedir(), env.slice(2)) : resolve(env);
	return join(homedir(), ".reflex");
}

/** Pi's agent dir (auth.json, settings.json, sessions, extensions, skills). */
export function getPiAgentDir(): string {
	return join(getReflexHome(), "agent");
}

export function getReflexConfigPath(): string {
	return join(getReflexHome(), "reflex.json");
}

/** Voice (speech-to-text) providers Reflex knows how to talk to. */
export type VoiceProviderId = "sarvam" | "openai" | "groq" | "deepgram" | "whisper-cpp" | "none";

export interface VoiceConfig {
	provider: VoiceProviderId;
	/** BCP-47 code for Sarvam (e.g. "en-IN", "hi-IN", "unknown" = auto-detect). */
	language: string;
	/** Model override per provider (e.g. "saarika:v2.5", "whisper-1", "whisper-large-v3-turbo", "nova-3"). */
	model?: string;
	/** Push-to-talk shortcut inside the TUI. */
	shortcut: string;
	/** Path to whisper.cpp binary + model when provider = whisper-cpp. */
	whisperCppBin?: string;
	whisperCppModel?: string;
	/** Translate non-English speech to English (Sarvam Saaras) instead of transcribing verbatim. */
	translateToEnglish: boolean;
}

/** How much risk the reflex layer may take on before asking you. */
export type RiskAppetite = "cautious" | "balanced" | "bold";

export interface ReflexPolicyConfig {
	/** Master switch for the Jev reflex layer. */
	enabled: boolean;
	riskAppetite: RiskAppetite;
	/** Gate tool calls (bash/edit/write/computer) through Jev before execution. */
	gateToolCalls: boolean;
	/** After each turn, ask Jev whether the agent is looping / stuck / claiming success without verification. */
	monitorProgress: boolean;
	/** Route each new user task to a cheaper/faster model when Jev is confident it is simple. */
	routeModels: boolean;
	/** Classify voice transcripts (command vs. task vs. noise) before sending to the LLM. */
	classifyVoice: boolean;
	/** Extra paths (globs) that are always considered sensitive. */
	protectedPaths: string[];
	/** Model routing tiers: pi model ids like "openrouter/anthropic/claude-sonnet-4.6". */
	routing: {
		fast?: string;
		default?: string;
		strong?: string;
	};
	/** Jev model id. */
	model: string;
	/** Where Jev is called: TypeSafe's API, OpenRouter's System One endpoint, or whichever key exists ("auto"). */
	provider: "auto" | "typesafe" | "openrouter";
	/** Hard timeout for a single Jev request. On timeout the gate falls back to "ask". */
	timeoutMs: number;
	/** Show every Jev decision as a line in the chat (off: only asks/blocks/nudges are visible). */
	verbose: boolean;
	/** Before each prompt, let Jev pick the relevant skill and MCP connector and hint the model. */
	selectSkills: boolean;
}

export interface ReflexConfig {
	version: 1;
	onboarded: boolean;
	voice: VoiceConfig;
	reflex: ReflexPolicyConfig;
	/** Default LLM: pi provider + model id. */
	llm: { provider?: string; model?: string; thinkingLevel?: string };
	/** Look and feel. */
	ui: { theme: "typesafe" | "typesafe-light" | string };
	/** Jev-driven browser automation. */
	browser: BrowserConfig;
}

export interface BrowserConfig {
	/** Run Chrome headless (default: visible window so you can watch). */
	headless: boolean;
	/** Attach to an existing Chrome DevTools endpoint instead of launching (e.g. http://127.0.0.1:9222). */
	attachUrl?: string;
	/** Pi model ref for the tiny text helper that writes field values, e.g. "openrouter/google/gemini-3.1-flash-lite-preview". Defaults to the session model. */
	textModel?: string;
	maxSteps: number;
}

export const DEFAULT_CONFIG: ReflexConfig = {
	version: 1,
	onboarded: false,
	voice: {
		provider: "sarvam",
		language: "unknown",
		shortcut: "ctrl+shift+v",
		translateToEnglish: false,
	},
	reflex: {
		enabled: true,
		riskAppetite: "balanced",
		gateToolCalls: true,
		monitorProgress: true,
		routeModels: false,
		classifyVoice: true,
		protectedPaths: [".env", "**/.env*", "**/*.pem", "**/id_rsa*", "~/.ssh/**", "~/.aws/**"],
		routing: {},
		model: "jev-latest",
		provider: "auto",
		timeoutMs: 4000,
		verbose: true,
		selectSkills: true,
	},
	llm: { provider: "openrouter", model: "anthropic/claude-sonnet-4.6" },
	ui: { theme: "typesafe" },
	browser: { headless: false, maxSteps: 60 },
};

export function loadReflexConfig(): ReflexConfig {
	const path = getReflexConfigPath();
	if (!existsSync(path)) return structuredClone(DEFAULT_CONFIG);
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ReflexConfig>;
		return deepMerge(structuredClone(DEFAULT_CONFIG) as unknown as Record<string, unknown>, parsed as Record<string, unknown>) as unknown as ReflexConfig;
	} catch {
		return structuredClone(DEFAULT_CONFIG);
	}
}

export function saveReflexConfig(config: ReflexConfig): void {
	mkdirSync(getReflexHome(), { recursive: true });
	writeFileSync(getReflexConfigPath(), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function deepMerge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
	for (const [k, v] of Object.entries(over)) {
		if (v && typeof v === "object" && !Array.isArray(v) && base[k] && typeof base[k] === "object") {
			base[k] = deepMerge(base[k] as Record<string, unknown>, v as Record<string, unknown>);
		} else if (v !== undefined) {
			base[k] = v;
		}
	}
	return base;
}

// ---------------------------------------------------------------------------
// .env loading (no dependency). Only sets variables that are not already set.
// ---------------------------------------------------------------------------

export function loadDotEnv(dir: string = process.cwd()): string[] {
	const loaded: string[] = [];
	const candidates = [join(dir, ".env"), join(getReflexHome(), ".env")];
	for (const file of candidates) {
		if (!existsSync(file)) continue;
		let text: string;
		try {
			text = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		for (const rawLine of text.split(/\r?\n/)) {
			const line = rawLine.trim();
			if (!line || line.startsWith("#")) continue;
			const eq = line.indexOf("=");
			if (eq <= 0) continue;
			const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
			let value = line.slice(eq + 1).trim();
			if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
				value = value.slice(1, -1);
			}
			if (!process.env[key]) {
				process.env[key] = value;
				loaded.push(key);
			}
		}
	}
	return loaded;
}

// ---------------------------------------------------------------------------
// Key resolution.
// LLM keys are owned by Pi (env vars, ~/.reflex/agent/auth.json via ModelRuntime).
// Non-LLM service keys (TypeSafe, Sarvam, Deepgram, …) live in ~/.reflex/keys.json (0600).
// Env always wins so CI / .env can override stored keys.
// ---------------------------------------------------------------------------

/** Env var per service. LLM provider ids match Pi's provider ids. */
export const SERVICE_ENV: Record<string, string> = {
	typesafe: "TYPESAFE_API_KEY",
	sarvam: "SARVAM_API_KEY",
	deepgram: "DEEPGRAM_API_KEY",
	openai: "OPENAI_API_KEY",
	groq: "GROQ_API_KEY",
	openrouter: "OPENROUTER_API_KEY",
	anthropic: "ANTHROPIC_API_KEY",
	google: "GEMINI_API_KEY",
	xai: "XAI_API_KEY",
	deepseek: "DEEPSEEK_API_KEY",
	mistral: "MISTRAL_API_KEY",
};

export function getKeysPath(): string {
	return join(getReflexHome(), "keys.json");
}

export function loadStoredKeys(): Record<string, string> {
	try {
		if (!existsSync(getKeysPath())) return {};
		const parsed = JSON.parse(readFileSync(getKeysPath(), "utf8")) as Record<string, unknown>;
		const out: Record<string, string> = {};
		for (const [k, v] of Object.entries(parsed)) if (typeof v === "string" && v) out[k] = v;
		return out;
	} catch {
		return {};
	}
}

export function storeKey(service: string, key: string | undefined): void {
	const keys = loadStoredKeys();
	if (key) keys[service] = key;
	else delete keys[service];
	mkdirSync(getReflexHome(), { recursive: true });
	writeFileSync(getKeysPath(), `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600 });
}

export interface KeyResolver {
	get(service: string): string | undefined;
	/** Where the key came from, for `reflex doctor`. */
	source(service: string): "env" | "keys.json" | "auth.json" | undefined;
}

/**
 * Resolve a service key: env → ~/.reflex/keys.json → Pi's auth.json (for LLM providers
 * that double as voice providers, e.g. openai / groq).
 */
export function createKeyResolver(piAuthGet: (provider: string) => string | undefined = () => undefined): KeyResolver {
	const stored = loadStoredKeys();
	const lookup = (service: string): [string | undefined, KeyResolver["source"] extends (s: string) => infer R ? R : never] => {
		const envName = SERVICE_ENV[service];
		const fromEnv = envName ? process.env[envName] : undefined;
		if (fromEnv) return [fromEnv, "env"];
		if (stored[service]) return [stored[service], "keys.json"];
		const fromPi = piAuthGet(service);
		if (fromPi) return [fromPi, "auth.json"];
		return [undefined, undefined];
	};
	return {
		get: (service) => lookup(service)[0],
		source: (service) => lookup(service)[1],
	};
}
