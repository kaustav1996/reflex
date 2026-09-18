import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { frontendToolchain, resolveManifest, sqlitePath } from "../src/artifacts/manifest.ts";
import { PERSIST_PY, withPersistence } from "../src/artifacts/persist.ts";
import { artifactSlug } from "../src/artifacts/store.ts";

const scratch = () => mkdtempSync(join(tmpdir(), "reflex-art-"));

test("plain static folder → static, no build, publish root", () => {
	const d = scratch();
	writeFileSync(join(d, "index.html"), "<h1>hi</h1>");
	const m = resolveManifest(d, "demo");
	assert.equal(m.kind, "static");
	assert.equal(m.frontend.build, "");
	assert.equal(m.frontend.publish, ".");
	assert.equal(m.source, "detected");
});

test("vite web/ + FastAPI api/ → fullstack with uvicorn start and sqlite env", () => {
	const d = scratch();
	mkdirSync(join(d, "web"));
	writeFileSync(join(d, "web", "package.json"), JSON.stringify({ scripts: { build: "vite build" }, devDependencies: { vite: "^5" } }));
	writeFileSync(join(d, "web", "package-lock.json"), "{}");
	mkdirSync(join(d, "api"));
	writeFileSync(join(d, "api", "requirements.txt"), "fastapi\nuvicorn\n");
	writeFileSync(join(d, "api", "main.py"), "from fastapi import FastAPI\napp = FastAPI()\n");
	const m = resolveManifest(d, "todo");
	assert.equal(m.kind, "fullstack");
	assert.deepEqual([m.frontend.dir, m.frontend.build, m.frontend.publish, m.frontend.apiUrlEnv], ["web", "npm ci && npm run build", "dist", "VITE_API_URL"]);
	assert.equal(m.backend?.runtime, "python");
	assert.equal(m.backend?.start, "uvicorn main:app --host 0.0.0.0 --port $PORT");
	assert.equal(sqlitePath(m.backend), "./data.db");
});

test("reflex-artifact.json wins over detection and is validated", () => {
	const d = scratch();
	writeFileSync(join(d, "index.html"), "x");
	writeFileSync(join(d, "reflex-artifact.json"), JSON.stringify({ version: 1, name: "custom", kind: "fullstack", frontend: { dir: "site", build: "make", publish: "public" }, backend: { dir: "srv", runtime: "node", start: "node server.js", env: { DATABASE_URL: "sqlite:///./db/app.sqlite" } } }));
	const m = resolveManifest(d, "ignored");
	assert.equal(m.source, "file");
	assert.equal(m.frontend.publish, "public");
	assert.equal(m.backend?.build, "npm ci");
	assert.equal(sqlitePath(m.backend), "./db/app.sqlite");
	writeFileSync(join(d, "reflex-artifact.json"), JSON.stringify({ version: 1, name: "bad", kind: "fullstack" }));
	assert.throws(() => resolveManifest(d, "x"), /no backend/);
});

test("toolchain table", () => {
	assert.equal(frontendToolchain({ "react-scripts": "5" }).publish, "build");
	assert.equal(frontendToolchain({ next: "14" }).apiUrlEnv, "NEXT_PUBLIC_API_URL");
});

test("withPersistence wraps start under the sidecar and keeps $PORT for the inner shell", () => {
	const spec = { dir: "api", runtime: "python" as const, build: "pip install -r requirements.txt", start: "uvicorn main:app --host 0.0.0.0 --port $PORT", health: "/health", env: { DATABASE_URL: "sqlite:///./data.db" } };
	const w = withPersistence(spec, { url: "https://api.netlify.com/api/v1/blobs/site/site:reflex-appdata/x.db.gz", token: "tok", dbPath: "./data.db" });
	assert.ok(w.start.startsWith("if command -v python3"));
	assert.ok(w.start.includes('python3 .reflex-persist.py -- "uvicorn main:app --host 0.0.0.0 --port \\$PORT"'));
	assert.ok(w.start.endsWith("else uvicorn main:app --host 0.0.0.0 --port $PORT; fi"));
	assert.equal(w.env.REFLEX_DB_PATH, "./data.db");
	assert.equal(w.env.REFLEX_APPDATA_TOKEN, "tok");
	assert.equal(w.env.DATABASE_URL, "sqlite:///./data.db");
});

test("sidecar uses the Netlify Blobs signed-url contract and sqlite backup", () => {
	assert.ok(PERSIST_PY.includes("application/json;type=signed-url"));
	assert.ok(PERSIST_PY.includes("src.backup(dst)"));
	assert.ok(PERSIST_PY.includes("REFLEX_APPDATA_URL"));
});

test("artifact slugs", () => {
	assert.equal(artifactSlug("My Todo App!"), "my-todo-app");
	assert.throws(() => artifactSlug("!"), /valid artifact name/);
});
