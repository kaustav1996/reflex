/**
 * Netlify: one site per artifact, published by zip upload, reachable at <slug>.<DEPLOY_DOMAIN>.
 *
 * DEPLOY_DOMAIN must be a zone on Netlify DNS: setting `custom_domain` on the site is then enough
 * for Netlify to create the record and issue the certificate (no DNS API calls needed). Until the
 * certificate exists the site is served on its *.netlify.app address, which we keep as a fallback.
 *
 * The same site also hosts the artifact's SQLite snapshots in Netlify Blobs (store "reflex-appdata"),
 * so a fullstack app needs nothing beyond the Netlify token you already configured.
 */
import { HttpError, type Heartbeat, json, sleep } from "./http.js";
import { type AuthSource, netlifyAccountSlug, resolveNetlify } from "./providers.js";

const API = "https://api.netlify.com/api/v1";
export const APPDATA_STORE = "reflex-appdata";

export interface NetlifySite {
	id: string;
	name: string;
	custom_domain?: string;
	ssl?: boolean;
	url?: string;
	ssl_url?: string;
}

export class Netlify {
	constructor(
		public readonly token: string,
		private accountSlug: string,
		/** Custom base domain (on Netlify DNS). Undefined → sites live at rx-<slug>.netlify.app. */
		public domain: string | undefined,
		public source: AuthSource = "env",
	) {}

	/** Token from the netlify CLI login (or NETLIFY_API_KEY), account from the API unless NETLIFY_ACCOUNT_SLUG is set. */
	static async resolve(domainOverride?: string): Promise<Netlify> {
		const auth = resolveNetlify();
		if (!auth) throw new Error("frontend deploys need a Netlify login: run `netlify login` (or set NETLIFY_API_KEY)");
		const domain = (domainOverride || process.env.DEPLOY_DOMAIN || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
		const slug = await netlifyAccountSlug(auth.token);
		return new Netlify(auth.token, slug, domain && domain !== "netlify.app" ? domain : undefined, auth.source);
	}

	siteName(slug: string): string {
		return `rx-${slug}`; // Netlify site names are global across all of Netlify
	}
	hostname(slug: string): string {
		return this.domain ? `${slug}.${this.domain}` : `${this.siteName(slug)}.netlify.app`;
	}

	async findSite(slug: string): Promise<NetlifySite | undefined> {
		const name = this.siteName(slug);
		const sites = await json<NetlifySite[]>(`${API}/sites?name=${encodeURIComponent(name)}&filter=all`, { token: this.token });
		return sites.find((s) => s.name === name); // ?name= is a substring match
	}

	async ensureSite(slug: string): Promise<NetlifySite> {
		const name = this.siteName(slug);
		const hostname = this.hostname(slug);
		let site = await this.findSite(slug);
		if (!site) {
			site = await json<NetlifySite>(`${API}/${this.accountSlug}/sites`, { method: "POST", token: this.token, body: JSON.stringify({ name, ...(this.domain ? { custom_domain: hostname } : {}), processing_settings: { skip: true } }) });
		} else if (this.domain && site.custom_domain !== hostname) {
			site = await json<NetlifySite>(`${API}/sites/${site.id}`, { method: "PATCH", token: this.token, body: JSON.stringify({ custom_domain: hostname }) });
		}
		if (this.domain && !site.ssl) await this.provisionTls(site.id);
		return site;
	}

	private async provisionTls(siteId: string): Promise<void> {
		try {
			await json(`${API}/sites/${siteId}/ssl`, { method: "POST", token: this.token }); // returns null; Netlify provisions lazily
		} catch {}
	}

	/** Upload a zip of the publish folder. Returns the deploy id. */
	async deployZip(siteId: string, zip: Buffer, title: string): Promise<string> {
		const url = `${API}/sites/${siteId}/deploys?title=${encodeURIComponent(title)}`;
		const res = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/zip", "User-Agent": "reflex-artifacts" }, body: new Uint8Array(zip) });
		const text = await res.text();
		if (!res.ok) throw new HttpError(res.status, url, text);
		return (JSON.parse(text) as { id: string }).id;
	}

	async waitReady(siteId: string, deployId: string, hb: Heartbeat, timeoutMs = 5 * 60_000, tlsWaitMs = 90_000): Promise<{ url: string; fallbackUrl: string; tlsReady: boolean }> {
		const t0 = Date.now();
		let fallbackUrl = "";
		while (Date.now() - t0 < timeoutMs) {
			const dep = await json<{ state: string; error_message?: string; deploy_ssl_url?: string; name?: string }>(`${API}/sites/${siteId}/deploys/${deployId}`, { token: this.token });
			hb(`netlify deploy ${dep.state}`);
			if (dep.state === "error") throw new Error(`Netlify deploy error: ${dep.error_message ?? "unknown"}`);
			if (dep.state === "ready") {
				fallbackUrl = dep.deploy_ssl_url ?? `https://${dep.name ?? siteId}.netlify.app`;
				break;
			}
			await sleep(4_000);
		}
		if (!fallbackUrl) throw new Error("Netlify deploy timed out");
		const site = await json<NetlifySite>(`${API}/sites/${siteId}`, { token: this.token });
		if (!site.custom_domain) return { url: fallbackUrl, fallbackUrl, tlsReady: true };
		// Trust Netlify's own `ssl` flag: an HTTP probe can succeed against the *.netlify.app wildcard and lie.
		await this.provisionTls(siteId);
		const url = `https://${site.custom_domain}`;
		const t1 = Date.now();
		while (Date.now() - t1 < tlsWaitMs) {
			if (await this.siteTls(siteId)) {
				hb(`${site.custom_domain} certificate issued`);
				return { url, fallbackUrl, tlsReady: true };
			}
			hb(`${site.custom_domain} waiting for certificate`);
			await sleep(10_000);
		}
		return { url, fallbackUrl, tlsReady: false };
	}

	async siteTls(siteId: string): Promise<boolean> {
		const s = await json<NetlifySite>(`${API}/sites/${siteId}`, { token: this.token }).catch(() => undefined);
		return !!s?.ssl;
	}

	async deleteSite(siteId: string): Promise<void> {
		try {
			await json(`${API}/sites/${siteId}`, { method: "DELETE", token: this.token });
		} catch (err) {
			if (!(err instanceof HttpError && err.status === 404)) throw err;
		}
	}

	// ---- Netlify Blobs: the SQLite snapshot store for fullstack artifacts ----

	/** REST address of one blob; the sidecar GETs it directly and PUTs through a signed URL. */
	blobUrl(siteId: string, key: string): string {
		return `${API}/blobs/${siteId}/site:${APPDATA_STORE}/${encodeURIComponent(key)}`;
	}

	async deleteBlob(siteId: string, key: string): Promise<void> {
		try {
			await fetch(this.blobUrl(siteId, key), { method: "DELETE", headers: { Authorization: `Bearer ${this.token}`, "User-Agent": "reflex-artifacts" } });
		} catch {}
	}

	/** Size and age of the stored snapshot, if any (HEAD). */
	async blobInfo(siteId: string, key: string): Promise<{ exists: boolean; size?: number; lastModified?: string }> {
		try {
			const res = await fetch(this.blobUrl(siteId, key), { method: "HEAD", headers: { Authorization: `Bearer ${this.token}`, "User-Agent": "reflex-artifacts" } });
			if (!res.ok) return { exists: false };
			return { exists: true, size: Number(res.headers.get("content-length") ?? 0) || undefined, lastModified: res.headers.get("last-modified") ?? undefined };
		} catch {
			return { exists: false };
		}
	}
}
