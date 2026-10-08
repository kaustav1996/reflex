/**
 * Per-million model rates, read from Pi's own models store — the same prices the provider quotes,
 * so a report never invents one. A model the store doesn't know is left out, and the report says
 * how many calls that covered rather than guessing.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getPiAgentDir, loadReflexConfig } from "../config.js";
import type { ModelRates } from "./report.js";

export function loadModelRates(): { rates: Record<string, ModelRates>; defaultModel?: string } {
	const rates: Record<string, ModelRates> = {};
	try {
		const file = join(getPiAgentDir(), "models-store.json");
		if (existsSync(file)) {
			const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, { models?: unknown }>;
			for (const [provider, entry] of Object.entries(raw)) {
				const models = Array.isArray(entry?.models) ? entry.models : Object.values(entry?.models ?? {});
				for (const m of models as Array<{ id?: string; cost?: ModelRates }>) {
					if (m?.id && m.cost && typeof m.cost.input === "number") rates[`${provider}/${m.id}`] = m.cost;
				}
			}
		}
	} catch {}
	const config = loadReflexConfig();
	return { rates, defaultModel: config.reflex.routing?.default };
}
