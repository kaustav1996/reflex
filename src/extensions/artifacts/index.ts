/**
 * Artifacts from inside a session: the coding agent builds an app, then calls `deploy_artifact`
 * to publish it under <slug>.<DEPLOY_DOMAIN> (and a Render backend when the app has one).
 * Progress streams into the tool row; the result carries the URLs.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { deployArtifact, destroyArtifact, liveDeploy, registerArtifact } from "../../artifacts/deploy.js";
import { ghLogin, githubAuth } from "../../artifacts/github.js";
import { type ProviderName, startCliLogin, waitForCliLogin } from "../../artifacts/providers.js";
import { showForm } from "../secrets/index.js";
import { writeSecret } from "../secrets/store.js";
import { getReflexHome } from "../../config.js";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { artifactsConfig, listArtifacts, listDeploys } from "../../artifacts/store.js";
import { loadDotEnv } from "../../config.js";
import { clip } from "../typesafe/context.js";
import type { ReflexState } from "../typesafe/state.js";

const TOKEN_FIELDS: Record<ProviderName, Array<{ name: string; description: string; required?: boolean; placeholder?: string }>> = {
	netlify: [
		{ name: "NETLIFY_API_KEY", description: "Netlify personal access token (User settings → Applications → Personal access tokens)", placeholder: "nfp_…" },
		{ name: "NETLIFY_ACCOUNT_SLUG", description: "Optional: team slug from app.netlify.com/teams/<slug>; blank = your default account", required: false },
		{ name: "DEPLOY_DOMAIN", description: "Optional: a domain on Netlify DNS for <name>.<domain>; blank = <name>.netlify.app", required: false },
	],
	render: [
		{ name: "RENDER_API_KEY", description: "Render API key (Account settings → API keys)", placeholder: "rnd_…" },
		{ name: "RENDER_OWNER_ID", description: "Optional: workspace id (tea-…); blank = your first team", required: false },
	],
	github: [{ name: "GITHUB_TOKEN", description: "GitHub token with repo scope (only if you cannot use `gh auth login`)", placeholder: "ghp_… or github_pat_…" }],
};
const LABEL: Record<ProviderName, string> = { netlify: "Netlify", render: "Render", github: "GitHub" };

/**
 * Make one provider usable: offer the machine's CLI login first (no token to paste), a pasted
 * token second. Returns true when the provider is connected afterwards.
 */
async function connectProvider(ctx: ExtensionContext, provider: ProviderName, getReflex: () => ReflexState | undefined, onLine: (l: string) => void): Promise<boolean> {
	const probe = () => {
		const a = githubAuth();
		return a ? { source: a.source, login: a.source === "gh" ? ghLogin() : undefined } : undefined;
	};
	const status = () => artifactsConfig(probe() ? { ok: true, source: probe()!.source } : undefined);
	const ok = () => {
		const c = status();
		return provider === "netlify" ? c.frontend.ok : provider === "render" ? c.backend.ok : c.github.ok;
	};
	if (ok()) return true;
	const cli = status().cli.find((c) => c.provider === provider)!;
	const cliLabel = cli.installed ? `Log in with the ${cli.cli} CLI (opens your browser; nothing to paste)` : `Install the ${cli.cli} CLI (${cli.install}) and log in`;
	const choice = await ctx.ui.select(`${LABEL[provider]} is not connected on this machine. How do you want to connect it?`, [cliLabel, `Paste a ${LABEL[provider]} API token (stored in ~/.reflex/.env, never in chat)`, "Cancel"]);
	if (!choice || choice === "Cancel") return false;
	if (choice === cliLabel) {
		if (!cli.installed && provider !== "netlify") {
			ctx.ui.notify(`Install it first: ${cli.install}   then run: ${cli.login}`, "warning");
			return false;
		}
		const started = startCliLogin(provider, onLine);
		ctx.ui.notify(started.how === "spawned" ? `Running ${started.command}: finish the login in the browser tab that opens…` : started.how === "terminal" ? `Opened a Terminal window running ${started.command}; finish the login there and in your browser…` : `Run this in a terminal, then come back: ${started.command}`, "info");
		getReflex()?.record("artifact", `connect ${provider} via CLI (${started.how})`);
		const st = await waitForCliLogin(provider, probe);
		if (!st.loggedIn) {
			ctx.ui.notify(`${LABEL[provider]} still isn't logged in (waited 4 minutes). Run ${started.command} in a terminal and retry.`, "warning");
			return false;
		}
		ctx.ui.notify(`${LABEL[provider]} connected via ${cli.cli}${st.account ? ` (${st.account})` : ""}.`, "info");
		return true;
	}
	const fields = TOKEN_FIELDS[provider].map((f) => ({ ...f, required: f.required !== false }));
	const res = await showForm(ctx, { reason: `${LABEL[provider]} token for artifact deploys`, destination: "~/.reflex/.env", fields, warnings: [] });
	if (res.cancelled) return false;
	for (const f of fields) {
		const v = (res.values[f.name] ?? "").trim();
		if (!v) continue;
		writeSecret(join(getReflexHome(), ".env"), f.name, v);
		process.env[f.name] = v;
	}
	return ok();
}

export function createArtifactsExtension(getReflex: () => ReflexState | undefined): (pi: ExtensionAPI) => void {
	return (pi) => {
		pi.registerTool({
			name: "deploy_artifact",
			label: "Deploy artifact",
			description:
				"Publish an app folder as an artifact: builds the frontend and uploads it to Netlify at <name>.<DEPLOY_DOMAIN>; if the folder has a backend (api/, server/ or backend/ with requirements.txt or package.json, or a reflex-artifact.json manifest) it is pushed to a GitHub repo, deployed as a Render web service with a SQLite persistence sidecar, and its URL is injected into the frontend build. Requires NETLIFY_API_KEY, NETLIFY_ACCOUNT_SLUG, DEPLOY_DOMAIN (and RENDER_API_KEY, RENDER_OWNER_ID plus a GitHub login for backends). Returns the live URLs or the failing step.",
			promptSnippet: "Deploy an app folder as a hosted artifact (Netlify frontend, Render backend)",
			promptGuidelines: [
				"When the user asks to deploy, publish, host or share an app, call deploy_artifact with its folder instead of explaining deployment steps. Check the result's step list and fix build errors before retrying.",
				"Provider access comes from the machine's own CLI logins (netlify, render, gh); deploy_artifact offers the login flow itself when something is missing. Never request Netlify, Render or GitHub tokens with request_secrets.",
				"Apps that need a database should use SQLite via DATABASE_URL (sqlite:///./data.db); the backend must expose GET /health and bind 0.0.0.0:$PORT; the frontend reads the API base URL from VITE_API_URL (or the toolchain's equivalent). Read the reflex-artifacts skill for details.",
			],
			parameters: Type.Object({
				dir: Type.Optional(Type.String({ description: "App folder (default: current working directory)" })),
				name: Type.Optional(Type.String({ description: "Artifact name → subdomain slug (default: folder name)" })),
			}),
			async execute(_id, params, _signal, onUpdate, ctx) {
				const rec = registerArtifact(params.dir ?? ctx.cwd, params.name);
				loadDotEnv(params.dir ?? ctx.cwd); // pick up defaults saved in Settings → Artifacts after this session started
				const lines: string[] = [];
				const push = (l: string) => {
					lines.push(l);
					onUpdate?.({ content: [{ type: "text", text: lines.slice(-40).join("\n") }], details: { lines: lines.slice(-40) } });
				};
				// Connect what is missing, CLI logins first. Headless runs can only report.
				const needed: ProviderName[] = ["netlify", ...(rec.manifest.kind === "fullstack" ? (["render", "github"] as ProviderName[]) : [])];
				for (const p of needed) {
					if (ctx.hasUI) {
						if (!(await connectProvider(ctx, p, getReflex, push))) return { content: [{ type: "text", text: `${LABEL[p]} is not connected; the user did not complete the connection. Nothing was deployed. Do not ask for tokens in chat: the user can run the ${p === "github" ? "gh" : p} CLI login or use the Artifacts tab.` }], details: { cancelled: true } };
					}
				}
				const cfg = artifactsConfig(githubAuth() ? { ok: true, source: githubAuth()!.source } : undefined);
				const target = cfg.frontend.domain ? `${rec.id}.${cfg.frontend.domain}` : `rx-${rec.id}.netlify.app`;
				if (!cfg.frontend.ok) throw new Error(`artifacts need ${cfg.frontend.missing.join(", ")} (Artifacts tab in reflex web, or ~/.reflex/.env)`);
				if (rec.manifest.kind === "fullstack" && !cfg.backend.ok) throw new Error(`this app has a backend (${rec.manifest.backend?.dir}); it needs ${cfg.backend.missing.join(", ")}`);
				if (rec.manifest.kind === "fullstack" && !cfg.github.ok) throw new Error(`backend deploys push the code to a GitHub repo for Render to build: ${cfg.github.missing.join(", ")}`);
				if (liveDeploy(rec.id)) throw new Error(`artifact ${rec.id} is already deploying`);
				if (ctx.hasUI) {
					const ok = await ctx.ui.confirm(`Deploy ${rec.name} → https://${target}?`, `${rec.manifest.kind} app from ${rec.dir}${rec.manifest.backend ? ` · backend ${rec.manifest.backend.dir} → Render (public GitHub repo unless ARTIFACTS_REPO_PRIVATE=true)` : ""}`);
					if (!ok) return { content: [{ type: "text", text: "The user declined the deploy. Do not retry unless asked." }], details: { cancelled: true } };
				}
				getReflex()?.record("artifact", `deploy ${rec.id} (${rec.manifest.kind}) → ${target}`);
				const d = await deployArtifact(rec.id, {
					trigger: "agent",
					onEvent: (ev) => {
						if (ev.type === "step" && ev.step.status !== "pending") push(`${ev.step.status === "ok" ? "✓" : ev.step.status === "failed" ? "✗" : ev.step.status === "skipped" ? "–" : "▶"} ${ev.step.label}${ev.step.detail ? ` · ${ev.step.detail}` : ""}`);
						if (ev.type === "log") push(`  ${ev.line}`);
					},
				});
				const summary = d.steps.filter((s) => s.status !== "skipped").map((s) => `${s.status === "ok" ? "✓" : s.status === "failed" ? "✗" : "·"} ${s.label}${s.detail ? `: ${clip(s.detail, 200)}` : ""}`).join("\n");
				if (d.status !== "succeeded") throw new Error(`deploy ${d.status}: ${d.error}\n${summary}`);
				const text = `Deployed ${rec.name}.\nfrontend: ${d.frontendUrl}${d.fallbackUrl && d.fallbackUrl !== d.frontendUrl ? ` (also ${d.fallbackUrl})` : ""}${d.backendUrl ? `\nbackend: ${d.backendUrl}` : ""}\n\n${summary}\n\nRedeploy with the same call after changes; manage it in the Artifacts tab of reflex web.`;
				return { content: [{ type: "text", text }], details: { artifactId: rec.id, deployId: d.id, frontendUrl: d.frontendUrl, backendUrl: d.backendUrl, steps: d.steps } };
			},
			renderCall(args, theme) {
				const a = args as { dir?: string; name?: string };
				return new Text(`${theme.fg("toolTitle", theme.bold("deploy_artifact "))}${theme.fg("accent", a.name ?? "")} ${theme.fg("dim", a.dir ?? "(cwd)")}`, 0, 0);
			},
			renderResult(result, { isPartial }, theme) {
				const d = (result.details ?? {}) as { lines?: string[]; frontendUrl?: string; backendUrl?: string; cancelled?: boolean };
				if (isPartial) return new Text(`${theme.fg("warning", "● deploying")}\n${theme.fg("dim", (d.lines ?? []).slice(-8).join("\n"))}`, 0, 0);
				if (d.cancelled) return new Text(theme.fg("warning", "cancelled by user"), 0, 0);
				return new Text(`${theme.fg("success", "✓ live")} ${theme.fg("accent", d.frontendUrl ?? "")}${d.backendUrl ? theme.fg("dim", ` · api ${d.backendUrl}`) : ""}`, 0, 0);
			},
		});

		pi.registerTool({
			name: "list_artifacts",
			label: "List artifacts",
			description: "List deployed artifacts (name, kind, URLs, last deploy) and whether artifact deploys are configured on this machine.",
			parameters: Type.Object({}),
			async execute() {
				loadDotEnv();
				const gh = githubAuth();
				const cfg = artifactsConfig(gh ? { ok: true, source: gh.source } : undefined);
				const all = listArtifacts().map((a) => ({ id: a.id, name: a.name, kind: a.manifest.kind, dir: a.dir, url: a.netlify?.url, api: a.render?.url, lastDeploy: a.lastDeploy, deploys: listDeploys(a.id, 3).map((d) => ({ id: d.id, status: d.status, error: d.error })) }));
				const text = [`config: frontend ${cfg.frontend.ok ? `ok (${cfg.frontend.domain})` : `missing ${cfg.frontend.missing.join(", ")}`} · backend ${cfg.backend.ok ? "ok" : `missing ${cfg.backend.missing.join(", ")}`} · github ${cfg.github.ok ? cfg.github.source : "missing"}`, ...all.map((a) => `${a.id} (${a.kind}) ${a.url ?? "not deployed"}${a.api ? ` api ${a.api}` : ""} · ${a.lastDeploy ? `${a.lastDeploy.status} ${new Date(a.lastDeploy.at).toISOString()}` : "never"} · ${a.dir}`)].join("\n");
				return { content: [{ type: "text", text }], details: { config: cfg, artifacts: all } };
			},
		});

		pi.registerCommand("artifacts", {
			description: "Show deployed artifacts and whether deploys are configured",
			handler: async (_args, ctx) => {
				const gh = githubAuth();
				const cfg = artifactsConfig(gh ? { ok: true, source: gh.source } : undefined);
				const all = listArtifacts();
				ctx.ui.notify([`frontend ${cfg.frontend.ok ? "ok" : "missing " + cfg.frontend.missing.join(", ")} · backend ${cfg.backend.ok ? "ok" : "missing " + cfg.backend.missing.join(", ")} · github ${cfg.github.ok ? "ok" : "missing"}`, ...all.slice(0, 8).map((a) => `${a.id}: ${a.netlify?.url ?? "not deployed"}`)].join("\n"), "info");
			},
		});

		// keep the destroy path reachable from a session too (asks first)
		pi.registerTool({
			name: "delete_artifact",
			label: "Delete artifact",
			description: "Delete an artifact: removes its Netlify site, Render service, GitHub repo and SQLite snapshot, then the local record. Asks the user first.",
			parameters: Type.Object({ id: Type.String({ description: "Artifact id (slug)" }) }),
			async execute(_id, params, _signal, _onUpdate, ctx) {
				if (ctx.hasUI && !(await ctx.ui.confirm(`Delete artifact ${params.id}?`, "This removes the live site, the backend service, the repo and the database snapshot."))) return { content: [{ type: "text", text: "The user declined." }], details: { cancelled: true } };
				const lines: string[] = [];
				await destroyArtifact(params.id, (l) => lines.push(l));
				return { content: [{ type: "text", text: `deleted ${params.id}\n${lines.join("\n")}` }], details: { lines } };
			},
		});
	};
}
