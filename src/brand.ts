/**
 * Rebrand Pi without forking it.
 *
 * Pi reads its app name, config dir name and version from the package.json in
 * `PI_PACKAGE_DIR` (documented for Nix/Guix). We point it at a small shim directory
 * whose package.json carries `piConfig: { name: "reflex", configDir: ".reflex" }` and whose
 * other assets (dist, docs, examples) are symlinks into the real pi-coding-agent package.
 * Result: "reflex --session …", the `reflex` banner, ~/.reflex/agent config, REFLEX_* env vars.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { BRAND_CLI, getReflexHome } from "./config.js";

/** Version of the underlying pi-coding-agent (the shim makes pi's own VERSION report Reflex's). */
export function piVersion(): string {
	try {
		let dir = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
		while (!existsSync(join(dir, "package.json")) && dirname(dir) !== dir) dir = dirname(dir);
		return (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version: string }).version;
	} catch {
		return "?";
	}
}

export function ensureBrandShim(version: string): string | undefined {
	try {
		// pi's exports map only has an "import" condition, so resolve it as ESM and walk up to the package root.
		let piDir = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
		while (!existsSync(join(piDir, "package.json")) && dirname(piDir) !== piDir) piDir = dirname(piDir);
		const piPkgJson = join(piDir, "package.json");
		const piPkg = JSON.parse(readFileSync(piPkgJson, "utf8")) as { version: string };
		const shim = join(getReflexHome(), "pi-shim");
		mkdirSync(shim, { recursive: true });

		const link = (name: string, target: string) => {
			const path = join(shim, name);
			try {
				if (lstatSync(path).isSymbolicLink() && readlinkSync(path) === target) return;
				unlinkSync(path);
			} catch {}
			symlinkSync(target, path, "junction");
		};
		for (const name of ["dist", "docs", "examples"]) if (existsSync(join(piDir, name))) link(name, join(piDir, name));

		const pkg = {
			name: "reflex-agent",
			version,
			description: `Reflex ${version} on pi-coding-agent ${piPkg.version}`,
			piConfig: { name: BRAND_CLI, configDir: ".reflex" },
			piVersion: piPkg.version,
		};
		const pkgPath = join(shim, "package.json");
		const next = `${JSON.stringify(pkg, null, 2)}\n`;
		if (!existsSync(pkgPath) || readFileSync(pkgPath, "utf8") !== next) writeFileSync(pkgPath, next);
		// Pi shows the CHANGELOG since the last seen version; ours is empty on purpose.
		for (const [file, content] of [
			["CHANGELOG.md", `# Reflex changelog\n\nSee the Reflex README. Underlying pi-coding-agent: ${piPkg.version}.\n`],
			["README.md", `Reflex ${version} — a coding agent & assistant with System One reflexes (on pi-coding-agent ${piPkg.version}).\n`],
		] as const) {
			const path = join(shim, file);
			if (!existsSync(path) || readFileSync(path, "utf8") !== content) writeFileSync(path, content);
		}
		return shim;
	} catch {
		return undefined;
	}
}
