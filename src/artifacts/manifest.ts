/**
 * Artifact manifest: what to build and how to run it. Either written by the coding agent as
 * `reflex-artifact.json` in the app folder (cowork.json is accepted too), or detected from the
 * folder layout with deterministic rules.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface FrontendSpec {
	/** Folder relative to the artifact dir ("." = root). */
	dir: string;
	/** Build command, "" for a plain static folder. */
	build: string;
	/** Folder (relative to `dir`) that gets published. */
	publish: string;
	/** Env var the frontend reads for the backend base URL; injected at build time. */
	apiUrlEnv: string;
	/** Add a `/* /index.html 200` rewrite so deep links work (single-page apps). */
	spa: boolean;
}

export interface BackendSpec {
	dir: string;
	runtime: "python" | "node";
	build: string;
	/** Must bind 0.0.0.0:$PORT. */
	start: string;
	health: string;
	env: Record<string, string>;
}

export interface Manifest {
	version: 1;
	name: string;
	kind: "static" | "fullstack";
	frontend: FrontendSpec;
	backend?: BackendSpec;
	/** How the manifest was obtained; "file" = reflex-artifact.json, "detected" = folder heuristics. */
	source: "file" | "detected";
}

export const MANIFEST_FILES = ["reflex-artifact.json", "cowork.json"];

function readJson(file: string): Record<string, unknown> | undefined {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

function pkgOf(dir: string): { deps: Record<string, string>; scripts: Record<string, string> } | undefined {
	const p = readJson(join(dir, "package.json"));
	if (!p) return undefined;
	const deps = { ...((p.dependencies as Record<string, string>) ?? {}), ...((p.devDependencies as Record<string, string>) ?? {}) };
	return { deps, scripts: (p.scripts as Record<string, string>) ?? {} };
}

/** Publish folder + api env var for the common frontend toolchains. */
export function frontendToolchain(deps: Record<string, string>): { publish: string; apiUrlEnv: string; tool: string } {
	if (deps.vite) return { publish: "dist", apiUrlEnv: "VITE_API_URL", tool: "vite" };
	if (deps["react-scripts"]) return { publish: "build", apiUrlEnv: "REACT_APP_API_URL", tool: "create-react-app" };
	if (deps["@sveltejs/kit"]) return { publish: "build", apiUrlEnv: "PUBLIC_API_URL", tool: "sveltekit" };
	if (deps.astro) return { publish: "dist", apiUrlEnv: "PUBLIC_API_URL", tool: "astro" };
	if (deps.next) return { publish: "out", apiUrlEnv: "NEXT_PUBLIC_API_URL", tool: "next (needs output: 'export')" };
	if (deps["@angular/core"]) return { publish: "dist", apiUrlEnv: "NG_API_URL", tool: "angular" };
	return { publish: "dist", apiUrlEnv: "VITE_API_URL", tool: "unknown" };
}

const FRONTEND_DIRS = ["web", "frontend", "client", "app", "ui"];
const BACKEND_DIRS = ["api", "server", "backend"];

function detectFrontend(root: string): FrontendSpec {
	const candidates = [".", ...FRONTEND_DIRS].filter((d) => existsSync(join(root, d, "package.json")));
	for (const dir of candidates) {
		const pkg = pkgOf(join(root, dir));
		if (!pkg) continue;
		if (pkg.scripts.build) {
			const tc = frontendToolchain(pkg.deps);
			const lock = existsSync(join(root, dir, "package-lock.json"));
			return { dir, build: `${lock ? "npm ci" : "npm install"} && npm run build`, publish: tc.publish, apiUrlEnv: tc.apiUrlEnv, spa: true };
		}
	}
	for (const dir of [".", ...FRONTEND_DIRS, "public", "site", "docs"]) {
		if (existsSync(join(root, dir, "index.html"))) return { dir, build: "", publish: ".", apiUrlEnv: "VITE_API_URL", spa: false };
	}
	throw new Error(`no frontend found in ${root}: expected a package.json with a build script, or an index.html (in the root or web/, frontend/, client/, public/)`);
}

function detectBackend(root: string): BackendSpec | undefined {
	for (const dir of BACKEND_DIRS) {
		const d = join(root, dir);
		if (!existsSync(d)) continue;
		if (existsSync(join(d, "requirements.txt"))) {
			const files = readdirSync(d);
			const read = (f: string) => (existsSync(join(d, f)) ? readFileSync(join(d, f), "utf8") : "");
			let start = "python main.py";
			if (/FastAPI\(/.test(read("main.py"))) start = "uvicorn main:app --host 0.0.0.0 --port $PORT";
			else if (/FastAPI\(/.test(read("app.py"))) start = "uvicorn app:app --host 0.0.0.0 --port $PORT";
			else if (/Flask\(/.test(read("app.py"))) start = "flask --app app run --host 0.0.0.0 --port $PORT";
			else if (files.includes("app.py")) start = "python app.py";
			return { dir, runtime: "python", build: "pip install -r requirements.txt", start, health: "/health", env: { DATABASE_URL: "sqlite:///./data.db" } };
		}
		const pkg = pkgOf(d);
		if (pkg && (pkg.scripts.start || pkg.scripts.build)) {
			const lock = existsSync(join(d, "package-lock.json"));
			const build = `${lock ? "npm ci" : "npm install"}${pkg.scripts.build ? " && npm run build" : ""}`;
			return { dir, runtime: "node", build, start: pkg.scripts.start ? "npm start" : "node index.js", health: "/health", env: { DATABASE_URL: "sqlite:///./data.db" } };
		}
	}
	return undefined;
}

function coerce(raw: Record<string, unknown>, fallbackName: string): Manifest {
	const fe = (raw.frontend as Partial<FrontendSpec>) ?? {};
	const be = raw.backend as Partial<BackendSpec> | undefined;
	const frontend: FrontendSpec = { dir: fe.dir ?? ".", build: fe.build ?? "npm ci && npm run build", publish: fe.publish ?? "dist", apiUrlEnv: fe.apiUrlEnv ?? "VITE_API_URL", spa: fe.spa ?? true };
	const backend: BackendSpec | undefined = be
		? { dir: be.dir ?? "api", runtime: be.runtime === "node" ? "node" : "python", build: be.build ?? (be.runtime === "node" ? "npm ci" : "pip install -r requirements.txt"), start: be.start ?? "", health: be.health ?? "/health", env: be.env ?? {} }
		: undefined;
	const kind = raw.kind === "fullstack" || (raw.kind === undefined && backend) ? "fullstack" : "static";
	if (kind === "fullstack" && !backend) throw new Error("manifest says fullstack but has no backend section");
	if (backend && !backend.start) throw new Error("backend.start is required (must bind 0.0.0.0:$PORT)");
	return { version: 1, name: String(raw.name ?? fallbackName), kind, frontend, backend: kind === "fullstack" ? backend : undefined, source: "file" };
}

/** Manifest from file if present, otherwise detected. */
export function resolveManifest(dir: string, fallbackName: string): Manifest {
	for (const f of MANIFEST_FILES) {
		const raw = readJson(join(dir, f));
		if (raw) return coerce(raw, fallbackName);
	}
	const frontend = detectFrontend(dir);
	const backend = detectBackend(dir);
	return { version: 1, name: fallbackName, kind: backend ? "fullstack" : "static", frontend, backend, source: "detected" };
}

/** DB path the persistence sidecar should snapshot, from DATABASE_URL (sqlite:///./data.db → ./data.db). */
export function sqlitePath(backend: BackendSpec | undefined): string | undefined {
	if (!backend) return undefined;
	const m = backend.env.DATABASE_URL?.match(/^sqlite:\/\/\/(.+)$/);
	return m ? m[1] : "./data.db";
}
