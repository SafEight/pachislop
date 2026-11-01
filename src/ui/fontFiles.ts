import { registerFont } from '../assets/registry';
import { errorMsg, msg } from '../store/msg';
import { useEditor } from '../store/store';

// Adding user fonts (upload in FontBrowser, LocalFontDialog): validation and registration.

/** Validate container format; opentype.js parses TTF/OTF only. Returns an English message key. */
function checkFontData(data: ArrayBuffer): string | null {
  const tag = new TextDecoder('latin1').decode(data.slice(0, 4));
  if (tag === 'wOF2') return 'WOFF2 fonts are not supported (no outline parser). Convert to .ttf/.otf first.';
  if (tag === 'wOFF') return 'WOFF fonts are not supported. Convert to .ttf/.otf first.';
  if (tag === 'ttcf') return 'Font collections (.ttc) are not supported. Extract a single .ttf/.otf first.';
  const ok = tag === 'OTTO' || tag === 'true' || tag === 'typ1' || (data.byteLength > 4 && new DataView(data).getUint32(0) === 0x00010000);
  return ok ? null : 'Unrecognised font format (expected .ttf or .otf).';
}

/** Validates and registers a user font, notifying the outcome; resolves with its id, or null when it failed. */
export async function installFont(id: string, name: string, data: ArrayBuffer): Promise<string | null> {
  const st = useEditor.getState();
  const err = checkFontData(data);
  if (err) {
    st.notify(msg('{name}: {error}', { name, error: msg(err) }), 'error');
    return null;
  }
  try {
    const f = await registerFont(id, name, data);
    st.notify(msg('Font “{name}” added', { name: f.name }));
    return f.id;
  } catch (e) {
    st.notify(msg('{name}: could not parse font ({error})', { name, error: errorMsg(e) }), 'error');
    return null;
  }
}

/** Lower-case ASCII id fragment of a font or file name. */
export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
