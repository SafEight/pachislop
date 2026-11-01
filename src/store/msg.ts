// User-facing text produced outside React (History labels, toasts, confirmations, io errors and
// notes). It is stored in English with its values kept apart, and translated where it is shown:
// `formatMsg(m, t)` with the UI's `t` / `tr` (src/ui/i18n). Nothing here depends on the UI.

/** Values for a message's `{name}` placeholders: strings and numbers are shown as they are (layer names, file names, counts); a nested message is translated too. */
export type MsgVars = Readonly<Record<string, string | number | Msg | MsgList>>;

/** An English template with its values. `lower` lowercases an English result's first letter (a mid-sentence word; acronyms like “FOV” and single letters stay); a translation is kept as it is. `ctx` picks the meaning of an ambiguous key (see `TransOpts`). */
export interface Msg {
  readonly en: string;
  readonly vars?: MsgVars;
  readonly lower?: boolean;
  readonly ctx?: string;
}

/** Several messages shown as one text, joined by `sep` (“; ”, “ · ”). */
export interface MsgList {
  readonly parts: readonly Text[];
  readonly sep: string;
}

/** A plain string is an English UI literal (the i18n key); a `Msg` carries values. */
export type Text = string | Msg | MsgList;

export const msg = (en: string, vars?: MsgVars, ctx?: string): Msg => (ctx !== undefined ? { en, vars, ctx } : vars ? { en, vars } : { en });

export const joinMsgs = (parts: readonly Text[], sep: string): MsgList => ({ parts, sep });

/** A value shown verbatim, never looked up (a browser error message, a file's own text). */
export const verbatim = (text: string): Msg => ({ en: '{text}', vars: { text } });

/** `ctx` names where an ambiguous English key is used (“export”, “plate”); the tables key that meaning as `ctx|English`, falling back to the bare key. */
export interface TransOpts {
  readonly ctx?: string;
}

export type Translate = (en: string, vars?: Readonly<Record<string, string | number>>, opts?: TransOpts) => string;

/** English rendering without lookup (logs, `Error.message`). */
export const english: Translate = (en, vars) => (vars ? en.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : en);

/** Render `m` through `t` (`useT()` in components, `tr` elsewhere); nested messages are translated first. */
export function formatMsg(m: Text, t: Translate): string {
  if (typeof m === 'string') return m === '' ? '' : t(m);
  if ('parts' in m) return m.parts.map((p) => formatMsg(p, t)).join(m.sep);
  if (m.en === '{text}' && m.vars && typeof m.vars.text === 'string') return m.vars.text;
  let vars: Record<string, string | number> | undefined;
  if (m.vars) {
    vars = {};
    for (const [k, v] of Object.entries(m.vars)) vars[k] = typeof v === 'object' ? formatMsg(v, t) : v;
  }
  const s = t(m.en, vars, m.ctx === undefined ? undefined : { ctx: m.ctx });
  return m.lower && s === english(m.en, vars) && /^[A-Z][a-z0-9 ]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s;
}

/** An Error whose text is a `Msg`, so the UI can show it translated; `message` stays English. */
export class MsgError extends Error {
  readonly msg: Msg;
  constructor(m: Msg) {
    super(formatMsg(m, english));
    this.msg = m;
  }
}

/** The user-facing text of a caught value: a `MsgError`'s message, else the error's own text as is. */
export const errorMsg = (e: unknown): Msg => (e instanceof MsgError ? e.msg : verbatim(e instanceof Error ? e.message : String(e)));
