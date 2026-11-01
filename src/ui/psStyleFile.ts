import type { PsStyleFile } from '../io/psStyle';
import { errorMsg, msg } from '../store/msg';
import { useEditor } from '../store/store';
import { pickFile } from './util';

/**
 * "Import PS style…" file step: picks a .psd / .asl and reads its layer styles. Errors are
 * notified here; null on cancel or error. The ag-psd reader is a lazy chunk kept out of first
 * paint (precached for offline use), so it loads on the first import.
 */
export async function pickPsStyleFile(): Promise<{ name: string; data: PsStyleFile } | null> {
  const f = await pickFile('.psd,.asl,image/vnd.adobe.photoshop');
  if (!f) return null;
  try {
    const { readPsStyles } = await import('../io/psStyle');
    return { name: f.name, data: await readPsStyles(f) };
  } catch (e) {
    useEditor.getState().notify(msg('{file}: {error}', { file: f.name, error: errorMsg(e) }), 'error');
    return null;
  }
}
