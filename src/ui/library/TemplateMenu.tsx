import { useEffect, useSyncExternalStore } from 'react';
import { Engine } from '../../engine/Engine';
import { prepareRender } from '../../io/export';
import { TEMPLATES } from '../../presets/templates';
import type { Template } from '../../presets/types';
import { errorMsg, msg } from '../../store/msg';
import { useEditor } from '../../store/store';
import { useT } from '../i18n';

// Template picker: a grid of small stills of every template's own build. Each still is
// rendered once per session by a DEDICATED offscreen Engine (sharing the viewport engine
// would dispose the live layers' renderers, see library/thumbs.ts), one per macrotask so the
// UI stays responsive; the engine is released once the queue is empty.

/** Tile image box, CSS px (16:9; portrait comps are letterboxed). */
const TILE_W = 200;
const TILE_H = 113;

/** Object URL per template id; null = the render failed. */
const stills = new Map<string, string | null>();
const pending: Template[] = [];
const listeners = new Set<() => void>();
let version = 0;
let pumping = false;

const thumbStore = {
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  getVersion: () => version,
};

async function renderStill(engine: Engine, t: Template): Promise<string> {
  const project = t.build();
  await prepareRender(engine, project, true);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const { width, height } = project.comp;
  const scale = Math.min(TILE_W / width, TILE_H / height) * dpr;
  const img = engine.renderImageData(project, { scale, includeGuides: true });
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  canvas.getContext('2d')!.putImageData(img, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('PNG encoding failed');
  return URL.createObjectURL(blob);
}

async function pump() {
  if (pumping) return;
  pumping = true;
  const engine = new Engine(document.createElement('canvas'));
  try {
    for (let t = pending.shift(); t; t = pending.shift()) {
      if (stills.has(t.id)) continue;
      let url: string | null = null;
      try {
        url = await renderStill(engine, t);
      } catch (e) {
        console.warn(`Template still “${t.name}” failed`, e);
      }
      stills.set(t.id, url);
      version++;
      for (const l of listeners) l();
      await new Promise((r) => setTimeout(r, 0));
    }
  } finally {
    engine.dispose();
    pumping = false;
  }
}

/** Queue stills for every template not rendered yet. */
function requestStills() {
  for (const t of TEMPLATES) if (!stills.has(t.id) && !pending.includes(t)) pending.push(t);
  void pump();
}

/** Replace the project with template `t` (in-app confirmation; undoable). */
async function applyTemplate(t: Template) {
  const st = useEditor.getState();
  try {
    if (await st.replaceProject(t.build(), msg('Template “{name}”', { name: t.name }), msg('the “{name}” template', { name: t.name }))) st.notify(msg('New project from “{name}”', { name: t.name }));
  } catch (e) {
    st.notify(msg('Template “{name}” failed: {error}', { name: t.name, error: errorMsg(e) }), 'error');
  }
}

/** Thumbnail grid of all templates; `onPick` runs before the (possibly confirmed) replacement. */
export function TemplateGrid({ onPick }: { onPick?: () => void }) {
  useSyncExternalStore(thumbStore.subscribe, thumbStore.getVersion);
  useEffect(requestStills, []);
  const t = useT();
  return (
    <div className="template-grid" role="list" aria-label={t('Templates')}>
      {TEMPLATES.map((tpl) => {
        const url = stills.get(tpl.id);
        return (
          <button
            key={tpl.id}
            role="listitem"
            className="template-tile"
            title={t('New project from “{name}” (replaces the current one; ⌘Z brings it back)', { name: tpl.name })}
            aria-label={t('New project from “{name}” (replaces the current one; ⌘Z brings it back)', { name: tpl.name })}
            onClick={() => {
              onPick?.();
              void applyTemplate(tpl);
            }}
          >
            <span className="template-img checker">
              {url ? <img src={url} alt="" draggable={false} /> : <span className="muted">{url === null ? t('preview failed') : t('rendering…')}</span>}
            </span>
            <span className="template-name">{tpl.name}</span>
          </button>
        );
      })}
    </div>
  );
}

/** The template grid as a dialog (empty-canvas card ▸ Start from template). */
export function TemplateDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Capture + stopImmediatePropagation: Esc closes the dialog without also deselecting underneath.
      if (e.key !== 'Escape' || useEditor.getState().confirmation) return;
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <div className="modal-back" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal template-dialog" role="dialog" aria-label={t('Start from a template')}>
        <div className="modal-head">
          {t('Start from a template')}
          <button className="right" onClick={onClose} title={t('Close (Esc)')} aria-label={t('Close')}>
            ✕
          </button>
        </div>
        <div className="scroll">
          <TemplateGrid onPick={onClose} />
        </div>
      </div>
    </div>
  );
}
