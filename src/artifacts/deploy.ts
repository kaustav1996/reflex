/**
 * Deploy pipeline for one artifact. Deterministic steps, in this order:
 *
 *   manifest → [backend: push to GitHub → Render service → deploy → live → healthy]
 *            → frontend build (with the backend URL injected) → zip → Netlify deploy → ready → TLS
 *
 * Every step is logged to the deploy's jsonl file and fanned out to live listeners (web UI SSE,
 * the coding-agent tool, the CLI). Only one deploy per artifact runs at a time.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { loadDotEnv } from "../config.js";
import { Github } from "./github.js";
import { type Manifest, resolveManifest, sqlitePath } from "./manifest.js";
import { Netlify } from "./netlify.js";
import { withPersistence, writeSidecar } from "./persist.js";
import { Render } from "./render.js";
import { type ArtifactRecord, artifactSlug, artifactsConfig, type DeployRecord, type DeployStep, deployLogPath, loadArtifact, newDeployId, saveArtifact, saveDeploy } from "./store.js";

export type DeployEvent =
	| { type: "deploy_start"; deploy: DeployRecord }
	| { type: "step"; step: DeployStep }
	| { type: "log"; line: string; at: number }
	| { type: "deploy_end"; deploy: DeployRecord };

type Listener = (ev: DeployEvent) => void;
const live = new Map<string, { deploy: DeployRecord; listeners: Set<Listener> }>();

export function liveDeploy(artifactId: string): DeployRecord | undefined {
	return [...live.values()].find((l) => l.deploy.artifactId === artifactId)?.deploy;
}
export function attachDeployListener(deployId: string, fn: Listener): (() => void) | undefined {
	const l = live.get(deployId);
	if (!l) return undefined;
	l.listeners.add(fn);
	return () => l.listeners.delete(fn);
}

const STEPS: Array<[string, string]> = [
	["manifest", "Read manifest"],
	["repo", "Push backend to GitHub"],
	["service", "Render service"],
	["backend", "Backend deploy"],
	["health", "Backend health"],
	["build", "Build frontend"],
	["site", "Netlify site"],
	["publish", "Publish frontend"],
	["tls", "Certificate"],
];

/** Create (or refresh) the record for a folder. Detects the manifest; nothing is deployed. */
export function registerArtifact(dir: string, name?: string): ArtifactRecord {
	const abs = resolve(dir);
	if (!existsSync(abs)) throw new Error(`folder not found: ${abs}`);
	const manifest = resolveManifest(abs, artifactSlug(name ?? basename(abs)));
	const id = artifactSlug(name ?? manifest.name ?? basename(abs));
	const existing = loadArtifact(id);
	const rec: ArtifactRecord = existing ? { ...existing, dir: abs, manifest, name: name ?? existing.name } : { id, name: name ?? manifest.name ?? id, dir: abs, manifest, createdAt: Date.now(), updatedAt: Date.now() };
	saveArtifact(rec);
	return rec;
}

export async function deployArtifact(id: string, opts: { trigger?: DeployRecord["trigger"]; onEvent?: Listener } = {}): Promise<DeployRecord> {
	const rec = loadArtifact(id);
	if (!rec) throw new Error(`unknown artifact ${id}`);
	if (liveDeploy(id)) throw new Error(`artifact ${id} is already deploying`);
	loadDotEnv(rec.dir);

	const deploy: DeployRecord = { id: newDeployId(), artifactId: id, status: "running", startedAt: Date.now(), steps: STEPS.map(([sid, label]) => ({ id: sid, label, status: "pending" })), trigger: opts.trigger ?? "manual" };
	const entry = { deploy, listeners: new Set<Listener>() };
	if (opts.onEvent) entry.listeners.add(opts.onEvent);
	live.set(deploy.id, entry);
	mkdirSync(join(deployLogPath(deploy), ".."), { recursive: true });
	const emit = (ev: DeployEvent) => {
		try {
			appendFileSync(deployLogPath(deploy), `${JSON.stringify(ev)}\n`);
		} catch {}
		for (const l of entry.listeners) {
			try {
				l(ev);
			} catch {}
		}
	};
	const log = (line: string) => emit({ type: "log", line, at: Date.now() });
	const step = (sid: string, status: DeployStep["status"], detail?: string) => {
		const s = deploy.steps.find((x) => x.id === sid)!;
		s.status = status;
		if (status === "running") s.startedAt = Date.now();
		if (status === "ok" || status === "failed" || status === "skipped") s.endedAt = Date.now();
		if (detail) s.detail = detail;
		saveDeploy(deploy);
		emit({ type: "step", step: { ...s } });
	};
	saveDeploy(deploy);
	emit({ type: "deploy_start", deploy });

	const finish = (status: DeployRecord["status"], error?: string) => {
		deploy.status = status;
		deploy.endedAt = Date.now();
		if (error) deploy.error = error;
		for (const s of deploy.steps) if (s.status === "pending" || s.status === "running") s.status = status === "succeeded" ? "skipped" : status === "failed" && s.status === "running" ? "failed" : "skipped";
		saveDeploy(deploy);
		rec.lastDeploy = { id: deploy.id, status, at: deploy.endedAt, url: deploy.frontendUrl };
		saveArtifact(rec);
		emit({ type: "deploy_end", deploy });
		live.delete(deploy.id);
		return deploy;
	};

	let current = "manifest";
	try {
		// 1. manifest
		step("manifest", "running");
		const manifest: Manifest = resolveManifest(rec.dir, rec.id);
		rec.manifest = manifest;
		saveArtifact(rec);
		const cfg = artifactsConfig();
		if (!cfg.frontend.ok) throw new Error(`frontend deploys need ${cfg.frontend.missing.join(", ")}`);
		if (manifest.kind === "fullstack" && !cfg.backend.ok) throw new Error(`this app has a backend; backend deploys need ${cfg.backend.missing.join(", ")}`);
		step("manifest", "ok", `${manifest.kind} · ${manifest.source} · frontend ${manifest.frontend.dir} (${manifest.frontend.build || "no build"} → ${manifest.frontend.publish})${manifest.backend ? ` · backend ${manifest.backend.dir} (${manifest.backend.runtime})` : ""}`);

		const netlify = Netlify.fromEnv(rec.settings?.domain);
		let backendUrl: string | undefined;

		// 2–5. backend
		if (manifest.kind === "fullstack" && manifest.backend) {
			current = "repo";
			step("repo", "running");
			const { gh, source } = await Github.fromEnv();
			log(`github: ${gh.owner} (${source})`);
			const priv = rec.settings?.repoPrivate ?? /^(1|true|yes)$/i.test(process.env.ARTIFACTS_REPO_PRIVATE ?? "");
			const repo = await gh.ensureRepo(rec.id, priv);
			rec.github = { owner: gh.owner!, repo: repo.name, url: repo.url, private: repo.private };
			if (repo.created) log(`created ${repo.private ? "private" : "public"} repo ${repo.url}${repo.private ? " (Render must have GitHub access to read it)" : ""}`);
			// Snapshot store: Netlify Blobs on this artifact's own site, so the site must exist before the backend is configured.
			step("site", "running");
			const site = await netlify.ensureSite(rec.id);
			rec.netlify = { siteId: site.id, siteName: site.name, customDomain: site.custom_domain ?? netlify.hostname(rec.id) };
			step("site", "ok", `${site.name} → ${rec.netlify.customDomain}`);
			const dbPath = sqlitePath(manifest.backend) ?? "./data.db";
			rec.appdata = { siteId: site.id, store: "reflex-appdata", key: `${rec.id}.db.gz`, dbPath };
			const appdata = { url: netlify.blobUrl(site.id, rec.appdata.key), token: process.env.NETLIFY_API_KEY!, dbPath };
			const backendDir = join(rec.dir, manifest.backend.dir);
			if (!existsSync(backendDir)) throw new Error(`backend dir not found: ${backendDir}`);
			writeSidecar(backendDir);
			const spec = withPersistence(manifest.backend, appdata);
			const commit = gh.pushSnapshot(rec.dir, repo.url, `reflex deploy ${deploy.id}`, log);
			deploy.commit = commit;
			step("repo", "ok", `${repo.url} @ ${commit.slice(0, 7)}`);

			current = "service";
			step("service", "running");
			const render = Render.fromEnv(rec.settings?.region);
			const svc = await render.ensureService(rec.id, repo.url, spec, spec.env);
			const envChanged = await render.syncEnv(svc.id, spec.env);
			rec.render = { serviceId: svc.id, serviceName: svc.name, url: svc.url, repo: repo.url, commit };
			saveArtifact(rec);
			step("service", "ok", `${svc.name} · ${svc.url} · ${render.region}${envChanged ? " · env updated" : ""}`);

			current = "backend";
			step("backend", "running");
			const rdid = await render.deploy(svc.id, commit, envChanged);
			await render.waitLive(svc.id, rdid, (m) => log(m));
			step("backend", "ok", `deploy ${rdid} live`);

			current = "health";
			step("health", "running");
			await render.waitHealthy(svc.url, manifest.backend.health, (m) => log(m));
			backendUrl = svc.url;
			deploy.backendUrl = svc.url;
			step("health", "ok", `${svc.url}${manifest.backend.health} → 2xx · SQLite snapshots → Netlify Blobs (${rec.appdata.key})`);
		} else {
			for (const s of ["repo", "service", "backend", "health"]) step(s, "skipped", "static app");
		}

		// 6. frontend build
		current = "build";
		step("build", "running");
		const feDir = resolve(rec.dir, manifest.frontend.dir);
		const publishDir = resolve(feDir, manifest.frontend.publish);
		if (manifest.frontend.build) {
			const env: Record<string, string | undefined> = { ...process.env, CI: "1", GIT_TERMINAL_PROMPT: "0" };
			if (backendUrl) env[manifest.frontend.apiUrlEnv] = backendUrl;
			log(`$ ${manifest.frontend.build}${backendUrl ? `   (${manifest.frontend.apiUrlEnv}=${backendUrl})` : ""}`);
			const r = spawnSync(process.env.SHELL || "/bin/sh", ["-lc", manifest.frontend.build], { cwd: feDir, env, encoding: "utf8", timeout: 10 * 60_000, maxBuffer: 16 << 20 });
			const tail = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim().split("\n").slice(-30).join("\n");
			if (tail) log(tail);
			if (r.status !== 0) throw new Error(`frontend build failed (exit ${r.status})`);
		}
		if (!existsSync(join(publishDir, "index.html"))) throw new Error(`no index.html in publish folder ${publishDir}`);
		if (manifest.frontend.spa && !existsSync(join(publishDir, "_redirects"))) {
			writeFileSync(join(publishDir, "_redirects"), "/*  /index.html  200\n");
			log("added _redirects (SPA fallback)");
		}
		const zip = zipDir(publishDir, rec.id);
		step("build", "ok", `${publishDir} · ${(zip.length / 1024).toFixed(0)} KB zipped`);

		// 7. site
		current = "site";
		if (!rec.netlify) {
			step("site", "running");
			const site = await netlify.ensureSite(rec.id);
			rec.netlify = { siteId: site.id, siteName: site.name, customDomain: site.custom_domain ?? netlify.hostname(rec.id) };
			saveArtifact(rec);
			step("site", "ok", `${site.name} → ${rec.netlify.customDomain}`);
		}

		// 8–9. publish + tls
		current = "publish";
		step("publish", "running");
		const ndid = await netlify.deployZip(rec.netlify.siteId, zip, `reflex deploy ${deploy.id}`);
		step("tls", "running");
		const ready = await netlify.waitReady(rec.netlify.siteId, ndid, (m) => {
			log(m);
			if (m.includes("certificate")) step("tls", "running", m);
		});
		deploy.frontendUrl = ready.tlsReady ? ready.url : ready.fallbackUrl;
		deploy.fallbackUrl = ready.fallbackUrl;
		rec.netlify.url = ready.url;
		rec.netlify.fallbackUrl = ready.fallbackUrl;
		rec.netlify.tlsReady = ready.tlsReady;
		step("publish", "ok", ready.fallbackUrl);
		step("tls", ready.tlsReady ? "ok" : "failed", ready.tlsReady ? ready.url : `${ready.url} has no certificate yet (Netlify issues it in a few minutes; ${ready.fallbackUrl} works now)`);
		log(`live: ${deploy.frontendUrl}${backendUrl ? ` · api: ${backendUrl}` : ""}`);
		return finish("succeeded");
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		step(current, "failed", msg);
		log(`✗ ${msg}`);
		return finish("failed", msg);
	}
}

function zipDir(dir: string, id: string): Buffer {
	const out = join(dir, "..", `.reflex-${id}.zip`);
	rmSync(out, { force: true });
	// macOS/Info-ZIP syntax: zip [flags] archive inputs -x patterns ("--" before the archive is rejected).
	const r = spawnSync("zip", ["-qr", out, ".", "-x", ".DS_Store", "*/.DS_Store"], { cwd: dir, encoding: "utf8", timeout: 120_000 });
	if (r.status !== 0) throw new Error(`zip failed: ${r.stderr || r.stdout}`);
	const buf = readFileSync(out);
	rmSync(out, { force: true });
	return buf;
}

/** Remove everything the artifact created remotely (site, service, repo, snapshot) and the record. */
export async function destroyArtifact(id: string, log: (line: string) => void = () => {}): Promise<void> {
	const rec = loadArtifact(id);
	if (!rec) throw new Error(`unknown artifact ${id}`);
	loadDotEnv(rec.dir);
	if (rec.render && process.env.RENDER_API_KEY) {
		await Render.fromEnv(rec.settings?.region).deleteService(rec.render.serviceId);
		log(`deleted Render service ${rec.render.serviceName}`);
	}
	if (rec.netlify && process.env.NETLIFY_API_KEY) {
		const n = Netlify.fromEnv(rec.settings?.domain);
		if (rec.appdata) await n.deleteBlob(rec.appdata.siteId, rec.appdata.key);
		await n.deleteSite(rec.netlify.siteId);
		log(`deleted Netlify site ${rec.netlify.siteName}`);
	}
	if (rec.github) {
		try {
			const { gh } = await Github.fromEnv();
			await gh.deleteRepo(id);
			log(`deleted repo ${rec.github.url}`);
		} catch (e) {
			log(`repo not deleted (${e instanceof Error ? e.message : e}); remove ${rec.github.url} by hand`);
		}
	}
	const { deleteArtifactRecord } = await import("./store.js");
	deleteArtifactRecord(id);
}
