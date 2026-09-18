/**
 * `reflex jev`: one TypeSafe System One request from the shell.
 *   reflex jev --state "text or @file" --questions '{"q":{"type":"noul","instructions":"…"}}'
 *   reflex jev --state @report.txt --choice "kind: shell|decide|llm" "Which step type should do this activity?"
 *   reflex jev --state @x.json --noul "Is the input a valid invoice?"
 * Prints JSON answers (probabilities + confidence). Use it to classify, route and order things deterministically in scripts.
 */
import { readFileSync } from "node:fs";
import { createKeyResolver, loadDotEnv } from "./config.js";
import { choice, noul, type Question, score, TypesafeClient } from "./extensions/typesafe/client.js";
import { piStoredApiKey } from "./extensions/typesafe/state.js";

function readArg(v: string | undefined): string {
	if (!v) return "";
	if (v.startsWith("@")) return v === "@-" ? readFileSync(0, "utf8") : readFileSync(v.slice(1), "utf8");
	return v;
}

export async function runJevCli(args: string[]): Promise<void> {
	loadDotEnv();
	const get = (name: string) => {
		const i = args.indexOf(name);
		return i >= 0 ? args[i + 1] : undefined;
	};
	const key = createKeyResolver(piStoredApiKey).get("typesafe");
	if (!key) throw new Error("TYPESAFE_API_KEY missing (reflex setup)");
	const stateRaw = readArg(get("--state") ?? get("-s"));
	if (!stateRaw) throw new Error("usage: reflex jev --state <text|@file|@-> (--questions <json|@file> | --noul <q> | --choice \"id: a|b|c\" <q> | --score <q> --levels \"l0|l1|l2\")");
	let state: unknown = stateRaw;
	try {
		state = JSON.parse(stateRaw);
	} catch {}
	const questions: Record<string, Question> = {};
	const q = get("--questions") ?? get("-q");
	if (q) Object.assign(questions, JSON.parse(readArg(q)));
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--noul") questions[`noul${Object.keys(questions).length + 1}`] = noul(args[++i]);
		if (args[i] === "--choice") {
			const spec = args[++i];
			const text = args[++i];
			const [id, opts] = spec.includes(":") ? [spec.split(":")[0].trim(), spec.split(":").slice(1).join(":")] : ["choice", spec];
			questions[id] = choice(text, Object.fromEntries(opts.split("|").map((o) => o.trim()).filter(Boolean).map((o) => [o, o])));
		}
		if (args[i] === "--score") {
			const text = args[++i];
			const levels = (get("--levels") ?? "low|medium|high").split("|").map((l) => l.trim());
			questions.score = score(text, levels);
		}
	}
	if (!Object.keys(questions).length) throw new Error("no questions given");
	const client = new TypesafeClient(key, { timeoutMs: 15000 });
	const res = await client.systemOne({ purpose: "cli", state: state as never, questions });
	const out = { model: res.model, latencyMs: Math.round(res.latencyMs), answers: res.answers };
	console.log(JSON.stringify(out, null, args.includes("--compact") ? 0 : 2));
}
