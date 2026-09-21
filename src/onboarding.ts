/**
 * Interactive onboarding: collects LLM / TypeSafe / voice keys and preferences.
 *
 * Runs in the plain terminal before Pi's TUI starts.
 *  - LLM keys go through Pi's ModelRuntime.login() → ~/.reflex/agent/auth.json (0600),
 *    so Pi resolves them itself (env vars such as OPENROUTER_API_KEY also work).
 *  - TypeSafe / voice keys go to ~/.reflex/keys.json (0600).
 * Values already present in the environment or a .env file are detected and offered.
 */
import { confirm, input, password, select } from "@inquirer/prompts";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import {
	BRAND,
	BRAND_TAGLINE,
	createKeyResolver,
	getPiAgentDir,
	getReflexConfigPath,
	loadReflexConfig,
	type ReflexConfig,
	type RiskAppetite,
	saveReflexConfig,
	SERVICE_ENV,
	storeKey,
	type VoiceProviderId,
} from "./config.js";
import { piStoredApiKey } from "./extensions/typesafe/state.js";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const accent = (s: string) => `\x1b[36m${s}\x1b[0m`;
const ok = (s: string) => `\x1b[32m${s}\x1b[0m`;
const warn = (s: string) => `\x1b[33m${s}\x1b[0m`;

/** Pi provider ids and the env var Pi reads for each. */
const LLM_PROVIDERS: Array<{ id: string; name: string; hint: string }> = [
	{ id: "openrouter", name: "OpenRouter (recommended: every model, one key)", hint: "OPENROUTER_API_KEY" },
	{ id: "anthropic", name: "Anthropic", hint: "ANTHROPIC_API_KEY" },
	{ id: "openai", name: "OpenAI", hint: "OPENAI_API_KEY" },
	{ id: "google", name: "Google Gemini", hint: "GEMINI_API_KEY" },
	{ id: "groq", name: "Groq", hint: "GROQ_API_KEY" },
	{ id: "xai", name: "xAI", hint: "XAI_API_KEY" },
	{ id: "deepseek", name: "DeepSeek", hint: "DEEPSEEK_API_KEY" },
	{ id: "mistral", name: "Mistral", hint: "MISTRAL_API_KEY" },
];

/** Curated OpenRouter defaults for coding; anything else can be typed in. */
const OPENROUTER_PICKS = [
	"anthropic/claude-sonnet-4.6",
	"anthropic/claude-opus-4.7",
	"anthropic/claude-fable-5.1",
	"openai/gpt-5.5",
	"openai/gpt-5.3-codex",
	"google/gemini-3.1-pro-preview",
	"moonshotai/kimi-k2.7-code",
	"deepseek/deepseek-v4-pro",
	"qwen/qwen3-coder-plus",
	"z-ai/glm-5.3",
	"openrouter/auto",
];

const VOICE_PROVIDERS: Array<{ id: VoiceProviderId; name: string; env?: string }> = [
	{ id: "sarvam", name: "Sarvam AI (recommended: 22 Indian languages + English, auto-detect)", env: "SARVAM_API_KEY" },
	{ id: "openai", name: "OpenAI (gpt-4o-transcribe / whisper-1)", env: "OPENAI_API_KEY" },
	{ id: "groq", name: "Groq (whisper-large-v3-turbo, very fast)", env: "GROQ_API_KEY" },
	{ id: "deepgram", name: "Deepgram (nova-3)", env: "DEEPGRAM_API_KEY" },
	{ id: "whisper-cpp", name: "Local whisper.cpp (offline)" },
	{ id: "none", name: "No voice input" },
];

export interface OnboardingOptions {
	force?: boolean;
	/** Optional validator for the TypeSafe key: returns an error string or undefined. */
	validateTypesafe?: (key: string) => Promise<string | undefined>;
}

const mask = (v: string) => `${v.slice(0, 6)}…${v.slice(-4)}`;

async function askKey(label: string, service: string, optional: boolean): Promise<{ key: string; fromEnv: boolean } | undefined> {
	const keys = createKeyResolver(piStoredApiKey);
	const existing = keys.get(service);
	const source = keys.source(service);
	if (existing) {
		const keep = await confirm({ message: `${label}: found key in ${source === "env" ? `env ${SERVICE_ENV[service]}` : source} (${mask(existing)}). Use it?`, default: true });
		if (keep) return { key: existing, fromEnv: source === "env" };
	}
	const value = await password({ message: `${label} API key${optional ? dim(" (enter to skip)") : ""}:`, mask: "•" });
	const trimmed = value.trim();
	if (!trimmed) return optional ? undefined : askKey(label, service, optional);
	return { key: trimmed, fromEnv: false };
}

export async function runOnboarding(options: OnboardingOptions = {}): Promise<ReflexConfig> {
	const config = loadReflexConfig();
	if (config.onboarded && !options.force) return config;

	const agentDir = getPiAgentDir();
	const runtime = await ModelRuntime.create({ authPath: `${agentDir}/auth.json`, modelsPath: `${agentDir}/models.json` });
	const settings = SettingsManager.create(process.cwd(), agentDir);

	console.log();
	console.log(`${bold(accent(BRAND))} ${dim("—")} ${BRAND_TAGLINE}`);
	console.log(dim(`Config: ${getReflexConfigPath()} · LLM keys: ${agentDir}/auth.json · other keys: ~/.reflex/keys.json (0600)`));
	console.log();

	// ── 1. LLM provider ────────────────────────────────────────────────────
	console.log(bold("1/4  Language model (System Two)"));
	const providerId = await select({
		message: "Which LLM provider should power the agent?",
		choices: LLM_PROVIDERS.map((p) => ({ name: p.name, value: p.id, description: dim(p.hint) })),
		default: config.llm.provider ?? "openrouter",
	});
	const llmKey = await askKey(LLM_PROVIDERS.find((p) => p.id === providerId)?.name.split(" (")[0] ?? providerId, providerId, false);
	if (llmKey && !llmKey.fromEnv) {
		await runtime.login(providerId, "api_key", {
			prompt: async () => llmKey.key,
			notify: () => {},
		});
	}

	let modelId = config.llm.model;
	const catalog = runtime.getModels(providerId).map((m) => m.id);
	const picks = providerId === "openrouter" ? OPENROUTER_PICKS.filter((id) => catalog.includes(id)) : catalog.slice(0, 12);
	const modelChoice = await select({
		message: "Default model:",
		choices: [...picks.map((id) => ({ name: id, value: id })), { name: dim("Type a model id…"), value: "__custom__" }],
		default: modelId && picks.includes(modelId) ? modelId : picks[0],
	});
	modelId = modelChoice === "__custom__" ? (await input({ message: "Model id:", default: modelId })).trim() : modelChoice;
	settings.setDefaultModelAndProvider(providerId, modelId);
	config.llm = { provider: providerId, model: modelId };
	console.log(ok(`  ✓ ${providerId} / ${modelId}`));
	console.log();

	// ── 2. TypeSafe ────────────────────────────────────────────────────────
	console.log(bold("2/4  TypeSafe System One (Jev) — the reflex layer"));
	console.log(dim("  Jev answers narrow typed questions in ~100ms with calibrated confidence."));
	console.log(dim("  A TypeSafe key calls it directly; without one, an OpenRouter key reaches the same model."));
	console.log(dim("  Reflex uses it to gate risky actions, catch loops and unverified claims, classify voice, and route models."));
	let typesafe = await askKey("TypeSafe", "typesafe", true);
	if (typesafe && options.validateTypesafe) {
		process.stdout.write(dim("  checking key… "));
		const err = await options.validateTypesafe(typesafe.key);
		if (err) {
			console.log(warn(`✗ ${err}`));
			const keep = await confirm({ message: "Key check failed. Keep it anyway?", default: false });
			if (!keep) typesafe = undefined;
		} else console.log(ok("✓"));
	}
	// Jev is also served by OpenRouter's System One endpoint, so an OpenRouter key alone is enough.
	const openrouterKey = providerId === "openrouter" ? (llmKey?.key ?? process.env.OPENROUTER_API_KEY) : process.env.OPENROUTER_API_KEY;
	let viaOpenRouter = false;
	if (!typesafe && openrouterKey) {
		viaOpenRouter = await confirm({ message: "No TypeSafe key. Reach Jev through your OpenRouter key instead (same model, billed by OpenRouter)?", default: true });
		if (viaOpenRouter) console.log(ok("  ✓ reflex layer will call Jev via OpenRouter"));
	}
	if (typesafe || viaOpenRouter) {
		if (typesafe && !typesafe.fromEnv) storeKey("typesafe", typesafe.key);
		config.reflex.provider = "auto";
		config.reflex.enabled = true;
		config.reflex.riskAppetite = (await select({
			message: "Risk appetite for autonomous actions:",
			choices: [
				{ name: "balanced  — auto-run when Jev is confident it's safe, ask when unsure", value: "balanced" },
				{ name: "cautious  — ask for anything Jev isn't very sure about", value: "cautious" },
				{ name: "bold      — only stop for actions Jev flags as clearly dangerous", value: "bold" },
			],
			default: config.reflex.riskAppetite,
		})) as RiskAppetite;
		config.reflex.routeModels = await confirm({ message: "Let Jev route simple tasks to a cheaper/faster model automatically?", default: config.reflex.routeModels });
		if (config.reflex.routeModels && providerId === "openrouter") {
			const r = config.reflex.routing;
			r.default ??= `openrouter/${modelId}`;
			r.fast ??= "openrouter/google/gemini-3.1-flash-lite-preview";
			r.strong ??= "openrouter/anthropic/claude-opus-4.7";
			console.log(dim(`  routing: fast=${r.fast} default=${r.default} strong=${r.strong}  (change with /reflex routing …)`));
		}
	} else {
		config.reflex.enabled = false;
		console.log(warn("  Reflex layer disabled (no TypeSafe or OpenRouter key). Run `reflex setup` later to enable."));
	}
	console.log();

	// ── 3. Voice ───────────────────────────────────────────────────────────
	console.log(bold("3/4  Voice input"));
	const voiceId = (await select({
		message: "Speech-to-text provider:",
		choices: VOICE_PROVIDERS.map((v) => ({ name: v.name, value: v.id })),
		default: config.voice.provider,
	})) as VoiceProviderId;
	config.voice.provider = voiceId;
	const voice = VOICE_PROVIDERS.find((v) => v.id === voiceId);
	if (voice?.env) {
		const k = await askKey(voice.name.split(" (")[0], voiceId, true);
		if (k && !k.fromEnv) storeKey(voiceId, k.key);
		else if (!k) console.log(warn("  No key: voice input will be unavailable until you add one (reflex setup)."));
	}
	if (voiceId === "sarvam") {
		config.voice.language = await select({
			message: "Spoken language:",
			choices: [
				{ name: "Auto-detect", value: "unknown" },
				{ name: "English (India)", value: "en-IN" },
				{ name: "Hindi", value: "hi-IN" },
				{ name: "Bengali", value: "bn-IN" },
				{ name: "Tamil", value: "ta-IN" },
				{ name: "Telugu", value: "te-IN" },
				{ name: "Kannada", value: "kn-IN" },
				{ name: "Malayalam", value: "ml-IN" },
				{ name: "Marathi", value: "mr-IN" },
				{ name: "Gujarati", value: "gu-IN" },
				{ name: "Punjabi", value: "pa-IN" },
				{ name: "Odia", value: "od-IN" },
				{ name: "Urdu", value: "ur-IN" },
			],
			default: config.voice.language,
		});
		config.voice.translateToEnglish = await confirm({ message: "Translate non-English speech to English before sending to the model?", default: config.voice.translateToEnglish });
	}
	if (voiceId === "whisper-cpp") {
		config.voice.whisperCppBin = (await input({ message: "whisper.cpp binary:", default: config.voice.whisperCppBin ?? "whisper-cli" })).trim();
		config.voice.whisperCppModel = (await input({ message: "whisper.cpp model path (ggml-*.bin):", default: config.voice.whisperCppModel ?? "" })).trim();
	}
	console.log();

	// ── 4. Save ────────────────────────────────────────────────────────────
	console.log(bold("4/4  Save"));
	config.ui.theme = await select({
		message: "Look:",
		choices: [
			{ name: "typesafe        — dark terminal: near-black, off-white, pink accent", value: "typesafe" },
			{ name: "typesafe-light  — light terminal, like typesafe.ai", value: "typesafe-light" },
		],
		default: config.ui.theme,
	});
	settings.setTheme(config.ui.theme);
	config.onboarded = true;
	saveReflexConfig(config);
	await settings.flush();
	console.log(ok(`  ✓ saved ${getReflexConfigPath()}`));
	console.log(dim("  Inside the agent: /reflex (policy) · /voice or ctrl+shift+v (push-to-talk) · /computer (macOS control) · /setup · /model"));
	console.log();
	return config;
}
