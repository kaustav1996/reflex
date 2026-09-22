/**
 * `reflex agent …` subcommands for humans and for the coding agent building agents.
 */
import { describeCron } from "./cron.js";
import { runAgent } from "./runner.js";
import { deleteAgent, listAgents, listRuns, loadAgent, saveAgent } from "./store.js";

/** The first message of an import review session. */
export function importKickoff(stagingId: string, name: string): string {
	return `I'm importing the shared agent "${name}" (staged as ${stagingId}). Review it with me using the reflex-agent-import skill: explain what it does, set it up for this machine, check what it needs, and trial-run it when I say so. Don't add it until I decide.`;
}

export async function runAgentCli(args: string[]): Promise<void> {
	const [sub, ...rest] = args;
	const flag = (name: string) => {
		const i = rest.indexOf(name);
		return i >= 0 ? rest[i + 1] : undefined;
	};
	switch (sub) {
		case "list": {
			const agents = listAgents();
			if (!agents.length) return console.log("no agents yet — create one in `reflex web` → Agents, or ask the coding agent (skill: reflex-agents)");
			for (const a of agents) {
				const runs = listRuns(a.id, 1);
				const trig = a.triggers.map((t) => (t.type === "cron" ? `cron ${t.schedule} (${describeCron(t.schedule)})` : t.type === "webhook" ? "webhook" : "manual")).join(", ");
				console.log(`${a.enabled ? "●" : "○"} ${a.id.padEnd(24)} ${a.name}  [${trig}]${runs[0] ? `  last: ${runs[0].status} ${new Date(runs[0].startedAt).toLocaleString()}` : ""}`);
			}
			return;
		}
		case "run": {
			const id = rest[0];
			const agent = id && loadAgent(id);
			if (!agent) throw new Error(`unknown agent "${id}". reflex agent list`);
			const input = flag("--input");
			console.log(`▶ running ${agent.name} …`);
			// A session hook starts runs with --trigger hook --from <hook@session>, so the run says where it came from.
			const trigger = flag("--trigger") === "hook" ? ({ type: "hook", from: flag("--from") } as const) : ({ type: "manual" } as const);
			const trial = rest.includes("--trial");
			if (trial) console.log("  trial: read and local steps run; external steps are only reported");
			const run = await runAgent(agent, trigger, input, (_r, ev) => {
				const e = ev as { type?: string; toolName?: string; args?: Record<string, unknown>; id?: string; ok?: boolean; result?: { skipped?: string; wouldRun?: string } };
				if (e.type === "tool_execution_start") console.log(`  ↳ ${e.toolName} ${JSON.stringify(e.args ?? {}).slice(0, 100)}`);
				if (e.type === "step_end") console.log(e.result?.skipped ? `  ⤼ ${e.id}: not run (${e.result.skipped})${e.result.wouldRun ? ` — would run: ${e.result.wouldRun.split("\n")[0].slice(0, 120)}` : ""}` : `  ${e.ok ? "✓" : "✗"} ${e.id}`);
			}, { trial });
			console.log(`\n${run.status === "succeeded" ? "✓" : "✗"} ${run.status} · run ${run.id} · ${run.toolCalls} tool calls · ${run.reflexBlocks} reflex blocks · ${((run.endedAt ?? Date.now()) - run.startedAt) / 1000}s`);
			if (run.output) console.log(`\n${run.output}`);
			if (run.error) console.log(`\nerror: ${run.error}`);
			process.exitCode = run.status === "succeeded" ? 0 : 1;
			return;
		}
		case "runs": {
			const id = rest[0];
			if (!id) throw new Error("usage: reflex agent runs <id>");
			for (const r of listRuns(id, 20)) console.log(`${r.status.padEnd(9)} ${r.id}  ${new Date(r.startedAt).toLocaleString()}  ${r.trigger.type}${r.trigger.from ? ` ← ${r.trigger.from}` : ""}${r.cost ? `  $${r.cost.totalUsd.toFixed(4)}` : ""}${r.resumes ? `  resumed×${r.resumes}` : ""}  ${r.toolCalls} tools${r.output ? `  · ${r.output.split("\n")[0].slice(0, 60)}` : ""}`);
			return;
		}
		case "create": {
			const name = flag("--name");
			const prompt = flag("--prompt");
			if (!name || !prompt) throw new Error('usage: reflex agent create --name "…" --prompt "…" [--cwd dir] [--cron "0 9 * * 1-5"] [--webhook] [--model provider/id] [--reflex balanced] [--instructions "…"]');
			const triggers: Parameters<typeof saveAgent>[0]["triggers"] = [{ type: "manual" }];
			const cron = flag("--cron");
			if (cron) triggers.push({ type: "cron", schedule: cron });
			if (rest.includes("--webhook")) triggers.push({ type: "webhook", secret: "" });
			const a = saveAgent({ name, prompt, cwd: flag("--cwd") ?? process.cwd(), model: flag("--model"), reflex: flag("--reflex") as never, instructions: flag("--instructions"), triggers });
			console.log(`created ${a.id} → ~/.reflex/agents/${a.id}/agent.json`);
			for (const t of a.triggers) if (t.type === "webhook") console.log(`webhook: POST http://127.0.0.1:7331/hooks/${a.id}/${t.secret}`);
			return;
		}
		case "resume": {
			const [agentId, runId] = rest;
			if (!agentId || !runId) throw new Error("usage: reflex agent resume <agent-id> <run-id>   (continues a failed/timed-out/cancelled workflow run from its last completed step)");
			const { loadAgent: load } = await import("./store.js");
			const a = load(agentId);
			if (!a) throw new Error(`unknown agent ${agentId}`);
			const { resumeRun } = await import("./runner.js");
			const r = await resumeRun(a, runId, (_r, ev) => {
				const e = ev as { type?: string; id?: string; stepType?: string; ok?: boolean; run?: { completed?: string[]; nextStep?: string } };
				if (e.type === "run_resumed") console.log(`↻ resuming after [${(e.run?.completed ?? []).join(", ")}] → next: ${e.run?.nextStep}`);
				if (e.type === "step_end") console.log(`${e.ok ? "✓" : "✗"} ${e.stepType} ${e.id}`);
			});
			console.log(`${r.status}${r.error ? `: ${r.error}` : ""}${r.cost ? ` · $${r.cost.totalUsd.toFixed(4)} · ${r.cost.jevCalls} jev · ${r.cost.llmRuns} llm` : ""}`);
			if (r.output) console.log(r.output);
			return;
		}
		case "export": {
			const id = rest[0];
			const agent = id && loadAgent(id);
			if (!agent) throw new Error("usage: reflex agent export <id> [--out file] [--author name]   (Jev picks the machine-specific values to turn into parameters)");
			const { buildBundle, findParamCandidates, judgeCandidates, suggestEffects } = await import("./bundle.js");
			const candidates = await judgeCandidates(agent, findParamCandidates(agent));
			const chosen = candidates.filter((c) => (c.score ?? 0) >= 0.5);
			for (const c of candidates) console.log(`  ${(c.score ?? 0) >= 0.5 ? "✓" : "·"} ${c.suggestedId.padEnd(16)} ${(c.score ?? 0).toFixed(2)}  ${c.value}`);
			const effects = await suggestEffects(agent.steps ?? []);
			const { bundle, warnings } = buildBundle(agent, {
				params: chosen.map((c) => ({ id: c.suggestedId, type: c.type, description: `Replace with your own ${c.type === "dir" ? "folder" : c.type} (the author's was ${c.value})`, value: c.value })),
				effects: Object.fromEntries(Object.entries(effects).map(([k, v]) => [k, v.effect])),
				meta: { author: flag("--author") },
			});
			const { writeFileSync } = await import("node:fs");
			const out = flag("--out") ?? `${agent.id}.reflex-agent.json`;
			writeFileSync(out, `${JSON.stringify(bundle, null, 2)}\n`);
			console.log(`\nwrote ${out} · ${bundle.params.length} parameters · connectors: ${bundle.requires.connectors.map((c) => c.id).join(", ") || "none"} · secrets: ${bundle.requires.secrets.map((x) => x.name).join(", ") || "none"}`);
			for (const w of warnings) console.log(`⚠ ${w}`);
			return;
		}
		case "import": {
			const file = rest[0];
			if (!file) throw new Error("usage: reflex agent import <file.reflex-agent.json> [--cwd dir] [--yes]   (opens a session that reviews it with you; nothing is added until you add it)");
			const { existsSync, readFileSync } = await import("node:fs");
			const { resolve } = await import("node:path");
			const { homedir } = await import("node:os");
			const path = resolve(file.replace(/^~(?=$|\/)/, homedir()));
			if (!existsSync(path)) throw new Error(`no file at ${path}`);
			let cwd = resolve((flag("--cwd") ?? process.cwd()).replace(/^~(?=$|\/)/, homedir()));
			if (!flag("--cwd") && !rest.includes("--yes") && process.stdin.isTTY) {
				const { createInterface } = await import("node:readline/promises");
				const rl = createInterface({ input: process.stdin, output: process.stdout });
				const answer = (await rl.question(`Review it in ${cwd}? [Y/n or another folder] `)).trim();
				rl.close();
				if (/^n(o)?$/i.test(answer)) return console.log("cancelled; pass --cwd <folder> to choose one");
				if (answer && !/^y(es)?$/i.test(answer)) cwd = resolve(answer.replace(/^~(?=$|\/)/, homedir()));
			}
			if (!existsSync(cwd)) throw new Error(`folder ${cwd} doesn't exist`);
			const { stageBundle } = await import("./staging.js");
			const staged = await stageBundle(readFileSync(path, "utf8"), { source: path, cwd });
			console.log(`staged "${staged.bundle.meta.name}" as ${staged.id} · opening a review session in ${cwd}`);
			const { spawn } = await import("node:child_process");
			const { createRequire } = await import("node:module");
			const { dirname } = await import("node:path");
			const cli = resolve(dirname(createRequire(import.meta.url).resolve("../../package.json")), "dist", "cli.js");
			const kickoff = importKickoff(staged.id, staged.bundle.meta.name);
			await new Promise<void>((done) => spawn(process.execPath, [cli, "--", kickoff], { cwd, stdio: "inherit" }).on("exit", () => done()));
			return;
		}
		case "diagram": {
			if (!rest[0]) throw new Error("usage: reflex agent diagram <id>   (prints a Mermaid flowchart: trigger → shell / TypeSafe decide / LLM / call → end → chain)");
			const { loadAgent: load } = await import("./store.js");
			const a = load(rest[0]);
			if (!a) throw new Error(`unknown agent ${rest[0]}`);
			const { agentDiagram, toMermaid } = await import("./diagram.js");
			console.log(toMermaid(agentDiagram(a)));
			return;
		}
		case "delete": {
			if (!rest[0]) throw new Error("usage: reflex agent delete <id>");
			deleteAgent(rest[0]);
			console.log(`deleted ${rest[0]}`);
			return;
		}
		default:
			console.log(`reflex agent list | run <id> [--input text] | runs <id> | create --name … --prompt … [--cron … | --webhook] | delete <id>`);
	}
}
