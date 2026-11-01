import { useEffect, useMemo, useState } from 'react';
import { installFont, slug } from './fontFiles';
import { useT } from './i18n';

// "Local fonts…" in the font browser: lists the fonts installed on this computer (Local Font
// Access API, Chrome / Edge) and adds the picked one. Loaded on demand by FontBrowser.

interface LocalFontData {
  family: string;
  fullName: string;
  postscriptName: string;
  style: string;
  blob(): Promise<Blob>;
}
type QueryLocalFonts = () => Promise<LocalFontData[]>;

// Local Font Access API is untyped in lib.dom; must be called bound to window.
const queryLocalFonts: QueryLocalFonts | undefined =
  'queryLocalFonts' in window ? (window.queryLocalFonts as QueryLocalFonts).bind(window) : undefined;

export function LocalFontDialog({ onPick, onClose }: { onPick: (id: string) => void; onClose: () => void }) {
  const [fonts, setFonts] = useState<LocalFontData[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const t = useT();
  useEffect(() => {
    queryLocalFonts!()
      .then(setFonts)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  const shown = useMemo(() => {
    const ql = q.toLowerCase();
    return (fonts ?? []).filter((f) => f.fullName.toLowerCase().includes(ql) || f.family.toLowerCase().includes(ql)).slice(0, 300);
  }, [fonts, q]);
  return (
    <div className="modal-back" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal font-dialog" onKeyDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>{t('Add local font')}</span>
          <button className="icon-btn right" onClick={onClose} title={t('Close')} aria-label={t('Close')}>
            ✕
          </button>
        </div>
        <input autoFocus placeholder={t('Search…')} value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="font-list">
          {error && <div className="error">{t('Local fonts unavailable: {error}', { error })}</div>}
          {!fonts && !error && <div className="muted">{t('Requesting permission…')}</div>}
          {shown.map((f) => (
            <button
              key={f.postscriptName}
              className="font-item"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const data = await (await f.blob()).arrayBuffer();
                  const id = await installFont(`local-${slug(f.postscriptName)}`, f.fullName, data);
                  if (id) {
                    onPick(id);
                    onClose();
                  }
                } finally {
                  setBusy(false);
                }
              }}
            >
              <span>{f.fullName}</span>
              <span className="muted">{f.style}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

