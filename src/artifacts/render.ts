/**
 * Render: one free web service per fullstack artifact, built from the artifact's GitHub repo at a
 * pinned commit. Auto-deploy is off; every deploy is triggered by the API with a commit id.
 *
 * Lessons carried over: Render kicks off a build on service creation even with autoDeploy off, a
 * second trigger while one is queued answers 202 with an empty body, env added after a deploy
 * started is invisible to it, and a finished deploy of the same commit must never be reused.
 */
import { type Heartbeat, json, sleep } from "./http.js";
import type { BackendSpec } from "./manifest.js";

const API = "https://api.render.com/v1";
const INFLIGHT = new Set(["created", "queued", "build_in_progress", "update_in_progress", "pre_deploy_in_progress"]);
const FAILED = new Set(["build_failed", "update_failed", "canceled", "deactivated", "pre_deploy_failed"]);

export interface RenderService {
	id: string;
	name: string;
	url: string;
}

export class Render {
	constructor(
		private token: string,
		private ownerId: string,
		public region: string,
	) {}

	static fromEnv(regionOverride?: string): Render {
		const { RENDER_API_KEY, RENDER_OWNER_ID } = process.env;
		if (!RENDER_API_KEY || !RENDER_OWNER_ID) throw new Error("backend deploys need RENDER_API_KEY and RENDER_OWNER_ID (the tea-… workspace id)");
		return new Render(RENDER_API_KEY, RENDER_OWNER_ID.split(/\s/)[0], regionOverride || process.env.RENDER_REGION || "singapore");
	}

	serviceName(slug: string): string {
		return `rx-${slug}`.slice(0, 63);
	}

	async findService(slug: string): Promise<RenderService | undefined> {
		const name = this.serviceName(slug);
		const list = await json<Array<{ service: { id: string; name: string; serviceDetails?: { url?: string } } }>>(`${API}/services?name=${encodeURIComponent(name)}&ownerId=${this.ownerId}&limit=5`, { token: this.token });
		const s = list.map((x) => x.service).find((x) => x?.name === name);
		return s ? { id: s.id, name, url: s.serviceDetails?.url ?? `https://${name}.onrender.com` } : undefined;
	}

	async ensureService(slug: string, repoUrl: string, spec: BackendSpec, env: Record<string, string>): Promise<RenderService> {
		const name = this.serviceName(slug);
		const existing = await this.findService(slug);
		if (existing) {
			await json(`${API}/services/${existing.id}`, { method: "PATCH", token: this.token, body: JSON.stringify({ branch: "main", rootDir: spec.dir, serviceDetails: { envSpecificDetails: { buildCommand: spec.build, startCommand: spec.start } } }) });
			return existing;
		}
		// The sidecar env must be in the CREATE body: the first build starts at creation and env added later is not seen by it.
		const created = await json<{ service: { id: string; serviceDetails?: { url?: string } } }>(`${API}/services`, {
			method: "POST",
			token: this.token,
			body: JSON.stringify({
				type: "web_service",
				name,
				ownerId: this.ownerId,
				repo: repoUrl.replace(/\.git$/, ""),
				branch: "main",
				autoDeploy: "no",
				rootDir: spec.dir,
				envVars: Object.entries(env).map(([key, value]) => ({ key, value })),
				serviceDetails: { runtime: spec.runtime, plan: "free", region: this.region, healthCheckPath: spec.health, envSpecificDetails: { buildCommand: spec.build, startCommand: spec.start } },
			}),
		});
		const s = created.service;
		return { id: s.id, name, url: s.serviceDetails?.url ?? `https://${name}.onrender.com` };
	}

	async syncEnv(serviceId: string, env: Record<string, string>): Promise<boolean> {
		const current = await json<Array<{ envVar?: { key: string; value: string } }>>(`${API}/services/${serviceId}/env-vars`, { token: this.token }).catch(() => []);
		const have = Object.fromEntries(current.map((e) => [e.envVar?.key, e.envVar?.value]));
		const changed = Object.entries(env).some(([k, v]) => have[k] !== v) || Object.keys(have).some((k) => !(k in env));
		if (changed) await json(`${API}/services/${serviceId}/env-vars`, { method: "PUT", token: this.token, body: JSON.stringify(Object.entries(env).map(([key, value]) => ({ key, value }))) });
		return changed;
	}

	async deploy(serviceId: string, commit: string, envChanged: boolean): Promise<string> {
		const inflight = envChanged ? undefined : await this.findDeploy(serviceId, commit);
		if (inflight) return inflight;
		const d = await json<{ id?: string } | undefined>(`${API}/services/${serviceId}/deploys`, { method: "POST", token: this.token, body: JSON.stringify({ commitId: commit, clearCache: "do_not_clear" }) });
		if (d?.id) return d.id;
		await sleep(3_000);
		const again = await this.findDeploy(serviceId, commit);
		if (!again) throw new Error("Render accepted the deploy but it never appeared in the deploy list");
		return again;
	}

	private async findDeploy(serviceId: string, commit: string): Promise<string | undefined> {
		const list = await json<Array<{ deploy: { id: string; status: string; commit?: { id?: string } } }>>(`${API}/services/${serviceId}/deploys?limit=10`, { token: this.token });
		return list.map((x) => x.deploy).find((d) => d.commit?.id?.startsWith(commit) && INFLIGHT.has(d.status))?.id;
	}

	async waitLive(serviceId: string, deployId: string, hb: Heartbeat, timeoutMs = 15 * 60_000): Promise<void> {
		const t0 = Date.now();
		while (Date.now() - t0 < timeoutMs) {
			const dep = await json<{ status: string }>(`${API}/services/${serviceId}/deploys/${deployId}`, { token: this.token });
			hb(`render deploy ${dep.status}`);
			if (dep.status === "live") return;
			if (FAILED.has(dep.status)) throw new Error(`Render deploy ${dep.status} — open the service logs on dashboard.render.com`);
			await sleep(10_000);
		}
		throw new Error("Render deploy timed out");
	}

	async waitHealthy(url: string, path: string, hb: Heartbeat, timeoutMs = 3 * 60_000): Promise<void> {
		const t0 = Date.now();
		while (Date.now() - t0 < timeoutMs) {
			try {
				const r = await fetch(url + path, { headers: { "User-Agent": "reflex-artifacts" } });
				hb(`health ${r.status}`);
				if (r.ok) return;
			} catch (e) {
				hb(`health ${String(e).slice(0, 60)}`);
			}
			await sleep(5_000);
		}
		throw new Error(`backend never answered ${path} with 2xx`);
	}

	async deleteService(serviceId: string): Promise<void> {
		await json(`${API}/services/${serviceId}`, { method: "DELETE", token: this.token }).catch((e) => {
			if (!String(e).includes("404")) throw e;
		});
	}
}
