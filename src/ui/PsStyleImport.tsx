import { lazy, Suspense, useState } from 'react';
import type { PsStyleFile } from '../io/psStyle';
import { useT } from './i18n';
import { Loading } from './Loading';
import { pickPsStyleFile } from './psStyleFile';

// "Import PS style…": reads the layer styles of a .psd / .asl, lets the user confirm the size
// each style was designed for (px → % of size), and adds the chosen ones to My Styles. The
// ag-psd reader and the dialog load on the first import, not with the library panel.

const PsStyleDialog = lazy(() => import('./PsStyleDialog').then((m) => ({ default: m.PsStyleDialog })));

/** The library-header button; opens the import dialog once a file has been read. */
export function PsStyleImportButton() {
  const t = useT();
  const [file, setFile] = useState<{ name: string; data: PsStyleFile } | null>(null);
  const pick = async () => {
    const picked = await pickPsStyleFile();
    if (picked) setFile(picked);
  };
  return (
    <>
      <button className="small" title={t('Import the layer styles of a Photoshop .psd or .asl style library into My Styles')} onClick={() => void pick()}>
        {t('Import PS style…')}
      </button>
      {file && (
        <Suspense fallback={<Loading modal />}>
          <PsStyleDialog fileName={file.name} data={file.data} onClose={() => setFile(null)} />
        </Suspense>
      )}
    </>
  );
}
