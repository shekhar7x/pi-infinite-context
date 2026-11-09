import { mock, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

mock.module("@earendil-works/pi-ai", () => ({ uuidv7: () => "x" }));
mock.module("typebox", () => ({
  Type: { Object: (o: any) => o, String: (o?: any) => o, Number: (o?: any) => o, Optional: (o: any) => o },
}));
mock.module("@earendil-works/pi-coding-agent", () => ({
  convertToLlm: (m: any) => m,
  serializeConversation: (m: any[]) => m.map((x) => JSON.stringify(x.content)).join("\n"),
  estimateTokens: (m: any) => Math.ceil(JSON.stringify(m.content ?? "").length / 4),
}));

const DIR = mkdtempSync(join(tmpdir(), "aw-"));
process.env.PI_INFINITE_CONTEXT_STATE_DIR = DIR;
const { default: ext } = await import("../extensions/infinite-context.ts");

const T = (role: string, ts: number, text: string) => ({ role, timestamp: ts, content: [{ type: "text", text }] });
function load() {
  const h: any = {}, t: any = {};
  ext({ on: (e: string, x: any) => { h[e] = x; }, registerCommand() {}, registerTool: (x: any) => { t[x.name] = x; } } as any);
  return { h, t };
}
function session(id: string, msgs: any[], calls: { n: number }) {
  const entries = msgs.map((m, i) => ({ type: "message", id: `e${i}`, message: m }));
  return {
    sessionManager: { getSessionId: () => id, getEntryCount: () => entries.length, getEntries: () => entries, getBranch: () => entries },
    model: { id: "m" }, signal: undefined,
    ui: { notify() {}, setStatus() {} },
    modelRegistry: {
      find: () => undefined,
      complete: async () => { calls.n++; return { content: [{ type: "text", text: "SUMMARY\nSearchable: file0, topic0" }] }; },
    },
  } as any;
}
function convo() {
  const ms: any[] = []; let ts = 1;
  for (let i = 0; i < 12; i++) {
    ms.push(T("user", ts++, `prompt ${i} about topic${i}`));
    ms.push({ role: "assistant", timestamp: ts++, content: [{ type: "toolCall", name: "read", arguments: { path: `/src/file${i}.ts` } }] });
    ms.push(T("toolResult", ts++, "x".repeat(2000) + ` uniqueword${i}`));
  }
  return ms;
}
const withBudget = (id: string, max: number) => {
  writeFileSync(join(DIR, `${id}.json`), JSON.stringify({ version: 1, config: { maxInputTokens: max, foldRatio: 0.6, keepLatestPrompts: 5 }, summary: "", folded: [], access: {}, updatedAt: 0 }));
};

test("under budget: no fold, view untouched", async () => {
  const calls = { n: 0 }, ms = convo();
  withBudget("under", 10_000_000);
  const { h } = load();
  const r: any = await h.context({ messages: ms }, session("under", ms, calls));
  expect(r.messages).toEqual(ms); // nothing folded: the window holds every turn
  expect(calls.n).toBe(0);
  const saved = JSON.parse(readFileSync(join(DIR, "under.json"), "utf8"));
  expect(saved.window.length).toBe(ms.length); // window persisted even with no fold
  expect(saved.folded.length).toBe(0);
});

test("over budget: one call, last 5 prompts + newest group kept, tool groups folded first", async () => {
  const calls = { n: 0 }, ms = convo();
  withBudget("over", 3000);
  const { h } = load();
  const r = await h.context({ messages: ms }, session("over", ms, calls));
  expect(calls.n).toBe(1);
  expect(r.messages[0].content[0].text).toContain("Infinite context summary");
  const users = r.messages.filter((m: any) => m.role === "user" && !m.content[0].text.startsWith("[Infinite")).map((m: any) => m.content[0].text);
  for (const i of [7, 8, 9, 10, 11]) expect(users).toContain(`prompt ${i} about topic${i}`);
  expect(r.messages.at(-1)).toBe(ms.at(-1));
  const st = JSON.parse(readFileSync(join(DIR, "over.json"), "utf8"));
  expect(st.folded.length).toBeGreaterThan(0);
  expect(st.summary).toContain("Searchable");
});

test("restart reloads the saved view with no new LLM call", async () => {
  const calls = { n: 0 }, ms = convo();
  withBudget("restart", 3000);
  const a = load();
  const r1 = await a.h.context({ messages: ms }, session("restart", ms, calls));
  const before = calls.n;
  const b = load(); // fresh module state, same saved file
  const r2 = await b.h.context({ messages: ms }, session("restart", ms, calls));
  expect(r2.messages.length).toBe(r1.messages.length);
  expect(calls.n).toBe(before);
});

test("search_turns finds folded turns; fetch_turn returns full text", async () => {
  const calls = { n: 0 }, ms = convo();
  const { t } = load();
  const ctx = session("search", ms, calls);
  const sr = await t.search_turns.execute("1", { query: "uniqueword3" }, undefined, undefined, ctx);
  expect(sr.content[0].text).toContain("uniqueword3");
  const id = /\[(e\d+)\]/.exec(sr.content[0].text)![1];
  const ft = await t.fetch_turn.execute("2", { id }, undefined, undefined, ctx);
  expect(ft.content[0].text).toContain("uniqueword3");
});

test("system-prompt guidelines are descriptive", () => {
  const { t } = load();
  expect(t.search_turns.promptGuidelines.length).toBe(3);
});

test("state file is created on first sight of a session", async () => {
  const calls = { n: 0 }, ms = convo();
  const { h } = load();
  await h.context({ messages: ms }, session("fresh", ms, calls));
  const st = JSON.parse(readFileSync(join(DIR, "fresh.json"), "utf8"));
  expect(st.config.maxInputTokens).toBeGreaterThan(0);
  expect(st.folded).toEqual([]);
});
