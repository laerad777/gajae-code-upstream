import { expect, test } from "bun:test";
import { __editorPerfCounters, Editor } from "../src/components/editor";
import { defaultEditorTheme } from "./test-themes";

test("typing lays out only the changed cursor line, with cold-render parity", () => {
	const editor = new Editor(defaultEditorTheme);
	editor.focused = true;
	editor.setText(Array.from({ length: 1000 }, (_, i) => `line ${i} 한글 👩‍💻`).join("\n"));
	editor.render(40);
	__editorPerfCounters.reset();
	editor.handleInput("x");
	const warm = editor.render(40);
	expect(__editorPerfCounters.layoutLogicalLinesProcessed).toBeLessThanOrEqual(2);
	editor.invalidate();
	expect(editor.render(40)).toEqual(warm);
});

test("shrinking releases trailing layouts before the next render", () => {
	const editor = new Editor(defaultEditorTheme);
	editor.setText(Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n"));
	editor.render(40);
	expect(editor.logicalLayoutCacheSize).toBe(1000);
	editor.setText("short");
	expect(editor.logicalLayoutCacheSize).toBeLessThanOrEqual(1);
	editor.render(40);
	expect(editor.logicalLayoutCacheSize).toBe(1);
	editor.invalidate();
	expect(editor.logicalLayoutCacheSize).toBe(0);
});

test("reuse never survives text, geometry, cursor, or invalidation changes incorrectly", () => {
	const editor = new Editor(defaultEditorTheme);
	editor.focused = true;
	editor.setText("first 한글\nsecond 👩‍💻\nthird " + "word ".repeat(30));
	for (const input of [
		"x",
		"\x1b[A",
		"\x1b[D",
		"y",
		"\x7f",
		"\x1b[B",
		"\x1b[13;2u",
		"z",
		"\x1b[200~paste\nline\x1b[201~",
	]) {
		editor.handleInput(input);
		for (const width of [40, 18, 60]) {
			const warm = editor.render(width);
			editor.invalidate();
			expect(editor.render(width)).toEqual(warm);
		}
	}
	// Reordering identical-sized lines must not reuse another index's cursor metadata.
	editor.setText("third\nfirst\nsecond");
	const reordered = editor.render(40);
	editor.invalidate();
	expect(editor.render(40)).toEqual(reordered);
	editor.handleInput("x");
	editor.render(40);
	editor.handleInput("\x1f"); // undo
	const undone = editor.render(40);
	editor.invalidate();
	expect(editor.render(40)).toEqual(undone);
	editor.setText("replacement");
	const replaced = editor.render(40);
	editor.invalidate();
	expect(editor.render(40)).toEqual(replaced);
});
