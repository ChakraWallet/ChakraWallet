// Code editor (CodeMirror 6) with Solidity highlighting (and simple highlighting for the TON languages: Tact, FunC,
// Tolk), themed with the app's colours, and compiler diagnostics.
import { useEffect, useRef } from 'preact/hooks';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection } from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, HighlightStyle, indentOnInput, bracketMatching, indentUnit, StreamLanguage } from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { lintGutter, setDiagnostics } from '@codemirror/lint';
import { tags } from '@lezer/highlight';
import { solidity } from '@replit/codemirror-lang-solidity';

// ------------------------------------------------------------ TON languages (keywords, comments, strings, numbers)
const words = (s) => new Set(s.split(/\s+/));
function cLike({ keywords, atoms, line, block }) {
  const kw = words(keywords), at = words(atoms);
  return StreamLanguage.define({
    startState: () => ({ inBlock: false }),
    token(stream, st) {
      if (st.inBlock) {
        const i = stream.string.indexOf(block[1], stream.pos);
        if (i < 0) { stream.skipToEnd(); return 'comment'; }
        stream.pos = i + block[1].length; st.inBlock = false; return 'comment';
      }
      if (stream.eatSpace()) return null;
      if (line.some((l) => stream.match(l))) { stream.skipToEnd(); return 'comment'; }
      if (stream.match(block[0])) { st.inBlock = true; return 'comment'; }
      if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return 'string';
      if (stream.match(/^-?(0x[0-9a-fA-F_]+|0b[01_]+|\d[\d_]*)/)) return 'number';
      if (stream.match(/^#?[A-Za-z_][\w?!']*/)) {
        const w = stream.current();
        if (kw.has(w) || w.startsWith('#')) return 'keyword';
        if (at.has(w)) return 'atom';
        return /^[A-Z]/.test(w) ? 'typeName' : 'variableName';
      }
      stream.next();
      return 'operator';
    },
    languageData: { commentTokens: { line: line[0] } },
  });
}
const TON_LANGS = {
  tact: cLike({
    keywords: 'contract trait struct message fun receive bounced external init get let const if else while repeat do until return try catch foreach in as with import primitive native extends mutates virtual override abstract inline asm self initOf require throw emit send reply forward dump codeOf',
    atoms: 'true false null', line: ['//'], block: ['/*', '*/'],
  }),
  func: cLike({
    keywords: 'int cell slice builder cont tuple var forall return if ifnot else elseif elseifnot while do until repeat try catch impure inline inline_ref method_id asm const global',
    atoms: 'true false nil Nil', line: [';;'], block: ['{-', '-}'],
  }),
  tolk: cLike({
    keywords: 'fun get import tolk const global var val if else while do repeat return try catch throw assert match struct type enum as is lazy mutate contract',
    atoms: 'true false null', line: ['//'], block: ['/*', '*/'],
  }),
};
const EXT = { tact: 'tact', fc: 'func', func: 'func', tolk: 'tolk', sol: 'solidity' };
/** Language of a file by its extension: solidity, tact, func, tolk, else `fallback`. */
export const langOf = (path, fallback = 'plain') => EXT[String(path).split('.').pop().toLowerCase()] || fallback;
const language = (lang) => (lang === 'solidity' ? solidity : TON_LANGS[lang] || []);

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
export function CodeEditor({ value, onChange, readOnly = false, diagnostics, jump, lang = 'solidity' }) {
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
        highlightActiveLine(), indentUnit.of('    '), language(lang), syntaxHighlighting(highlight), theme, lintGutter(),
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
