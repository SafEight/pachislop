import { jaOf } from '../i18n';
import { norm } from '../properties/searchIndex';

// The Library's search: a tile matches when every word of the query is found in its search text
// (its name, section and 2D / 3D, as written and in Japanese), with Properties' folding: case,
// full- / half-width and katakana / hiragana.

/** Id of the Library's search field. */
export const LIB_FIND_INPUT_ID = 'lib-find';

/** The words of `query`, folded; none for a blank query. */
export function queryWords(query: string): string[] {
  const q = norm(query);
  return q ? q.split(' ') : [];
}

/** Search text of a tile described by `texts`: each text as written and its Japanese, folded. */
export function searchText(texts: readonly string[]): string {
  return texts.flatMap((s) => [s, jaOf(s) ?? '']).map(norm).join('\n');
}

/** ⌘F while the Library shows: focus its search field, its text selected. */
export function focusLibrarySearch() {
  const input = document.getElementById(LIB_FIND_INPUT_ID);
  if (input instanceof HTMLInputElement) {
    input.focus();
    input.select();
  }
}
