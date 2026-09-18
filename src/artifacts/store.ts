/**
 * Artifacts: deployable apps (a static frontend, or a frontend + backend) published under a
 * subdomain of DEPLOY_DOMAIN. Records live under ~/.reflex/artifacts/<id>/.
 *
 *   ~/.reflex/artifacts/<id>/artifact.json       the record (dir, manifest, provider ids, urls)
 *   ~/.reflex/artifacts/<id>/deploys/<did>.json  one deploy: status, steps, urls, error
 *   ~/.reflex/artifacts/<id>/deploys/<did>.log   jsonl event log of that deploy
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getReflexHome } from "../config.js";
import type { Manifest } from "./manifest.js";

export interface ArtifactRecord {
	id: string;
	name: string;
	/** Absolute path of the app on this machine. */
	dir: string;
	manifest: Manifest;
	netlify?: { siteId: string; siteName: string; customDomain: string; url?: string; fallbackUrl?: string; tlsReady?: boolean };
	render?: { serviceId: string; serviceName: string; url: string; repo: string; commit?: string };
	github?: { owner: string; repo: string; url: string; private: boolean };
	/** Per-artifact overrides; anything unset falls back to the defaults in Settings → Artifacts (env). */
	settings?: { domain?: string; region?: string; repoPrivate?: boolean };
	/** Netlify Blobs location of the SQLite snapshot (fullstack only). */
	appdata?: { siteId: string; store: string; key: string; dbPath: string };
	createdAt: number;
	updatedAt: number;
	lastDeploy?: { id: string; status: DeployStatus; at: number; url?: string };
}

export type DeployStatus = "running" | "succeeded" | "failed" | "cancelled";

export interface DeployStep {
	id: string;
	label: string;
	status: "pending" | "running" | "ok" | "failed" | "skipped";
	startedAt?: number;
	endedAt?: number;
	detail?: string;
}

export interface DeployRecord {
	id: string;
	artifactId: string;
	status: DeployStatus;
	startedAt: number;
	endedAt?: number;
	steps: DeployStep[];
	frontendUrl?: string;
	backendUrl?: string;
	fallbackUrl?: string;
	commit?: string;
	error?: string;
	trigger: "manual" | "agent" | "api";
}

export function artifactsDir(): string {
	return join(getReflexHome(), "artifacts");
}
export function artifactDir(id: string): string {
	return join(artifactsDir(), id);
}
function deploysDir(id: string): string {
	return join(artifactDir(id), "deploys");
}

export function listArtifacts(): ArtifactRecord[] {
	const dir = artifactsDir();
	if (!existsSync(dir)) return [];
	const out: ArtifactRecord[] = [];
	for (const id of readdirSync(dir)) {
		const a = loadArtifact(id);
		if (a) out.push(a);
	}
	return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function loadArtifact(id: string): ArtifactRecord | undefined {
	try {
		return JSON.parse(readFileSync(join(artifactDir(id), "artifact.json"), "utf8")) as ArtifactRecord;
	} catch {
		return undefined;
	}
}

export function saveArtifact(a: ArtifactRecord): void {
	a.updatedAt = Date.now();
	mkdirSync(deploysDir(a.id), { recursive: true });
	writeFileSync(join(artifactDir(a.id), "artifact.json"), `${JSON.stringify(a, null, 2)}\n`);
}

export function deleteArtifactRecord(id: string): void {
	rmSync(artifactDir(id), { recursive: true, force: true });
}

export function listDeploys(id: string, limit = 50): DeployRecord[] {
	const dir = deploysDir(id);
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((f) => f.endsWith(".json"))
		.map((f) => {
			try {
				return JSON.parse(readFileSync(join(dir, f), "utf8")) as DeployRecord;
			} catch {
				return undefined;
			}
		})
		.filter((d): d is DeployRecord => !!d)
		.sort((a, b) => b.startedAt - a.startedAt)
		.slice(0, limit);
}

export function loadDeploy(id: string, did: string): DeployRecord | undefined {
	try {
		return JSON.parse(readFileSync(join(deploysDir(id), `${did}.json`), "utf8")) as DeployRecord;
	} catch {
		return undefined;
	}
}

export function saveDeploy(d: DeployRecord): void {
	mkdirSync(deploysDir(d.artifactId), { recursive: true });
	writeFileSync(join(deploysDir(d.artifactId), `${d.id}.json`), `${JSON.stringify(d, null, 2)}\n`);
}

export function deployLogPath(d: DeployRecord): string {
	return join(deploysDir(d.artifactId), `${d.id}.log`);
}

export function newDeployId(): string {
	const d = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Slug rules shared with Netlify site names and Render service names. */
export function artifactSlug(name: string): string {
	const s = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(s)) throw new Error(`cannot make a valid artifact name from "${name}" (need 2–40 chars, letters/digits/dashes)`);
	return s;
}

// ---------------------------------------------------------------------------
// Configuration: which parts of the pipeline are available.
// ---------------------------------------------------------------------------

export interface ArtifactsConfig {
	frontend: { ok: boolean; missing: string[]; domain?: string; accountSlug?: string };
	backend: { ok: boolean; missing: string[]; region: string };
	github: { ok: boolean; source?: "GITHUB_TOKEN" | "GITHUB_ORG_TOKEN" | "gh"; owner?: string; missing: string[] };
}

export function artifactsConfig(githubProbe?: { ok: boolean; source?: ArtifactsConfig["github"]["source"]; owner?: string }): ArtifactsConfig {
	const need = (names: string[]) => names.filter((n) => !process.env[n]);
	const fe = need(["NETLIFY_API_KEY", "NETLIFY_ACCOUNT_SLUG", "DEPLOY_DOMAIN"]);
	const be = need(["RENDER_API_KEY", "RENDER_OWNER_ID"]);
	const gh = githubProbe ?? { ok: false };
	return {
		frontend: { ok: fe.length === 0, missing: fe, domain: process.env.DEPLOY_DOMAIN, accountSlug: process.env.NETLIFY_ACCOUNT_SLUG },
		backend: { ok: be.length === 0, missing: be, region: process.env.RENDER_REGION || "singapore" },
		github: { ok: gh.ok, source: gh.source, owner: gh.owner, missing: gh.ok ? [] : ["GITHUB_TOKEN (or a `gh auth login`)"] },
	};
}
