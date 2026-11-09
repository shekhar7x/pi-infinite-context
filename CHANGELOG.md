# Changelog

## [0.1.0] - 2026-11-09

- First release. Infinite context for pi: sessions that run for months, with nothing cut.
- Folds low-priority, least-recently-used turns into one summary in a single LLM call.
- Last N user prompts protected; the newest turn is never folded.
- `search_turns` (BM25) and `fetch_turn` bring any original turn back.
- State saved per session and restored on restart; footer status; `/window` `/budget` `/fold` `/unfold` `/keep`.
