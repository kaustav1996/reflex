/**
 * macOS computer-use tools so Reflex works as a personal assistant, not only a coding agent.
 *
 *   screenshot  – capture the screen (or a region) and hand the image to the model
 *   computer    – observe (frontmost app, windows, accessibility text) and act
 *                 (open apps/urls, keys, typing, clicks, AppleScript / JXA)
 *
 * Every state-changing action goes through the Jev reflex gate like bash/edit/write.
 * Needs macOS permissions for the terminal app: Accessibility (System Events) and
 * Screen Recording (screencapture). Off by default in coding sessions: /computer on.
 */
import { execFile } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ReflexConfig } from "../../config.js";

const run = promisify(execFile);

export const COMPUTER_TOOL_NAMES = ["screenshot", "computer"] as const;
export const READ_ONLY_COMPUTER_ACTIONS = new Set(["frontmost", "list_windows", "read_screen", "clipboard_read"]);

const MAX_TEXT = 12000;

async function osascript(script: string, language: "applescript" | "javascript" = "applescript", timeoutMs = 20000): Promise<string> {
	const args = language === "javascript" ? ["-l", "JavaScript", "-e", script] : ["-e", script];
	try {
		const { stdout } = await run("osascript", args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
		return stdout.trimEnd();
	} catch (err) {
		const e = err as { stderr?: string; message: string };
		const msg = (e.stderr || e.message).trim();
		if (/not allowed assistive access|osascript is not allowed/i.test(msg)) {
			throw new Error(`${msg}\nGrant your terminal app Accessibility access: System Settings → Privacy & Security → Accessibility.`);
		}
		throw new Error(msg);
	}
}

const asQuoted = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

const KEY_CODES: Record<string, number> = {
	return: 36, enter: 36, tab: 48, space: 49, delete: 51, backspace: 51, escape: 53, esc: 53,
	left: 123, right: 124, down: 125, up: 126, home: 115, end: 119, pageup: 116, pagedown: 121,
	f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,
};

function keystrokeScript(combo: string): string {
	const parts = combo.toLowerCase().split("+").map((p) => p.trim()).filter(Boolean);
	const key = parts.pop() ?? "";
	const mods = parts.map((m) => ({ cmd: "command down", command: "command down", ctrl: "control down", control: "control down", alt: "option down", option: "option down", shift: "shift down" })[m]).filter(Boolean);
	const using = mods.length ? ` using {${mods.join(", ")}}` : "";
	const code = KEY_CODES[key];
	const action = code !== undefined ? `key code ${code}` : `keystroke ${asQuoted(key)}`;
	return `tell application "System Events" to ${action}${using}`;
}

/** JXA: dump the frontmost window's accessibility tree as compact text (role, title/value, position). */
const READ_SCREEN_JXA = `
const se = Application("System Events");
const procs = se.processes.whose({ frontmost: true })();
if (!procs.length) throw new Error("no frontmost process");
const proc = procs[0];
const lines = [];
lines.push("app: " + proc.name());
let count = 0;
function walk(el, depth) {
  if (count > 400 || depth > 8) return;
  let kids;
  try { kids = el.uiElements(); } catch (e) { return; }
  for (const k of kids) {
    if (count > 400) return;
    let role = "", name = "", value = "", pos = "";
    try { role = k.role(); } catch (e) {}
    try { name = k.name() || ""; } catch (e) {}
    try { const d = k.description(); if (d && !name) name = d; } catch (e) {}
    try { const v = k.value(); if (v !== null && v !== undefined && typeof v !== "object") value = String(v); } catch (e) {}
    try { const p = k.position(); const s = k.size(); pos = "@" + Math.round(p[0]) + "," + Math.round(p[1]) + " " + Math.round(s[0]) + "x" + Math.round(s[1]); } catch (e) {}
    const interesting = /button|text|field|link|menu|check|radio|tab|cell|row|combo|slider|pop|image|heading|static/i.test(role) && (name || value);
    if (interesting) {
      count++;
      lines.push("  ".repeat(Math.min(depth, 4)) + role.replace("AX", "") + (name ? " \\"" + name.slice(0, 80) + "\\"" : "") + (value ? " = " + value.slice(0, 120).replace(/\\n/g, " ") : "") + " " + pos);
    }
    walk(k, depth + 1);
  }
}
try { const w = proc.windows[0]; lines.push("window: " + (w.name() || "")); walk(w, 1); } catch (e) { walk(proc, 1); }
lines.join("\\n");
`;

export function createComputerExtension(config: ReflexConfig): (pi: ExtensionAPI) => void {
	return (pi) => {
		let active = false;

		pi.registerFlag("assistant", { type: "boolean", default: false, description: "Start with macOS computer-use tools enabled" });

		function setActive(on: boolean, ctx?: ExtensionContext): void {
			active = on;
			const current = new Set(pi.getActiveTools());
			for (const n of COMPUTER_TOOL_NAMES) on ? current.add(n) : current.delete(n);
			pi.setActiveTools([...current]);
			if (ctx?.hasUI) ctx.ui.setStatus("computer", on ? ctx.ui.theme.fg("accent", "🖥 computer") : undefined);
		}

		pi.registerTool({
			name: "screenshot",
			label: "Screenshot",
			description: "Capture the macOS screen (or a region) and return it as an image so you can see what the user sees. Use before and after GUI actions.",
			promptSnippet: "Capture the screen or a region as an image",
			promptGuidelines: ["Use screenshot to look at the screen before acting on GUI elements and to verify the result afterwards. Prefer computer(action=read_screen) when text is enough; it is faster and cheaper."],
			parameters: Type.Object({
				region: Type.Optional(Type.String({ description: "x,y,w,h in screen points to capture a region (default: full screen)" })),
				maxWidth: Type.Optional(Type.Number({ description: "Downscale so the longest side is at most this many px (default 1568)" })),
			}),
			async execute(_id, params) {
				if (process.platform !== "darwin") throw new Error("screenshot is only implemented for macOS");
				const file = join(tmpdir(), `reflex-shot-${Date.now()}.png`);
				const args = ["-x", "-t", "png"];
				if (params.region) args.push("-R", params.region);
				args.push(file);
				try {
					await run("screencapture", args, { timeout: 15000 });
					await run("sips", ["-Z", String(params.maxWidth ?? 1568), file], { timeout: 15000 }).catch(() => undefined);
					const data = readFileSync(file).toString("base64");
					return { content: [{ type: "image", data, mimeType: "image/png" }, { type: "text", text: `screenshot captured${params.region ? ` (region ${params.region})` : ""}` }], details: { bytes: data.length } };
				} catch (err) {
					throw new Error(`${err instanceof Error ? err.message : String(err)}\nIf the image is black/empty, grant your terminal Screen Recording access in System Settings → Privacy & Security.`);
				} finally {
					rmSync(file, { force: true });
				}
			},
			renderResult(result, _opts, theme) {
				return new Text(theme.fg("success", `📸 ${result.content.find((c) => c.type === "text")?.type === "text" ? "screenshot captured" : "done"}`), 0, 0);
			},
		});

		pi.registerTool({
			name: "computer",
			label: "Computer",
			description:
				"Observe and control the macOS desktop. Read-only actions: frontmost, list_windows, read_screen (accessibility text of the front window), clipboard_read. Actions: open_app, open_url, key (e.g. cmd+s, return), type (text), click / double_click / right_click (x,y in screen points), scroll (up|down), clipboard_write, applescript (AppleScript or JXA).",
			promptSnippet: "Observe and control macOS apps: open, read screen text, click, type, keys, AppleScript",
			promptGuidelines: [
				"Use computer only for tasks outside the terminal (apps, browser, files in Finder, messages). Prefer bash for anything a shell can do.",
				"Before clicking, call computer(action=read_screen) or screenshot to find the element and its position. After acting, verify with read_screen or screenshot.",
				"Never type passwords, payment details, or send messages/emails without explicit user confirmation; ask first.",
			],
			parameters: Type.Object({
				action: StringEnum(["frontmost", "list_windows", "read_screen", "clipboard_read", "open_app", "open_url", "key", "type", "click", "double_click", "right_click", "scroll", "clipboard_write", "applescript"] as const),
				app: Type.Optional(Type.String({ description: "App name for open_app / to focus before key/type (e.g. Safari, Notes)" })),
				url: Type.Optional(Type.String()),
				text: Type.Optional(Type.String({ description: "Text to type, clipboard content, or script source" })),
				key: Type.Optional(Type.String({ description: "Key combo like cmd+shift+s, return, escape, down" })),
				x: Type.Optional(Type.Number()),
				y: Type.Optional(Type.Number()),
				direction: Type.Optional(StringEnum(["up", "down"] as const)),
				amount: Type.Optional(Type.Number({ description: "Scroll steps (default 5)" })),
				language: Type.Optional(StringEnum(["applescript", "javascript"] as const)),
			}),
			async execute(_id, p) {
				if (process.platform !== "darwin") throw new Error("computer is only implemented for macOS");
				const focus = async () => {
					if (p.app) await osascript(`tell application ${asQuoted(p.app)} to activate`);
				};
				let out = "";
				switch (p.action) {
					case "frontmost":
						out = await osascript(`tell application "System Events"
  set p to first application process whose frontmost is true
  set t to ""
  try
    set t to name of front window of p
  end try
  return (name of p) & " — " & t
end tell`);
						break;
					case "list_windows":
						out = await osascript(`tell application "System Events"
  set outText to ""
  repeat with p in (every application process whose background only is false)
    try
      set ws to name of every window of p
      if (count of ws) > 0 then set outText to outText & (name of p) & ": " & (ws as text) & linefeed
    end try
  end repeat
  return outText
end tell`);
						break;
					case "read_screen":
						await focus();
						out = await osascript(READ_SCREEN_JXA, "javascript", 30000);
						break;
					case "clipboard_read":
						out = (await run("pbpaste", [], { maxBuffer: 4 * 1024 * 1024 })).stdout;
						break;
					case "clipboard_write":
						await new Promise<void>((resolve, reject) => {
							const child = execFile("pbcopy", [], (err) => (err ? reject(err) : resolve()));
							child.stdin?.end(p.text ?? "");
						});
						out = "copied to clipboard";
						break;
					case "open_app":
						if (!p.app) throw new Error("open_app needs app");
						await run("open", ["-a", p.app]);
						out = `opened ${p.app}`;
						break;
					case "open_url":
						if (!p.url) throw new Error("open_url needs url");
						if (!/^https?:\/\/|^[a-z][a-z0-9+.-]*:/i.test(p.url)) throw new Error("open_url needs a full URL with scheme");
						await run("open", [p.url]);
						out = `opened ${p.url}`;
						break;
					case "key":
						if (!p.key) throw new Error("key needs key");
						await focus();
						await osascript(keystrokeScript(p.key));
						out = `pressed ${p.key}`;
						break;
					case "type":
						if (p.text === undefined) throw new Error("type needs text");
						await focus();
						await osascript(`tell application "System Events" to keystroke ${asQuoted(p.text)}`);
						out = `typed ${p.text.length} chars`;
						break;
					case "click":
					case "double_click":
					case "right_click": {
						if (p.x === undefined || p.y === undefined) throw new Error(`${p.action} needs x and y`);
						await focus();
						const hasCliclick = await run("which", ["cliclick"]).then(() => true, () => false);
						if (hasCliclick) {
							const verb = p.action === "click" ? "c" : p.action === "double_click" ? "dc" : "rc";
							await run("cliclick", [`${verb}:${Math.round(p.x)},${Math.round(p.y)}`]);
						} else {
							if (p.action !== "click") throw new Error(`${p.action} needs cliclick (brew install cliclick)`);
							await osascript(`tell application "System Events" to click at {${Math.round(p.x)}, ${Math.round(p.y)}}`);
						}
						out = `${p.action} at ${Math.round(p.x)},${Math.round(p.y)}`;
						break;
					}
					case "scroll": {
						await focus();
						const n = Math.max(1, Math.min(50, Math.round(p.amount ?? 5)));
						const code = p.direction === "up" ? 126 : 125;
						await osascript(`tell application "System Events"\nrepeat ${n} times\nkey code ${code}\nend repeat\nend tell`);
						out = `scrolled ${p.direction ?? "down"} ${n}`;
						break;
					}
					case "applescript":
						if (!p.text) throw new Error("applescript needs text (script source)");
						out = await osascript(p.text, p.language ?? "applescript", 60000);
						break;
				}
				const text = out.length > MAX_TEXT ? `${out.slice(0, MAX_TEXT)}\n…[truncated ${out.length - MAX_TEXT} chars]` : out;
				return { content: [{ type: "text", text: text || "(no output)" }], details: { action: p.action } };
			},
			renderCall(args, theme) {
				const a = args as { action?: string; app?: string; key?: string; url?: string; x?: number; y?: number; text?: string };
				const detail = a.app ?? a.key ?? a.url ?? (a.x !== undefined ? `${a.x},${a.y}` : a.text ? `"${a.text.slice(0, 40)}"` : "");
				return new Text(`${theme.fg("toolTitle", theme.bold("computer "))}${theme.fg("accent", a.action ?? "")} ${theme.fg("dim", detail)}`, 0, 0);
			},
		});

		pi.registerCommand("computer", {
			description: "Toggle macOS computer-use tools (screenshot, computer): /computer on|off",
			handler: async (args, ctx) => {
				const want = args.trim() === "on" ? true : args.trim() === "off" ? false : !active;
				setActive(want, ctx);
				ctx.ui.notify(want ? "🖥 Computer-use tools enabled (screenshot, computer). Actions are gated by Reflex." : "Computer-use tools disabled", "info");
			},
		});

		pi.on("session_start", async (_e, ctx) => {
			const wanted = !!pi.getFlag("assistant") || (config as ReflexConfig & { computerByDefault?: boolean }).computerByDefault === true;
			setActive(wanted, ctx);
		});
	};
}
