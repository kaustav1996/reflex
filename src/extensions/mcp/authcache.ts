/**
 * Clear the `mcp-remote` OAuth token cache for a given remote URL.
 *
 * `mcp-remote` (the stdio→remote-OAuth bridge Reflex uses for OAuth presets) caches tokens
 * under `~/.mcp-auth/<mcp-remote-*>/<md5(url)>_*`. The cache is keyed by the md5 of the server
 * URL, so we can remove exactly one server's tokens without touching other services.
 *
 * Why: removing a connector from `~/.reflex/mcp.json` only drops the *connection config*; the
 * cached OAuth token survives, so reconnecting silently reuses it. For security symmetry —
 * "remove" should mean "I am disconnecting" — Reflex clears the cached token on remove, and
 * optionally on connect so a reconnect re-prompts for consent.
 *
 * This is a best-effort, version-tolerant scrape of `mcp-remote`'s cache layout. If the layout
 * changes we simply clear nothing and fall back to the normal flow (a stale token may be reused).
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** Root of the mcp-remote token cache. */
export function mcpAuthDir(): string {
	return join(homedir(), ".mcp-auth");
}

/**
 * Remove all cached credentials for `url` across every installed `mcp-remote` version dir.
 * Returns the number of files removed.
 */
export function clearOAuthCache(url: string): number {
	const dir = mcpAuthDir();
	if (!existsSync(dir)) return 0;
	const prefix = createHash("md5").update(url).digest("hex");
	let removed = 0;
	for (const entry of readdirSync(dir)) {
		// version subdirs look like: mcp-remote-0.1.37, mcp-remote-0.2.1, mcp-remote-v1, …
		if (!entry.startsWith("mcp-remote")) continue;
		const vdir = join(dir, entry);
		try {
			for (const file of readdirSync(vdir)) {
				if (file.startsWith(`${prefix}_`)) {
					rmSync(join(vdir, file), { force: true });
					removed++;
				}
			}
		} catch {
			/* dir vanished or unreadable — ignore */
		}
	}
	return removed;
}
