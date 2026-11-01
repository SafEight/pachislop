import { compensateV4CharScale } from '../io/migrateText';
import { charScaleNote, installBundle, parseProjectFile, PROJECT_EXT, safeFileName, serializeProject } from '../io/project';
import { errorMsg, joinMsgs, msg, verbatim } from '../store/msg';
import { useEditor } from '../store/store';
import { downloadBlob, pickFile } from './util';

/** Download the current project as a self-contained `.pslot.json`. */
export function saveProjectFile() {
  const { project, notify } = useEditor.getState();
  const blob = new Blob([serializeProject(project)], { type: 'application/json' });
  const name = `${safeFileName(project.name)}${PROJECT_EXT}`;
  downloadBlob(blob, name);
  notify(msg('Saved {file}', { file: name }));
}

/**
 * Pick a `.pslot.json`, register its fonts/assets and load it in place of the current project
 * (in-app confirmation; undo brings the previous project back). v4 / v5 files are upgraded by
 * the io migration, whose notes are shown.
 */
export async function openProjectFile() {
  const st = useEditor.getState();
  const file = await pickFile(`${PROJECT_EXT},.json,application/json`);
  if (!file) return;
  try {
    const bundle = parseProjectFile(await file.text());
    // Fonts / assets first so the project renders complete the moment it appears (unused ones are
    // never saved), and so the v4 char-scale compensation can measure with them.
    const errors = await installBundle(bundle);
    const project = await compensateV4CharScale(bundle.project, bundle.version === 4);
    const notes = project !== bundle.project ? [...bundle.notes, charScaleNote] : bundle.notes;
    if (!(await st.replaceProject(project, msg('Open {file}', { file: file.name }), verbatim(file.name)))) return;
    if (errors.length) st.notify(joinMsgs([...notes, ...errors], '; '), 'error');
    else st.notify(joinMsgs([msg('Opened {file}', { file: file.name }), ...notes], ' — '));
  } catch (e) {
    st.notify(msg('Could not open {file}: {error}', { file: file.name, error: errorMsg(e) }), 'error');
  }
}
