/**
 * Ways to give Reflex an LLM besides an API key:
 *
 *  - Subscription sign-in. Pi ships the OAuth flows for a Claude subscription (provider
 *    `anthropic`), a ChatGPT subscription (`openai-codex`) and GitHub Copilot. Reflex only drives
 *    them: `ModelRuntime.login(provider, "oauth", …)` stores the credential in Pi's auth store,
 *    and the provider's models then appear in the model picker. Whether a subscription may be used
 *    from a third-party tool is up to that provider's terms.
 *  - Any OpenAI-compatible endpoint (Ollama, LM Studio, LiteLLM, vLLM, a company proxy). These are
 *    Pi "custom providers": an entry in <agent dir>/models.json with a base URL, an optional key and
 *    a list of model ids.
 *
 * Jev is separate: it is only served by TypeSafe and OpenRouter (see typesafe/provider.ts).
 */
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ModelRuntime, readStoredCredential, SettingsManager } from "@earendil-works/pi-coding-agent";
import { getPiAgentDir, loadReflexConfig, saveReflexConfig } from "../config.js";

// ---------------------------------------------------------------------------
// Subscription sign-in
// ---------------------------------------------------------------------------

export interface SubscriptionLogin {
	/** Pi provider id. */
	id: string;
	label: string;
	hint: string;
}

export const SUBSCRIPTION_LOGINS: SubscriptionLogin[] = [
	{ id: "anthropic", label: "Claude subscription", hint: "Sign in with Anthropic (Claude Pro or Max)" },
	{ id: "openai-codex", label: "ChatGPT subscription", hint: "Sign in with OpenAI (ChatGPT Plus or Pro)" },
	{ id: "github-copilot", label: "GitHub Copilot", hint: "Sign in with GitHub (Copilot subscription)" },
];

export async function modelRuntime(): Promise<ModelRuntime> {
	const dir = getPiAgentDir();
	return ModelRuntime.create({ authPath: `${dir}/auth.json`, modelsPath: `${dir}/models.json` });
}

/** "oauth" | "api_key" when a credential is stored for the provider. */
export function storedAuthType(provider: string): "oauth" | "api_key" | undefined {
	try {
		const c = readStoredCredential(provider, `${getPiAgentDir()}/auth.json`) as { type?: string } | undefined;
		return c?.type === "oauth" || c?.type === "api_key" ? c.type : undefined;
	} catch {
		return undefined;
	}
}

export type LoginPrompt = { type: "text" | "secret" | "manual_code"; message: string; placeholder?: string } | { type: "select"; message: string; options: Array<{ id: string; label: string; description?: string }> };

export interface LoginSession {
	id: string;
	provider: string;
	status: "running" | "done" | "error" | "cancelled";
	/** Browser URL to open (OAuth consent). */
	url?: string;
	instructions?: string;
	/** Device-code flows: the code to type at `verificationUri`. */
	deviceCode?: { userCode: string; verificationUri: string };
	messages: string[];
	/** Set while the flow waits for the user (a pasted code, a choice). */
	prompt?: LoginPrompt;
	error?: string;
	startedAt: number;
}

const sessions = new Map<string, { session: LoginSession; answer?: (v: string) => void; reject?: (e: Error) => void; abort: AbortController }>();

/** Start a sign-in in the background. Poll `getLogin`, answer prompts with `answerLogin`. */
export function startLogin(provider: string): LoginSession {
	if (!SUBSCRIPTION_LOGINS.some((p) => p.id === provider)) throw new Error(`no subscription sign-in for "${provider}"`);
	for (const [id, s] of sessions) if (Date.now() - s.session.startedAt > 15 * 60_000) sessions.delete(id);
	const session: LoginSession = { id: randomUUID().slice(0, 8), provider, status: "running", messages: [], startedAt: Date.now() };
	const abort = new AbortController();
	const entry: { session: LoginSession; answer?: (v: string) => void; reject?: (e: Error) => void; abort: AbortController } = { session, abort };
	sessions.set(session.id, entry);
	void (async () => {
		try {
			const runtime = await modelRuntime();
			await runtime.login(provider, "oauth", {
				signal: abort.signal,
				prompt: (p) =>
					new Promise<string>((resolve, reject) => {
						session.prompt = p.type === "select" ? { type: "select", message: p.message, options: p.options.map((o) => ({ ...o })) } : { type: p.type, message: p.message, placeholder: p.placeholder };
						entry.answer = (v) => {
							session.prompt = undefined;
							resolve(v);
						};
						entry.reject = reject;
						// A callback server can win the race against a manual code: Pi aborts this prompt then.
						p.signal?.addEventListener("abort", () => {
							session.prompt = undefined;
							reject(new Error("prompt superseded"));
						});
					}),
				notify: (ev) => {
					if (ev.type === "auth_url") {
						session.url = ev.url;
						session.instructions = ev.instructions;
					} else if (ev.type === "device_code") session.deviceCode = { userCode: ev.userCode, verificationUri: ev.verificationUri };
					else session.messages.push(ev.message);
				},
			});
			session.status = "done";
		} catch (err) {
			if (session.status === "running") {
				session.status = abort.signal.aborted ? "cancelled" : "error";
				session.error = err instanceof Error ? err.message : String(err);
			}
		} finally {
			session.prompt = undefined;
		}
	})();
	return session;
}

export function getLogin(id: string): LoginSession | undefined {
	return sessions.get(id)?.session;
}

export function answerLogin(id: string, value: string): boolean {
	const e = sessions.get(id);
	if (!e?.answer) return false;
	const fn = e.answer;
	e.answer = undefined;
	fn(value);
	return true;
}

export function cancelLogin(id: string): void {
	const e = sessions.get(id);
	if (!e) return;
	e.session.status = "cancelled";
	e.abort.abort();
	e.reject?.(new Error("cancelled"));
}

export async function logoutProvider(provider: string): Promise<void> {
	await (await modelRuntime()).logout(provider);
}

// ---------------------------------------------------------------------------
// OpenAI-compatible endpoints (Pi custom providers in models.json)
// ---------------------------------------------------------------------------

export interface CompatPreset {
	id: string;
	label: string;
	baseUrl: string;
	needsKey: boolean;
}

export const COMPAT_PRESETS: CompatPreset[] = [
	{ id: "ollama", label: "Ollama", baseUrl: "http://localhost:11434/v1", needsKey: false },
	{ id: "lmstudio", label: "LM Studio", baseUrl: "http://localhost:1234/v1", needsKey: false },
	{ id: "litellm", label: "LiteLLM proxy", baseUrl: "http://localhost:4000/v1", needsKey: true },
	{ id: "vllm", label: "vLLM", baseUrl: "http://localhost:8000/v1", needsKey: false },
	{ id: "custom", label: "Other OpenAI-compatible endpoint", baseUrl: "https://", needsKey: true },
];

export interface CompatProvider {
	name: string;
	baseUrl: string;
	hasKey: boolean;
	models: string[];
}

function modelsPath(): string {
	return join(getPiAgentDir(), "models.json");
}

type ModelsFile = { providers?: Record<string, { baseUrl?: string; api?: string; apiKey?: string; compat?: Record<string, unknown>; models?: Array<{ id: string }> }> };

function readModelsFile(): ModelsFile {
	try {
		return existsSync(modelsPath()) ? (JSON.parse(readFileSync(modelsPath(), "utf8")) as ModelsFile) : {};
	} catch {
		return {};
	}
}

export const PROVIDER_NAME = /^[a-z0-9][a-z0-9-]{1,30}$/;

export function normalizeBaseUrl(url: string): string {
	const u = url.trim().replace(/\/+$/, "");
	if (!/^https?:\/\//.test(u)) throw new Error("base URL must start with http:// or https://");
	return u;
}

/** Ask the endpoint which models it serves (GET <baseUrl>/models). */
export async function listEndpointModels(baseUrl: string, apiKey?: string, fetchImpl: typeof fetch = fetch): Promise<string[]> {
	const res = await fetchImpl(`${normalizeBaseUrl(baseUrl)}/models`, { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {}, signal: AbortSignal.timeout(8000) });
	if (!res.ok) throw new Error(`${baseUrl}/models answered HTTP ${res.status}`);
	const data = (await res.json()) as { data?: Array<{ id?: string }>; models?: Array<{ id?: string; name?: string }> };
	const ids = [...(data.data ?? []).map((m) => m.id), ...(data.models ?? []).map((m) => m.id ?? m.name)].filter((x): x is string => !!x);
	return [...new Set(ids)];
}

export function listCompatProviders(): CompatProvider[] {
	return Object.entries(readModelsFile().providers ?? {})
		.filter(([, p]) => (p.api ?? "openai-completions") === "openai-completions" && !!p.baseUrl)
		.map(([name, p]) => ({ name, baseUrl: p.baseUrl ?? "", hasKey: !!p.apiKey && p.apiKey !== "none", models: (p.models ?? []).map((m) => m.id) }));
}

/**
 * Add or replace an OpenAI-compatible provider. Local servers often reject the `developer` role and
 * `reasoning_effort`, so both are switched off; keyless servers still get a placeholder key because
 * Pi only lists models of providers that have one.
 */
export function saveCompatProvider(input: { name: string; baseUrl: string; apiKey?: string; models: string[] }): CompatProvider {
	const name = input.name.trim().toLowerCase();
	if (!PROVIDER_NAME.test(name)) throw new Error("provider name: 2–31 lowercase letters, digits or dashes");
	const models = [...new Set(input.models.map((m) => m.trim()).filter(Boolean))];
	if (!models.length) throw new Error("pick at least one model id");
	const file = readModelsFile();
	const existing = file.providers?.[name];
	file.providers = {
		...(file.providers ?? {}),
		[name]: {
			...existing,
			baseUrl: normalizeBaseUrl(input.baseUrl),
			api: "openai-completions",
			apiKey: input.apiKey?.trim() || existing?.apiKey || "none",
			compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, ...(existing?.compat ?? {}) },
			models: models.map((id) => ({ id })),
		},
	};
	mkdirSync(getPiAgentDir(), { recursive: true });
	writeFileSync(modelsPath(), `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
	try {
		chmodSync(modelsPath(), 0o600);
	} catch {}
	return listCompatProviders().find((p) => p.name === name)!;
}

export function removeCompatProvider(name: string): void {
	const file = readModelsFile();
	if (!file.providers?.[name]) return;
	delete file.providers[name];
	writeFileSync(modelsPath(), `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Usable models and the default (what System 2 offers to the rest of Reflex)
// ---------------------------------------------------------------------------

export const EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export interface UsableModel {
	/** `provider/id`, the form used everywhere in Reflex config. */
	ref: string;
	provider: string;
	id: string;
	name?: string;
	/** Whether the model can think; effort only matters for these. */
	reasoning: boolean;
	contextWindow?: number;
	/** USD per million tokens, when known. */
	cost?: { input: number; output: number };
	/** How the provider is authenticated right now. */
	via: "subscription" | "api key" | "endpoint";
}

/** Every model whose provider has working credentials: keys, subscription sign-ins and custom endpoints. */
export async function usableModels(): Promise<UsableModel[]> {
	const runtime = await modelRuntime();
	const endpoints = new Set(listCompatProviders().map((e) => e.name));
	const models = await runtime.getAvailable();
	return models.map((m) => {
		const mm = m as unknown as { provider: string; id: string; name?: string; reasoning?: unknown; contextWindow?: number; cost?: { input?: number; output?: number } };
		return {
			ref: `${mm.provider}/${mm.id}`,
			provider: mm.provider,
			id: mm.id,
			name: mm.name,
			reasoning: !!mm.reasoning,
			contextWindow: mm.contextWindow,
			cost: mm.cost ? { input: mm.cost.input ?? 0, output: mm.cost.output ?? 0 } : undefined,
			via: endpoints.has(mm.provider) ? "endpoint" : runtime.isUsingOAuth(mm.provider) ? "subscription" : "api key",
		};
	});
}

export function currentDefault(): { ref?: string; effort?: Effort } {
	const cfg = loadReflexConfig();
	let effort: Effort | undefined;
	try {
		effort = SettingsManager.create(process.cwd(), getPiAgentDir()).getDefaultThinkingLevel() as Effort | undefined;
	} catch {}
	return { ref: cfg.llm.provider && cfg.llm.model ? `${cfg.llm.provider}/${cfg.llm.model}` : undefined, effort };
}

/** Set the default model (and effort) for new sessions, in both Reflex's config and Pi's settings. */
export function setDefaultModel(ref: string, effort?: Effort): void {
	const i = ref.indexOf("/");
	if (i <= 0) throw new Error("model must look like provider/model-id");
	const provider = ref.slice(0, i);
	const model = ref.slice(i + 1);
	const cfg = loadReflexConfig();
	cfg.llm = { provider, model };
	saveReflexConfig(cfg);
	const settings = SettingsManager.create(process.cwd(), getPiAgentDir());
	settings.setDefaultModelAndProvider(provider, model);
	if (effort && (EFFORTS as readonly string[]).includes(effort)) settings.setDefaultThinkingLevel(effort as never);
}
