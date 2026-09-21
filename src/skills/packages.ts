/**
 * Skills that come from installed Pi packages (for example ECC's 292), and which of them load.
 *
 * Pi lists every loaded skill in the system prompt (name, description, location), so a large
 * package makes every request longer. Pi can load only some of a package's skills: a package
 * entry in settings.json may carry a `skills` filter. This module reads what each package
 * offers through Pi's own resolver and writes the filter, in the same pattern format Pi's
 * `pi config` uses (paths relative to the package folder):
 *
 *   all skills        "git:github.com/affaan-m/ECC"                       (no filter)
 *   a chosen few      { source, skills: ["!**", "+skills/tdd/SKILL.md"] }  (exclude all, add back)
 *   none              { source, skills: ["!**"] }
 *
 * An empty `skills` array would mean "all" to Pi, so "none" is written as an exclude-all.
 */
import { readFileSync } from "node:fs";
import { basename, dirname, relative } from "node:path";
import { DefaultPackageManager, type PackageSource, SettingsManager } from "@earendil-works/pi-coding-agent";
import { getPiAgentDir } from "../config.js";

export interface PackageSkill {
	/** The package source as written in settings (e.g. git:github.com/affaan-m/ECC). */
	source: string;
	/** Skill folder name. */
	name: string;
	description: string;
	/** Absolute path to SKILL.md. */
	path: string;
	/** Pi's pattern for this skill: its path relative to the package folder. */
	pattern: string;
	enabled: boolean;
	/** Rough tokens this skill adds to every request's skill list when enabled. */
	tokens: number;
}

export interface SkillPackage {
	source: string;
	skills: PackageSkill[];
	enabledCount: number;
	/** Tokens the enabled skills add to every request. */
	enabledTokens: number;
	/** Whether a skills filter is set (false = Pi loads every skill in the package). */
	filtered: boolean;
}

export function skillDescription(skillMd: string): string {
	const fm = skillMd.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
	const m = `\n${fm}`.match(/\ndescription:\s*[|>]?-?\s*([\s\S]*?)(?=\n[a-zA-Z_-]+:|$)/);
	return (m?.[1] ?? "").replace(/^["']|["']$/g, "").replace(/\s+/g, " ").trim();
}

/** Tokens a skill costs in the system prompt: Pi lists name, description and location (≈4 chars a token). */
export function skillTokens(name: string, description: string, path: string): number {
	return Math.ceil(`<skill><name>${name}</name><description>${description}</description><location>${path}</location></skill>`.length / 4);
}

const sourceOf = (p: PackageSource) => (typeof p === "string" ? p : p.source);

/** Every package's skills with their on/off state, as Pi resolves them. Never installs anything. */
export async function listPackageSkills(cwd = process.cwd(), agentDir = getPiAgentDir()): Promise<SkillPackage[]> {
	const settings = SettingsManager.create(cwd, agentDir);
	const configured = settings.getPackages();
	if (!configured.length) return [];
	const pm = new DefaultPackageManager({ cwd, agentDir, settingsManager: settings });
	const resolved = await pm.resolve(async () => "skip");
	const bySource = new Map<string, SkillPackage>();
	for (const p of configured) {
		const filter = typeof p === "string" ? undefined : p.skills;
		bySource.set(sourceOf(p), { source: sourceOf(p), skills: [], enabledCount: 0, enabledTokens: 0, filtered: filter !== undefined });
	}
	for (const r of resolved.skills) {
		if (r.metadata.origin !== "package") continue;
		const pkg = bySource.get(r.metadata.source);
		if (!pkg) continue;
		const skillMd = basename(r.path) === "SKILL.md" ? r.path : `${r.path}/SKILL.md`;
		let description = "";
		try {
			description = skillDescription(readFileSync(skillMd, "utf8"));
		} catch {}
		const name = basename(dirname(skillMd));
		const baseDir = r.metadata.baseDir ?? dirname(r.path);
		const tokens = skillTokens(name, description, skillMd);
		pkg.skills.push({ source: pkg.source, name, description, path: skillMd, pattern: relative(baseDir, r.path), enabled: r.enabled, tokens });
		if (r.enabled) {
			pkg.enabledCount++;
			pkg.enabledTokens += tokens;
		}
	}
	for (const pkg of bySource.values()) pkg.skills.sort((a, b) => a.name.localeCompare(b.name));
	return [...bySource.values()].filter((p) => p.skills.length > 0);
}

export interface OtherSkill {
	name: string;
	description: string;
	/** Absolute path to SKILL.md. */
	path: string;
}

/**
 * Skills Pi loads from folders outside Reflex's own skills folder and outside packages, such as
 * the shared ~/.agents/skills that several agent tools read. Shown so the Skills page lists
 * everything a session loads.
 */
export async function listOtherSkills(cwd = process.cwd(), agentDir = getPiAgentDir()): Promise<OtherSkill[]> {
	const settings = SettingsManager.create(cwd, agentDir);
	const pm = new DefaultPackageManager({ cwd, agentDir, settingsManager: settings });
	const resolved = await pm.resolve(async () => "skip");
	const own = `${agentDir}/skills/`;
	const out: OtherSkill[] = [];
	for (const r of resolved.skills) {
		if (r.metadata.origin === "package" || !r.enabled) continue;
		const skillMd = basename(r.path) === "SKILL.md" ? r.path : `${r.path}/SKILL.md`;
		if (skillMd.startsWith(own)) continue;
		let description = "";
		try {
			description = skillDescription(readFileSync(skillMd, "utf8"));
		} catch {}
		out.push({ name: basename(dirname(skillMd)), description, path: skillMd });
	}
	return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The settings entry for a package with the given skill selection. `"all"` removes the skills filter. */
export function withSkillSelection(entry: PackageSource, selection: "all" | string[]): PackageSource {
	const obj = typeof entry === "string" ? { source: entry } : { ...entry };
	if (selection === "all") delete obj.skills;
	else obj.skills = ["!**", ...selection.map((p) => `+${p}`)];
	const hasFilters = (["extensions", "skills", "prompts", "themes"] as const).some((k) => obj[k] !== undefined) || obj.autoload !== undefined;
	return hasFilters ? obj : obj.source;
}

/** Save which of a package's skills load (user scope, where Reflex installs packages). */
export async function setPackageSkills(source: string, selection: "all" | string[], cwd = process.cwd(), agentDir = getPiAgentDir()): Promise<void> {
	const settings = SettingsManager.create(cwd, agentDir);
	const packages = settings.getGlobalSettings().packages ?? [];
	const i = packages.findIndex((p) => sourceOf(p) === source);
	if (i < 0) throw new Error(`package ${source} is not installed`);
	const next = [...packages];
	next[i] = withSkillSelection(packages[i], selection);
	settings.setPackages(next);
	await settings.flush(); // Pi queues settings writes
}
