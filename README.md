# ∞ pi-infinite-context

**Infinite context for pi. Run one session for months. Nothing is ever cut.**

Pi's compaction makes one hard cut and keeps a single summary. This extension never cuts. Your session
file keeps every turn forever. Only the view the model sees is managed: when it grows past your
budget, the least important, least recently used turns are folded into a summary. Any folded turn is
one search away.

```
what the model sees  =  [summary]  +  [turns still in the window]
what you keep        =  every turn, forever (the session file)
```

## Older messages are always reachable

Folding only shrinks what the model sees. Every older message stays in the session file, and the
model can call two tools at any time to get it back:

- **`search_turns(query)`** finds older messages by keyword, ranked, with ids and snippets.
- **`fetch_turn(id)`** returns one full message, paged for long ones.

The summary ends with a `Searchable:` line of exact words, so the model knows what to search for.
These are ordinary pi tools, called the same way as MCP tools, and they work on any folded turn.

## You choose what stays: priority + LRU

Two rules decide what folds first, and you control both.

- **Priority.** Every turn has a rank. Tool output folds first, then assistant text, then older
  prompts. Your first prompt and your latest prompts fold last. The ranks are listed under
  [How it works](#how-it-works).
- **LRU (least recently used).** Among turns of the same rank, the one you have touched least goes
  first. When the model fetches an old turn with `fetch_turn`, that turn counts as fresh and is kept
  longer.

What you can set:

- `/keep <n>` sets how many of your latest prompts stay untouchable (default 5).
- `/budget <tokens>` sets how big the window may grow before anything folds.
- `/fold [ratio]` folds now, and the ratio says how much (default 0.6 of the window).
- `/unfold` brings the raw turns back.
- The ranks are plain numbers in `priorityOf` in `extensions/infinite-context.ts`. Edit them to
  change the order.

## Why you'll like it

- **No cut, no loss.** Folded turns stay in the session and come back with `search_turns` and `fetch_turn`.
- **You choose what stays.** Priority + LRU decide the order, and you set the budget, the fold size and how many recent prompts are protected.
- **Smart order.** Tool output goes first. Your latest prompts go last. Turns the model fetches stay longer.
- **One call, not many.** Everything is folded in a single summarizer call.
- **Survives restarts.** The window is saved to a file and restored when you resume.
- **Always visible.** The footer shows `∞ ~84k/120k · 214 folded`.

## Install

```bash
pi install git:github.com/shekhar7x/pi-infinite-context
```

Turn pi's built-in compaction off so the two don't fight (`~/.pi/agent/settings.json`):

```json
{ "compaction": { "enabled": false } }
```

With compaction off, pi also skips its context-overflow retry. Keep the budget at about 85% of the
model's window so there is room for the system prompt and tool definitions.

## How it works

- **Trigger:** estimated view tokens > `maxInputTokens` (default 120000).
- **Fold:** victims worth `foldRatio` (default 0.6) of the current view are summarized together in
  one LLM call. If the call fails nothing is folded, and you get a warning.
- **Priority** (folded first to last, ties go to the least recently used):

  | Priority | Turn |
  |---|---|
  | 20 | tool group (assistant call + its results) |
  | 25 | other roles |
  | 30 | assistant text |
  | 40 | older user prompts |
  | 80 | first user prompt |
  | 100 | last `keepLatestPrompts` (default 5) user prompts |

  A tool call and its results fold together. The newest group is never folded.
- **Summary** ends with a `Searchable:` line of exact words, so the originals are easy to find.
- **Search:** an in-memory BM25 index over every turn. `search_turns(query)` finds them,
  `fetch_turn(id)` reads one (paged) and marks it recently used.
- **Saved state:** `~/.pi/agent/infinite-context/<sessionId>.json`. Change the folder with `PI_INFINITE_CONTEXT_STATE_DIR`.

## Commands

| Command | |
|---|---|
| `/window` | config, raw vs view tokens, folded count, state file path |
| `/budget <tokens>` | max input tokens before folding (`0` turns it off) |
| `/fold [ratio]` | fold now |
| `/unfold` | clear the summary and send raw turns again |
| `/keep <n>` | latest user prompts kept at top priority |

## Settings (environment, defaults for new sessions)

| Variable | Default | |
|---|---|---|
| `PI_INFINITE_CONTEXT_MAX_INPUT_TOKENS` | `120000` | max input tokens |
| `PI_INFINITE_CONTEXT_FOLD_RATIO` | `0.6` | share of the view to fold |
| `PI_INFINITE_CONTEXT_KEEP_LATEST_PROMPTS` | `5` | protected latest user prompts |
| `PI_INFINITE_CONTEXT_SUMMARIZER_MODEL` | current model | summarizer, `provider/id` |
| `PI_INFINITE_CONTEXT_STATE_DIR` | `~/.pi/agent/infinite-context` | state folder |

## Honest limits

- The history is unlimited. The window is not: the model still sees only what fits your budget.
- The fold call receives all chosen turns at once. If the summarizer's context is smaller than the
  folded share of your budget, the call fails and history stays raw.
- Token counts are estimates (characters / 4).
- Search is keyword (BM25). There are no embeddings.
- You can't pin an individual message yet. You protect your latest prompts with `/keep` and tune the ranks in code.

## Development

```bash
bun test
```

## License

MIT
