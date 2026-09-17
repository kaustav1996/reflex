/**
 * Minimal Chrome DevTools Protocol client over WebSocket. No dependencies.
 * Launches a dedicated Chrome (separate profile under ~/.reflex/chrome) or attaches
 * to an already-running one (REFLEX_CHROME_URL, e.g. http://127.0.0.1:9222).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { platform } from "node:os";
import { join } from "node:path";
import { getReflexHome } from "../../config.js";

export class CdpError extends Error {
	constructor(
		message: string,
		public readonly code?: number,
	) {
		super(message);
		this.name = "CdpError";
	}
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; method: string };

export class CdpConnection {
	private ws: WebSocket;
	private nextId = 1;
	private pending = new Map<number, Pending>();
	private listeners = new Set<(method: string, params: unknown, sessionId?: string) => void>();
	closed = false;

	private constructor(ws: WebSocket) {
		this.ws = ws;
		ws.addEventListener("message", (ev) => {
			const msg = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: { code: number; message: string }; method?: string; params?: unknown; sessionId?: string };
			if (msg.id !== undefined) {
				const p = this.pending.get(msg.id);
				if (!p) return;
				this.pending.delete(msg.id);
				if (msg.error) p.reject(new CdpError(`${p.method}: ${msg.error.message}`, msg.error.code));
				else p.resolve(msg.result);
			} else if (msg.method) {
				for (const l of this.listeners) l(msg.method, msg.params, msg.sessionId);
			}
		});
		ws.addEventListener("close", () => {
			this.closed = true;
			for (const p of this.pending.values()) p.reject(new CdpError("CDP connection closed"));
			this.pending.clear();
		});
	}

	static async connect(wsUrl: string): Promise<CdpConnection> {
		const ws = new WebSocket(wsUrl);
		await new Promise<void>((resolve, reject) => {
			ws.addEventListener("open", () => resolve(), { once: true });
			ws.addEventListener("error", () => reject(new CdpError(`cannot connect to ${wsUrl}`)), { once: true });
		});
		return new CdpConnection(ws);
	}

	send<T = unknown>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 30000): Promise<T> {
		if (this.closed) return Promise.reject(new CdpError("CDP connection closed"));
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new CdpError(`${method} timed out`));
			}, timeoutMs);
			this.pending.set(id, {
				method,
				resolve: (v) => {
					clearTimeout(timer);
					resolve(v as T);
				},
				reject: (e) => {
					clearTimeout(timer);
					reject(e);
				},
			});
			this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
		});
	}

	on(listener: (method: string, params: unknown, sessionId?: string) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	close(): void {
		if (!this.closed) this.ws.close();
	}
}

export interface ChromeHandle {
	wsUrl: string;
	httpUrl: string;
	process?: ChildProcess;
	owned: boolean;
}

function chromeBinary(): string | undefined {
	const env = process.env.REFLEX_CHROME_BIN;
	if (env && existsSync(env)) return env;
	const candidates =
		platform() === "darwin"
			? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", `${process.env.HOME}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`]
			: platform() === "win32"
				? ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"]
				: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium"];
	return candidates.find((c) => existsSync(c));
}

async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.listen(0, "127.0.0.1", () => {
			const addr = srv.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			srv.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
		});
	});
}

async function versionInfo(httpUrl: string): Promise<{ webSocketDebuggerUrl: string } | undefined> {
	try {
		const res = await fetch(`${httpUrl}/json/version`, { signal: AbortSignal.timeout(1500) });
		if (!res.ok) return undefined;
		return (await res.json()) as { webSocketDebuggerUrl: string };
	} catch {
		return undefined;
	}
}

/** Attach to REFLEX_CHROME_URL if reachable, otherwise launch a Reflex-owned Chrome. */
export async function ensureChrome(options: { headless?: boolean; attachUrl?: string } = {}): Promise<ChromeHandle> {
	const attachUrl = options.attachUrl ?? process.env.REFLEX_CHROME_URL;
	if (attachUrl) {
		const info = await versionInfo(attachUrl.replace(/\/$/, ""));
		if (info) return { wsUrl: info.webSocketDebuggerUrl, httpUrl: attachUrl, owned: false };
		throw new CdpError(`No Chrome DevTools endpoint at ${attachUrl}. Start Chrome with --remote-debugging-port or unset REFLEX_CHROME_URL.`);
	}
	const bin = chromeBinary();
	if (!bin) throw new CdpError("Google Chrome / Chromium not found. Install Chrome or set REFLEX_CHROME_BIN.");
	const port = await freePort();
	const profile = join(getReflexHome(), "chrome");
	mkdirSync(profile, { recursive: true });
	const args = [
		`--remote-debugging-port=${port}`,
		`--user-data-dir=${profile}`,
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-features=Translate,MediaRouter",
		"--disable-background-timer-throttling",
		"--window-size=1120,860",
		...(options.headless ? ["--headless=new"] : []),
		"about:blank",
	];
	const child = spawn(bin, args, { stdio: "ignore", detached: false });
	const httpUrl = `http://127.0.0.1:${port}`;
	const deadline = Date.now() + 20000;
	while (Date.now() < deadline) {
		const info = await versionInfo(httpUrl);
		if (info) return { wsUrl: info.webSocketDebuggerUrl, httpUrl, process: child, owned: true };
		if (child.exitCode !== null) throw new CdpError(`Chrome exited immediately (code ${child.exitCode})`);
		await new Promise((r) => setTimeout(r, 150));
	}
	child.kill();
	throw new CdpError("Chrome did not expose DevTools within 20s");
}
