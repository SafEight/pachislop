import { lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { BUILTIN_FONTS, ensureFont, listFonts, registry, type FontCategory } from '../assets/registry';
import { isTitleLayer } from '../model/parts';
import { selectedLayer, useEditor } from '../store/store';
import { installFont, slug } from './fontFiles';
import { useT } from './i18n';
import { Loading } from './Loading';
import { pickFile, usePopover } from './util';

// Font browser: bundled fonts grouped by category, each name drawn in its own face (CSS
// family = font id, registered by the registry once loaded), plus uploaded and local fonts.
// Hovering an entry previews it on the layer (onHover).

/** Local Font Access API (Chrome / Edge); the dialog listing the local fonts loads on first use. */
const hasLocalFonts = 'queryLocalFonts' in window;
const LocalFontDialog = lazy(() => import('./LocalFontDialog').then((m) => ({ default: m.LocalFontDialog })));

/** Category headings (English keys, translated where shown). */
const CATEGORY_LABEL: Record<FontCategory, string> = {
  gothic: 'Gothic (ゴシック)',
  mincho: 'Mincho (明朝)',
  brush: 'Brush (筆)',
  display: 'Display',
  pop: 'Pop (ポップ)',
  user: 'Your fonts',
};
const CATEGORY_ORDER: FontCategory[] = ['gothic', 'mincho', 'brush', 'display', 'pop', 'user'];
/** Preview text when the selected layer has no text of its own. */
const SAMPLE = '確定 激アツ BIG';
/** Longest preview, in code points: enough to judge the face without overflowing the row. */
const SAMPLE_MAX = 24;

/** The selected text layer's own text on one line (lines joined by spaces), else SAMPLE. */
function useSample(): string {
  const text = useEditor((s) => {
    const l = selectedLayer(s);
    return isTitleLayer(l) && l.source.kind === 'text' ? l.source.text : '';
  });
  const line = text.replace(/\s+/g, ' ').trim();
  if (!line) return SAMPLE;
  const cps = Array.from(line);
  return cps.length > SAMPLE_MAX ? `${cps.slice(0, SAMPLE_MAX).join('')}…` : line;
}

export function FontBrowser({ value, onChange, onHover }: { value: string; onChange: (id: string) => void; onHover?: (id: string | null) => void }) {
  useSyncExternalStore(registry.subscribe, registry.getVersion);
  const sample = useSample();
  const anchor = useRef<HTMLDivElement>(null);
  const pop = usePopover(anchor, 'left');
  const [localOpen, setLocalOpen] = useState(false);
  const t = useT();
  const loaded = listFonts();
  const loadedIds = new Set(loaded.map((f) => f.id));
  const entries = [
    ...BUILTIN_FONTS.map((f) => ({ id: f.id, name: f.name, category: f.category })),
    ...loaded.filter((f) => !f.builtin).map((f) => ({ id: f.id, name: f.name, category: 'user' as const })),
  ];
  const current = entries.find((f) => f.id === value);

  useEffect(() => {
    if (pop.open) for (const f of BUILTIN_FONTS) void ensureFont(f.id);
  }, [pop.open]);

  const close = () => {
    onHover?.(null);
    pop.setOpen(false);
  };

  return (
    <div className="font-browser" ref={anchor}>
      <button className="font-current" onClick={() => (pop.open ? close() : pop.setOpen(true))} style={{ fontFamily: `"${value}", system-ui` }}>
        <span className="ellipsis">{current?.name ?? t('{font} (missing)', { font: value })}</span>
        <span className="muted">▾</span>
      </button>
      {pop.open && (
        <div className="menu-pop font-pop" style={pop.style} onPointerLeave={() => onHover?.(null)}>
          {CATEGORY_ORDER.map((cat) => {
            const list = entries.filter((f) => f.category === cat);
            if (list.length === 0) return null;
            return (
              <div key={cat}>
                <div className="menu-group">{t(CATEGORY_LABEL[cat])}</div>
                {list.map((f) => (
                  <button
                    key={f.id}
                    className={`font-entry ${f.id === value ? 'sel' : ''}`}
                    onPointerEnter={() => {
                      void ensureFont(f.id);
                      onHover?.(f.id);
                    }}
                    onClick={() => {
                      close();
                      if (f.id !== value) onChange(f.id);
                    }}
                  >
                    <span className="font-name" style={{ fontFamily: `"${f.id}", system-ui` }}>
                      {f.name}
                    </span>
                    <span className="font-sample" style={{ fontFamily: `"${f.id}", system-ui`, opacity: loadedIds.has(f.id) ? 1 : 0.3 }}>
                      {loadedIds.has(f.id) ? sample : t('loading…')}
                    </span>
                  </button>
                ))}
              </div>
            );
          })}
          <div className="font-actions">
            <button
              onClick={async () => {
                close();
                const file = await pickFile('.ttf,.otf,font/ttf,font/otf');
                if (!file) return;
                const id = await installFont(`user-${slug(file.name)}-${Date.now().toString(36)}`, file.name.replace(/\.[^.]+$/, ''), await file.arrayBuffer());
                if (id) onChange(id);
              }}
            >
              {t('Upload .ttf/.otf…')}
            </button>
            <button
              disabled={!hasLocalFonts}
              title={hasLocalFonts ? t('Use a font installed on this computer') : t('Local Font Access needs Chrome/Edge')}
              onClick={() => {
                close();
                setLocalOpen(true);
              }}
            >
              {t('Local fonts…')}
            </button>
          </div>
        </div>
      )}
      {localOpen && (
        <Suspense fallback={<Loading modal />}>
          <LocalFontDialog onPick={onChange} onClose={() => setLocalOpen(false)} />
        </Suspense>
      )}
    </div>
  );
}
