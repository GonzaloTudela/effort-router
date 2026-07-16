# Common analysis IR

The canonical serialized representation is `schemas/code-profile.schema.json` version `1.0.0`.
Language adapters emit this IR; the matcher and router never consume parser-specific nodes.

## Guarantees

- Paths use repository-relative `/` separators and locations use one-based, inclusive line numbers.
- Symbols, calls, state accesses, effects, dependencies, and evidence are sorted by path, source range, kind, then ID.
- IDs are deterministic hashes of the normalized structural identity, never array positions.
- Comments are not executable evidence. Identifier names and string values identify AST nodes but never imply difficulty.
- Every effect has a source location and a versioned rule ID. Direct language facts such as assignments also use a PHP core rule.
- Unknown calls and dynamic constructs remain explicit and reduce coverage; adapters never invent a target.
- Raw control-flow counts are observations. The IR contains no difficulty score, model, effort, or routing weight.

## Adapter boundary

An adapter performs parsing, name normalization, local symbol resolution, call extraction, state access extraction,
effect-rule matching, test discovery, and coverage accounting. Cross-file slicing and task interpretation belong to
the matcher, not to the adapter.

## Stable serialization

Objects are serialized with recursively sorted keys, arrays use the ordering rules above, and output ends with a
single newline. The source hash covers source bytes; cache keys additionally cover the task spec, analyzer version,
and all active rule catalog versions.