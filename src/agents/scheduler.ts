/**
 * Cron scheduler: every 20 s, run agents whose cron triggers match the current minute.
 * Agent definitions are re-read from disk each tick, so edits (by you or by the coding agent) apply immediately.
 */
import { cronMatches, parseCron } from "./cron.js";
import { runAgent } from "./runner.js";
import { listAgents } from "./store.js";

const fired = new Map<string, number>(); // `${agentId}#${i}` → minute stamp

export function startScheduler(log: (msg: string) => void = () => {}): () => void {
	const tick = () => {
		const now = new Date();
		const stamp = Math.floor(now.getTime() / 60000);
		for (const agent of listAgents()) {
			if (!agent.enabled) continue;
			agent.triggers.forEach((t, i) => {
				if (t.type !== "cron" || t.enabled === false) return;
				let spec;
				try {
					spec = parseCron(t.schedule);
				} catch {
					return;
				}
				const key = `${agent.id}#${i}`;
				if (fired.get(key) === stamp || !cronMatches(spec, now)) return;
				fired.set(key, stamp);
				log(`cron → ${agent.name} (${t.schedule})`);
				void runAgent(agent, { type: "cron" }, t.input, undefined, { idempotencyKey: `cron:${i}:${stamp}` });
			});
		}
	};
	tick();
	const timer = setInterval(tick, 20000);
	return () => clearInterval(timer);
}
