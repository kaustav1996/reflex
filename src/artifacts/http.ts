/** Tiny JSON fetch helper shared by the Netlify / Render / GitHub adapters. */
export class HttpError extends Error {
	constructor(
		public status: number,
		public url: string,
		public body: string,
	) {
		super(`HTTP ${status} ${url}: ${body.slice(0, 300)}`);
	}
	get retryable(): boolean {
		return this.status === 429 || this.status >= 500;
	}
}

export async function json<T = unknown>(url: string, init: RequestInit & { token?: string; tokenScheme?: string } = {}): Promise<T> {
	const headers = new Headers(init.headers);
	if (init.token) headers.set("Authorization", `${init.tokenScheme ?? "Bearer"} ${init.token}`);
	if (init.body && typeof init.body === "string" && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
	headers.set("Accept", "application/json");
	if (!headers.has("User-Agent")) headers.set("User-Agent", "reflex-artifacts");
	const res = await fetch(url, { ...init, headers });
	const text = await res.text();
	if (!res.ok) throw new HttpError(res.status, url, text);
	return text ? (JSON.parse(text) as T) : (undefined as T);
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type Heartbeat = (message: string) => void;
