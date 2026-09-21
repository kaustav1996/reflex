/**
 * `reflex doctor`: check keys, recorder, TypeSafe reachability and the LLM model.
 */
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createKeyResolver, getPiAgentDir, getReflexConfigPath, loadReflexConfig, SERVICE_ENV } from "./config.js";
import { noul } from "./extensions/typesafe/client.js";
import { createJevClient, missingJevHint, normalizeSetting } from "./extensions/typesafe/provider.js";
import { piStoredApiKey } from "./extensions/typesafe/state.js";
import { detectRecorder, recorderInstallHint } from "./extensions/voice/recorder.js";

const ok = (s: string) => `\x1b[32m✓\x1b[0m ${s}`;
const bad = (s: string) => `\x1b[31m✗\x1b[0m ${s}`;
const warn = (s: string) => `\x1b[33m!\x1b[0m ${s}`;

export async function runDoctor(): Promise<void> {
	const config = loadReflexConfig();
	const keys = createKeyResolver(piStoredApiKey);
	console.log(`reflex doctor · config ${getReflexConfigPath()} · pi dir ${getPiAgentDir()}\n`);
	console.log(config.onboarded ? ok("onboarding complete") : warn("not onboarded yet (run `reflex setup`)"));

	// LLM
	const agentDir = getPiAgentDir();
	try {
		const runtime = await ModelRuntime.create({ authPath: `${agentDir}/auth.json`, modelsPath: `${agentDir}/models.json` });
		const provider = config.llm.provider ?? "openrouter";
		const status = runtime.hasConfiguredAuth(provider);
		console.log(status ? ok(`LLM provider ${provider}: credentials configured`) : bad(`LLM provider ${provider}: no credentials (set ${SERVICE_ENV[provider] ?? "API key"} or run \`reflex setup\`)`));
		const model = config.llm.model ? runtime.getModel(provider, config.llm.model) : undefined;
		console.log(model ? ok(`default model ${provider}/${model.id} (ctx ${model.contextWindow})`) : warn(`default model ${provider}/${config.llm.model ?? "?"} not in catalog (try \`pi update --models\` or pick another with /model)`));
	} catch (err) {
		console.log(bad(`model runtime: ${err instanceof Error ? err.message : String(err)}`));
	}

	// TypeSafe
	const made = createJevClient(config, keys, { timeoutMs: 8000 });
	if (!made) console.log(bad(`Jev unreachable: ${missingJevHint(normalizeSetting(process.env.REFLEX_JEV_PROVIDER ?? config.reflex.provider))} → reflex layer disabled`));
	else {
		const client = made.client;
		try {
			const t0 = performance.now();
			const res = await client.systemOne({ purpose: "doctor", state: { command: "git status" }, questions: { destructive: noul("Is running command destructive?") } });
			console.log(ok(`Jev ${res.model} via ${made.route.provider} (${made.route.reason}): ${Math.round(performance.now() - t0)}ms · P(git status destructive)=${res.answers.destructive.noul.toFixed(3)} · key from ${keys.source(made.route.provider)}`));
		} catch (err) {
			console.log(bad(`Jev via ${made.route.provider}: ${err instanceof Error ? err.message : String(err)}`));
		}
	}
	console.log(`  reflex: ${config.reflex.enabled ? "on" : "off"} · appetite ${config.reflex.riskAppetite} · gate ${config.reflex.gateToolCalls} · monitor ${config.reflex.monitorProgress} · route ${config.reflex.routeModels}`);

	// Voice
	const rec = detectRecorder();
	console.log(rec ? ok(`microphone recorder: ${rec}`) : warn(`no recorder found: ${recorderInstallHint()}`));
	const vp = config.voice.provider;
	if (vp === "none") console.log(warn("voice provider: none"));
	else if (vp === "whisper-cpp") console.log(config.voice.whisperCppModel ? ok(`voice: whisper.cpp ${config.voice.whisperCppModel}`) : bad("voice: whisper.cpp model path not set"));
	else console.log(keys.get(vp) ? ok(`voice: ${vp} (${config.voice.language}) · key from ${keys.source(vp)}`) : bad(`voice: ${vp} key missing (${SERVICE_ENV[vp] ?? "?"})`));

	// Computer use
	if (process.platform === "darwin") {
		const { execFile } = await import("node:child_process");
		const has = (bin: string) => new Promise<boolean>((r) => execFile("which", [bin], (e) => r(!e)));
		console.log(ok(`macOS computer-use: osascript + screencapture available${(await has("cliclick")) ? " · cliclick present" : " · brew install cliclick for double/right clicks"}`));
	} else console.log(warn("computer-use tools are macOS-only"));
}
