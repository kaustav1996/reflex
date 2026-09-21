/**
 * Where Jev is reached. TypeSafe's own API and OpenRouter's System One endpoint take the same
 * request and return the same answers, so one client serves both and only the base URL and key
 * change:
 *
 *   typesafe    POST https://api.typesafe.ai/v1/systemone     Bearer TYPESAFE_API_KEY
 *   openrouter  POST https://openrouter.ai/api/v1/systemone   Bearer OPENROUTER_API_KEY
 *
 * OpenRouter accepts bare model ids (jev-latest → ~typesafe/jev-latest) and adds `id`,
 * `provider` and `usage.cost` to the response. With `auto` (the default) a TypeSafe key wins
 * when there is one; otherwise the OpenRouter key most users already have for their LLM is used,
 * so the reflex layer needs no second key.
 */
import type { KeyResolver, ReflexConfig } from "../../config.js";
import { TypesafeClient } from "./client.js";

export type JevProvider = "typesafe" | "openrouter";
export type JevProviderSetting = "auto" | JevProvider;

export const JEV_BASE_URL: Record<JevProvider, string> = {
	typesafe: "https://api.typesafe.ai/v1",
	openrouter: "https://openrouter.ai/api/v1",
};

export const JEV_KEY_ENV: Record<JevProvider, string> = { typesafe: "TYPESAFE_API_KEY", openrouter: "OPENROUTER_API_KEY" };

export interface JevRoute {
	provider: JevProvider;
	key: string;
	baseUrl: string;
	/** Why this provider was picked, for /reflex and `reflex doctor`. */
	reason: "configured" | "auto: TypeSafe key present" | "auto: no TypeSafe key, using OpenRouter";
}

export function normalizeSetting(v: unknown): JevProviderSetting {
	return v === "typesafe" || v === "openrouter" ? v : "auto";
}

/** Pure: pick the route from the setting and the keys that exist. Undefined = Jev is unavailable. */
export function resolveJevRoute(setting: JevProviderSetting, keys: { typesafe?: string; openrouter?: string }): JevRoute | undefined {
	const make = (provider: JevProvider, reason: JevRoute["reason"]): JevRoute | undefined => {
		const key = keys[provider];
		return key ? { provider, key, baseUrl: JEV_BASE_URL[provider], reason } : undefined;
	};
	if (setting === "typesafe" || setting === "openrouter") return make(setting, "configured");
	return make("typesafe", "auto: TypeSafe key present") ?? make("openrouter", "auto: no TypeSafe key, using OpenRouter");
}

export function jevRouteFor(config: ReflexConfig, keys: KeyResolver): JevRoute | undefined {
	const setting = normalizeSetting(process.env.REFLEX_JEV_PROVIDER ?? config.reflex.provider);
	return resolveJevRoute(setting, { typesafe: keys.get("typesafe"), openrouter: keys.get("openrouter") });
}

/** The one place a Jev client is built. */
export function createJevClient(config: ReflexConfig, keys: KeyResolver, opts: { timeoutMs?: number } = {}): { client: TypesafeClient; route: JevRoute } | undefined {
	const route = jevRouteFor(config, keys);
	if (!route) return undefined;
	return { route, client: new TypesafeClient(route.key, { model: config.reflex.model, timeoutMs: opts.timeoutMs ?? config.reflex.timeoutMs, baseUrl: route.baseUrl, provider: route.provider }) };
}

/** What to tell someone when no route exists. */
export function missingJevHint(setting: JevProviderSetting): string {
	if (setting === "typesafe") return "Jev provider is set to typesafe but TYPESAFE_API_KEY is missing";
	if (setting === "openrouter") return "Jev provider is set to openrouter but OPENROUTER_API_KEY is missing";
	return "no TypeSafe or OpenRouter key found (either one reaches Jev)";
}
