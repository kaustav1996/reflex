/**
 * `reflex web` — a local browser interface with multiple sessions.
 *
 * Each session tab is its own `reflex --mode rpc` process (same extensions: reflex layer,
 * browse, computer use), so everything still runs on this machine. The page talks to this
 * server over plain HTTP + Server-Sent Events: no extra dependencies.
 *
 *   GET  /                      the app
 *   GET  /api/sessions          list sessions
 *   POST /api/sessions          {cwd?, name?} → create (spawns a process)
 *   DELETE /api/sessions/:id    stop
 *   GET  /api/sessions/:id/events   SSE stream of RPC events (+ replay of recent)
 *   POST /api/sessions/:id/rpc  forward one RPC command (prompt, abort, set_model, extension_ui_response, …)
 *   GET  /api/sessions/:id/state
 *   POST /api/transcribe        audio (webm/wav) → text via the configured voice provider
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync, unwatchFile, watchFile } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createKeyResolver, loadReflexConfig } from "../config.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { piStoredApiKey } from "../extensions/typesafe/state.js";
import { transcribe } from "../extensions/voice/providers.js";
import { convertToWav } from "./audio.js";
import { describeCron, parseCron } from "../agents/cron.js";
import { attachRunListener, cancelRun, getLiveRun, liveRunsForAgent, runAgent } from "../agents/runner.js";
import { startScheduler } from "../agents/scheduler.js";
import { type AgentDefinition, agentSessionsDir, deleteAgent, listAgents, listRuns, loadAgent, loadRun, runLogPath, saveAgent } from "../agents/store.js";
import { getReflexHome, loadReflexConfig as loadCfg, saveReflexConfig, SERVICE_ENV, storeKey } from "../config.js";
import { loadMcpConfig, McpClient, saveMcpConfig } from "../extensions/mcp/client.js";
import { getPiAgentDir } from "../config.js";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);

interface Session {
	id: string;
	name: string;
	cwd: string;
	proc: ChildProcess;
	buffer: string;
	recent: string[];
	clients: Set<ServerResponse>;
	pendingUi: Map<string, unknown>;
	createdAt: number;
	alive: boolean;
	resumeFile?: string;
}

const sessions = new Map<string, Session>();
const MAX_RECENT = 2000;

interface Presence {
	pid: number;
	cwd: string;
	sessionFile: string | null;
	sessionId: string;
	name: string;
	model: string | null;
	seenAt: number;
	startedAt: number;
}
const presence = new Map<number, Presence>();
const PRESENCE_TTL = 45000;
function livePresence(): Presence[] {
	const now = Date.now();
	for (const [pid, p] of presence) if (now - p.seenAt > PRESENCE_TTL) presence.delete(pid);
	return [...presence.values()].sort((a, b) => b.startedAt - a.startedAt);
}

/** Stream a session .jsonl file as SSE `transcript_entry` events: existing entries, then appended ones. */
function tailSessionFile(file: string, res: ServerResponse, req: IncomingMessage): void {
	let offset = 0;
	let rest = "";
	const pump = () => {
		try {
			const size = statSync(file).size;
			if (size < offset) {
				offset = 0;
				rest = "";
			}
			if (size === offset) return;
			const fd = openSync(file, "r");
			try {
				const buf = Buffer.alloc(size - offset);
				readSync(fd, buf, 0, buf.length, offset);
				offset = size;
				rest += buf.toString("utf8");
			} finally {
				closeSync(fd);
			}
			let idx: number;
			while ((idx = rest.indexOf("\n")) >= 0) {
				const line = rest.slice(0, idx).trim();
				rest = rest.slice(idx + 1);
				if (!line) continue;
				try {
					res.write(`data: ${JSON.stringify({ type: "transcript_entry", entry: JSON.parse(line) })}\n\n`);
				} catch {}
			}
		} catch {}
	};
	pump();
	res.write(`data: ${JSON.stringify({ type: "replay_done" })}\n\n`);
	watchFile(file, { interval: 700 }, pump);
	const ping = setInterval(() => res.write(": ping\n\n"), 25000);
	req.on("close", () => {
		clearInterval(ping);
		unwatchFile(file, pump);
	});
}

async function recentSessions(): Promise<Array<{ path: string; id: string; cwd: string; name: string; modified: number; messages: number }>> {
	try {
		const all = await SessionManager.listAll();
		return all
			.filter((s) => s.cwd && s.messageCount > 0)
			.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime())
			.slice(0, 20)
			.map((s) => ({ path: s.path, id: s.id, cwd: s.cwd, name: s.name || s.firstMessage?.slice(0, 60) || s.cwd.split("/").pop() || s.id, modified: new Date(s.modified).getTime(), messages: s.messageCount }));
	} catch {
		return [];
	}
}

function cliPath(): string {
	const require = createRequire(import.meta.url);
	return resolve(dirname(require.resolve("../../package.json")), "dist", "cli.js");
}

function broadcast(s: Session, line: string): void {
	s.recent.push(line);
	if (s.recent.length > MAX_RECENT) s.recent.splice(0, s.recent.length - MAX_RECENT);
	for (const res of s.clients) res.write(`data: ${line}\n\n`);
}

function createSession(cwd: string, name?: string, resumeFile?: string): Session {
	const id = randomUUID().slice(0, 8);
	const extra = resumeFile ? ["--session", resumeFile] : [];
	const proc = spawn(process.execPath, [cliPath(), "--mode", "rpc", ...extra], { cwd, env: { ...process.env, REFLEX_WEB: "1" }, stdio: ["pipe", "pipe", "pipe"] });
	const s: Session = { id, name: name ?? cwd.split("/").pop() ?? id, cwd, proc, buffer: "", recent: [], clients: new Set(), pendingUi: new Map(), createdAt: Date.now(), alive: true, resumeFile };
	proc.stdout?.setEncoding("utf8");
	proc.stdout?.on("data", (chunk: string) => {
		s.buffer += chunk;
		let idx: number;
		while ((idx = s.buffer.indexOf("\n")) >= 0) {
			const line = s.buffer.slice(0, idx).replace(/\r$/, "");
			s.buffer = s.buffer.slice(idx + 1);
			if (!line.trim()) continue;
			try {
				const ev = JSON.parse(line) as { type?: string; id?: string; method?: string };
				if (ev.type === "extension_ui_request" && ev.id && ["select", "confirm", "input", "editor"].includes(ev.method ?? "")) s.pendingUi.set(ev.id, ev);
				if (ev.type === "extension_ui_response" && ev.id) s.pendingUi.delete(ev.id);
			} catch {
				continue;
			}
			broadcast(s, line);
		}
	});
	proc.stderr?.setEncoding("utf8");
	proc.stderr?.on("data", (chunk: string) => broadcast(s, JSON.stringify({ type: "stderr", text: String(chunk) })));
	proc.on("exit", (code) => {
		s.alive = false;
		broadcast(s, JSON.stringify({ type: "session_exit", code }));
	});
	sessions.set(id, s);
	return s;
}

function send(s: Session, command: Record<string, unknown>): void {
	if (!s.alive) throw new Error("session has exited");
	if (command.type === "extension_ui_response" && typeof command.id === "string") s.pendingUi.delete(command.id);
	s.proc.stdin?.write(`${JSON.stringify(command)}\n`);
}

async function readBody(req: IncomingMessage, limit = 30 * 1024 * 1024): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size > limit) throw new Error("body too large");
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks);
}

const json = (res: ServerResponse, status: number, body: unknown) => {
	res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
	res.end(JSON.stringify(body));
};

export async function runWeb(options: { port?: number; open?: boolean } = {}): Promise<void> {
	const port = options.port ?? Number(process.env.REFLEX_WEB_PORT ?? 7331);
	const require = createRequire(import.meta.url);
	const appPath = join(dirname(require.resolve("../../package.json")), "web", "app.html");
	const html = () => (existsSync(appPath) ? readFileSync(appPath, "utf8") : "<h1>reflex web: app.html missing</h1>");
	const token = randomUUID();

	const server = createServer(async (req, res) => {
		try {
			const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
			// Same-origin only: the page carries the token; curl/other origins are refused.
			const isApi = url.pathname.startsWith("/api/");
			const isPresence = url.pathname.startsWith("/api/presence") || url.pathname.startsWith("/hooks/");
			if (isApi && !isPresence && req.headers["x-reflex-token"] !== token && url.searchParams.get("token") !== token) return json(res, 403, { error: "forbidden" });

			// Webhook triggers: POST /hooks/<agentId>/<secret> with JSON or text body.
			const hm = url.pathname.match(/^\/hooks\/([a-z0-9-]+)\/([a-f0-9]{8,})$/);
			if (hm && req.method === "POST") {
				const agent = loadAgent(hm[1]);
				const trig = agent?.triggers.find((t) => t.type === "webhook" && t.secret === hm[2] && t.enabled !== false);
				if (!agent || !trig) return json(res, 404, { error: "unknown hook" });
				if (!agent.enabled) return json(res, 409, { error: "agent disabled" });
				const raw = (await readBody(req, 2 * 1024 * 1024)).toString("utf8");
				let input = raw;
				try {
					const parsed = JSON.parse(raw) as { input?: unknown };
					input = typeof parsed?.input === "string" ? parsed.input : JSON.stringify(parsed, null, 2);
				} catch {}
				void runAgent(agent, { type: "webhook" }, input);
				const id = await new Promise<string>((r) => setTimeout(() => r(listRuns(agent.id, 1)[0]?.id ?? ""), 150));
				return json(res, 202, { ok: true, agent: agent.id, runId: id });
			}
			// Presence from terminal sessions (loopback only; the server never binds elsewhere).
			if (url.pathname === "/api/presence" && req.method === "POST") {
				const body = JSON.parse((await readBody(req, 64 * 1024)).toString("utf8")) as Partial<Presence>;
				if (typeof body.pid !== "number" || typeof body.cwd !== "string") return json(res, 400, { error: "pid and cwd required" });
				const prev = presence.get(body.pid);
				presence.set(body.pid, { pid: body.pid, cwd: body.cwd, sessionFile: body.sessionFile ?? null, sessionId: body.sessionId ?? "", name: body.name ?? body.cwd, model: body.model ?? null, seenAt: Date.now(), startedAt: prev?.startedAt ?? Date.now() });
				return json(res, 200, { ok: true });
			}
			const pm = url.pathname.match(/^\/api\/presence\/(\d+)$/);
			if (pm && req.method === "DELETE") {
				presence.delete(Number(pm[1]));
				return json(res, 200, { ok: true });
			}
			const tm = url.pathname.match(/^\/api\/terminal\/(\d+)\/events$/);
			if (tm && req.method === "GET") {
				const p = presence.get(Number(tm[1]));
				if (!p?.sessionFile || !existsSync(p.sessionFile)) return json(res, 404, { error: "no transcript for this terminal session (started with --no-session?)" });
				res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
				return tailSessionFile(p.sessionFile, res, req);
			}

			if (url.pathname === "/" && req.method === "GET") {
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
				return res.end(html().replace("__REFLEX_TOKEN__", token).replace("__REFLEX_HOME__", homedir()));
			}
			if (url.pathname === "/api/sessions" && req.method === "GET") {
				const live = livePresence();
				const openFiles = new Set([...sessions.values()].map((s) => s.resumeFile).filter(Boolean));
				const recent = (await recentSessions()).filter((r) => !live.some((p) => p.sessionFile === r.path) && !openFiles.has(r.path));
				return json(res, 200, {
					sessions: [...sessions.values()].map((s) => ({ id: s.id, name: s.name, cwd: s.cwd, alive: s.alive, createdAt: s.createdAt, pendingUi: [...s.pendingUi.values()] })),
					terminal: live,
					recent,
				});
			}
			if (url.pathname === "/api/sessions" && req.method === "POST") {
				const body = JSON.parse((await readBody(req)).toString("utf8") || "{}") as { cwd?: string; name?: string; sessionFile?: string };
				let cwd = resolve((body.cwd ?? process.cwd()).replace(/^~(?=$|\/)/, homedir()));
				let resumeFile: string | undefined;
				if (body.sessionFile) {
					if (!existsSync(body.sessionFile)) return json(res, 404, { error: "session file not found" });
					if (livePresence().some((p) => p.sessionFile === body.sessionFile)) return json(res, 409, { error: "that session is open in a terminal right now; close it there first" });
					resumeFile = body.sessionFile;
					const info = (await recentSessions()).find((r) => r.path === body.sessionFile);
					if (info?.cwd && existsSync(info.cwd)) cwd = info.cwd;
				}
				if (!existsSync(cwd)) return json(res, 400, { error: `directory not found: ${cwd}` });
				const s = createSession(cwd, body.name, resumeFile);
				return json(res, 201, { id: s.id, name: s.name, cwd: s.cwd });
			}
			const m = url.pathname.match(/^\/api\/sessions\/([a-z0-9-]+)(?:\/(events|rpc|state))?$/);
			if (m) {
				const s = sessions.get(m[1]);
				if (!s) return json(res, 404, { error: "no such session" });
				if (m[2] === "events" && req.method === "GET") {
					res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
					for (const line of s.recent) res.write(`data: ${line}\n\n`);
					res.write(`data: ${JSON.stringify({ type: "replay_done" })}\n\n`);
					s.clients.add(res);
					const ping = setInterval(() => res.write(": ping\n\n"), 25000);
					req.on("close", () => {
						clearInterval(ping);
						s.clients.delete(res);
					});
					return;
				}
				if (m[2] === "rpc" && req.method === "POST") {
					const cmd = JSON.parse((await readBody(req)).toString("utf8")) as Record<string, unknown>;
					send(s, cmd);
					return json(res, 202, { ok: true });
				}
				if (m[2] === "state" && req.method === "GET") {
					return json(res, 200, { id: s.id, name: s.name, cwd: s.cwd, alive: s.alive, pendingUi: [...s.pendingUi.values()] });
				}
				if (!m[2] && req.method === "DELETE") {
					s.proc.kill();
					sessions.delete(s.id);
					return json(res, 200, { ok: true });
				}
			}
			if (url.pathname === "/api/transcribe" && req.method === "POST") {
				const config = loadReflexConfig();
				const keys = createKeyResolver(piStoredApiKey);
				const mime = String(req.headers["content-type"] ?? "application/octet-stream");
				const raw = await readBody(req);
				const wav = await convertToWav(raw, mime);
				const result = await transcribe(wav, { config: config.voice, apiKey: keys.get(config.voice.provider) });
				return json(res, 200, result);
			}
			if (url.pathname === "/api/fs" && req.method === "GET") {
				const raw = (url.searchParams.get("path") || homedir()).replace(/^~(?=$|\/)/, homedir());
				const path = resolve(raw);
				if (!existsSync(path) || !statSync(path).isDirectory()) return json(res, 404, { error: `not a directory: ${path}` });
				const dirs: Array<{ name: string; path: string; git: boolean }> = [];
				for (const name of readdirSync(path).sort((a, b) => a.localeCompare(b))) {
					if (name.startsWith(".") || name === "node_modules" || name === "Library") continue;
					const full = join(path, name);
					try {
						if (!statSync(full).isDirectory()) continue;
					} catch {
						continue;
					}
					dirs.push({ name, path: full, git: existsSync(join(full, ".git")) });
					if (dirs.length >= 400) break;
				}
				const parent = dirname(path);
				return json(res, 200, { path, parent: parent === path ? null : parent, git: existsSync(join(path, ".git")), dirs, home: homedir() });
			}
			if (url.pathname === "/api/recent" && req.method === "GET") {
				const seen = new Map<string, number>();
				try {
					for (const info of await SessionManager.listAll()) {
						if (!info.cwd || !existsSync(info.cwd)) continue;
						const t = new Date(info.modified).getTime();
						if ((seen.get(info.cwd) ?? 0) < t) seen.set(info.cwd, t);
					}
				} catch {}
				const recent = [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([cwd, modified]) => ({ cwd, modified }));
				return json(res, 200, { recent, cwd: process.cwd(), home: homedir() });
			}
			// ── Agents ───────────────────────────────────────────────────────
			if (url.pathname === "/api/agents" && req.method === "GET") {
				const agents = listAgents().map((a) => ({ ...a, running: liveRunsForAgent(a.id).length, lastRun: listRuns(a.id, 1)[0] ?? null, triggersInfo: a.triggers.map((t) => (t.type === "cron" ? { ...t, next: describeCron(t.schedule) } : t.type === "webhook" ? { ...t, url: `http://127.0.0.1:${port}/hooks/${a.id}/${t.secret}` } : t)) }));
				return json(res, 200, { agents });
			}
			if (url.pathname === "/api/agents" && req.method === "POST") {
				const body = JSON.parse((await readBody(req)).toString("utf8")) as Partial<AgentDefinition> & { name: string; prompt: string };
				if (!body.name?.trim() || !body.prompt?.trim()) return json(res, 400, { error: "name and prompt are required" });
				for (const t of body.triggers ?? []) if (t.type === "cron") parseCron(t.schedule);
				if (body.cwd) body.cwd = resolve(body.cwd.replace(/^~(?=$|\/)/, homedir()));
				const a = saveAgent(body);
				return json(res, 201, { agent: a });
			}
			const am = url.pathname.match(/^\/api\/agents\/([a-z0-9-]+)(?:\/(run|runs|toggle))?$/);
			if (am) {
				const agent = loadAgent(am[1]);
				if (!agent) return json(res, 404, { error: "no such agent" });
				if (!am[2] && req.method === "GET") return json(res, 200, { agent, runs: listRuns(agent.id, 100), live: liveRunsForAgent(agent.id).map((r) => r.id) });
				if (!am[2] && req.method === "DELETE") {
					for (const r of liveRunsForAgent(agent.id)) cancelRun(r.id);
					deleteAgent(agent.id);
					return json(res, 200, { ok: true });
				}
				if (am[2] === "toggle" && req.method === "POST") return json(res, 200, { agent: saveAgent({ ...agent, enabled: !agent.enabled }) });
				if (am[2] === "run" && req.method === "POST") {
					const body = JSON.parse((await readBody(req)).toString("utf8") || "{}") as { input?: string };
					const runPromise = runAgent(agent, { type: "manual" }, body.input);
					const id = await new Promise<string>((r) => setTimeout(() => r(listRuns(agent.id, 1)[0]?.id ?? ""), 150));
					void runPromise;
					return json(res, 202, { runId: id });
				}
				if (am[2] === "runs" && req.method === "GET") return json(res, 200, { runs: listRuns(agent.id, 100) });
			}
			const rm = url.pathname.match(/^\/api\/agents\/([a-z0-9-]+)\/runs\/([A-Za-z0-9-]+)(?:\/(events|cancel))?$/);
			if (rm) {
				const agentId = rm[1];
				const runRec = loadRun(agentId, rm[2]);
				if (!runRec) return json(res, 404, { error: "no such run" });
				if (rm[3] === "cancel" && req.method === "POST") return json(res, 200, { ok: cancelRun(runRec.id) });
				if (rm[3] === "events" && req.method === "GET") {
					res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
					const log = runLogPath(runRec);
					if (existsSync(log)) for (const line of readFileSync(log, "utf8").split("\n")) if (line.trim()) res.write(`data: ${line}\n\n`);
					res.write(`data: ${JSON.stringify({ type: "replay_done" })}\n\n`);
					const detach = attachRunListener(runRec.id, (_r, ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`));
					if (!detach) res.write(`data: ${JSON.stringify({ type: "run_closed", status: runRec.status })}\n\n`);
					const ping = setInterval(() => res.write(": ping\n\n"), 25000);
					req.on("close", () => {
						clearInterval(ping);
						detach?.();
					});
					return;
				}
				if (!rm[3] && req.method === "GET") return json(res, 200, { run: runRec, live: !!getLiveRun(runRec.id) });
			}

			// ── Settings ─────────────────────────────────────────────────────
			if (url.pathname === "/api/settings" && req.method === "GET") {
				const cfg = loadCfg();
				const keys = createKeyResolver(piStoredApiKey);
				const keyStatus = Object.fromEntries(["typesafe", "sarvam", "openai", "groq", "deepgram", "openrouter", "anthropic", "google"].map((k) => [k, keys.source(k) ?? null]));
				let packages: unknown = [];
				try {
					const sp = JSON.parse(readFileSync(join(getPiAgentDir(), "settings.json"), "utf8")) as { packages?: unknown };
					packages = sp.packages ?? [];
				} catch {}
				const skillsDir = join(getPiAgentDir(), "skills");
				const skills = existsSync(skillsDir) ? readdirSync(skillsDir).filter((n) => existsSync(join(skillsDir, n, "SKILL.md"))).map((n) => ({ name: n, description: (readFileSync(join(skillsDir, n, "SKILL.md"), "utf8").match(/^description:\s*>?\s*([\s\S]*?)\n(?:[a-z-]+:|---)/m)?.[1] ?? "").replace(/\s+/g, " ").trim().slice(0, 200) })) : [];
				return json(res, 200, { config: cfg, keys: keyStatus, env: SERVICE_ENV, packages, skills, mcp: loadMcpConfig(), agentDir: getPiAgentDir(), home: getReflexHome() });
			}
			if (url.pathname === "/api/settings" && req.method === "POST") {
				const body = JSON.parse((await readBody(req)).toString("utf8")) as { config?: Partial<ReturnType<typeof loadCfg>>; keys?: Record<string, string> };
				if (body.keys) for (const [k, v] of Object.entries(body.keys)) if (typeof v === "string") storeKey(k, v.trim() || undefined);
				if (body.config) {
					const cfg = loadCfg();
					const merged = { ...cfg, ...body.config, reflex: { ...cfg.reflex, ...(body.config.reflex ?? {}) }, voice: { ...cfg.voice, ...(body.config.voice ?? {}) }, browser: { ...cfg.browser, ...(body.config.browser ?? {}) }, ui: { ...cfg.ui, ...(body.config.ui ?? {}) }, llm: { ...cfg.llm, ...(body.config.llm ?? {}) } };
					saveReflexConfig(merged);
				}
				return json(res, 200, { ok: true });
			}
			if (url.pathname === "/api/packages" && req.method === "POST") {
				const body = JSON.parse((await readBody(req)).toString("utf8")) as { action: "install" | "remove"; source: string };
				if (!/^(npm:|git:|https?:\/\/|ssh:\/\/|\/|\.\/)/.test(body.source ?? "")) return json(res, 400, { error: "source must be npm:<pkg>, git:<host/user/repo>, an https URL or a local path" });
				try {
					const { stdout, stderr } = await run(process.execPath, [cliPath(), body.action, body.source], { timeout: 180000, env: { ...process.env, PI_TELEMETRY: "0" } });
					return json(res, 200, { ok: true, output: `${stdout}\n${stderr}`.trim() });
				} catch (err) {
					const e = err as { stdout?: string; stderr?: string; message: string };
					return json(res, 500, { error: `${e.stderr || ""}\n${e.stdout || ""}`.trim() || e.message });
				}
			}
			if (url.pathname === "/api/skills" && req.method === "POST") {
				// Add skills from a GitHub/git repo: clones and copies every folder containing a SKILL.md (optionally only `skill`).
				const body = JSON.parse((await readBody(req)).toString("utf8")) as { repo: string; skill?: string; ref?: string };
				const repo = body.repo?.trim();
				if (!repo) return json(res, 400, { error: "repo required (owner/name or git URL)" });
				const gitUrl = /^https?:\/\/|^git@|^ssh:\/\//.test(repo) ? repo : `https://github.com/${repo.replace(/^github\.com\//, "")}.git`;
				const tmp = mkdtempSync(join(tmpdir(), "reflex-skill-"));
				try {
					await run("git", ["clone", "--depth", "1", ...(body.ref ? ["--branch", body.ref] : []), gitUrl, tmp], { timeout: 120000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
					const found: string[] = [];
					const walk = (dir: string, depth: number) => {
						if (depth > 4) return;
						for (const name of readdirSync(dir)) {
							if (name === ".git" || name === "node_modules") continue;
							const full = join(dir, name);
							try {
								if (!statSync(full).isDirectory()) continue;
							} catch {
								continue;
							}
							if (existsSync(join(full, "SKILL.md"))) found.push(full);
							else walk(full, depth + 1);
						}
					};
					if (existsSync(join(tmp, "SKILL.md"))) found.push(tmp);
					walk(tmp, 0);
					const chosen = found.filter((f) => !body.skill || f.split("/").pop() === body.skill);
					if (!chosen.length) return json(res, 404, { error: found.length ? `no skill named "${body.skill}"; available: ${found.map((f) => f.split("/").pop()).join(", ")}` : "no SKILL.md found in that repo" });
					const installed: string[] = [];
					for (const src of chosen) {
						const name = src === tmp ? repo.split("/").pop()!.replace(/\.git$/, "") : src.split("/").pop()!;
						const dest = join(getPiAgentDir(), "skills", name);
						rmSync(dest, { recursive: true, force: true });
						cpSync(src, dest, { recursive: true });
						installed.push(name);
					}
					return json(res, 200, { ok: true, installed });
				} catch (err) {
					const e = err as { stderr?: string; message: string };
					return json(res, 500, { error: (e.stderr || e.message).trim().slice(-400) });
				} finally {
					rmSync(tmp, { recursive: true, force: true });
				}
			}
			const skm = url.pathname.match(/^\/api\/skills\/([A-Za-z0-9._-]+)$/);
			if (skm && req.method === "DELETE") {
				rmSync(join(getPiAgentDir(), "skills", skm[1]), { recursive: true, force: true });
				return json(res, 200, { ok: true });
			}
			if (url.pathname === "/api/mcp" && req.method === "POST") {
				const body = JSON.parse((await readBody(req)).toString("utf8")) as { servers: ReturnType<typeof loadMcpConfig>["servers"] };
				saveMcpConfig({ servers: body.servers ?? {} });
				return json(res, 200, { ok: true });
			}
			if (url.pathname === "/api/mcp/test" && req.method === "POST") {
				const body = JSON.parse((await readBody(req)).toString("utf8")) as { name: string; server: ConstructorParameters<typeof McpClient>[1] };
				const client = new McpClient(body.name, body.server);
				try {
					await client.connect(20000);
					return json(res, 200, { ok: true, server: client.serverInfo, tools: client.tools.map((t) => ({ name: t.name, description: (t.description ?? "").slice(0, 160) })) });
				} catch (err) {
					return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
				} finally {
					client.close();
				}
			}
			if (url.pathname === "/api/config" && req.method === "GET") {
				const config = loadReflexConfig();
				return json(res, 200, { voice: config.voice.provider, reflex: config.reflex.enabled ? config.reflex.riskAppetite : "off", model: `${config.llm.provider}/${config.llm.model}` });
			}
			json(res, 404, { error: "not found" });
		} catch (err) {
			json(res, 500, { error: err instanceof Error ? err.message : String(err) });
		}
	});

	await new Promise<void>((resolveListen, rejectListen) => {
		server.once("error", (err: NodeJS.ErrnoException) => rejectListen(err.code === "EADDRINUSE" ? new Error(`port ${port} is already in use (another reflex web?). Try: reflex web --port ${port + 1}`) : err));
		server.listen(port, "127.0.0.1", resolveListen);
	});
	const address = `http://127.0.0.1:${port}/`;
	process.env.REFLEX_WEB_TOKEN = token;
	process.env.REFLEX_WEB_URL = address.replace(/\/$/, "");
	const stopScheduler = startScheduler((msg) => console.log(`   ⏰ ${msg}`));
	console.log(`⚡ reflex web  ${address}`);
	console.log("   each tab is its own reflex process on this machine (reflex layer, browse, computer use all active)");
	console.log(`   agents: ${listAgents().length} defined · cron scheduler and webhooks active while this runs`);
	console.log("   ctrl+c to stop; sessions are persisted under ~/.reflex/agent/sessions like the terminal ones");
	if (options.open !== false && process.platform === "darwin") spawn("open", [address], { stdio: "ignore" }).unref();

	const shutdown = () => {
		stopScheduler();
		for (const s of sessions.values()) s.proc.kill();
		server.close();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}
