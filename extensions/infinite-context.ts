/**
 * Infinite Context for pi — a session that never gets cut.
 *
 * The session JSONL is never modified: every original turn stays in it and is
 * searchable (in-memory BM25 over all turns) and fetchable (`fetch_turn`).
 * Only the VIEW sent to the model changes:
 *
 *   [summary node] + [turns that are not folded]
 *
 * Trigger:  view tokens > maxInputTokens (default 120000)
 * Fold:     victims worth `foldRatio` (default 60%) of the current view tokens,
 *           picked by priority then LRU, summarized in ONE LLM call.
 * Priority (low -> folded first):
 *           tool group 20 < assistant text 30 < other 25.. < older user 40
 *           < first user turn 80 < last `keepLatestPrompts` (5) user prompts 100.
 *           Ties broken by LRU (last access / timestamp). The newest group is
 *           never folded.
 * Persist:  ~/.pi/agent/infinite-context/<sessionId>.json  (config, folded keys,
 *           summary, LRU stamps) — reloaded on restart/resume.
 *
 * Commands: /window  /budget <tokens>  /fold [ratio]  /unfold  /keep <n>
 * Tools:    search_turns(query), fetch_turn(id)
 * Env:      PI_INFINITE_CONTEXT_MAX_INPUT_TOKENS, PI_INFINITE_CONTEXT_FOLD_RATIO, PI_INFINITE_CONTEXT_KEEP_LATEST_PROMPTS (defaults), PI_INFINITE_CONTEXT_SUMMARIZER_MODEL=provider/id
 *
 * Requires pi's built-in compaction off ("compaction": {"enabled": false}).
 * Load: pi install git:github.com/shekhar7x/pi-infinite-context   (or: pi --extension ./extensions/infinite-context.ts)
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { convertToLlm, estimateTokens, serializeConversation } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type Msg = any; // AgentMessage

interface Config {
	maxInputTokens: number; // 0 = window off
	foldRatio: number;
	keepLatestPrompts: number;
}
interface State {
	version: 1;
	config: Config;
	summary: string;
	folded: string[]; // message keys currently replaced by the summary
	access: Record<string, number>; // key -> last access (LRU)
	updatedAt: number;
}

const SUMMARY_MARK = "[Infinite context summary";
const DIR = join(process.env.PI_INFINITE_CONTEXT_STATE_DIR ?? join(homedir(), ".pi", "agent", "infinite-context"));

const envNum = (k: string, d: number) => {
	const n = Number(process.env[k]);
	return Number.isFinite(n) && process.env[k] ? n : d;
};

// ── message helpers ──────────────────────────────────────────────────────────
function textOf(m: Msg): string {
	const c = m?.content;
	if (typeof c === "string") return c;
	if (!Array.isArray(c)) return "";
	return c
		.map((p: any) =>
			p?.type === "text"
				? p.text
				: p?.type === "toolCall"
					? `tool_call ${p.name}(${JSON.stringify(p.arguments ?? {})})`
					: "",
		)
		.join("\n");
}

function hash(s: string): string {
	let h = 5381;
	for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
	return (h >>> 0).toString(36);
}
/** Stable identity of a message across context rebuilds and restarts. */
export function keyOf(m: Msg): string {
	const t = textOf(m);
	return `${m.role}:${m.timestamp ?? 0}:${hash(t.slice(0, 256))}:${t.length}`;
}

const isSummary = (m: Msg) => m.role === "user" && textOf(m).startsWith(SUMMARY_MARK);
const hasToolCalls = (m: Msg) => Array.isArray(m.content) && m.content.some((p: any) => p?.type === "toolCall");

/** Atomic groups: an assistant turn stays with its toolResults. */
export function groupsOf(ms: Msg[]): Msg[][] {
	const out: Msg[][] = [];
	for (const m of ms) {
		if (m.role === "toolResult" && out.length) out[out.length - 1].push(m);
		else out.push([m]);
	}
	return out;
}

// ── in-memory BM25 over every turn ───────────────────────────────────────────
function tokenize(text: string): string[] {
	const low = text.toLowerCase();
	const words = low.match(/[a-z0-9]+/g) ?? [];
	const idents = low.match(/[a-z0-9_./:-]{4,}/g) ?? []; // paths / identifiers kept whole
	return idents.length ? words.concat(idents) : words;
}

class Index {
	docs: { id: string; key: string; role: string; ts: number; text: string; len: number }[] = [];
	byId = new Map<string, number>();
	post = new Map<string, Map<number, number>>();
	totalLen = 0;
	seen = new Set<string>();

	add(id: string, key: string, role: string, ts: number, text: string) {
		if (this.seen.has(id)) return;
		this.seen.add(id);
		const toks = tokenize(text);
		const d = this.docs.length;
		this.docs.push({ id, key, role, ts, text, len: toks.length });
		this.byId.set(id, d);
		this.totalLen += toks.length;
		const tf = new Map<string, number>();
		for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
		for (const [t, n] of tf) {
			let p = this.post.get(t);
			if (!p) this.post.set(t, (p = new Map()));
			p.set(d, n);
		}
	}

	search(query: string, k: number) {
		const N = this.docs.length;
		if (!N) return [];
		const avg = this.totalLen / N || 1;
		const score = new Map<number, number>();
		for (const t of new Set(tokenize(query))) {
			const p = this.post.get(t);
			if (!p) continue;
			const idf = Math.log(1 + (N - p.size + 0.5) / (p.size + 0.5));
			for (const [d, tf] of p) {
				const dl = this.docs[d].len;
				const s = (idf * tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * (dl / avg)));
				score.set(d, (score.get(d) ?? 0) + s);
			}
		}
		return [...score]
			.sort((a, b) => b[1] - a[1])
			.slice(0, k)
			.map(([d, s]) => ({ doc: this.docs[d], score: s }));
	}
}

// ── extension ────────────────────────────────────────────────────────────────
export default function (pi: ExtensionAPI) {
	let st: State | null = null;
	let stSession = "";
	const index = new Index();
	let indexedSession = "";
	let indexedCount = -1;

	const defaults = (): Config => ({
		maxInputTokens: envNum("PI_INFINITE_CONTEXT_MAX_INPUT_TOKENS", 120_000),
		foldRatio: envNum("PI_INFINITE_CONTEXT_FOLD_RATIO", 0.6),
		keepLatestPrompts: envNum("PI_INFINITE_CONTEXT_KEEP_LATEST_PROMPTS", 5),
	});
	const fileOf = (sid: string) => join(DIR, `${sid}.json`);

	function load(ctx: ExtensionContext): State {
		const sid = ctx.sessionManager.getSessionId();
		if (st && stSession === sid) return st;
		stSession = sid;
		try {
			const s = JSON.parse(readFileSync(fileOf(sid), "utf8")) as State;
			st = { ...s, config: { ...defaults(), ...s.config } };
		} catch {
			st = { version: 1, config: defaults(), summary: "", folded: [], access: {}, updatedAt: Date.now() };
			try {
				save(ctx); // create the file right away so the window is always visible on disk
			} catch {
				/* read-only home etc.: keep working in memory */
			}
		}
		return st;
	}
	function save(ctx: ExtensionContext) {
		if (!st) return;
		st.updatedAt = Date.now();
		mkdirSync(DIR, { recursive: true });
		const f = fileOf(ctx.sessionManager.getSessionId());
		writeFileSync(`${f}.tmp`, JSON.stringify(st, null, 1));
		renameSync(`${f}.tmp`, f);
	}

	function syncIndex(ctx: ExtensionContext) {
		const sid = ctx.sessionManager.getSessionId();
		const n = ctx.sessionManager.getEntryCount();
		if (sid === indexedSession && n === indexedCount) return;
		if (sid !== indexedSession) {
			index.docs = [];
			index.byId.clear();
			index.post.clear();
			index.seen.clear();
			index.totalLen = 0;
		}
		for (const e of ctx.sessionManager.getEntries() as any[]) {
			if (e.type !== "message") continue;
			const m = e.message;
			if (isSummary(m)) continue;
			index.add(e.id, keyOf(m), m.role, m.timestamp ?? 0, textOf(m));
		}
		indexedSession = sid;
		indexedCount = n;
	}

	const tok = (m: Msg) => estimateTokens(m);
	const total = (ms: Msg[]) => ms.reduce((n, m) => n + tok(m), 0);

	function summaryNode(s: State): Msg {
		return {
			role: "user",
			content: [
				{
					type: "text",
					text:
						`${SUMMARY_MARK} — older turns folded out of this view. Originals are intact: ` +
						`use search_turns("<words>") with the Searchable words below, then fetch_turn(id).]\n\n${s.summary}`,
				},
			],
			timestamp: 0,
		};
	}
	function render(messages: Msg[], s: State): Msg[] {
		if (!s.folded.length) return messages;
		const gone = new Set(s.folded);
		const rest = messages.filter((m) => !gone.has(keyOf(m)));
		return s.summary ? [summaryNode(s), ...rest] : rest;
	}

	function priorityOf(g: Msg[], userRank: Map<string, number>, firstUserKey: string, cfg: Config): number {
		const m = g[0];
		if (m.role === "user") {
			const k = keyOf(m);
			if ((userRank.get(k) ?? 1e9) < cfg.keepLatestPrompts) return 100; // last N user prompts
			if (k === firstUserKey) return 80;
			return 40;
		}
		if (m.role === "assistant") return hasToolCalls(m) || g.length > 1 ? 20 : 30;
		return 25;
	}

	async function summarize(ctx: ExtensionContext, prior: string, turns: Msg[], prompts: [string, string], signal?: AbortSignal) {
		let model = ctx.model;
		const spec = process.env.PI_INFINITE_CONTEXT_SUMMARIZER_MODEL;
		if (spec?.includes("/")) {
			const [p, id] = spec.split("/", 2);
			model = ctx.modelRegistry.find(p, id) ?? model;
		}
		if (!model) return "";
		const body = serializeConversation(convertToLlm(turns));
		const text =
			`You summarize a node of an AI coding agent's conversation and tool results, FOR the current context.\n\n` +
			`CURRENT prompt:\n${prompts[0] || "(none)"}\n\nPREVIOUS prompt:\n${prompts[1] || "(none)"}\n\n` +
			`Summarize for that context. Drop unnecessary detail or leave a short reference. Cite file paths, commands, ` +
			`titles/URLs. Do not invent anything. Keep it as long as needed — do not truncate.\n\n` +
			`The full originals stay in session memory; the agent searches them later with keyword search. For everything ` +
			`you drop or compress, keep the exact searchable words that would find it (names, paths, identifiers, numbers, ` +
			`errors, commands). End with a line 'Searchable: kw1, kw2, ...'.\n\n` +
			(prior ? `Previous summary (merge into your new summary; it is being replaced):\n<previous>\n${prior}\n</previous>\n\n` : "") +
			`<conversation>\n${body}\n</conversation>`;
		try {
			const r = await ctx.modelRegistry.complete(
				model,
				{ messages: [{ role: "user", content: [{ type: "text", text }], timestamp: Date.now() }] },
				{ maxTokens: 8192, signal, cacheRetention: "none", sessionId: uuidv7() },
			);
			return r.content
				.filter((c: any) => c.type === "text")
				.map((c: any) => c.text)
				.join("\n")
				.trim();
		} catch {
			return ""; // fail-safe: nothing folded, history stays raw
		}
	}

	/** Fold `ratio` of the current view tokens (priority asc, LRU asc) in ONE LLM call. */
	async function fold(ctx: ExtensionContext, messages: Msg[], s: State, ratio: number, signal?: AbortSignal): Promise<boolean> {
		const view = render(messages, s);
		const want = Math.floor(total(view) * ratio);
		const gone = new Set(s.folded);
		const live = messages.filter((m) => !gone.has(keyOf(m)) && !isSummary(m));
		const gs = groupsOf(live);
		if (gs.length < 2) return false;

		const users = messages.filter((m) => m.role === "user" && !isSummary(m));
		const userRank = new Map<string, number>();
		[...users].reverse().forEach((m, i) => userRank.set(keyOf(m), i));
		const firstUserKey = users[0] ? keyOf(users[0]) : "";

		const cands = gs
			.slice(0, -1) // the newest group (in-flight turn) is never folded
			.map((g, i) => ({
				g,
				i,
				pr: priorityOf(g, userRank, firstUserKey, s.config),
				lru: Math.max(...g.map((m) => s.access[keyOf(m)] ?? m.timestamp ?? 0)),
				size: total(g),
			}))
			.sort((a, b) => a.pr - b.pr || a.lru - b.lru || a.i - b.i);

		const picked: typeof cands = [];
		let got = 0;
		for (const c of cands) {
			if (got >= want) break;
			picked.push(c);
			got += c.size;
		}
		if (!picked.length) return false;

		picked.sort((a, b) => a.i - b.i); // chronological for the summarizer
		const turns = picked.flatMap((c) => c.g);
		const prompts: [string, string] = [textOf(users.at(-1) ?? {}), textOf(users.at(-2) ?? {})];
		const summary = await summarize(ctx, s.summary, turns, prompts, signal);
		if (!summary) return false;

		s.summary = summary;
		for (const m of turns) s.folded.push(keyOf(m));
		save(ctx);
		return true;
	}

	// ── the view applied before every LLM call ──
	pi.on("context", async (event, ctx) => {
		const s = load(ctx);
		if (s.config.maxInputTokens <= 0) return;
		let view = render(event.messages, s);
		if (total(view) > s.config.maxInputTokens) {
			const before = total(view);
			if (await fold(ctx, event.messages, s, s.config.foldRatio, ctx.signal)) {
				view = render(event.messages, s);
				ctx.ui.notify(`infinite context: ${before} → ${total(view)} tokens`, "info");
			} else {
				ctx.ui.notify(
					`infinite context: over budget (${before} > ${s.config.maxInputTokens}) and fold failed — sending raw; ` +
						`with pi compaction off there is no overflow recovery`,
					"warning",
				);
			}
		}
		// Footer: message tokens of what is sent (excludes system prompt + tool defs, so ~).
		const vt = total(view);
		ctx.ui.setStatus(
			"infinite-context",
			`∞ ~${Math.round(vt / 1000)}k/${Math.round(s.config.maxInputTokens / 1000)}k` +
				(s.folded.length ? ` · ${s.folded.length} folded` : ""),
		);
		return s.folded.length ? { messages: view } : undefined;
	});

	// ── user control ──
	const currentMessages = (ctx: ExtensionContext): Msg[] =>
		(ctx.sessionManager.getBranch() as any[]).filter((e) => e.type === "message").map((e) => e.message);

	pi.registerCommand("window", {
		description: "Show infinite context: config, tokens raw vs view, folded count",
		handler: async (_a, ctx) => {
			const s = load(ctx);
			const msgs = currentMessages(ctx);
			const view = render(msgs, s);
			ctx.ui.notify(
				`max=${s.config.maxInputTokens || "off"} fold=${s.config.foldRatio} keepLatestPrompts=${s.config.keepLatestPrompts}\n` +
					`raw ${msgs.length} msgs / ${total(msgs)} tok → view ${view.length} msgs / ${total(view)} tok\n` +
					`folded ${s.folded.length} msgs; summary ${s.summary ? estimateTokens(summaryNode(s)) : 0} tok\nfile: ${fileOf(stSession)}`,
				"info",
			);
		},
	});
	pi.registerCommand("budget", {
		description: "Max input tokens before folding (0 = off): /budget 120000",
		handler: async (a, ctx) => {
			const n = Number.parseInt(a.trim(), 10);
			if (!Number.isFinite(n) || n < 0) return ctx.ui.notify("usage: /budget <tokens>", "warning");
			const s = load(ctx);
			s.config.maxInputTokens = n;
			save(ctx);
			ctx.ui.notify(`max input tokens = ${n || "off"}`, "info");
		},
	});
	pi.registerCommand("keep", {
		description: "How many latest user prompts are highest priority: /keep 5",
		handler: async (a, ctx) => {
			const n = Number.parseInt(a.trim(), 10);
			if (!Number.isFinite(n) || n < 0) return ctx.ui.notify("usage: /keep <n>", "warning");
			const s = load(ctx);
			s.config.keepLatestPrompts = n;
			save(ctx);
			ctx.ui.notify(`keepLatestPrompts = ${n}`, "info");
		},
	});
	pi.registerCommand("fold", {
		description: "Fold now: /fold [ratio] (default = configured foldRatio, e.g. 0.6)",
		handler: async (a, ctx) => {
			const s = load(ctx);
			const r = Number.parseFloat(a.trim()) || s.config.foldRatio;
			ctx.ui.notify(`folding ${Math.round(r * 100)}% of view…`, "info");
			const ok = await fold(ctx, currentMessages(ctx), s, r, ctx.signal);
			ctx.ui.notify(ok ? `folded; ${s.folded.length} msgs now in summary` : "nothing folded", ok ? "info" : "warning");
		},
	});
	pi.registerCommand("unfold", {
		description: "Clear the summary; send raw turns again (originals were never removed)",
		handler: async (_a, ctx) => {
			const s = load(ctx);
			s.folded = [];
			s.summary = "";
			save(ctx);
			ctx.ui.notify("window cleared", "info");
		},
	});

	// ── recovery tools ──
	pi.registerTool({
		name: "search_turns",
		label: "Search turns",
		description:
			"Search ALL original turns of this session (including ones folded out of your context) by keywords, BM25-ranked. " +
			"Use the 'Searchable:' words from the infinite-context summary. Returns hits with ids; call fetch_turn(id) for full text.",
		promptSnippet: "Search folded-away session turns by keywords",
		promptGuidelines: [
			"Earlier turns of this session may be folded into a summary; search_turns and fetch_turn read the originals.",
			"The latest user message is the current request; earlier messages that never got a reply are usually leftovers from an interrupted turn.",
			"When the context already holds what the current request needs, a direct answer is usually enough.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Words to look for" }),
			top_k: Type.Optional(Type.Number({ description: "Max hits (default 5, max 10)" })),
		}),
		async execute(_id, p, _sig, _up, ctx) {
			syncIndex(ctx);
			const hits = index.search(p.query, Math.min(10, p.top_k ?? 5));
			const text = hits.length
				? hits
						.map(({ doc, score }) => {
							const low = doc.text.toLowerCase();
							const w = tokenize(p.query).find((t) => low.includes(t)) ?? "";
							const at = Math.max(0, low.indexOf(w));
							const snip = doc.text.slice(Math.max(0, at - 120), at + 320).replace(/\s+/g, " ");
							return `[${doc.id}] ${doc.role} ${new Date(doc.ts).toISOString()} score=${score.toFixed(2)}\n  …${snip}…`;
						})
						.join("\n\n")
				: "no matches";
			return { content: [{ type: "text", text }], details: { hits: hits.length } };
		},
	});
	pi.registerTool({
		name: "fetch_turn",
		label: "Fetch turn",
		description:
			"Fetch the full text of one original session turn by id (from search_turns), paged by characters. " +
			"Fetching marks the turn recently used so it is folded later.",
		parameters: Type.Object({
			id: Type.String({ description: "Turn id from a search_turns hit" }),
			offset: Type.Optional(Type.Number({ description: "Char offset (default 0)" })),
			max_chars: Type.Optional(Type.Number({ description: "Slice size (default 6000)" })),
		}),
		async execute(_id, p, _sig, _up, ctx) {
			syncIndex(ctx);
			const d = index.byId.get(p.id);
			if (d === undefined) return { content: [{ type: "text", text: "turn not found" }], details: {} };
			const doc = index.docs[d];
			const s = load(ctx);
			s.access[doc.key] = Date.now(); // LRU touch
			save(ctx);
			const off = p.offset ?? 0;
			const n = p.max_chars ?? 6000;
			const more = off + n < doc.text.length ? `\n\n[next_offset=${off + n} of ${doc.text.length}]` : "";
			return { content: [{ type: "text", text: doc.text.slice(off, off + n) + more }], details: { length: doc.text.length } };
		},
	});
}
