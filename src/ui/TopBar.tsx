import { lazy, Suspense, useRef, useState, type ReactNode } from 'react';
import type { PsStyleFile } from '../io/psStyle';
import { createProject } from '../model/defaults';
import { isTitleLayer } from '../model/parts';
import { titleForm } from '../store/arrange';
import { selectedLayer, useEditor, type PreviewRes, type ViewState } from '../store/store';
import { flipTargets } from '../store/transformOps';
import { focusDockTab } from './dock/layout';
import { useLang, useT } from './i18n';
import { openSplitImage, pasteClipboard } from './layerActions';
import { Loading } from './Loading';
import { openProjectFile, saveProjectFile } from './projectFile';
import { pickPsStyleFile } from './psStyleFile';
import { stepZoom, usePopover } from './util';

// Not needed for first paint: the export chunk carries ag-psd, the PSD writer and ZIP;
// the template chunk the template builds and their still renderer; the PS style dialog its preview.
const ExportDialog = lazy(() => import('./ExportDialog').then((m) => ({ default: m.ExportDialog })));
const TemplateGrid = lazy(() => import('./library/TemplateMenu').then((m) => ({ default: m.TemplateGrid })));
const PsStyleDialog = lazy(() => import('./PsStyleDialog').then((m) => ({ default: m.PsStyleDialog })));

/** Empty comp keeping only the default guide backdrop; nothing gets selected (see setProject). */
function newBlank() {
  void useEditor.getState().replaceProject(createProject(), 'New blank project', 'a blank project');
}

/**
 * A menu-bar menu: the button and its popover. `children` gets a `close` for the items;
 * `onOpen` runs as the button opens it.
 */
function BarMenu({ label, title, wide, onOpen, children }: { label: string; title: string; wide?: boolean; onOpen?: () => void; children: (close: () => void) => ReactNode }) {
  const anchor = useRef<HTMLDivElement>(null);
  const pop = usePopover(anchor, 'left');
  return (
    <div className="menu" ref={anchor}>
      <button
        className={`menu-btn bar-menu-btn ${pop.open ? 'active' : ''}`}
        aria-haspopup="true"
        aria-expanded={pop.open}
        title={title}
        onClick={() => {
          if (!pop.open) onOpen?.();
          pop.setOpen(!pop.open);
        }}
      >
        {label}
      </button>
      {pop.open && (
        <div className={`menu-pop bar-menu-pop ${wide ? 'new-pop' : ''}`} style={pop.style}>
          {children(() => pop.setOpen(false))}
        </div>
      )}
    </div>
  );
}

/** One menu command: label, its shortcut on the right, an optional ✓ and a second line. */
function MenuRow({ label, keys, hint, checked, disabled, onClick }: { label: string; keys?: string; hint?: string; checked?: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button className="menu-item" disabled={disabled} aria-checked={checked} role={checked === undefined ? undefined : 'menuitemcheckbox'} onClick={onClick}>
      <span className="mi-label mi-row">
        <span className="mi-check">{checked ? '✓' : ''}</span>
        <span className="mi-text">{label}</span>
        {keys && <kbd className="mi-key">{keys}</kbd>}
      </span>
      {hint && <span className="mi-hint">{hint}</span>}
    </button>
  );
}

/** File: New ▸ (blank / templates), Open, Save, Import PS style, Export. */
function FileMenu({ onExport }: { onExport: () => void }) {
  const t = useT();
  const [templates, setTemplates] = useState(false);
  const [psFile, setPsFile] = useState<{ name: string; data: PsStyleFile } | null>(null);
  return (
    <>
      <BarMenu label={t('File')} title={t('File: new, open, save, import a Photoshop style, export')} wide={templates} onOpen={() => setTemplates(false)}>
        {(close) =>
          templates ? (
            <>
              <button className="menu-item" title={t('Back to the File menu')} onClick={() => setTemplates(false)}>
                <span className="mi-label">‹ {t('New from template')}</span>
              </button>
              <Suspense fallback={<Loading />}>
                <TemplateGrid onPick={close} />
              </Suspense>
            </>
          ) : (
            <>
              <MenuRow
                label={t('New blank project')}
                hint={t('Empty comp, no layers (undoable)')}
                onClick={() => {
                  close();
                  newBlank();
                }}
              />
              <MenuRow label={t('New from template ▸')} hint={t('One of the ready-made pachislot titles')} onClick={() => setTemplates(true)} />
              <div className="menu-sep" />
              <MenuRow
                label={t('Open…')}
                keys="⌘O"
                hint={t('Open .pslot.json (⌘O)')}
                onClick={() => {
                  close();
                  void openProjectFile();
                }}
              />
              <MenuRow
                label={t('Save')}
                keys="⌘S"
                hint={t('Save .pslot.json (⌘S)')}
                onClick={() => {
                  close();
                  saveProjectFile();
                }}
              />
              <div className="menu-sep" />
              <MenuRow
                label={t('Import PS style…')}
                hint={t('Import the layer styles of a Photoshop .psd or .asl style library into My Styles')}
                onClick={() => {
                  close();
                  void pickPsStyleFile().then((f) => f && setPsFile(f));
                }}
              />
              <MenuRow
                label={t('Export…')}
                keys="⌘E"
                hint={t('Export PNG / batches / SVG (⌘E)')}
                onClick={() => {
                  close();
                  onExport();
                }}
              />
            </>
          )
        }
      </BarMenu>
      {psFile && (
        <Suspense fallback={<Loading modal />}>
          <PsStyleDialog fileName={psFile.name} data={psFile.data} onClose={() => setPsFile(null)} />
        </Suspense>
      )}
    </>
  );
}

/** Edit: Undo, Redo, Paste (as 3D) an image / SVG, Copy / Paste layer style, Transform ▸ Flip, Split image. */
function EditMenu() {
  const t = useT();
  const [transform, setTransform] = useState(false);
  const canUndo = useEditor((s) => s.past.length > 0);
  const canRedo = useEditor((s) => s.future.length > 0);
  const layer = useEditor(selectedLayer);
  const canPaste = useEditor((s) => s.styleClip !== null && s.selectedLayerIds.length > 0);
  const canFlip = useEditor((s) => flipTargets(s.project.layers, s.selectedLayerIds).length > 0);
  const { undo, redo, copyStyle, pasteStyle, flipLayers } = useEditor.getState();
  return (
    <BarMenu label={t('Edit')} title={t('Edit: undo, redo, paste images, copy / paste layer style, flip')} onOpen={() => setTransform(false)}>
      {(close) =>
        transform ? (
          <>
            <button className="menu-item" title={t('Back to the Edit menu')} onClick={() => setTransform(false)}>
              <span className="mi-label">‹ {t('Transform')}</span>
            </button>
            <MenuRow
              label={t('Flip Horizontal')}
              hint={t('Mirror the selected layers left ↔ right in place')}
              disabled={!canFlip}
              onClick={() => {
                close();
                flipLayers(useEditor.getState().selectedLayerIds, 'x');
              }}
            />
            <MenuRow
              label={t('Flip Vertical')}
              hint={t('Mirror the selected layers top ↔ bottom in place')}
              disabled={!canFlip}
              onClick={() => {
                close();
                flipLayers(useEditor.getState().selectedLayerIds, 'y');
              }}
            />
          </>
        ) : (
          <>
            <MenuRow
              label={t('Undo')}
              keys="⌘Z"
              disabled={!canUndo}
              onClick={() => {
                close();
                undo();
              }}
            />
            <MenuRow
              label={t('Redo')}
              keys="⇧⌘Z"
              disabled={!canRedo}
              onClick={() => {
                close();
                redo();
              }}
            />
            <div className="menu-sep" />
            <MenuRow
              label={t('Paste')}
              keys="⌘V"
              hint={t('An image or SVG on the clipboard, as a new 2D layer at its own pixel size')}
              onClick={() => {
                close();
                void pasteClipboard('2d');
              }}
            />
            <MenuRow
              label={t('Paste as 3D')}
              keys="⌥⇧⌘V"
              hint={t('An image or SVG on the clipboard, as an extruded 3D layer showing the picture on its face')}
              onClick={() => {
                close();
                void pasteClipboard('3d');
              }}
            />
            <div className="menu-sep" />
            <MenuRow
              label={t('Copy layer style')}
              keys="⌥⌘C"
              disabled={!isTitleLayer(layer)}
              onClick={() => {
                close();
                if (layer) copyStyle(layer.id);
              }}
            />
            <MenuRow
              label={t('Paste layer style')}
              keys="⌥⌘V"
              hint={t('Onto every selected layer of the same kind')}
              disabled={!canPaste}
              onClick={() => {
                close();
                pasteStyle(useEditor.getState().selectedLayerIds);
              }}
            />
            <div className="menu-sep" />
            <MenuRow label={t('Transform ▸')} hint={t('Flip the selected layers horizontally or vertically')} onClick={() => setTransform(true)} />
            <div className="menu-sep" />
            <MenuRow
              label={t('Split image…')}
              hint={t('Cut the picture into its parts (a logo and its word…): one layer each, in a group, each taking its own extrude and style')}
              disabled={!isTitleLayer(layer) || layer.source.kind !== 'image'}
              onClick={() => {
                close();
                if (layer) openSplitImage(layer.id);
              }}
            />
          </>
        )
      }
    </BarMenu>
  );
}

const RES: { v: PreviewRes; label: string; title: string }[] = [
  { v: 1, label: 'Full', title: 'Preview at full comp resolution' },
  { v: 0.5, label: '½', title: 'Preview at half resolution (faster)' },
  { v: 0.25, label: '¼', title: 'Preview at quarter resolution (fastest)' },
];

/** View: zoom, preview resolution, CMYK gamut warning. */
function ViewMenu() {
  const t = useT();
  const zoom = useEditor((s) => s.view.zoom);
  const res = useEditor((s) => s.view.previewRes);
  const gamut = useEditor((s) => s.view.gamut);
  const setView = useEditor((s) => s.setView);
  return (
    <BarMenu label={t('View')} title={t('View: zoom, preview resolution, CMYK gamut warning')}>
      {(close) => {
        const apply = (patch: Partial<ViewState>) => {
          close();
          setView(patch);
        };
        return (
          <>
            <MenuRow label={t('Zoom in')} keys="⌘=" onClick={() => stepZoom(1)} />
            <MenuRow label={t('Zoom out')} keys="⌘-" onClick={() => stepZoom(-1)} />
            <MenuRow label={t('Fit comp in view')} keys="⌘0" checked={zoom === 'fit'} onClick={() => apply({ zoom: 'fit', panX: 0, panY: 0 })} />
            <MenuRow label="100%" keys="⌘1" checked={zoom === 1} onClick={() => apply({ zoom: 1, panX: 0, panY: 0 })} />
            <div className="menu-group">{t('Preview resolution (export always renders at full quality)')}</div>
            {RES.map((r) => (
              <MenuRow key={r.v} label={r.v === 1 ? t(r.label) : r.label} hint={t(r.title)} checked={res === r.v} onClick={() => apply({ previewRes: r.v })} />
            ))}
            <div className="menu-sep" />
            <MenuRow
              label={t('CMYK gamut warning')}
              keys="⇧⌘Y"
              hint={t("Hatch colours the active CMYK ICC profile can't print (soft proof, relative colorimetric)")}
              checked={gamut}
              onClick={() => apply({ gamut: !gamut })}
            />
          </>
        );
      }}
    </BarMenu>
  );
}

/**
 * Inline “rename the project after the new title?” prompt, offered once after the text the
 * project is named after was retyped (store.renameOffer). Shows only while the proposed name
 * differs from the current one.
 */
function RenameOffer() {
  const proposed = useEditor((s) => {
    const o = s.renameOffer;
    const l = o && s.project.layers.find((x) => x.id === o.layerId);
    const name = o && isTitleLayer(l) && l.source.kind === 'text' ? titleForm(l.source.text, o.whole) : '';
    return name && name !== s.project.name ? name : null;
  });
  const settle = useEditor((s) => s.settleRenameOffer);
  const t = useT();
  if (!proposed) return null;
  const [before, after] = t('Rename project to “{name}”?').split('{name}');
  return (
    <span className="rename-offer" role="group" aria-label={t('Rename project')}>
      <span className="ellipsis" title={t('Rename project to “{name}”?', { name: proposed })}>
        {before}
        <b>{proposed}</b>
        {after}
      </span>
      <button className="small primary" title={t('Name the project “{name}” (also the save / export file name)', { name: proposed })} onClick={() => settle(true)}>
        {t('Rename')}
      </button>
      <button className="small" title={t('Keep the current project name (not asked again for this project)')} onClick={() => settle(false)}>
        {t('Keep')}
      </button>
    </span>
  );
}

/** JP / EN switch for the whole UI (persisted by useLang); the active language is highlighted. */
function LangToggle() {
  const lang = useLang((s) => s.lang);
  const t = useT();
  const next = lang === 'ja' ? 'en' : 'ja';
  return (
    <button
      className="lang-toggle right"
      onClick={() => useLang.getState().setLang(next)}
      title={t('Interface language: 日本語 / English (click to switch)')}
      aria-label={next === 'ja' ? t('Switch the interface to Japanese') : t('Switch the interface to English')}
    >
      <span className={lang === 'ja' ? 'on' : ''}>JP</span>/<span className={lang === 'en' ? 'on' : ''}>EN</span>
    </button>
  );
}

/** Opens the export dialog when `exportOpen` is set (also from Cmd/Ctrl+E); `onHelp` toggles the shortcut sheet. */
export function TopBar({ exportOpen, setExportOpen, onHelp }: { exportOpen: boolean; setExportOpen: (o: boolean) => void; onHelp: () => void }) {
  const name = useEditor((s) => s.project.name);
  const comp = useEditor((s) => s.project.comp);
  const canUndo = useEditor((s) => s.past.length > 0);
  const canRedo = useEditor((s) => s.future.length > 0);
  const { edit, undo, redo } = useEditor.getState();
  const t = useT();
  const [nameKey, setNameKey] = useState(0);
  return (
    <header className="topbar">
      <span className="logo" aria-label="Pachislop">
        <svg className="logo-mark" viewBox="0 0 18 18" aria-hidden="true">
          <defs>
            <radialGradient id="logo-ball" cx="0.35" cy="0.3" r="0.75">
              <stop offset="0" stopColor="#ffffff" />
              <stop offset="0.25" stopColor="#e9edf3" />
              <stop offset="0.7" stopColor="#8d96a6" />
              <stop offset="1" stopColor="#3a404c" />
            </radialGradient>
          </defs>
          <circle cx="9" cy="9" r="8.5" fill="url(#logo-ball)" />
          <ellipse cx="6.3" cy="5.6" rx="2.4" ry="1.5" fill="#fff" opacity="0.9" />
        </svg>
        <span aria-hidden="true">
          PACHI<span className="logo-sub">SLOP</span>
        </span>
      </span>
      <nav className="bar-menus" aria-label={t('Menu bar')}>
        <FileMenu onExport={() => setExportOpen(true)} />
        <EditMenu />
        <ViewMenu />
      </nav>
      <span className="sep" />
      <input
        className="project-name"
        value={name}
        title={t('Project name (also the default export file name)')}
        aria-label={t('Project name')}
        onFocus={() => setNameKey(performance.now())}
        onChange={(e) => {
          // Naming it by hand answers the rename offer.
          if (useEditor.getState().renameOffer) useEditor.getState().settleRenameOffer(false);
          edit((p) => ({ ...p, name: e.target.value }), `project-name:${nameKey}`, 'Rename project');
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
      />
      <RenameOffer />
      <button disabled={!canUndo} onClick={undo} title={t('Undo (⌘Z)')} aria-label={t('Undo')}>
        ↶
      </button>
      <button disabled={!canRedo} onClick={redo} title={t('Redo (⇧⌘Z)')} aria-label={t('Redo')}>
        ↷
      </button>
      <span className="sep" />
      <button
        onClick={() => {
          // Properties shows the Document (comp settings) when nothing is selected.
          useEditor.getState().selectNode(null);
          focusDockTab('properties');
        }}
        title={t('Document settings in Properties: size, background, camera, environment, lights (deselects all)')}
      >
        {t(comp.background.transparent ? 'Comp {w}×{h} · transparent' : 'Comp {w}×{h}', { w: comp.width, h: comp.height })}
      </button>
      <LangToggle />
      <button onClick={onHelp} title={t('Keyboard shortcuts (?)')} aria-label={t('Keyboard shortcuts')}>
        ?
      </button>
      <button className="primary" onClick={() => setExportOpen(true)} title={t('Export PNG / batches / SVG (⌘E)')}>
        {t('Export…')}
      </button>
      {exportOpen && (
        <Suspense fallback={<Loading modal />}>
          <ExportDialog onClose={() => setExportOpen(false)} />
        </Suspense>
      )}
    </header>
  );
}
