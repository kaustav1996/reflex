/**
 * Browser driver: one CDP session on a Reflex-owned tab. Mirrors jev-ultrafast's
 * browser.py: observe → fresh → act, with semantic freshness guards and
 * geometry resolved right before input. Mutations are never retried.
 */
import { createHash } from "node:crypto";
import { platform } from "node:os";
import { type CdpConnection, type ChromeHandle, CdpConnection as Cdp, ensureChrome } from "./cdp.js";
import { afterInputExpression, guardExpression, MARKER, READ_STATE, resolveTargetExpression } from "./snapshot.js";

export class StalePage extends Error {
	constructor(message: string) {
		super(message);
		this.name = "StalePage";
	}
}

export interface PageAction {
	id: string;
	kind: "click" | "fill" | "select" | "scroll" | "wait";
	label: string;
	node?: number;
	role?: string;
	value?: string;
	current_value?: string;
	checked?: string;
	selected?: string;
	expanded?: string;
	delta?: number;
	rect?: { x: number; y: number; w: number; h: number };
}

export interface PageState {
	url: string;
	title: string;
	w: number;
	h: number;
	text: string;
	scroll: { y: number; height: number };
	actions: PageAction[];
	marker: unknown;
	page_key: unknown;
	guards: Record<string, unknown>;
	omitted_actions: number;
	fingerprint: string;
	screenshot?: string;
}

export interface BrowserOptions {
	headless?: boolean;
	attachUrl?: string;
	width?: number;
	height?: number;
}

export class Browser {
	private cdp!: CdpConnection;
	private chrome!: ChromeHandle;
	private session = "";
	private target = "";
	private afterInput: PageAction | undefined;

	static async open(url: string, options: BrowserOptions = {}): Promise<Browser> {
		const b = new Browser();
		b.chrome = await ensureChrome({ headless: options.headless, attachUrl: options.attachUrl });
		b.cdp = await Cdp.connect(b.chrome.wsUrl);
		const { targetId } = await b.cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank", background: !!options.attachUrl });
		b.target = targetId;
		const { sessionId } = await b.cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
		b.session = sessionId;
		await b.call("Emulation.setDeviceMetricsOverride", { width: options.width ?? 1120, height: options.height ?? 780, deviceScaleFactor: 1, mobile: false });
		await b.call("Emulation.setFocusEmulationEnabled", { enabled: true });
		await b.navigate(url);
		return b;
	}

	get url(): string {
		return this.lastUrl;
	}
	private lastUrl = "about:blank";

	call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
		return this.cdp.send<T>(method, params, this.session);
	}

	async evaluate<T = unknown>(expression: string, awaitPromise = false): Promise<T> {
		const res = await this.call<{ result?: { value?: T }; exceptionDetails?: unknown }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise });
		if (res.exceptionDetails) throw new StalePage("Document changed during evaluation");
		return res.result?.value as T;
	}

	async navigate(url: string): Promise<void> {
		await this.call("Page.navigate", { url });
		this.lastUrl = url;
		const deadline = Date.now() + 15000;
		while (Date.now() < deadline) {
			try {
				if ((await this.evaluate<string>("document.readyState")) === "complete") break;
			} catch {}
			await new Promise((r) => setTimeout(r, 20));
		}
	}

	async observe(screenshot = false): Promise<PageState> {
		if (this.afterInput) {
			const action = this.afterInput;
			this.afterInput = undefined;
			try {
				await this.evaluate(afterInputExpression(action), true);
			} catch {}
		}
		for (let attempt = 0; attempt < 10; attempt++) {
			try {
				const info = await this.evaluate<Omit<PageState, "fingerprint"> | null>(READ_STATE);
				if (info === null || info === undefined) throw new StalePage("Document is navigating");
				const page: PageState = { ...info, fingerprint: fingerprint(info) };
				if (screenshot) page.screenshot = (await this.call<{ data: string }>("Page.captureScreenshot", { format: "jpeg", quality: 60 })).data;
				this.lastUrl = page.url;
				return page;
			} catch (err) {
				if (!(err instanceof StalePage) || attempt === 9) throw err;
				await new Promise((r) => setTimeout(r, 20));
			}
		}
		throw new StalePage("Page did not settle");
	}

	async fresh(page: PageState, action?: PageAction): Promise<boolean> {
		if (action && (action.kind === "click" || action.kind === "select")) {
			if (typeof action.node !== "number") return false;
			const current = await this.evaluate<unknown>(guardExpression(action.node));
			return JSON.stringify(current) === JSON.stringify([page.page_key, page.guards[String(action.node)] ?? null]);
		}
		const marker = await this.evaluate<unknown>(MARKER);
		return JSON.stringify(marker) === JSON.stringify(page.marker);
	}

	async act(action: PageAction, page: PageState, text?: string): Promise<void> {
		if (!(await this.fresh(page, action))) throw new StalePage("Page changed since this decision. Observe again.");
		if (action.kind === "wait") {
			await new Promise((r) => setTimeout(r, 100));
			return;
		}
		if (action.kind === "scroll") {
			await this.call("Input.dispatchMouseEvent", { type: "mouseWheel", x: 550, y: 650, deltaX: 0, deltaY: action.delta ?? 560 });
			this.afterInput = action;
			return;
		}
		if (typeof action.node !== "number") throw new Error("Invalid observed node");
		let target: { x: number; y: number } | null;
		try {
			target = await this.evaluate<{ x: number; y: number } | null>(resolveTargetExpression(action));
		} catch (err) {
			if (action.kind === "select") throw new Error("Dropdown execution was interrupted; inspect before retrying.");
			throw err;
		}
		if (target === null) {
			if (action.kind === "select") throw new Error("Dropdown execution was not confirmed; inspect before retrying.");
			throw new StalePage("Target changed or is covered. Observe again.");
		}
		if (action.kind !== "select") {
			for (const type of ["mousePressed", "mouseReleased"]) {
				await this.call("Input.dispatchMouseEvent", { type, x: target.x, y: target.y, button: "left", clickCount: 1 });
			}
			if (action.kind === "fill") {
				const modifiers = platform() === "darwin" ? 4 : 2;
				await this.call("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers, commands: ["selectAll"] });
				await this.call("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers });
				await this.call("Input.insertText", { text: text ?? "" });
			}
		}
		this.afterInput = action;
	}

	async pressEnter(): Promise<void> {
		await this.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
		await this.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
	}

	async close(): Promise<void> {
		try {
			if (this.target) await this.cdp.send("Target.closeTarget", { targetId: this.target });
		} catch {}
		this.cdp.close();
		if (this.chrome.owned && this.chrome.process) {
			// Leave the window for the user unless headless; headless Chrome has no reason to linger.
			if (process.env.REFLEX_BROWSER_HEADLESS === "1") this.chrome.process.kill();
		}
	}
}

export function fingerprint(state: Omit<PageState, "fingerprint">): string {
	const content = { url: state.url, text: state.text, actions: state.actions, scroll: state.scroll };
	return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}
