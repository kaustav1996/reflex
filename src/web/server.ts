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
 *   PATCH  /api/sessions/:id    rename { title }
 *   DELETE /api/sessions/:id    stop
 *   GET  /api/sessions/:id/events   SSE stream of RPC events (+ replay of recent)
 *   POST /api/sessions/:id/rpc  forward one RPC command (prompt, abort, set_model, extension_ui_response, …)
 *   GET  /api/sessions/:id/state
 *   POST /api/transcribe        audio (webm/wav) → text via the configured voice provider
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync, unwatchFile, watchFile, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createKeyResolver, loadReflexConfig } from "../config.js";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { piStoredApiKey } from "../extensions/typesafe/state.js";
import { transcribe } from "../extensions/voice/providers.js";
import { convertToWav } from "./audio.js";
import { cleanTitle } from "./titles.js";
import { describeCron, parseCron } from "../agents/cron.js";
import { attachRunListener, cancelRun, getLiveRun, liveRunsForAgent, resumeRun, runAgent } from "../agents/runner.js";
import { startScheduler } from "../agents/scheduler.js";
import { type AgentDefinition, agentSessionsDir, deleteAgent, listAgents, listBrokenAgents, listRuns, loadAgent, loadRun, runLogPath, saveAgent, findRunByKey, loadCheckpoint } from "../agents/store.js";
import { getReflexHome, loadReflexConfig as loadCfg, saveReflexConfig, SERVICE_ENV, storeKey } from "../config.js";
import { loadMcpConfig, McpClient, saveMcpConfig } from "../extensions/mcp/client.js";
import { buildPresetConfig, persistServer, removeConnector } from "../extensions/mcp/connect.js";
import { PRESET_META } from "../extensions/mcp/presets.js";
import { listOtherSkills, listPackageSkills, setPackageSkills } from "../skills/packages.js";
import { attachDeployListener, deployArtifact, destroyArtifact, liveDeploy, registerArtifact } from "../artifacts/deploy.js";
import { agentDiagram, toMermaid } from "../agents/diagram.js";
import { deleteGlobalHook, EVENT_HELP, globalHooksPath, HOOK_EVENTS, listGlobalHooks, saveGlobalHook } from "../hooks/store.js";
import { answerLogin, cancelLogin, COMPAT_PRESETS, currentDefault, EFFORTS, getLogin, listCompatProviders, listEndpointModels, logoutProvider, removeCompatProvider, saveCompatProvider, setDefaultModel, startLogin, storedAuthType, SUBSCRIPTION_LOGINS, usableModels } from "../llm/providers.js";
import { asProvider, chosenProvider, JEV_LABEL, jevModelFor, jevRouteFor, listJevModels } from "../extensions/typesafe/provider.js";
import { ghLogin, githubAuth } from "../artifacts/github.js";
import { type ProviderName, startCliLogin } from "../artifacts/providers.js";
import { artifactsConfig, deployLogPath, listArtifacts, listDeploys, loadArtifact, loadDeploy } from "../artifacts/store.js";
import { writeSecret } from "../extensions/secrets/store.js";
import { rememberSecret } from "../extensions/secrets/index.js";
import { callLogStats, clearCalls, readCalls, type CallKind } from "../logs/calls.js";
import { saveArtifact } from "../artifacts/store.js";

/** LLM providers whose keys Pi stores in ~/.reflex/agent/auth.json. */
const PI_AUTH_PROVIDERS = new Set(["openrouter", "anthropic", "openai", "google", "groq", "xai", "deepseek", "mistral"]);

/** Returns a reason when OpenRouter rejects the key; undefined when it is valid or the check could not run. */
async function checkOpenRouterKey(key: string): Promise<string | undefined> {
	try {
		const res = await fetch("https://openrouter.ai/api/v1/key", { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(6000) });
		if (res.status === 401 || res.status === 403) return "OpenRouter rejected this key (401)";
		return undefined;
	} catch {
		return undefined; // offline or slow: save it rather than block
	}
}

function artifactsCfgFor() {
	const gh = githubAuth();
	return artifactsConfig(gh ? { ok: true, source: gh.source, owner: gh.source === "gh" ? ghLogin() : undefined } : undefined);
}
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
	resumeBaseSize?: number;
	branch?: string | null;
	/** What the sidebar shows: the user's name for it, else the first thing asked in it. */
	title?: string;
	/** The Pi session file, once the session reports it (used to keep it out of the history list). */
	sessionFile?: string;
	busy: boolean;
	lastActive: number;
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

async function loadHistoricalSessions(): Promise<Array<{ path: string; name: string; modified: number }>> {
	const sessionsDir = join(getPiAgentDir(), "sessions");
	if (!existsSync(sessionsDir)) return [];
	const files: Array<{ path: string; name: string; modified: number }> = [];
	for (const cwdDir of readdirSync(sessionsDir)) {
		const cwdPath = join(sessionsDir, cwdDir);
		if (!statSync(cwdPath).isDirectory()) continue;
		for (const file of readdirSync(cwdPath)) {
			if (!file.endsWith(".jsonl")) continue;
			const full = join(cwdPath, file);
			const stat = statSync(full);
			files.push({ path: full, name: file, modified: stat.mtimeMs });
		}
	}
	return files.sort((a, b) => b.modified - a.modified);
}

const branchCache = new Map<string, { at: number; branch: string | null }>();
function gitBranch(cwd: string): string | null {
	const c = branchCache.get(cwd);
	if (c && Date.now() - c.at < 5000) return c.branch;
	let branch: string | null = null;
	try {
		const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
		branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, stdio: ["ignore", "pipe", "ignore"], timeout: 1500 }).toString().trim() || null;
	} catch {}
	branchCache.set(cwd, { at: Date.now(), branch });
	return branch;
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

async function recentSessions(limit = 80): Promise<Array<{ path: string; id: string; cwd: string; name: string; modified: number; messages: number }>> {
	try {
		const all = await SessionManager.listAll();
		return all
			.filter((s) => s.cwd && s.messageCount > 0)
			.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime())
			.slice(0, limit)
			.map((s) => ({ path: s.path, id: s.id, cwd: s.cwd, name: cleanTitle(s.name) ?? cleanTitle(s.firstMessage) ?? "Untitled session", modified: new Date(s.modified).getTime(), messages: s.messageCount }));
	} catch {
		return [];
	}
}

function createSession(cwd: string, name?: string, resumeFile?: string, title?: string): Session {
	const id = randomUUID().slice(0, 8);
	const extra = resumeFile ? ["--session", resumeFile] : [];
	const proc = spawn(process.execPath, [cliPath(), "--mode", "rpc", ...extra], { cwd, env: { ...process.env, REFLEX_WEB: "1" }, stdio: ["pipe", "pipe", "pipe"] });
	let resumeBaseSize = 0;
	if (resumeFile) { try { resumeBaseSize = statSync(resumeFile).size; } catch {} }
	const s: Session = { id, name: name ?? cwd.split("/").pop() ?? id, cwd, proc, buffer: "", recent: [], clients: new Set(), pendingUi: new Map(), createdAt: Date.now(), alive: true, resumeFile, resumeBaseSize, title, sessionFile: resumeFile, busy: false, lastActive: Date.now() };
	proc.stdout?.setEncoding("utf8");
	proc.stdout?.on("data", (chunk: string) => {
		s.buffer += chunk;
		let idx: number;
		while ((idx = s.buffer.indexOf("\n")) >= 0) {
			const line = s.buffer.slice(0, idx).replace(/\r$/, "");
			s.buffer = s.buffer.slice(idx + 1);
			if (!line.trim()) continue;
			try {
				const ev = JSON.parse(line) as { type?: string; id?: string; method?: string; command?: string; success?: boolean; data?: { sessionFile?: string; sessionName?: string } };
				if (ev.type === "response" && ev.command === "get_state" && ev.success && ev.data) {
					if (ev.data.sessionFile) s.sessionFile = ev.data.sessionFile;
					if (ev.data.sessionName) s.title = cleanTitle(ev.data.sessionName) ?? s.title;
				}
				if (ev.type === "agent_start") s.busy = true;
				if (ev.type === "agent_end" || ev.type === "agent_settled") s.busy = false;
				if (ev.type === "agent_start" || ev.type === "agent_end") s.lastActive = Date.now();
				if (ev.type === "extension_ui_request" && ev.id && ["select", "confirm", "input", "editor"].includes(ev.method ?? "")) s.pendingUi.set(ev.id, ev);
				if (ev.type === "extension_ui_response" && ev.id) s.pendingUi.delete(ev.id);
				// A dialog cannot outlive the agent run that opened it (Pi cancels it on abort/end), so drop stale ones here.
				if (ev.type === "agent_end" || ev.type === "agent_settled" || ev.type === "session_exit") s.pendingUi.clear();
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
		s.busy = false;
		broadcast(s, JSON.stringify({ type: "session_exit", code }));
	});
	sessions.set(id, s);
	return s;
}

function send(s: Session, command: Record<string, unknown>): void {
	if (!s.alive) throw new Error("session has exited");
	if (command.type === "extension_ui_response" && typeof command.id === "string") s.pendingUi.delete(command.id);
	if (command.type === "prompt" && typeof command.message === "string") {
		s.lastActive = Date.now();
		s.title ??= cleanTitle(command.message);
	}
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
	// The page is re-read from disk on every request, but this process keeps the server code it
	// started with. If dist/ was rebuilt since, say so on the page instead of failing quietly.
	const serverStartedAt = Date.now();
	const serverJs = join(dirname(require.resolve("../../package.json")), "dist", "web", "server.js");
	const staleBanner = () => {
		try {
			if (existsSync(serverJs) && statSync(serverJs).mtimeMs > serverStartedAt) return `<div class="stale">⟳ reflex was rebuilt after this server started · stop it (ctrl+c) and run <b>reflex web</b> again, or some pages will fail</div>`;
		} catch {}
		return "";
	};
	const html = () => (existsSync(appPath) ? readFileSync(appPath, "utf8").replace("__REFLEX_STALE__", staleBanner()) : "<h1>reflex web: app.html missing</h1>");
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
				// A sender that retries can pass a key (header, ?key=, or body.idempotency_key): the same key never starts a second run.
				let key = String(req.headers["idempotency-key"] ?? url.searchParams.get("key") ?? "").trim() || undefined;
				try {
					const parsed = JSON.parse(raw) as { input?: unknown; idempotency_key?: unknown };
					if (!key && typeof parsed?.idempotency_key === "string") key = parsed.idempotency_key.trim() || undefined;
					input = typeof parsed?.input === "string" ? parsed.input : JSON.stringify(parsed, null, 2);
				} catch {}
				const existing = key ? findRunByKey(agent.id, `hook:${key}`) : undefined;
				if (existing) return json(res, 200, { ok: true, agent: agent.id, runId: existing.id, duplicate: true, status: existing.status });
				void runAgent(agent, { type: "webhook" }, input, undefined, { idempotencyKey: key ? `hook:${key}` : undefined });
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
				for (const s of sessions.values()) s.branch = gitBranch(s.cwd);
				const openFiles = new Set([...sessions.values()].flatMap((s) => [s.resumeFile, s.sessionFile]).filter(Boolean));
				const all = await recentSessions();
				const titleOf = new Map(all.map((r) => [r.path, r.name]));
				const recent = all.filter((r) => !live.some((p) => p.sessionFile === r.path) && !openFiles.has(r.path));
				return json(res, 200, {
					sessions: [...sessions.values()].map((s) => ({ id: s.id, name: s.name, title: s.title ?? null, cwd: s.cwd, alive: s.alive, busy: s.busy, createdAt: s.createdAt, lastActive: s.lastActive, branch: s.branch ?? null, pendingUi: [...s.pendingUi.values()] })),
					terminal: live.map((p) => ({ ...p, title: (p.sessionFile && titleOf.get(p.sessionFile)) || null })),
					recent,
				});
			}
			if (url.pathname === "/api/sessions/history" && req.method === "GET") {
				return json(res, 200, { history: await loadHistoricalSessions() });
			}
			if (url.pathname === "/api/sessions" && req.method === "POST") {
				const body = JSON.parse((await readBody(req)).toString("utf8") || "{}") as { cwd?: string; name?: string; sessionFile?: string };
				let cwd = resolve((body.cwd ?? process.cwd()).replace(/^~(?=$|\/)/, homedir()));
				let resumeFile: string | undefined;
				let title: string | undefined;
				if (body.sessionFile) {
					if (!existsSync(body.sessionFile)) return json(res, 404, { error: "session file not found" });
					if (livePresence().some((p) => p.sessionFile === body.sessionFile)) return json(res, 409, { error: "that session is open in a terminal right now; close it there first" });
					// Don't spawn a duplicate: if a live web session is already resuming this file, return it.
					const dup = [...sessions.values()].find((s) => s.alive && s.resumeFile === body.sessionFile);
					if (dup) return json(res, 200, { id: dup.id, name: dup.name, cwd: dup.cwd });
					resumeFile = body.sessionFile;
					const info = (await recentSessions()).find((r) => r.path === body.sessionFile);
					if (info?.cwd && existsSync(info.cwd)) cwd = info.cwd;
					title = info?.name;
				} else {
					// Several conversations per project are fine; two empty ones are not.
					const dup = [...sessions.values()].find((s) => s.alive && !s.resumeFile && !s.title && s.cwd === cwd);
					if (dup) return json(res, 200, { id: dup.id, name: dup.name, cwd: dup.cwd });
				}
				if (!existsSync(cwd)) return json(res, 400, { error: `directory not found: ${cwd}` });
				const s = createSession(cwd, body.name, resumeFile, title);
				return json(res, 201, { id: s.id, name: s.name, cwd: s.cwd });
			}
			const m = url.pathname.match(/^\/api\/sessions\/([a-z0-9-]+)(?:\/(events|rpc|state))?$/);
			if (m) {
				const s = sessions.get(m[1]);
				if (!s) return json(res, 404, { error: "no such session" });
				if (m[2] === "events" && req.method === "GET") {
					res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
					// Replay the resumed session's history from the .jsonl file (everything that existed
					// at spawn time) as transcript_entry events, so resumed web sessions show their
					// prior messages instead of starting blank. s.recent holds post-spawn stdout only,
					// so there is no overlap with the pre-spawn file slice.
					if (s.resumeFile && (s.resumeBaseSize ?? 0) > 0) {
						try {
							const fd = openSync(s.resumeFile, "r");
							try {
								const buf = Buffer.alloc(s.resumeBaseSize!);
								readSync(fd, buf, 0, buf.length, 0);
								for (const line of buf.toString("utf8").split("\n")) {
									const trimmed = line.trim();
									if (!trimmed) continue;
									try { res.write(`data: ${JSON.stringify({ type: "transcript_entry", entry: JSON.parse(trimmed) })}\n\n`); } catch {}
								}
							} finally { closeSync(fd); }
						} catch {}
					}
					// Replay history, but not dialogs that were already answered or cancelled: a reconnecting
					// page must only see requests that are still pending.
					for (const line of s.recent) {
						if (line.includes('"extension_ui_request"')) {
							try {
								const ev = JSON.parse(line) as { type?: string; id?: string; method?: string };
								if (ev.type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(ev.method ?? "") && !(ev.id && s.pendingUi.has(ev.id))) continue;
							} catch {}
						}
						res.write(`data: ${line}\n\n`);
					}
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
				if (!m[2] && req.method === "PATCH") {
					const body = JSON.parse((await readBody(req)).toString("utf8") || "{}") as { title?: string };
					const title = String(body.title ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
					if (!title) return json(res, 400, { error: "a title needs some text" });
					s.title = title;
					if (s.alive) send(s, { type: "set_session_name", name: title }); // Pi stores it in the session file, so it survives a restart
					return json(res, 200, { ok: true, title });
				}
				if (!m[2] && req.method === "DELETE") {
					s.proc.kill();
					sessions.delete(s.id);
					return json(res, 200, { ok: true });
				}
			}
			const um = url.pathname.match(/^\/api\/sessions\/([a-z0-9-]+)\/upload$/);
			if (um && req.method === "POST") {
				const s = sessions.get(um[1]);
				if (!s) return json(res, 404, { error: "no such session" });
				const name = (url.searchParams.get("name") || "file").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
				const dir = join(getReflexHome(), "uploads", s.id);
				mkdirSync(dir, { recursive: true });
				const path = join(dir, name);
				writeFileSync(path, await readBody(req, 50 * 1024 * 1024));
				return json(res, 200, { path });
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
				return json(res, 200, { agents, broken: listBrokenAgents() });
			}
			if (url.pathname === "/api/agents/diagram" && req.method === "POST") {
				// Preview: diagram for an unsaved agent definition (the editor form).
				const body = JSON.parse((await readBody(req)).toString("utf8")) as Record<string, unknown>;
				try {
					const draft = { id: String(body.id ?? "draft"), name: String(body.name ?? "draft"), prompt: String(body.prompt ?? ""), triggers: body.triggers ?? [], steps: body.steps, chain: body.chain, reflex: body.reflex, tools: body.tools } as unknown as Parameters<typeof agentDiagram>[0];
					const diagram = agentDiagram(draft);
					return json(res, 200, { diagram, mermaid: toMermaid(diagram) });
				} catch (err) {
					return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
				}
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
				if (!am[2] && req.method === "GET") {
					const diagram = agentDiagram(agent);
					return json(res, 200, { agent, runs: listRuns(agent.id, 100).map((r) => ({ ...r, resumable: !!agent.steps?.length && r.status !== "succeeded" && r.status !== "running" && r.status !== "queued" && !!loadCheckpoint(agent.id, r.id) })), live: liveRunsForAgent(agent.id).map((r) => r.id), diagram, mermaid: toMermaid(diagram) });
				}
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
			const rm = url.pathname.match(/^\/api\/agents\/([a-z0-9-]+)\/runs\/([A-Za-z0-9-]+)(?:\/(events|cancel|resume))?$/);
			if (rm) {
				const agentId = rm[1];
				const runRec = loadRun(agentId, rm[2]);
				if (!runRec) return json(res, 404, { error: "no such run" });
				if (rm[3] === "cancel" && req.method === "POST") return json(res, 200, { ok: cancelRun(runRec.id) });
				if (rm[3] === "resume" && req.method === "POST") {
					const ag = loadAgent(agentId);
					if (!ag) return json(res, 404, { error: "no such agent" });
					try {
						void resumeRun(ag, runRec.id).catch(() => {});
						return json(res, 202, { ok: true, runId: runRec.id, from: loadCheckpoint(agentId, runRec.id)?.completed ?? [] });
					} catch (err) {
						return json(res, 409, { error: err instanceof Error ? err.message : String(err) });
					}
				}
				if (!rm[3] && req.method === "GET") return json(res, 200, { run: runRec, live: !!getLiveRun(runRec.id), checkpoint: (() => { const cp = loadCheckpoint(agentId, runRec.id); return cp ? { completed: cp.completed, nextIndex: cp.nextIndex, savedAt: cp.savedAt } : null; })() });
				if (rm[3] === "events" && req.method === "GET") {
					res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
					const log = runLogPath(runRec);
					if (existsSync(log)) for (const line of readFileSync(log, "utf8").split("\n")) if (line.trim()) res.write(`data: ${line}\n\n`);
					res.write(`data: ${JSON.stringify({ type: "replay_done" })}\n\n`);
					const detach = attachRunListener(runRec.id, (_r, ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`));
					const ping = setInterval(() => res.write(": ping\n\n"), 25000);
					req.on("close", () => {
						clearInterval(ping);
						detach?.();
					});
					// Finished run: no live listener to attach — send the closure event and end the stream
					// instead of holding a dead connection open forever.
					if (!detach) {
						res.write(`data: ${JSON.stringify({ type: "run_closed", status: runRec.status })}\n\n`);
						clearInterval(ping);
						return void res.end();
					}
					return;
				}

			}

			// ── Settings ─────────────────────────────────────────────────────
			if (url.pathname === "/api/settings" && req.method === "GET") {
				const cfg = loadCfg();
				const keys = createKeyResolver(piStoredApiKey);
				const keyStatus = Object.fromEntries(["typesafe", "sarvam", "openai", "groq", "deepgram", "openrouter", "anthropic", "google", "xai", "deepseek", "mistral"].map((k) => [k, keys.source(k) ?? null]));
				let packages: unknown = [];
				try {
					const sp = JSON.parse(readFileSync(join(getPiAgentDir(), "settings.json"), "utf8")) as { packages?: unknown };
					packages = sp.packages ?? [];
				} catch {}
				const skillsDir = join(getPiAgentDir(), "skills");
				const bundledDir = join(dirname(require.resolve("../../package.json")), "skills");
				const skills = existsSync(skillsDir)
					? readdirSync(skillsDir)
							.filter((n) => existsSync(join(skillsDir, n, "SKILL.md")))
							.map((n) => ({
								name: n,
								description: (readFileSync(join(skillsDir, n, "SKILL.md"), "utf8").match(/^description:\s*[|>]?-?\s*([\s\S]*?)\n(?:[a-z-]+:|---)/m)?.[1] ?? "").replace(/^["']|["']$/g, "").replace(/\s+/g, " ").trim().slice(0, 300),
								bundled: existsSync(join(bundledDir, n, "SKILL.md")),
							}))
					: [];
				return json(res, 200, { config: cfg, keys: keyStatus, env: SERVICE_ENV, packages, skills, mcp: loadMcpConfig(), presets: PRESET_META, jev: (() => {
					const kr = createKeyResolver(piStoredApiKey);
					const has = { typesafe: !!kr.get("typesafe"), openrouter: !!kr.get("openrouter") };
					const pick = chosenProvider(cfg, { typesafe: kr.get("typesafe"), openrouter: kr.get("openrouter") });
					return { provider: pick.provider, chosen: pick.chosen, reachable: !!jevRouteFor(cfg, kr), hasKey: has, models: { typesafe: jevModelFor(cfg, "typesafe"), openrouter: jevModelFor(cfg, "openrouter") }, labels: JEV_LABEL };
				})(), artifacts: artifactsCfgFor(), artifactDefaults: { RENDER_REGION: process.env.RENDER_REGION || "singapore", ARTIFACTS_REPO_PRIVATE: /^(1|true|yes)$/i.test(process.env.ARTIFACTS_REPO_PRIVATE ?? "") }, agentDir: getPiAgentDir(), home: getReflexHome() });
			}
			if (url.pathname === "/api/settings" && req.method === "POST") {
				const body = JSON.parse((await readBody(req)).toString("utf8")) as { config?: Partial<ReturnType<typeof loadCfg>>; keys?: Record<string, string> };
				// LLM provider keys belong to Pi (auth.json), so the LLM and Jev-via-OpenRouter both see them;
				// everything else (TypeSafe, voice) lives in ~/.reflex/keys.json. Env vars win over both.
				const shadowed: string[] = [];
				const rejected: string[] = [];
				if (body.keys) {
					for (const [k, raw] of Object.entries(body.keys)) {
						if (typeof raw !== "string") continue;
						const v = raw.trim();
						if (PI_AUTH_PROVIDERS.has(k)) {
							if (!v) continue;
							if (k === "openrouter") {
								const problem = await checkOpenRouterKey(v);
								if (problem) {
									rejected.push(`openrouter: ${problem}`);
									continue;
								}
							}
							const agentDir = getPiAgentDir();
							const runtime = await ModelRuntime.create({ authPath: `${agentDir}/auth.json`, modelsPath: `${agentDir}/models.json` });
							await runtime.login(k, "api_key", { prompt: async () => v, notify: () => {} });
						} else storeKey(k, v || undefined);
						const envName = SERVICE_ENV[k];
						if (v && envName && process.env[envName] && process.env[envName] !== v) shadowed.push(envName);
					}
				}
				if (rejected.length) return json(res, 400, { error: `key not saved — ${rejected.join("; ")}` });
				if (body.config) {
					const cfg = loadCfg();
					const merged = { ...cfg, ...body.config, reflex: { ...cfg.reflex, ...(body.config.reflex ?? {}), routing: { ...cfg.reflex.routing, ...((body.config.reflex as { routing?: Record<string, string> } | undefined)?.routing ?? {}) }, routingEffort: { ...(cfg.reflex.routingEffort ?? {}), ...((body.config.reflex as { routingEffort?: Record<string, string> } | undefined)?.routingEffort ?? {}) }, models: { ...(cfg.reflex.models ?? {}), ...((body.config.reflex as { models?: Record<string, string> } | undefined)?.models ?? {}) } }, voice: { ...cfg.voice, ...(body.config.voice ?? {}) }, browser: { ...cfg.browser, ...(body.config.browser ?? {}) }, ui: { ...cfg.ui, ...(body.config.ui ?? {}) }, llm: { ...cfg.llm, ...(body.config.llm ?? {}) } };
					// A tier or effort sent as null was cleared in the UI.
					for (const group of [merged.reflex.routing, merged.reflex.routingEffort] as Array<Record<string, unknown> | undefined>) if (group) for (const k of Object.keys(group)) if (group[k] === null || group[k] === "") delete group[k];
					saveReflexConfig(merged);
				}
				return json(res, 200, { ok: true, shadowed });
			}
			if (url.pathname === "/api/packages" && req.method === "POST") {
				const body = JSON.parse((await readBody(req)).toString("utf8")) as { action: "install" | "remove"; source: string; skills?: "all" | "none" };
				if (!/^(npm:|git:|https?:\/\/|ssh:\/\/|\/|\.\/)/.test(body.source ?? "")) return json(res, 400, { error: "source must be npm:<pkg>, git:<host/user/repo>, an https URL or a local path" });
				try {
					const { stdout, stderr } = await run(process.execPath, [cliPath(), body.action, body.source], { timeout: 300000, env: { ...process.env, PI_TELEMETRY: "0", GIT_TERMINAL_PROMPT: "0" } });
					// "Start with none": install, then switch every skill off so the user picks what loads.
					if (body.action === "install" && body.skills === "none") await setPackageSkills(body.source, []);
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
			// Skills that come from installed packages, with which of them load (see src/skills/packages.ts).
			if (url.pathname === "/api/skills/packages" && req.method === "GET") {
				try {
					return json(res, 200, { packages: await listPackageSkills(), others: await listOtherSkills() });
				} catch (err) {
					return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
				}
			}
			if (url.pathname === "/api/skills/packages" && req.method === "POST") {
				const body = JSON.parse((await readBody(req)).toString("utf8")) as { source?: string; selection?: "all" | string[] };
				if (!body.source || !(body.selection === "all" || Array.isArray(body.selection))) return json(res, 400, { error: "source and selection (\"all\" or a list of skill patterns) required" });
				try {
					const known = (await listPackageSkills()).find((p) => p.source === body.source);
					if (!known) return json(res, 404, { error: `package ${body.source} has no skills here` });
					const patterns = new Set(known.skills.map((s) => s.pattern));
					if (Array.isArray(body.selection) && body.selection.some((p) => !patterns.has(p))) return json(res, 400, { error: "unknown skill in selection" });
					await setPackageSkills(body.source, body.selection);
					return json(res, 200, { ok: true, package: (await listPackageSkills()).find((p) => p.source === body.source) });
				} catch (err) {
					return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
				}
			}
			if (url.pathname === "/api/skills/package-doc" && req.method === "GET") {
				// Only files that are a listed package skill can be read through here.
				const path = url.searchParams.get("path") ?? "";
				const skill = [...(await listPackageSkills()).flatMap((p) => p.skills), ...(await listOtherSkills())].find((s) => s.path === path);
				if (!skill) return json(res, 404, { error: "not a package skill" });
				return json(res, 200, { path, content: readFileSync(path, "utf8"), files: readdirSync(dirname(path)) });
			}
			const skm = url.pathname.match(/^\/api\/skills\/([A-Za-z0-9._-]+)$/);
			if (skm && req.method === "DELETE") {
				rmSync(join(getPiAgentDir(), "skills", skm[1]), { recursive: true, force: true });
				return json(res, 200, { ok: true });
			}
			if (skm && req.method === "GET") {
				// One skill: its SKILL.md and the files beside it, for the settings detail page.
				const dir = join(getPiAgentDir(), "skills", skm[1]);
				if (!existsSync(join(dir, "SKILL.md"))) return json(res, 404, { error: "skill not found" });
				const files: string[] = [];
				const walk = (d: string, rel: string, depth: number) => {
					if (depth > 3) return;
					for (const n of readdirSync(d)) {
						if (n === ".git" || n === "node_modules" || n === ".DS_Store") continue;
						const full = join(d, n);
						try {
							if (statSync(full).isDirectory()) walk(full, `${rel}${n}/`, depth + 1);
							else files.push(`${rel}${n}`);
						} catch {}
					}
				};
				walk(dir, "", 0);
				return json(res, 200, { name: skm[1], path: dir, content: readFileSync(join(dir, "SKILL.md"), "utf8").slice(0, 200_000), files: files.slice(0, 200) });
			}
			// ---- artifacts: deployable apps under <slug>.<DEPLOY_DOMAIN> ----
			const artifactsCfg = artifactsCfgFor;
			if (url.pathname === "/api/artifacts/cli-login" && req.method === "POST") {
				const body = JSON.parse((await readBody(req)).toString("utf8")) as { provider?: ProviderName };
				if (!body.provider || !["netlify", "render", "github"].includes(body.provider)) return json(res, 400, { error: "provider required" });
				const r = startCliLogin(body.provider);
				return json(res, 200, r);
			}
			if (url.pathname === "/api/artifacts" && req.method === "GET") {
				return json(res, 200, { config: artifactsCfg(), artifacts: listArtifacts().map((a) => ({ ...a, live: liveDeploy(a.id)?.id ?? null })) });
			}
			if (url.pathname === "/api/artifacts" && req.method === "POST") {
				const body = JSON.parse((await readBody(req)).toString("utf8")) as { dir?: string; name?: string };
				if (!body.dir) return json(res, 400, { error: "dir required" });
				try {
					return json(res, 200, { artifact: registerArtifact(body.dir.replace(/^~(?=$|\/)/, homedir()), body.name || undefined) });
				} catch (err) {
					return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
				}
			}
			if (url.pathname === "/api/artifacts/config" && req.method === "POST") {
				// Keys for the user's own Netlify / Render / GitHub accounts → ~/.reflex/.env (never echoed back).
				const body = JSON.parse((await readBody(req)).toString("utf8")) as Record<string, string>;
				const allowed = ["NETLIFY_API_KEY", "NETLIFY_ACCOUNT_SLUG", "DEPLOY_DOMAIN", "RENDER_API_KEY", "RENDER_OWNER_ID", "GITHUB_TOKEN", "RENDER_REGION", "ARTIFACTS_REPO_PRIVATE"];
				const saved: string[] = [];
				for (const k of allowed) {
					const v = typeof body[k] === "string" ? body[k].trim() : "";
					if (!v) continue;
					writeSecret(join(getReflexHome(), ".env"), k, v);
					process.env[k] = v;
					if (/KEY|TOKEN/.test(k)) rememberSecret(k, v);
					saved.push(k);
				}
				return json(res, 200, { saved, config: artifactsCfg() });
			}
			const artm = url.pathname.match(/^\/api\/artifacts\/([a-z0-9-]+)(?:\/(deploy|deploys))?$/);
			if (artm) {
				const a = loadArtifact(artm[1]);
				if (!a) return json(res, 404, { error: "no such artifact" });
				if (!artm[2] && req.method === "GET") return json(res, 200, { artifact: a, deploys: listDeploys(a.id, 50), live: liveDeploy(a.id)?.id ?? null, config: artifactsCfg() });
				if (!artm[2] && req.method === "PATCH") {
					const body = JSON.parse((await readBody(req)).toString("utf8")) as { settings?: { domain?: string; region?: string; repoPrivate?: boolean } };
					const st = body.settings ?? {};
					a.settings = { domain: st.domain?.trim() || undefined, region: st.region?.trim() || undefined, repoPrivate: typeof st.repoPrivate === "boolean" ? st.repoPrivate : undefined };
					if (!a.settings.domain && !a.settings.region && a.settings.repoPrivate === undefined) delete a.settings;
					saveArtifact(a);
					return json(res, 200, { artifact: a });
				}
				if (!artm[2] && req.method === "DELETE") {
					const lines: string[] = [];
					try {
						await destroyArtifact(a.id, (l) => lines.push(l));
						return json(res, 200, { ok: true, lines });
					} catch (err) {
						return json(res, 500, { error: err instanceof Error ? err.message : String(err), lines });
					}
				}
				if (artm[2] === "deploy" && req.method === "POST") {
					if (liveDeploy(a.id)) return json(res, 409, { error: "already deploying" });
					const started = new Promise<string>((resolveId) => {
						void deployArtifact(a.id, { trigger: "api", onEvent: (ev) => ev.type === "deploy_start" && resolveId(ev.deploy.id) }).catch(() => {});
					});
					return json(res, 200, { deployId: await started });
				}
				if (artm[2] === "deploys" && req.method === "GET") return json(res, 200, { deploys: listDeploys(a.id, 50) });
			}
			const adm = url.pathname.match(/^\/api\/artifacts\/([a-z0-9-]+)\/deploys\/([A-Za-z0-9-]+)\/events$/);
			if (adm && req.method === "GET") {
				const d = loadDeploy(adm[1], adm[2]);
				if (!d) return json(res, 404, { error: "no such deploy" });
				res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
				const log = deployLogPath(d);
				if (existsSync(log)) for (const line of readFileSync(log, "utf8").split("\n")) if (line.trim()) res.write(`data: ${line}\n\n`);
				res.write(`data: ${JSON.stringify({ type: "replay_done" })}\n\n`);
				const detach = attachDeployListener(d.id, (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`));
				const ping = setInterval(() => res.write(": ping\n\n"), 25000);
				req.on("close", () => {
					clearInterval(ping);
					detach?.();
				});
				if (!detach) {
					res.write(`data: ${JSON.stringify({ type: "deploy_closed", status: d.status })}\n\n`);
					clearInterval(ping);
					return void res.end();
				}
				return;
			}
			// ---- LLM access without an API key: subscription sign-in and OpenAI-compatible endpoints ----
			if (url.pathname === "/api/llm" && req.method === "GET") {
				return json(res, 200, { subscriptions: SUBSCRIPTION_LOGINS.map((p) => ({ ...p, auth: storedAuthType(p.id) ?? null })), endpoints: listCompatProviders(), presets: COMPAT_PRESETS });
			}
			if (url.pathname === "/api/llm/models" && req.method === "GET") {
				// What System 2 can actually use right now: only providers with working credentials.
				try {
					return json(res, 200, { models: await usableModels(), default: currentDefault(), efforts: EFFORTS });
				} catch (err) {
					return json(res, 200, { models: [], default: currentDefault(), efforts: EFFORTS, error: err instanceof Error ? err.message : String(err) });
				}
			}
			if (url.pathname === "/api/llm/default" && req.method === "POST") {
				const body = JSON.parse((await readBody(req)).toString("utf8")) as { ref?: string; effort?: string };
				try {
					setDefaultModel(body.ref ?? "", body.effort as never);
					return json(res, 200, { ok: true, default: currentDefault() });
				} catch (err) {
					return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
				}
			}
			if (url.pathname === "/api/llm/login" && req.method === "POST") {
				const body = JSON.parse((await readBody(req)).toString("utf8")) as { provider?: string };
				try {
					return json(res, 200, { session: startLogin(body.provider ?? "") });
				} catch (err) {
					return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
				}
			}
			const lm = url.pathname.match(/^\/api\/llm\/login\/([a-f0-9-]{6,})(?:\/(answer))?$/);
			if (lm) {
				const session = getLogin(lm[1]);
				if (!session) return json(res, 404, { error: "no such sign-in" });
				if (!lm[2] && req.method === "GET") return json(res, 200, { session });
				if (!lm[2] && req.method === "DELETE") {
					cancelLogin(lm[1]);
					return json(res, 200, { ok: true });
				}
				if (lm[2] === "answer" && req.method === "POST") {
					const body = JSON.parse((await readBody(req)).toString("utf8")) as { value?: string };
					return json(res, 200, { ok: answerLogin(lm[1], String(body.value ?? "")) });
				}
			}
			const lo = url.pathname.match(/^\/api\/llm\/logout\/([a-z0-9-]+)$/);
			if (lo && req.method === "POST") {
				await logoutProvider(lo[1]);
				return json(res, 200, { ok: true });
			}
			if (url.pathname === "/api/llm/endpoints/models" && req.method === "POST") {
				const body = JSON.parse((await readBody(req)).toString("utf8")) as { baseUrl?: string; apiKey?: string };
				try {
					return json(res, 200, { models: await listEndpointModels(body.baseUrl ?? "", body.apiKey || undefined) });
				} catch (err) {
					return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
				}
			}
			if (url.pathname === "/api/llm/endpoints" && req.method === "POST") {
				const body = JSON.parse((await readBody(req)).toString("utf8")) as { name?: string; baseUrl?: string; apiKey?: string; models?: string[] };
				try {
					return json(res, 200, { endpoint: saveCompatProvider({ name: body.name ?? "", baseUrl: body.baseUrl ?? "", apiKey: body.apiKey, models: body.models ?? [] }) });
				} catch (err) {
					return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
				}
			}
			const le = url.pathname.match(/^\/api\/llm\/endpoints\/([a-z0-9-]+)$/);
			if (le && req.method === "DELETE") {
				removeCompatProvider(le[1]);
				return json(res, 200, { ok: true });
			}
			// ---- session hooks (global file; project files are approved inside a session) ----
			if (url.pathname === "/api/hooks" && req.method === "GET") {
				return json(res, 200, { hooks: listGlobalHooks(), events: HOOK_EVENTS.map((e) => ({ id: e, help: EVENT_HELP[e] })), file: globalHooksPath(), agents: listAgents().map((a) => ({ id: a.id, name: a.name, workflow: !!a.steps?.length })) });
			}
			if (url.pathname === "/api/hooks" && req.method === "POST") {
				try {
					return json(res, 200, { hook: saveGlobalHook(JSON.parse((await readBody(req)).toString("utf8"))) });
				} catch (err) {
					return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
				}
			}
			const hk = url.pathname.match(/^\/api\/hooks\/([a-z0-9-_]+)$/);
			if (hk && req.method === "DELETE") {
				deleteGlobalHook(hk[1]);
				return json(res, 200, { ok: true });
			}
			if (url.pathname === "/api/jev/models" && req.method === "GET") {
				const provider = asProvider(url.searchParams.get("provider"));
				if (!provider) return json(res, 400, { error: "provider must be typesafe or openrouter" });
				const kr = createKeyResolver(piStoredApiKey);
				return json(res, 200, { provider, hasKey: !!kr.get(provider), ...(await listJevModels(provider, kr.get(provider))) });
			}
			if (url.pathname === "/api/logs" && req.method === "GET") {
				const kinds = (url.searchParams.get("kind") ?? "").split(",").filter(Boolean) as CallKind[];
				const entries = readCalls({ limit: Number(url.searchParams.get("limit") ?? 300), kinds, q: url.searchParams.get("q") ?? undefined, since: Number(url.searchParams.get("since") ?? 0) || undefined });
				return json(res, 200, { entries, stats: callLogStats() });
			}
			if (url.pathname === "/api/logs" && req.method === "DELETE") {
				clearCalls();
				return json(res, 200, { ok: true });
			}
			if (url.pathname === "/api/mcp" && req.method === "POST") {
				const body = JSON.parse((await readBody(req)).toString("utf8")) as { servers: ReturnType<typeof loadMcpConfig>["servers"] };
				saveMcpConfig({ servers: body.servers ?? {} });
				return json(res, 200, { ok: true });
			}
			if (url.pathname === "/api/mcp/connect" && req.method === "POST") {
				const body = JSON.parse((await readBody(req)).toString("utf8")) as { id?: string; readOnly?: boolean; apiKey?: string; connect?: boolean; fields?: Record<string, string> };
				try {
					// Build WITHOUT persisting, then run the live connect (OAuth browser flow for
					// remotes, or a direct initialize for api-key/http). Only persist to mcp.json
					// if the connect succeeds — so an aborted OAuth consent never leaves a phantom
					// "connected" entry, and a retry always starts from a clean cache.
					const { server, result } = buildPresetConfig(body.id ?? "", { readOnly: body.readOnly, apiKey: body.apiKey, fresh: true, fields: body.fields });
					let serverInfo: { name?: string; version?: string } | undefined;
					let tools: { name: string; description: string }[] | undefined;
					if (body.connect) {
						const client = new McpClient(result.id, server);
						try {
							await client.connect(90000);
							serverInfo = client.serverInfo;
							tools = client.tools.map((t) => ({ name: t.name, description: (t.description ?? "").slice(0, 160) }));
						} finally {
							client.close();
						}
						persistServer(result.id, server);
					} else {
						persistServer(result.id, server);
					}
					return json(res, 200, { ok: true, ...result, server: serverInfo, tools, mcp: loadMcpConfig() });
				} catch (err) {
					return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
				}
			}
			if (url.pathname === "/api/mcp/remove" && req.method === "POST") {
				const body = JSON.parse((await readBody(req)).toString("utf8")) as { id?: string };
				try {
					const r = removeConnector(body.id ?? "");
					return json(res, 200, { ok: true, ...r, mcp: loadMcpConfig() });
				} catch (err) {
					return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
				}
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
