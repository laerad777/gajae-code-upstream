### Performance

- Avoid unsupported Kitty placement extraction on non-Kitty input frames and reuse unchanged editor logical-line layouts, retaining at most one layout per current logical line.
- Reuse the byte/line admission decision for exact cached Markdown highlights instead of rescanning unchanged fenced code. Cold misses still enforce the existing native-highlight limits.
- Add a native-highlight input-to-synchronized-write benchmark with same-frame visibility checks and deterministic write/viewport hashes. Scheduling, preparation, force precedence, and output revisions are unchanged.
