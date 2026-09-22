/**
 * Shared runtime state for the reflex layer (one per process).
 */
import { logCall } from "../../logs/calls.js";
import { appendFileSync, mkdirSync } from "node:fs";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import { createKeyResolver, getPiAgentDir, getReflexHome, type KeyResolver, loadReflexConfig, type ReflexConfig, saveReflexConfig } from "../../config.js";
import type { TypesafeClient } from "./client.js";
import { createJevClient, type JevRoute } from "./provider.js";

export interface GateStats {
	allowed: number;
	asked: number;
	userAllowed: number;
	userDenied: number;
	blocked: number;
	degraded: number;
	skipped: number;
}

export interface MonitorStats {
	checks: number;
	loopNudges: number;
	errorNudges: number;
	verifyNudges: number;
	driftWarnings: number;
	/** Turns that announced their next steps and stopped, sent back to do them. */
	continueNudges: number;
}

export type RouteTier = "fast" | "default" | "strong";

export interface RouterStats {
	decisions: number;
	switches: number;
	byTier: Record<string, number>;
}

/** Read a Pi-stored API key (auth.json) for an LLM provider id, if any. */
export function piStoredApiKey(provider: string): string | undefined {
	try {
		const cred = readStoredCredential(provider, `${getPiAgentDir()}/auth.json`);
		return cred && cred.type === "api_key" && typeof cred.key === "string" ? cred.key : undefined;
	} catch {
		return undefined;
	}
}

export class ReflexState {
	config: ReflexConfig;
	client: TypesafeClient | undefined;
	/** Which service Jev is reached through (TypeSafe directly or OpenRouter), and why. */
	route: JevRoute | undefined;
	keys: KeyResolver;
	readonly gate: GateStats = { allowed: 0, asked: 0, userAllowed: 0, userDenied: 0, blocked: 0, degraded: 0, skipped: 0 };
	readonly monitor: MonitorStats = { checks: 0, loopNudges: 0, errorNudges: 0, verifyNudges: 0, driftWarnings: 0, continueNudges: 0 };
	readonly router: RouterStats = { decisions: 0, switches: 0, byTier: {} };
	/**
	 * Routing for this session only (never saved): a model the user picked, which pauses routing,
	 * and tier models / efforts that replace the saved ones until the session ends.
	 */
	readonly sessionRoute: { pinned?: string; routing: Partial<Record<RouteTier, string>>; effort: Partial<Record<RouteTier, string>> } = { routing: {}, effort: {} };
	/** True while the router itself is switching models, so its own switch isn't taken for the user's pick. */
	routerSwitching = false;
	/** Actions the user allowed for the rest of the session (exact and scoped keys). */
	readonly sessionAllow = new Set<string>();
	/** Human-readable log of what the user allowed; sent to Jev as context so it stops re-asking about the same kind of thing. */
	readonly allowedHistory: string[] = [];
	/** Set when the last Jev call failed; cleared on success. */
	degradedReason: string | undefined;
	/** Recent Jev decisions, for `/reflex last`. */
	readonly log: Array<{ at: number; kind: string; summary: string; detail?: unknown }> = [];

	constructor(config: ReflexConfig) {
		this.config = config;
		this.keys = createKeyResolver(piStoredApiKey);
		this.refreshClient();
	}

	refreshClient(): void {
		this.keys = createKeyResolver(piStoredApiKey);
		const made = createJevClient(this.config, this.keys);
		this.client = made?.client;
		this.route = made?.route;
	}

	get enabled(): boolean {
		return this.config.reflex.enabled && !!this.client;
	}

	reload(): void {
		this.config = loadReflexConfig();
		this.refreshClient();
	}

	save(): void {
		saveReflexConfig(this.config);
	}

	/** Set by the extension so decisions can be shown in the chat (TUI-only entries). */
	show: ((kind: string, summary: string, detail?: unknown) => void) | undefined;

	record(kind: string, summary: string, detail?: unknown): void {
		this.log.push({ at: Date.now(), kind, summary, detail });
		if (kind === "browse") logCall({ kind: "browser", source: "browse", summary, detail });
		try {
			this.show?.(kind, summary, detail);
		} catch {}
		if (this.log.length > 200) this.log.shift();
		if (process.env.REFLEX_DEBUG) {
			try {
				mkdirSync(getReflexHome(), { recursive: true });
				appendFileSync(`${getReflexHome()}/reflex-debug.log`, `${JSON.stringify({ at: new Date().toISOString(), kind, summary, detail })}\n`);
			} catch {}
		}
	}

	avgLatency(): number | undefined {
		const s = this.client?.stats;
		if (!s || s.requests - s.failures === 0) return undefined;
		return s.totalLatencyMs / (s.requests - s.failures);
	}
}
