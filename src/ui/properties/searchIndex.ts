import type { ReactElement } from 'react';
import { listEffects } from '../../effects/registry';
import type { EffectDef } from '../../engine/contracts';
import type { PartKey } from '../../model/types';
import { useEditor } from '../../store/store';
import { selectTab } from '../dock/layout';
import { addErode, ERODE_NAME } from '../erode';
import { addGlint, GLINT_ADD_LABEL } from '../glint';
import { englishOf, jaOf, tr, type Lang } from '../i18n';
import { useSectionsOpen } from '../sectionMemory';

// Properties search: the index and the landing. The index is read from a hidden render of the
// real views (PropertySearch renders them with every Section open, under FindProbe), so it lists
// exactly the controls the selected layer shows, under the names it shows them with. The DOM
// contract it reads:
// - `section[data-sk]`: a Section; `data-sk` is its remembered-state key (`scope/id`), which is
//   also what opens it, and its header's `.title` (minus muted notes) names it;
// - `[data-fid]`: a labelled control (Row and the Ref* controls, a material feature toggle, a
//   gradient / light block); `data-fid` is its stable id (the ref key of a store control, else the
//   label), its `.label` child or own text the label; its options and choice buttons are values;
// - `div.sub-head`: a heading inside a section, a crumb of the rows after it;
// - `[data-fcap]`: a store-bound control (controls.tsx `Findable`) around its field, the first
//   `[data-fid]` inside; `data-fcap` names the element, registered in the render's FindCapture,
//   that the results show as the control.
// A hit is found again in the live panel by its section chain, its field id and its place among
// the fields with that id in the same section.

/** Where a slot of the index lives: which node to select to show it. */
export type FindTarget =
  | { kind: 'document' }
  | { kind: 'layer'; layerId: string }
  | { kind: 'multi' }
  | { kind: 'part'; layerId: string; part: PartKey }
  | { kind: 'effect'; layerId: string; part: PartKey | null; effectId: string }
  | { kind: 'mask'; layerId: string; maskId: string }
  | { kind: 'glint'; layerId: string }
  | { kind: 'erode'; layerId: string }
  /** A companion generator's card (ui/companions.ts): its layer node. */
  | { kind: 'companion'; layerId: string };

/** One page of the index: a node's view as the panel shows it. */
export interface Slot {
  key: string;
  target: FindTarget;
  /** Crumbs before the page's own sections ("Band 2", "Effects › Gaussian Blur", "Document"). */
  prefix: readonly string[];
  /** Section keys to open on the way (a part's Appearance section). */
  open: readonly string[];
}

/** A control or a section of the index. */
export interface Hit {
  slot: Slot;
  /** Order of the slot, then of the element in it: ties keep the panel's order. */
  order: number;
  label: string;
  /** Location before the label: the slot's prefix, the section titles and a sub-heading. */
  crumbs: readonly string[];
  /** `data-sk` of the enclosing sections, outermost first (a section hit ends with its own). */
  sections: readonly string[];
  /** `data-fid` of the control; null for a section, or the slot itself (an effect, a part). */
  fid: string | null;
  /** Place among the fields with this id owned by the same section. */
  nth: number;
  /** Choices of the control (options, segmented / ramp buttons), as shown. */
  values: readonly string[];
  /** The control bound to the store, rendered live in the results (controls.tsx `Findable`); null: the hit links to its place. */
  live: ReactElement | null;
  /** A Document 3D-lighting control: not offered while a 2D (or other non-3D) layer is selected. */
  doc3d: boolean;
  labelN: readonly string[];
  pathN: string;
  valuesN: readonly string[];
}

export interface FindIndex {
  hits: readonly Hit[];
  /** Whether the Document's 3D lighting applies to the selection (a 3D layer, a group of them, or nothing selected). */
  with3d: boolean;
  /** Layer that "Add effect" results add to (none for the Document or several layers). */
  addTo: string | null;
  /** Effect types the layer already has (shown as hits, not offered again). */
  hasTypes: ReadonlySet<string>;
  /** The layer's pinned style effect offered to add while not listed: a 3D title's glint (“Glint (3D highlights)”), a 2D title's かすれ. */
  addPinned: 'glint' | 'erode' | null;
}

export interface HitMatch {
  hit: Hit;
  rank: number;
  /** Index of the matching value (option / button) to focus, or -1. */
  pick: number;
}

export interface AddMatch {
  /** The effect to add; null for a pinned style effect (`pinned`). */
  def: EffectDef | null;
  /** With `def` null: the 3D glint or 2D かすれ, switched on (ui/glint.ts, ui/erode.ts). */
  pinned: 'glint' | 'erode' | null;
  name: string;
  layerId: string;
  rank: number;
}

export type Match = HitMatch | AddMatch;

export const isAdd = (m: Match): m is AddMatch => 'def' in m;

/** Synonym groups (English and Japanese): a query word equal to one term also finds the others. */
const SYNONYMS: readonly (readonly string[])[] = [
  ['blur', 'soften', 'feather', 'defocus', 'ぼかし', 'ぼけ', 'ソフト'],
  ['depth', 'extrude', 'extrusion', 'thickness', 'push z', '奥行き', '深さ', '押し出し', '厚み'],
  ['tilt', 'tilt x', 'tilt y', 'turn y', 'orbit', 'rotation x', 'rotation y', 'rotx', 'roty', '傾き', 'チルト', 'x 回転', 'y 回転'],
  ['gold', '金', 'ゴールド'],
  ['silver', '銀', 'シルバー'],
  ['rim', 'stroke', 'border', '境界線', '縁', 'フチ'],
  ['band', 'bevel copy', 'outline copy', 'z offset', '外枠', 'バンド'],
  ['color', 'colour', 'tint', '色', 'カラー'],
  ['glow', 'emissive', '光彩', 'グロー'],
  ['shine', 'gloss', 'specular', 'spec', '光沢', '艶'],
  ['glint', 'shine', 'shines', 'sparkle', 'sparkles', 'star', 'stars', 'streak', 'streaks', 'glare', 'bloom', 'きらきら', 'キラ', '輝き', 'グリント'],
  ['erode', 'erosion', 'dry brush', 'drybrush', 'distress', 'distressed', 'かすれ', '掠れ', 'ドライブラシ'],
  ['knockout', 'knock out', 'hollow', 'hollow letters', 'cut out', 'cutout', 'punch', 'punch through', 'ノックアウト', '中抜き', '抜き'],
  ['reflection', 'reflections', 'environment', 'env', 'mirror', '反射', '環境'],
  ['opacity', 'transparency', 'alpha', '不透明度'],
  ['shadow', '影', 'シャドウ'],
  ['light', 'lighting', 'ライト', '光源', 'ライティング'],
  ['font', 'typeface', 'フォント', '書体'],
  ['bevel', 'emboss', 'ベベル'],
  ['rotation', 'rotate', 'angle', '回転', '角度'],
  ['metal', 'metalness', 'chrome', 'メタル', '金属', 'クローム'],
  ['size', 'scale', 'サイズ'],
].map((g) => g.map(norm));

/** Search form of a text: NFKC, lower case, katakana as hiragana (ボカシ finds ぼかし), single spaces. */
export function norm(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u30a1-\u30f6]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/\s+/g, ' ')
    .trim();
}

/** `text` in the other UI language too (a number such as "Rim 2" goes through the `{n}` key). */
function variants(text: string, lang: Lang): string[] {
  const out = [text];
  const num = text.match(/\d+/)?.[0];
  const tpl = num === undefined ? null : text.replace(num, '{n}');
  if (lang === 'en') {
    const ja = jaOf(text) ?? (tpl ? jaOf(tpl)?.replace('{n}', num!) : undefined);
    if (ja) out.push(ja);
  } else {
    const en = englishOf(text);
    out.push(...(en.length || !tpl ? en : englishOf(tpl).map((s) => s.replace('{n}', num!))));
  }
  return out;
}

const SECTION = 'section[data-sk]';
const space = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

/** Visible name of a section or label element: its text without muted notes, info tips, swatches and controls. */
function nameOf(el: Element | null): string {
  if (!el) return '';
  const c = el.cloneNode(true) as Element;
  for (const n of c.querySelectorAll('.muted, .info-tip, .sty-group-on, .sty-swatch, .badge, input, select, button')) n.remove();
  return space(c.textContent);
}

/** The section owning `el` within `root` (the root itself outside every section). */
function ownerOf(el: Element, root: Element): Element {
  const s = el.parentElement?.closest(SECTION);
  return s && root.contains(s) ? s : root;
}

/** Sections around `el` within `root`, outermost first (`el` itself when it is one). */
function sectionsOf(el: Element, root: Element): Element[] {
  const out: Element[] = [];
  for (let s: Element | null = el.closest(SECTION); s && root.contains(s) && s !== root; s = s.parentElement?.closest(SECTION) ?? null) out.unshift(s);
  return out;
}

/** The `div.sub-head` heading the rows of `el` sit under, within its section. */
function subHeadOf(el: Element, owner: Element): string | null {
  for (let n: Element | null = el; n && n !== owner && !n.parentElement?.matches(SECTION); n = n.parentElement) {
    for (let p = n.previousElementSibling; p; p = p.previousElementSibling) if (p.matches('div.sub-head')) return nameOf(p);
  }
  return null;
}

/** The choices of a control: its options and the buttons that name a choice (segments, ramps). */
function valueEls(row: Element): HTMLElement[] {
  return [...row.querySelectorAll<HTMLElement>('option, button')].filter((v) => valueText(v) !== '');
}

function valueText(v: HTMLElement): string {
  if (v instanceof HTMLOptionElement) return v.hidden || v.disabled ? '' : space(v.text);
  const s = [v.getAttribute('aria-label'), v.title.split('\n')[0], v.textContent].map(space).find((x) => x && x.length <= 48) ?? '';
  return /^[\s−+–\-—…×✕▲▼⧉⤢⤡▸▾ⓘ✥⋮]*$/.test(s) ? '' : s;
}

/** Place of `el` among the `[data-fid=fid]` fields owned by `owner`. */
function fieldsOf(owner: Element, root: Element, fid: string): Element[] {
  return [...owner.querySelectorAll(`[data-fid="${CSS.escape(fid)}"]`)].filter((x) => ownerOf(x, root) === owner);
}

/**
 * Read the hits out of the hidden render: `container` holds one `[data-find-slot=i]` element per
 * slot. Every labelled control and every section is a hit; an effect, mask or part slot is one
 * too, under its own name. `captured`: the live controls registered in the render (FindCapture).
 */
export function collectHits(container: Element, slots: readonly Slot[], lang: Lang, captured: ReadonlyMap<string, ReactElement>): Hit[] {
  const hits: Hit[] = [];
  let order = 0;
  const add = (slot: Slot, label: string, crumbs: string[], sections: string[], fid: string | null, nth: number, values: string[], live: ReactElement | null) => {
    if (!label) return;
    const labelN = [...new Set(variants(label, lang).map(norm))];
    const pathN = crumbs.flatMap((c) => variants(c, lang)).map(norm).join(' / ');
    hits.push({ slot, order: order++, label, crumbs, sections, fid, nth, values, live, doc3d: sections.includes('doc/doc-lighting3d'), labelN, pathN, valuesN: values.map(norm) });
  };
  slots.forEach((slot, i) => {
    const root = container.querySelector(`[data-find-slot="${i}"]`);
    if (!root) return;
    if (slot.target.kind === 'effect' || slot.target.kind === 'glint' || slot.target.kind === 'erode' || slot.target.kind === 'companion' || slot.target.kind === 'mask' || slot.target.kind === 'part') add(slot, slot.prefix.at(-1) ?? '', slot.prefix.slice(0, -1), [], null, 0, [], null);
    for (const el of root.querySelectorAll(`${SECTION}, [data-fid]`)) {
      const chain = sectionsOf(el, root);
      const titles = chain.map((s) => nameOf(s.querySelector(':scope > header > .title')));
      if (el.matches(SECTION)) {
        add(slot, titles.at(-1) ?? '', [...slot.prefix, ...titles.slice(0, -1)], chain.map((s) => s.getAttribute('data-sk')!), null, 0, [], null);
        continue;
      }
      const fid = el.getAttribute('data-fid')!;
      const owner = ownerOf(el, root);
      const sub = subHeadOf(el, owner);
      // The control's capture: the nearest Findable wrapper, when this is the field it wraps (its first).
      const capEl = el.parentElement?.closest('[data-fcap]');
      const cap = capEl?.querySelector('[data-fid]') === el ? capEl.getAttribute('data-fcap') : null;
      add(
        slot,
        nameOf(el.querySelector(':scope > .label') ?? el),
        [...slot.prefix, ...titles, ...(sub ? [sub] : [])],
        chain.map((s) => s.getAttribute('data-sk')!),
        fid,
        fieldsOf(owner, root, fid).indexOf(el),
        valueEls(el).map(valueText),
        (cap && captured.get(cap)) || null,
      );
    }
  });
  return hits;
}

// ---------- matching ----------

const SEP = /[\s/()·・（）「」“”、,:：›>&+-]+/;

/** How well `text` holds `w`: 0 equal, 1 starts with it, 2 a word starts with it, 3 contains it, -1 not at all. */
function quality(text: string, w: string): number {
  const i = text.indexOf(w);
  if (i < 0) return -1;
  if (text === w) return 0;
  if (i === 0) return 1;
  return text.split(SEP).some((p) => p.startsWith(w)) ? 2 : 3;
}

/** Best quality of any of `words` in any of `texts` (-1: none). */
function best(texts: readonly string[], words: readonly string[]): number {
  let b = -1;
  for (const text of texts)
    for (const w of words) {
      const q = quality(text, w);
      if (q >= 0 && (b < 0 || q < b)) b = q;
    }
  return b;
}

interface Query {
  text: string;
  words: string[];
  /** Per word: the word and its synonyms. */
  alts: string[][];
  /** Synonyms of the whole query when it is a phrase of a synonym group (“cut out”, “dry brush”). */
  phrase: string[];
}

function parseQuery(q: string): Query | null {
  const text = norm(q);
  if (!text) return null;
  const words = text.split(' ');
  const alts = words.map((w) => [...new Set([w, ...SYNONYMS.filter((g) => g.includes(w)).flat()])]);
  const phrase = words.length > 1 ? SYNONYMS.filter((g) => g.includes(text)).flat() : [];
  return { text, words, alts, phrase };
}

const minOf = (xs: readonly number[]) => Math.min(...xs.filter((x) => x >= 0));

/**
 * Rank of `h` for the query (lower = better), or null: the whole query in the label (equal,
 * prefix, word, inside), then every word in the label, then every word in the label or its
 * location with at least one in the label ("rim width": Rim 1 › Geometry › Width), then the same
 * through synonyms ("blur": Soften) or a phrase's synonyms ("cut out": Hollow letters), then a
 * choice of the control ("金": Ramp · 金ランプ).
 */
function rankHit(h: Hit, q: Query): { rank: number; pick: number } | null {
  const whole = best(h.labelN, [q.text]);
  if (whole >= 0) return { rank: whole, pick: -1 };
  const direct = q.words.map((w) => best(h.labelN, [w]));
  if (direct.every((x) => x >= 0)) return { rank: 4 + minOf(direct) / 10, pick: -1 };
  const inPath = (ws: readonly string[]) => ws.some((w) => h.pathN.includes(w));
  if (direct.some((x) => x >= 0) && q.words.every((w, i) => direct[i] >= 0 || inPath([w]))) return { rank: 5 + minOf(direct) / 10, pick: -1 };
  const syn = q.alts.map((ws) => best(h.labelN, ws));
  if (syn.some((x) => x >= 0) && q.alts.every((ws, i) => syn[i] >= 0 || inPath(ws))) return { rank: 6 + minOf(syn) / 10, pick: -1 };
  const phrase = best(h.labelN, q.phrase);
  if (phrase >= 0) return { rank: 6 + phrase / 10, pick: -1 };
  for (let v = 0; v < h.valuesN.length; v++) {
    const inValue = q.alts.map((ws) => best([h.valuesN[v]], ws));
    if (inValue.some((x) => x >= 0) && q.alts.every((ws, i) => inValue[i] >= 0 || syn[i] >= 0 || inPath(ws))) return { rank: 8 + minOf(inValue) / 10, pick: v };
  }
  return null;
}

/**
 * The hits of `index` for `query`, best first (ties in panel order), then the effects that could
 * be added whose name (or a synonym of the query) matches (not those the layer has: they are
 * hits), the pinned glint / かすれ first.
 */
export function search(index: FindIndex, query: string): Match[] {
  const q = parseQuery(query);
  if (!q) return [];
  const found: HitMatch[] = [];
  for (const hit of index.hits) {
    if (hit.doc3d && !index.with3d) continue;
    const r = rankHit(hit, q);
    if (r) found.push({ hit, ...r });
  }
  found.sort((a, b) => a.rank - b.rank || a.hit.order - b.hit.order);
  const adds: AddMatch[] = [];
  const layerId = index.addTo;
  if (layerId) {
    // The whole query, its phrase synonyms, and a one-word query's synonyms (“distress”: かすれ).
    const terms = [q.text, ...q.phrase, ...(q.words.length === 1 ? q.alts[0] : [])];
    const offer = (def: EffectDef | null, pinned: AddMatch['pinned'], label: string) => {
      const names = (['en', 'ja'] as const).map((lang) => norm(tr(label, undefined, { lang })));
      const rank = best(names, terms);
      if (rank >= 0 && rank <= 2) adds.push({ def, pinned, name: tr(label), layerId, rank });
    };
    if (index.addPinned === 'glint') offer(null, 'glint', GLINT_ADD_LABEL);
    if (index.addPinned === 'erode') offer(null, 'erode', ERODE_NAME);
    for (const def of listEffects()) if (!index.hasTypes.has(def.type)) offer(def, null, def.label);
  }
  adds.sort((a, b) => a.rank - b.rank);
  return [...found, ...adds];
}

// ---------- landing ----------

const FOCUSABLE = 'input:not([type="hidden"]):not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** The live element of `hit` in the panel body, or null while it isn't shown yet. */
function locate(body: Element, hit: Hit): HTMLElement | null {
  const root = hit.slot.target.kind === 'part' ? (body.querySelector('.sty-inline') ?? body) : body;
  let scope: Element = root;
  for (const sk of hit.sections) {
    const s = scope.querySelector(`section[data-sk="${CSS.escape(sk)}"]`);
    if (!s) return null;
    scope = s;
  }
  if (hit.fid !== null) return (fieldsOf(scope, root, hit.fid)[hit.nth] as HTMLElement | undefined) ?? null;
  if (scope !== root) return scope.querySelector<HTMLElement>(':scope > header');
  // The slot itself: an effect card's head, a mask's first section, a part's Appearance row.
  const row = root.previousElementSibling;
  if (row?.matches('.sty-row')) return row as HTMLElement;
  return root.querySelector<HTMLElement>('.effect-head, section > header');
}

/** The next animation frame. (The app's lib predates Promise.withResolvers.) */
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** Briefly highlight `el` (CSS `.find-flash`). */
function flash(el: HTMLElement) {
  el.classList.remove('find-flash');
  void el.offsetWidth;
  el.classList.add('find-flash');
  setTimeout(() => el.classList.remove('find-flash'), 1600);
}

/** Bring the hit's control into view in the panel, focus it (the matching choice when there is one) and highlight it. */
async function reveal(hit: Hit | null, pick: number) {
  let el: HTMLElement | null = null;
  // The body remounts for the new node, sections open, a part expands: wait until it is there.
  for (let i = 0; i < 60 && !el; i++) {
    await frame();
    const body = document.querySelector('.panel.properties .props-body');
    el = body && (hit ? locate(body, hit) : body.querySelector<HTMLElement>('[data-fid]'));
  }
  if (!el) return;
  // The panel restores its remembered scroll and scrolls an expanded part's row up on the next
  // frame; land after that.
  await frame();
  await frame();
  el.scrollIntoView({ block: 'center' });
  focusField(el, pick);
  flash(el);
}

/**
 * Focus the control of field element `el`: the choice `pick` of it when there is one, else a
 * number's value field (focused, its value selected: type to change it), else its first control.
 */
export function focusField(el: HTMLElement, pick: number) {
  const choice = pick >= 0 ? valueEls(el)[pick] : undefined;
  const focus = choice instanceof HTMLOptionElement ? choice.parentElement : (choice ?? el.querySelector<HTMLElement>('input[type="text"]:not(:disabled)') ?? el.querySelector<HTMLElement>(FOCUSABLE) ?? (el.matches(FOCUSABLE) ? el : null));
  focus?.focus({ preventScroll: true });
}

/**
 * Go to a search result: select its node (the part, effect, mask, the layer — picking the first
 * letter for a Letters field — or the Document), open the sections on the way, then scroll to the
 * control, focus it and flash it. An "add effect" result adds the effect to the layer and lands
 * on its card.
 */
export function landOn(m: Match) {
  const st = useEditor.getState();
  if (isAdd(m)) {
    if (!m.def) {
      if (m.pinned === 'erode') addErode(m.layerId);
      else addGlint(m.layerId);
      void reveal(null, -1);
    } else if (st.addEffect({ layerId: m.layerId, part: null }, m.def.type)) void reveal(null, -1);
    return;
  }
  const { hit, pick } = m;
  const target = hit.slot.target;
  switch (target.kind) {
    case 'document':
      st.selectNode(null);
      break;
    case 'layer':
      st.selectNode({ kind: 'layer', layerId: target.layerId });
      if (hit.sections.some((k) => k.endsWith('/letters')) && !useEditor.getState().selectedChars.length) {
        const layer = st.project.layers.find((l) => l.id === target.layerId);
        const text = layer && 'source' in layer && layer.source.kind === 'text' ? layer.source.text : '';
        st.selectChars(firstLetter(text));
      }
      break;
    case 'multi':
      break;
    case 'part':
      st.selectNode({ kind: 'part', layerId: target.layerId, part: target.part });
      break;
    case 'effect':
      st.selectNode({ kind: 'effect', layerId: target.layerId, part: target.part, effectId: target.effectId });
      break;
    case 'mask':
      st.selectNode({ kind: 'mask', layerId: target.layerId, maskId: target.maskId });
      break;
    case 'glint':
    case 'erode':
      st.selectNode({ kind: target.kind, layerId: target.layerId });
      break;
    case 'companion':
      st.selectNode({ kind: 'layer', layerId: target.layerId });
      break;
  }
  const open = [...hit.slot.open, ...hit.sections];
  if (open.length) useSectionsOpen.setState(Object.fromEntries(open.map((k) => [k, true])));
  void reveal(hit, pick);
}

/** The first pickable (non-space) character of `text`, as a letter selection; none for blank text. */
export function firstLetter(text: string): number[] {
  const i = Array.from(text).findIndex((ch) => !/\s/.test(ch));
  return i < 0 ? [] : [i];
}

/** Id of the search field. */
export const FIND_INPUT_ID = 'props-find';

/** ⌘F: show Properties and focus its search field, its text selected. */
export function focusPropertySearch() {
  selectTab('properties');
  requestAnimationFrame(() => {
    const input = document.getElementById(FIND_INPUT_ID);
    if (input instanceof HTMLInputElement) {
      input.focus();
      input.select();
    }
  });
}
