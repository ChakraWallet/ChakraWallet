// Code editor (CodeMirror 6) with Solidity highlighting, themed with the app's colours, and compiler diagnostics.
import { useEffect, useRef } from 'preact/hooks';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection } from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, HighlightStyle, indentOnInput, bracketMatching, indentUnit } from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { lintGutter, setDiagnostics } from '@codemirror/lint';
import { tags } from '@lezer/highlight';
import { solidity } from '@replit/codemirror-lang-solidity';

const theme = EditorView.theme({
  '&': { color: 'var(--text)', backgroundColor: 'var(--card)', height: '100%', fontSize: '.8125rem' },
  '.cm-scroller': { fontFamily: "ui-monospace, 'SF Mono', 'Roboto Mono', Consolas, monospace", lineHeight: '1.55' },
  '.cm-content': { caretColor: 'var(--primary)', padding: '.5rem 0' },
  '.cm-gutters': { backgroundColor: 'var(--card)', color: 'var(--muted)', border: 'none', borderRight: '1px solid var(--border)' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--primary) 6%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text)' },
  '&.cm-focused .cm-cursor': { borderLeftColor: 'var(--primary)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--primary-soft) !important' },
  '.cm-matchingBracket': { backgroundColor: 'var(--primary-soft)', outline: 'none' },
  '&.cm-focused': { outline: 'none' },
  '.cm-tooltip': { backgroundColor: 'var(--card)', border: '1px solid var(--border)', color: 'var(--text)' },
  '.cm-diagnostic-error': { borderLeftColor: 'var(--red)' },
  '.cm-diagnostic-warning': { borderLeftColor: 'var(--amber)' },
  '.cm-lintRange-error': { backgroundImage: 'none', textDecoration: 'underline wavy var(--red)' },
  '.cm-lintRange-warning': { backgroundImage: 'none', textDecoration: 'underline wavy var(--amber)' },
});

const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier, tags.controlKeyword, tags.operatorKeyword, tags.definitionKeyword], color: 'var(--cm-keyword)', fontWeight: '600' },
  { tag: [tags.typeName, tags.className, tags.namespace], color: 'var(--cm-type)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--cm-string)' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: 'var(--cm-number)' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment], color: 'var(--muted)', fontStyle: 'italic' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: 'var(--cm-fn)' },
  { tag: [tags.variableName, tags.propertyName], color: 'var(--text)' },
  { tag: [tags.operator, tags.punctuation, tags.bracket], color: 'var(--muted)' },
  { tag: [tags.meta, tags.annotation], color: 'var(--cm-type)' },
]);

/**
 * value: initial text (an editable editor owns it afterwards: remount with a new `key` to load another file;
 *   a read-only one follows it).
 * diagnostics: [{ from, to, severity, message }] for this file. jump: { line, n } scrolls to a line.
 */
export function CodeEditor({ value, onChange, readOnly = false, diagnostics, jump }) {
  const el = useRef(null);
  const view = useRef(null);
  const ro = useRef(new Compartment());
  const cb = useRef(onChange);
  cb.current = onChange;

  useEffect(() => {
    const state = EditorState.create({
      doc: value || '',
      extensions: [
        lineNumbers(), highlightActiveLineGutter(), history(), drawSelection(), indentOnInput(), bracketMatching(), closeBrackets(),
        highlightActiveLine(), indentUnit.of('    '), solidity, syntaxHighlighting(highlight), theme, lintGutter(),
        keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
        ro.current.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
        EditorView.updateListener.of((u) => { if (u.docChanged) cb.current?.(u.state.doc.toString()); }),
        EditorView.contentAttributes.of({ autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' }),
      ],
    });
    view.current = new EditorView({ state, parent: el.current });
    return () => { view.current?.destroy(); view.current = null; };
  }, []);

  // read-only views follow the text they show (editable ones own their document)
  useEffect(() => {
    const v = view.current;
    if (!v || !readOnly) return;
    const cur = v.state.doc.toString();
    if (cur !== (value || '')) v.dispatch({ changes: { from: 0, to: cur.length, insert: value || '' } });
  }, [value]);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const len = v.state.doc.length;
    const list = (diagnostics || []).map((d) => ({ ...d, from: Math.min(Math.max(0, d.from), len), to: Math.min(Math.max(d.from, d.to), len) }));
    v.dispatch(setDiagnostics(v.state, list));
  }, [diagnostics]);

  useEffect(() => {
    const v = view.current;
    if (!v || !jump?.line) return;
    const line = v.state.doc.line(Math.min(jump.line, v.state.doc.lines));
    v.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: 'center' }) });
    v.focus();
  }, [jump]);

  return <div class="ct-editor" ref={el} />;
}
