/**
 * reflex artifact list | deploy <dir> [--name x] | status <id> | delete <id> | config
 */
import { loadDotEnv } from "../config.js";
import { deployArtifact, destroyArtifact, registerArtifact } from "./deploy.js";
import { githubAuth } from "./github.js";
import { artifactsConfig, listArtifacts, listDeploys, loadArtifact } from "./store.js";

export async function runArtifactCli(args: string[]): Promise<void> {
	loadDotEnv();
	const sub = args[0] ?? "list";
	if (sub === "list") {
		const all = listArtifacts();
		if (!all.length) return console.log("no artifacts yet. reflex artifact deploy <folder>");
		for (const a of all) console.log(`${a.id.padEnd(24)} ${a.manifest.kind.padEnd(9)} ${(a.netlify?.url ?? "-").padEnd(40)} ${a.lastDeploy ? `${a.lastDeploy.status} ${new Date(a.lastDeploy.at).toLocaleString()}` : "never deployed"}  ${a.dir}`);
		return;
	}
	if (sub === "config") {
		const gh = githubAuth();
		const c = artifactsConfig(gh ? { ok: true, source: gh.source } : undefined);
		console.log(`frontend (Netlify): ${c.frontend.ok ? `ok · ${c.frontend.domain}` : `missing ${c.frontend.missing.join(", ")}`}`);
		console.log(`backend (Render):   ${c.backend.ok ? `ok · region ${c.backend.region}` : `missing ${c.backend.missing.join(", ")}`}`);
		console.log(`github:             ${c.github.ok ? `ok · ${c.github.source}` : `missing ${c.github.missing.join(", ")}`}`);
		return;
	}
	if (sub === "deploy") {
		const dir = args[1];
		if (!dir) throw new Error("usage: reflex artifact deploy <folder> [--name slug]");
		const ni = args.indexOf("--name");
		const rec = registerArtifact(dir, ni >= 0 ? args[ni + 1] : undefined);
		console.log(`artifact ${rec.id} (${rec.manifest.kind}, manifest ${rec.manifest.source}) from ${rec.dir}`);
		const d = await deployArtifact(rec.id, {
			trigger: "manual",
			onEvent: (ev) => {
				if (ev.type === "step" && ev.step.status !== "pending") console.log(`${ev.step.status === "ok" ? "✓" : ev.step.status === "failed" ? "✗" : ev.step.status === "skipped" ? "–" : "▶"} ${ev.step.label}${ev.step.detail ? ` · ${ev.step.detail}` : ""}`);
				if (ev.type === "log") console.log(`  ${ev.line}`);
			},
		});
		if (d.status !== "succeeded") {
			console.error(`deploy ${d.status}: ${d.error ?? ""}`);
			process.exitCode = 1;
		} else console.log(`\n${d.frontendUrl}${d.backendUrl ? `\napi: ${d.backendUrl}` : ""}`);
		return;
	}
	if (sub === "status") {
		const a = loadArtifact(args[1] ?? "");
		if (!a) throw new Error(`unknown artifact ${args[1]}`);
		console.log(JSON.stringify({ ...a, deploys: listDeploys(a.id, 5).map((d) => ({ id: d.id, status: d.status, startedAt: new Date(d.startedAt).toISOString(), error: d.error, url: d.frontendUrl })) }, null, 2));
		return;
	}
	if (sub === "delete" || sub === "destroy") {
		if (!args[1]) throw new Error("usage: reflex artifact delete <id>");
		await destroyArtifact(args[1], (l) => console.log(l));
		console.log(`deleted artifact ${args[1]}`);
		return;
	}
	console.log("usage: reflex artifact list | deploy <folder> [--name slug] | status <id> | delete <id> | config");
}
