import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { listOtherSkills, listPackageSkills, setPackageSkills, skillDescription, withSkillSelection } from "../src/skills/packages.ts";

/** A local Pi package with three skills, registered in a throwaway agent dir. */
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "reflex-pkgskills-"));
	const agentDir = join(root, "agent");
	const pkg = join(root, "pkg");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(pkg, { recursive: true });
	writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0", pi: { skills: ["./skills"] } }));
	for (const [name, desc] of [["alpha", "Write alpha things"], ["beta", "Review beta changes"], ["gamma", "Deploy gamma"]]) {
		mkdirSync(join(pkg, "skills", name), { recursive: true });
		writeFileSync(join(pkg, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n`);
	}
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [pkg] }));
	return { root, agentDir, pkg, cwd: root };
}

const enabledNames = async (cwd: string, agentDir: string) => (await listPackageSkills(cwd, agentDir))[0].skills.filter((s) => s.enabled).map((s) => s.name);

test("a package's skills are listed with descriptions and token estimates, all on by default", async () => {
	const f = fixture();
	const [p] = await listPackageSkills(f.cwd, f.agentDir);
	assert.equal(p.source, f.pkg);
	assert.deepEqual(p.skills.map((s) => s.name), ["alpha", "beta", "gamma"]);
	assert.equal(p.skills[1].description, "Review beta changes");
	assert.equal(p.enabledCount, 3);
	assert.equal(p.filtered, false);
	assert.ok(p.enabledTokens > 0 && p.skills.every((s) => s.tokens > 0));
});

test("choosing a few, none, then all again is what Pi's own resolver loads", async () => {
	const f = fixture();
	const [p] = await listPackageSkills(f.cwd, f.agentDir);
	const beta = p.skills.find((s) => s.name === "beta")!.pattern;

	await setPackageSkills(f.pkg, [beta], f.cwd, f.agentDir);
	assert.deepEqual(await enabledNames(f.cwd, f.agentDir), ["beta"]);
	assert.deepEqual(JSON.parse(readFileSync(join(f.agentDir, "settings.json"), "utf8")).packages[0], { source: f.pkg, skills: ["!**", `+${beta}`] });

	await setPackageSkills(f.pkg, [], f.cwd, f.agentDir);
	assert.deepEqual(await enabledNames(f.cwd, f.agentDir), [], "none means none, not Pi's empty-list-means-all");

	await setPackageSkills(f.pkg, "all", f.cwd, f.agentDir);
	assert.deepEqual(await enabledNames(f.cwd, f.agentDir), ["alpha", "beta", "gamma"]);
	assert.equal(JSON.parse(readFileSync(join(f.agentDir, "settings.json"), "utf8")).packages[0], f.pkg, "back to the plain string form");
});

test("the selection keeps a package's other filters", () => {
	assert.deepEqual(withSkillSelection({ source: "x", extensions: ["-a.ts"] }, "all"), { source: "x", extensions: ["-a.ts"] });
	assert.deepEqual(withSkillSelection("x", ["skills/a/SKILL.md"]), { source: "x", skills: ["!**", "+skills/a/SKILL.md"] });
});

test("descriptions are read from single-line and folded frontmatter", () => {
	assert.equal(skillDescription("---\nname: a\ndescription: Does a thing\nlicense: MIT\n---\n"), "Does a thing");
	assert.equal(skillDescription("---\nname: a\ndescription: >\n  Folded over\n  two lines\n---\n"), "Folded over two lines");
});

test("skills from other folders exclude Reflex's own folder and package skills", async () => {
	const f = fixture();
	mkdirSync(join(f.agentDir, "skills", "mine"), { recursive: true });
	writeFileSync(join(f.agentDir, "skills", "mine", "SKILL.md"), "---\nname: mine\ndescription: My own\n---\n");
	const others = await listOtherSkills(f.cwd, f.agentDir);
	assert.ok(others.every((o) => !o.path.startsWith(join(f.agentDir, "skills")) && !o.path.startsWith(f.pkg)), JSON.stringify(others));
});
