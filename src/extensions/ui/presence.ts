/**
 * Presence: a terminal `reflex` session announces itself to a running `reflex web`
 * (loopback only) so it shows up in the web sidebar as a live session with a
 * read-only transcript mirror. Silent when no web server is running.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";

export const DEFAULT_WEB_URL = "http://127.0.0.1:7331";

export function createPresenceExtension(): (pi: ExtensionAPI) => void {
	return (pi) => {
		if (process.env.REFLEX_WEB === "1") return; // we are a web-spawned session already
		const base = (process.env.REFLEX_WEB_URL ?? DEFAULT_WEB_URL).replace(/\/$/, "");
		let timer: NodeJS.Timeout | undefined;
		let registered = false;

		const payload = (ctx: ExtensionContext) => ({
			pid: process.pid,
			cwd: ctx.cwd,
			sessionFile: ctx.sessionManager.getSessionFile() ?? null,
			sessionId: ctx.sessionManager.getSessionId(),
			name: pi.getSessionName() ?? basename(ctx.cwd),
			model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
			mode: ctx.mode,
		});

		async function announce(ctx: ExtensionContext): Promise<void> {
			try {
				const res = await fetch(`${base}/api/presence`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload(ctx)), signal: AbortSignal.timeout(800) });
				registered = res.ok;
			} catch {
				registered = false;
			}
		}

		pi.on("session_start", async (_e, ctx) => {
			if (ctx.mode !== "tui") return;
			await announce(ctx);
			if (timer) clearInterval(timer);
			timer = setInterval(() => void announce(ctx), 15000);
			timer.unref();
		});
		pi.on("session_shutdown", async () => {
			if (timer) clearInterval(timer);
			timer = undefined;
			if (!registered) return;
			try {
				await fetch(`${base}/api/presence/${process.pid}`, { method: "DELETE", signal: AbortSignal.timeout(500) });
			} catch {}
		});
	};
}
