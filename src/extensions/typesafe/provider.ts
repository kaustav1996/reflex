/**
 * Where Jev is reached, and which Jev model is used there. Both are the user's choice:
 *
 *   reflex.provider   "typesafe" | "openrouter"
 *   reflex.models     { typesafe: "jev-latest", openrouter: "~typesafe/jev-latest" }
 *
 *   typesafe    POST https://api.typesafe.ai/v1/systemone     Bearer TYPESAFE_API_KEY
 *               models: GET https://api.typesafe.ai/v1/models          (jev-latest, jev-preview …)
 *   openrouter  POST https://openrouter.ai/api/v1/systemone   Bearer OPENROUTER_API_KEY
 *               models: GET https://openrouter.ai/api/v1/models?output_modalities=decisions
 *                       (~typesafe/jev-latest, typesafe/jev-1.13 …)
 *
 * The request and the answers are the same on both; OpenRouter adds `id`, `provider` and
 * `usage.cost`. Model ids are NOT interchangeable (jev-preview exists only on TypeSafe,
 * typesafe/jev-1.13 only on OpenRouter), so the model is remembered per provider.
 *
 * There is no automatic switching. An install that has not chosen yet (older configs) uses
 * TypeSafe when its key exists and OpenRouter otherwise, and says so until the user picks.
 */
import type { KeyResolver, ReflexConfig } from "../../config.js";
import { TypesafeClient } from "./client.js";

export type JevProvider = "typesafe" | "openrouter";
export const JEV_PROVIDERS: JevProvider[] = ["typesafe", "openrouter"];

export const JEV_BASE_URL: Record<JevProvider, string> = {
	typesafe: "https://api.typesafe.ai/v1",
	openrouter: "https://openrouter.ai/api/v1",
};
export const JEV_KEY_ENV: Record<JevProvider, string> = { typesafe: "TYPESAFE_API_KEY", openrouter: "OPENROUTER_API_KEY" };
export const JEV_LABEL: Record<JevProvider, string> = { typesafe: "TypeSafe (direct)", openrouter: "OpenRouter" };
export const DEFAULT_JEV_MODEL: Record<JevProvider, string> = { typesafe: "jev-latest", openrouter: "~typesafe/jev-latest" };
/** Shown when the live list cannot be fetched. */
export const FALLBACK_JEV_MODELS: Record<JevProvider, JevModel[]> = {
	typesafe: [{ id: "jev-latest", description: "The latest iteration of TypeSafe's System One model" }, { id: "jev-preview", description: "A preview version of jev-latest" }],
	openrouter: [{ id: "~typesafe/jev-latest", description: "Always the latest model in the Jev family" }, { id: "typesafe/jev-1.13", description: "Jev 1.13" }],
};

export interface JevModel {
	id: string;
	description?: string;
	/** USD per million input tokens, when the provider reports it. */
	inputPerMillion?: number;
}

export interface JevRoute {
	provider: JevProvider;
	model: string;
	key: string;
	baseUrl: string;
	/** false when the user has not picked a provider yet and a default is in use. */
	chosen: boolean;
}

export function asProvider(v: unknown): JevProvider | undefined {
	return v === "typesafe" || v === "openrouter" ? v : undefined;
}

/** The provider to use: the user's choice (env override first), else a stated default. */
export function chosenProvider(config: ReflexConfig, keys: { typesafe?: string; openrouter?: string }): { provider: JevProvider; chosen: boolean } {
	const explicit = asProvider(process.env.REFLEX_JEV_PROVIDER) ?? asProvider(config.reflex.provider);
	if (explicit) return { provider: explicit, chosen: true };
	return { provider: keys.typesafe || !keys.openrouter ? "typesafe" : "openrouter", chosen: false };
}

/** The model for a provider: the user's pick for that provider, else that provider's default. */
export function jevModelFor(config: ReflexConfig, provider: JevProvider): string {
	const picked = config.reflex.models?.[provider];
	if (picked) return picked;
	// Older configs had one shared `model`; it was always a TypeSafe id.
	if (provider === "typesafe" && config.reflex.model && !config.reflex.model.includes("/")) return config.reflex.model;
	return DEFAULT_JEV_MODEL[provider];
}

/** Pure: the route for a config and the keys that exist. Undefined = the chosen provider has no key. */
export function resolveJevRoute(config: ReflexConfig, keys: { typesafe?: string; openrouter?: string }): JevRoute | undefined {
	const { provider, chosen } = chosenProvider(config, keys);
	const key = keys[provider];
	if (!key) return undefined;
	return { provider, chosen, key, baseUrl: JEV_BASE_URL[provider], model: jevModelFor(config, provider) };
}

export function jevRouteFor(config: ReflexConfig, keys: KeyResolver): JevRoute | undefined {
	return resolveJevRoute(config, { typesafe: keys.get("typesafe"), openrouter: keys.get("openrouter") });
}

/** The one place a Jev client is built. */
export function createJevClient(config: ReflexConfig, keys: KeyResolver, opts: { timeoutMs?: number } = {}): { client: TypesafeClient; route: JevRoute } | undefined {
	const route = jevRouteFor(config, keys);
	if (!route) return undefined;
	return { route, client: new TypesafeClient(route.key, { model: route.model, timeoutMs: opts.timeoutMs ?? config.reflex.timeoutMs, baseUrl: route.baseUrl, provider: route.provider }) };
}

/** What to tell someone when the chosen provider cannot be used. */
export function missingJevHint(config: ReflexConfig, keys: KeyResolver): string {
	const { provider, chosen } = chosenProvider(config, { typesafe: keys.get("typesafe"), openrouter: keys.get("openrouter") });
	const other: JevProvider = provider === "typesafe" ? "openrouter" : "typesafe";
	return chosen
		? `Jev provider is ${JEV_LABEL[provider]} but ${JEV_KEY_ENV[provider]} is missing. Add that key, or choose ${JEV_LABEL[other]} (/reflex provider ${other}).`
		: `no ${JEV_KEY_ENV.typesafe} or ${JEV_KEY_ENV.openrouter} found; either one reaches Jev.`;
}

/** Live list of the Jev models a provider offers; falls back to the known ids when the list cannot be fetched. */
export async function listJevModels(provider: JevProvider, key: string | undefined, fetchImpl: typeof fetch = fetch): Promise<{ models: JevModel[]; live: boolean }> {
	try {
		if (provider === "typesafe") {
			if (!key) return { models: FALLBACK_JEV_MODELS.typesafe, live: false };
			const res = await fetchImpl(`${JEV_BASE_URL.typesafe}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(6000) });
			if (!res.ok) throw new Error(String(res.status));
			const data = (await res.json()) as { models?: Array<{ name: string; description?: string }> };
			const models = (data.models ?? []).map((m) => ({ id: m.name, description: m.description }));
			return models.length ? { models, live: true } : { models: FALLBACK_JEV_MODELS.typesafe, live: false };
		}
		const res = await fetchImpl(`${JEV_BASE_URL.openrouter}/models?output_modalities=decisions`, { signal: AbortSignal.timeout(6000) });
		if (!res.ok) throw new Error(String(res.status));
		const data = (await res.json()) as { data?: Array<{ id: string; name?: string; description?: string; pricing?: { prompt?: string } }> };
		const models = (data.data ?? [])
			.filter((m) => m.id.replace(/^~/, "").startsWith("typesafe/"))
			.map((m) => ({ id: m.id, description: m.name ?? m.description, inputPerMillion: m.pricing?.prompt ? Number(m.pricing.prompt) * 1e6 : undefined }));
		return models.length ? { models, live: true } : { models: FALLBACK_JEV_MODELS.openrouter, live: false };
	} catch {
		return { models: FALLBACK_JEV_MODELS[provider], live: false };
	}
}
