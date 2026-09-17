/**
 * /models [filter] — pick a model with context size and price per 1M tokens visible.
 * Pi's built-in /model hides prices; this lists what your keys can reach, sorted by provider.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function createModelsExtension(): (pi: ExtensionAPI) => void {
	return (pi) => {
		pi.registerCommand("models", {
			description: "Pick a model with prices: /models [filter], e.g. /models claude, /models openrouter/deepseek",
			handler: async (args, ctx) => {
				const filter = args.trim().toLowerCase();
				const all = ctx.modelRegistry.getAvailable();
				const models = all
					.filter((m) => !filter || `${m.provider}/${m.id} ${m.name}`.toLowerCase().includes(filter))
					.sort((a, b) => (a.provider === b.provider ? a.cost.input - b.cost.input || a.id.localeCompare(b.id) : a.provider.localeCompare(b.provider)));
				if (models.length === 0) {
					ctx.ui.notify(filter ? `No available model matches "${filter}" (${all.length} available).` : "No models available: add a key with /login or reflex setup.", "warning");
					return;
				}
				const fmtCtx = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M` : `${Math.round(n / 1000)}k`);
				const price = (n: number) => (n === 0 ? "free" : n < 0 ? "varies" : `$${n < 1 ? n.toFixed(3).replace(/0+$/, "").replace(/\.$/, "") : n.toFixed(2)}`);
				const rows = models.slice(0, 400).map((m) => {
					const current = ctx.model && ctx.model.provider === m.provider && ctx.model.id === m.id ? "● " : "  ";
					const flags = `${m.reasoning ? "R" : " "}${m.input.includes("image") ? "I" : " "}`;
					return `${current}${`${m.provider}/${m.id}`.padEnd(52)} ${fmtCtx(m.contextWindow).padStart(5)}  ${price(m.cost.input).padStart(7)} / ${price(m.cost.output).padEnd(7)} ${flags}`;
				});
				const picked = await ctx.ui.select(`Models (${models.length}) — ctx · $in / $out per 1M tokens · R=reasoning I=images`, rows);
				if (!picked) return;
				const ref = picked.slice(2).split(/\s+/)[0];
				const i = ref.indexOf("/");
				const model = ctx.modelRegistry.find(ref.slice(0, i), ref.slice(i + 1));
				if (!model) return ctx.ui.notify(`model ${ref} not found`, "error");
				const ok = await pi.setModel(model);
				ctx.ui.notify(ok ? `Model: ${model.provider}/${model.id} · ${price(model.cost.input)} / ${price(model.cost.output)} per 1M` : `No key for ${model.provider}`, ok ? "info" : "error");
			},
		});
	};
}
