/**
 * Sending only the tools a request needs.
 *
 * Every tool definition goes into every request, and a few connected connectors can add thousands
 * of tokens that most requests never use. The relevance questions already ask which connector a
 * request needs, so the answer can also decide which tool definitions are worth carrying.
 *
 * What is never dropped:
 *   - the core tools (read, edit, write, bash and friends): the agent's hands;
 *   - Reflex's own tools, which the user invokes by name;
 *   - every tool of the connector the request was judged to need;
 *   - anything the model has already used this session — if it reached for it once, it may again.
 *
 * Only connector tools (`server__tool`) from *other* servers are left out, and one sentence in the
 * system prompt says which servers are connected but not loaded, so the model can ask for them
 * rather than concluding they don't exist. Asking puts them back for the rest of the session.
 */

import { toolPrefix } from "../mcp/client.js";

/** Tools that are never withheld, whatever the request looks like. */
export function isCoreTool(name: string): boolean {
	return !name.includes("__");
}

export interface ToolPlan {
	keep: string[];
	dropped: string[];
	/** Servers whose tools were left out, for the note in the prompt. */
	heldBack: string[];
}

/**
 * Decide which tools this request carries. `wanted` is the connector the relevance questions chose
 * (or undefined), `used` the servers already used this session.
 */
export function planTools(all: string[], opts: { wanted?: string; used?: Set<string> }): ToolPlan {
	// A server named "cloudflare-docs" exposes tools as "cloudflare_docs__x": compare prefixes, or
	// the connector the request asked for is the one that gets left out.
	const serverOf = (name: string) => name.split("__")[0];
	const wanted = opts.wanted ? toolPrefix(opts.wanted) : undefined;
	const used = new Set([...(opts.used ?? [])].map(toolPrefix));
	const keep: string[] = [];
	const dropped: string[] = [];
	const heldBack = new Set<string>();
	for (const name of all) {
		if (isCoreTool(name)) {
			keep.push(name);
			continue;
		}
		const server = serverOf(name);
		if (server === wanted || used.has(server)) keep.push(name);
		else {
			dropped.push(name);
			heldBack.add(server);
		}
	}
	return { keep, dropped, heldBack: [...heldBack].sort() };
}

export function heldBackNote(servers: string[]): string {
	if (!servers.length) return "";
	return `\n\nConnected but not loaded for this request to save context: ${servers.join(", ")}. If you need one, say so and it will be available for the rest of the session.`;
}
