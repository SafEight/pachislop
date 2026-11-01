import { useCallback } from 'react';
import { create } from 'zustand';
import type { Translate, TransOpts } from '../../store/msg';
import { JA_EFFECTS } from './ja-effects';
import { JA_INSPECTOR } from './ja-inspector';
import { JA_SHELL } from './ja-shell';

// UI language. The English text IS the key: components wrap their literal with `t('Outer Glow')`,
// and the Japanese tables map that exact English string to Photoshop-JP / Element 3D-JP wording.
// Project data (layer names, preset names, effect types) never goes through here.
//
// One English word can mean different things in different places ("Scale" of a layer vs of the
// export; "Close" a dialog vs close a plate's gaps). Such a call passes a context,
// `t('Scale', undefined, { ctx: 'export' })`, and the table keys that meaning as `'export|Scale'`.
// English always shows the bare text; a context without its own entry uses the bare key's.
// Each key lives in exactly one table.

export type Lang = 'en' | 'ja';

const STORAGE_KEY = 'pachislot-visuals.lang';

const JA: Readonly<Record<string, string>> = { ...JA_SHELL, ...JA_INSPECTOR, ...JA_EFFECTS };

function initialLang(): Lang {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === 'en' || stored === 'ja') return stored;
  return navigator.language.toLowerCase().startsWith('ja') ? 'ja' : 'en';
}

interface LangState {
  lang: Lang;
  setLang: (lang: Lang) => void;
}

export const useLang = create<LangState>((set) => ({
  lang: initialLang(),
  setLang: (lang) => {
    localStorage.setItem(STORAGE_KEY, lang);
    document.documentElement.lang = lang;
    set({ lang });
  },
}));
document.documentElement.lang = useLang.getState().lang;

export type TVars = Record<string, string | number>;

/** `ctx`: the meaning of an ambiguous key (see above); `lang`: translate into this language instead of the current one. */
export interface TOpts extends TransOpts {
  readonly lang?: Lang;
}

const reported = new Set<string>();

/**
 * Translate an English UI string into the current (or given) language. `{name}` placeholders are
 * filled from `vars` after lookup, so the table holds one entry per message, not per value.
 */
export function tr(en: string, vars?: TVars, opts?: TOpts): string {
  let s = en;
  if ((opts?.lang ?? useLang.getState().lang) === 'ja') {
    const hit = (opts?.ctx === undefined ? undefined : JA[`${opts.ctx}|${en}`]) ?? JA[en];
    if (hit !== undefined) s = hit;
    else if (import.meta.env.DEV && !reported.has(en)) {
      reported.add(en);
      console.debug(`[i18n] no ja entry: ${JSON.stringify(en)}`);
    }
  }
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;
}

/** Hook form of `tr`: re-renders the component when the language changes. */
export function useT(): Translate {
  const lang = useLang((s) => s.lang);
  return useCallback<Translate>((en, vars, opts) => tr(en, vars, { ctx: opts?.ctx, lang }), [lang]);
}

/** Keys missing from the Japanese tables among `keys` (verification helper for dev tooling). */
export function missingJa(keys: Iterable<string>): string[] {
  return [...keys].filter((k) => JA[k] === undefined);
}

/** The Japanese text of English key `en` (bare, no context), if the tables have it. */
export function jaOf(en: string): string | undefined {
  return JA[en];
}

let jaToEn: Map<string, string[]> | null = null;

/** The English keys (contexts dropped) whose Japanese text is `ja`: the other language of a shown Japanese label. */
export function englishOf(ja: string): readonly string[] {
  if (!jaToEn) {
    jaToEn = new Map();
    for (const [key, text] of Object.entries(JA)) {
      const en = key.slice(key.indexOf('|') + 1);
      const list = jaToEn.get(text);
      if (!list) jaToEn.set(text, [en]);
      else if (!list.includes(en)) list.push(en);
    }
  }
  return jaToEn.get(ja) ?? [];
}
