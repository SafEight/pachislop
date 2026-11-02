import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { loadBuiltinFonts } from './assets/registry';
import { loadAutosave, startAutosave } from './io/autosave';
import { isTitleLayer } from './model/parts';
import { formatMsg, joinMsgs, msg } from './store/msg';
import { ownerNode } from './store/selection';
import { selectedLayer, useEditor, type ArrangeOp } from './store/store';
import { ancestorsOf } from './store/tree';
import { Menu } from './ui/controls';
import { Dock } from './ui/dock/Dock';
import { useDock } from './ui/dock/layout';
import { deleteGlint } from './ui/glint';
import { tr, useT } from './ui/i18n';
import { addTextLayer, clipboardFiles, closeSplitImage, draggingFiles, importFiles, pasteClipboard, shapeItems, useSplitImage } from './ui/layerActions';
import { Loading } from './ui/Loading';
import { OptionsBar } from './ui/OptionsBar';
import { openProjectFile, saveProjectFile } from './ui/projectFile';
import { Toolbar } from './ui/Toolbar';
import { TopBar } from './ui/TopBar';
import { isTyping, oneShot, setSpaceHand, stepZoom, TOOLS } from './ui/util';
import { Viewport } from './ui/Viewport';
import { focusPropertySearch } from './ui/properties/searchIndex';
import { focusLibrarySearch } from './ui/library/search';

// Dialogs opened on demand (?, Start from template…) load on first use.
const ShortcutSheet = lazy(() => import('./ui/ShortcutSheet').then((m) => ({ default: m.ShortcutSheet })));
const TemplateDialog = lazy(() => import('./ui/library/TemplateMenu').then((m) => ({ default: m.TemplateDialog })));
const SplitImageDialog = lazy(() => import('./ui/SplitImageDialog').then((m) => ({ default: m.SplitImageDialog })));

/**
 * Global shortcuts, Photoshop habits (the full list is the "?" sheet, ShortcutSheet.tsx).
 * ⌘D deselects as in PS; ⌘J duplicates. Arrows are left to the Viewport while glyphs are picked;
 * panels that own keys (Layers, dock tabs, the tool strip) stop them before they get here.
 */
function useShortcuts(setExportOpen: (open: boolean) => void, toggleSheet: () => void) {
  useEffect(() => {
    let nudgeKey = '';
    let nudgeAt = 0;
    // Space on a control focused from the keyboard presses it; on one a click just focused
    // (a tool button, a checkbox) it is the Hand tool, as in Photoshop. :focus-visible can't tell
    // them apart: Chrome turns it on for the focused control at the Space keydown itself.
    let pressing = false;
    let clickFocused: EventTarget | null = null;
    // Capture phase: panels that own keys stop them before the bubbling handler below.
    const onAnyKey = () => {
      pressing = false;
    };
    // The canvas takes no focus (a click on it leaves it where it was, e.g. in the Layers panel), so
    // ⌘F also counts as "on the canvas" after a press there.
    let canvasPressed = false;
    const onPointerDown = (e: PointerEvent) => {
      pressing = true;
      canvasPressed = e.target instanceof Element && !!e.target.closest('.viewport');
    };
    const onFocusIn = (e: FocusEvent) => {
      clickFocused = pressing ? e.target : null;
    };
    const onKey = (e: KeyboardEvent) => {
      const st = useEditor.getState();
      // An open confirmation owns the keyboard (ConfirmDialog); so does any modal dialog
      // (export, templates, PS style import, the ? sheet): the comp underneath stays untouched.
      if (st.confirmation || document.querySelector('.modal-back')) return;
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (mod && k === 'z') {
        if (isTyping(e.target)) return;
        e.preventDefault();
        if (e.shiftKey) st.redo();
        else st.undo();
        return;
      }
      if (mod && k === 'y') {
        e.preventDefault();
        // ⇧⌘Y: Photoshop's gamut warning; ⌘Y: redo.
        if (e.shiftKey) st.setView({ gamut: !st.view.gamut });
        else st.redo();
        return;
      }
      if (mod && k === 's') {
        e.preventDefault();
        saveProjectFile();
        return;
      }
      if (mod && k === 'o') {
        e.preventDefault();
        void openProjectFile();
        return;
      }
      if (mod && k === 'e') {
        e.preventDefault();
        setExportOpen(true);
        return;
      }
      // View zoom works even while a field has focus (PS does too); e.code because ⇧ / layouts change e.key.
      if (mod && !e.altKey && (e.code === 'Digit0' || e.code === 'Digit1' || e.code === 'Numpad0' || e.code === 'Numpad1')) {
        e.preventDefault();
        st.setView({ zoom: e.code.endsWith('0') ? 'fit' : 1, panX: 0, panY: 0 });
        return;
      }
      if (mod && !e.altKey && (e.code === 'Equal' || e.code === 'NumpadAdd' || e.code === 'Minus' || e.code === 'NumpadSubtract')) {
        e.preventDefault();
        stepZoom(e.code === 'Equal' || e.code === 'NumpadAdd' ? 1 : -1);
        return;
      }
      if (isTyping(e.target)) return;
      // ⌘F: find a setting in Properties — or a style in the Library while its tab is the one
      // showing — from the canvas (last pressed, or nothing focused) or that panel; anywhere else,
      // and in a text field (returned above), the browser's find stays.
      if (mod && !e.altKey && !e.shiftKey && e.code === 'KeyF') {
        const el = e.target instanceof Element ? e.target : null;
        if (!canvasPressed && el !== document.body && !el?.closest('.viewport, .panel.properties, #dock-panel-properties, #dock-panel-library')) return;
        e.preventDefault();
        const { active, collapsed } = useDock.getState();
        if (active.top === 'library' && !collapsed.top) focusLibrarySearch();
        else focusPropertySearch();
        return;
      }
      const layer = selectedLayer(st);
      const ids = st.selectedLayerIds;
      // ⌥⇧⌘V: Edit ▸ Paste as 3D (⌘V itself is the paste event below).
      if (mod && e.altKey && e.shiftKey && e.code === 'KeyV') {
        e.preventDefault();
        void pasteClipboard('3d');
        return;
      }
      // ⌘⌥C / ⌘⌥V: copy / paste layer style. e.code because Option changes e.key on macOS (ç, √).
      if (mod && e.altKey && (e.code === 'KeyC' || e.code === 'KeyV')) {
        e.preventDefault();
        if (!layer) return;
        if (e.code === 'KeyC') st.copyStyle(layer.id);
        else st.pasteStyle(ids);
        return;
      }
      // ⌥⌘G: Create / Release Clipping Mask on the selection (before ⌘G, which Ctrl+Alt+G also spells).
      if (mod && e.altKey && e.code === 'KeyG') {
        e.preventDefault();
        st.toggleClip();
        return;
      }
      // ⇧⌘N: new layer, a text layer of the Type tool's kind, ready to type.
      if (mod && e.shiftKey && e.code === 'KeyN') {
        e.preventDefault();
        addTextLayer(st.view.textKind);
        return;
      }
      if (mod && (e.code === 'BracketLeft' || e.code === 'BracketRight')) {
        e.preventDefault();
        const up = e.code === 'BracketRight';
        const op: ArrangeOp = e.shiftKey ? (up ? 'front' : 'back') : up ? 'forward' : 'backward';
        st.arrangeLayers(ids, op);
        return;
      }
      if (mod && k === 'j') {
        e.preventDefault();
        st.duplicateLayers(ids);
        return;
      }
      if (mod && k === 'g') {
        e.preventDefault();
        if (e.shiftKey) st.ungroupLayers(ids);
        else st.groupLayers(ids);
        return;
      }
      if (mod && k === 'd') {
        e.preventDefault();
        st.selectNode(null);
        return;
      }
      if (mod && k === 'a') {
        e.preventDefault();
        st.selectLayers(
          st.project.layers.map((l) => l.id),
          st.selectedLayerId ?? undefined,
        );
        return;
      }
      if (mod) return;
      // Space held: the Hand tool until it is released. A control focused from the keyboard
      // keeps Space (it presses buttons, ticks boxes).
      if (e.code === 'Space') {
        if (e.target instanceof HTMLElement && e.target !== document.body && e.target !== clickFocused) return;
        e.preventDefault();
        if (!e.repeat) setSpaceHand(true);
        return;
      }
      if (e.key === '?') {
        e.preventDefault();
        toggleSheet();
        return;
      }
      // Tool keys (V, A, T, U, G, D, L, H, Z). e.code: ⇧ and keyboard layouts change e.key.
      const tool = e.altKey ? undefined : TOOLS.find((x) => x.code === e.code);
      if (tool) {
        e.preventDefault();
        st.setTool(tool.tool);
        // The v5 habit stays: T adds 2D text, ⇧T 3D text, both open for typing.
        if (tool.tool === 'text') {
          const dim = e.shiftKey ? '3d' : '2d';
          st.setView({ textKind: dim });
          addTextLayer(dim);
        }
        return;
      }
      switch (e.key) {
        case 'Delete':
        case 'Backspace': {
          // A selected effect, glint or mask row is deleted on its own; a part is never deleted from the keyboard.
          const node = st.selectedNode;
          if (node?.kind === 'effect') {
            e.preventDefault();
            st.removeEffect({ layerId: node.layerId, part: node.part }, node.effectId);
          } else if (node?.kind === 'glint') {
            e.preventDefault();
            deleteGlint([node.layerId]);
          } else if (node?.kind === 'mask') {
            e.preventDefault();
            st.removeMask(node.layerId, node.maskId);
          } else if (node?.kind !== 'part' && node?.kind !== 'parts' && ids.length) {
            e.preventDefault();
            st.removeLayers(ids);
          }
          break;
        }
        case 'Enter':
          if (isTitleLayer(layer) && layer.source.kind === 'text' && !layer.locked) {
            e.preventDefault();
            st.beginTextEdit(layer.id);
          }
          break;
        case 'Escape': {
          // An open menu / popover takes this Esc to close (usePopover); the selection stays.
          if (document.querySelector('.menu-pop')) break;
          // One level up: picked glyphs → layer; effect → its part or layer; part / mask → layer;
          // layer → its group; only a top-level layer (or nothing) deselects to the Document.
          const node = st.selectedNode;
          const up = node && ownerNode(node);
          if (st.selectedChars.length) st.selectChars([]);
          else if (up) st.selectNode(up);
          else if (node && layer?.parentId) st.selectLayer(layer.parentId);
          else st.selectNode(null);
          break;
        }
        case 'ArrowLeft':
        case 'ArrowRight':
        case 'ArrowUp':
        case 'ArrowDown': {
          // Picked glyphs are nudged by the Viewport's own handler.
          if (st.selectedChars.length || !ids.length) return;
          e.preventDefault();
          const step = e.shiftKey ? 10 : 1;
          const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
          const dy = e.key === 'ArrowUp' ? step : e.key === 'ArrowDown' ? -step : 0; // +y is up
          // A burst of nudges on one selection is one undo step.
          const now = performance.now();
          const who = ids.join(',');
          if (!nudgeKey.startsWith(`${who}:`) || now - nudgeAt > 800) nudgeKey = `${who}:${oneShot('nudge')}`;
          nudgeAt = now;
          st.nudgeLayers(ids, dx, dy, nudgeKey);
          break;
        }
      }
    };
    // Space is released wherever focus went meanwhile; leaving the window releases it too.
    const onKeyUp = (e: KeyboardEvent) => e.code === 'Space' && setSpaceHand(false);
    const onBlur = () => setSpaceHand(false);
    // ⌘V: an image or SVG on the clipboard becomes a 2D layer at the comp centre (PS paste);
    // anything else is left alone. Fields and dialogs keep their own paste.
    const onPaste = (e: ClipboardEvent) => {
      if (!e.clipboardData || isTyping(e.target) || useEditor.getState().confirmation || document.querySelector('.modal-back')) return;
      const files = clipboardFiles(e.clipboardData);
      if (!files.length) return;
      e.preventDefault();
      void importFiles(files, { dim: '2d' });
    };
    // Files dropped outside a drop target (canvas, Layers panel) must not make the browser open them.
    const onFileDragOver = (e: DragEvent) => {
      if (e.defaultPrevented || !draggingFiles(e.dataTransfer)) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = 'none';
    };
    const onFileDrop = (e: DragEvent) => {
      if (draggingFiles(e.dataTransfer)) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    window.addEventListener('keydown', onAnyKey, true);
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('focusin', onFocusIn);
    window.addEventListener('paste', onPaste);
    window.addEventListener('dragover', onFileDragOver);
    window.addEventListener('drop', onFileDrop);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('keydown', onAnyKey, true);
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('focusin', onFocusIn);
      window.removeEventListener('paste', onPaste);
      window.removeEventListener('dragover', onFileDragOver);
      window.removeEventListener('drop', onFileDrop);
    };
  }, [setExportOpen, toggleSheet]);
}

function Toast() {
  const toast = useEditor((s) => s.toast);
  const t = useT();
  if (!toast) return null;
  return <div className={`toast ${toast.kind}`}>{formatMsg(toast.text, t)}</div>;
}

/** In-app yes / no (store.confirm): Enter confirms, Esc or a click outside cancels. */
function ConfirmDialog() {
  const c = useEditor((s) => s.confirmation);
  const answer = useEditor((s) => s.answerConfirm);
  const t = useT();
  const okRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!c) return;
    okRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' && e.key !== 'Enter') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      answer(e.key === 'Enter');
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [c, answer]);
  if (!c) return null;
  return (
    <div className="modal-back confirm-back" onPointerDown={(e) => e.target === e.currentTarget && answer(false)}>
      <div className="modal confirm-dialog" role="alertdialog" aria-modal aria-labelledby="confirm-title" aria-describedby="confirm-msg">
        <div className="modal-head" id="confirm-title">
          {formatMsg(c.title, t)}
        </div>
        <div className="confirm-msg" id="confirm-msg">
          {formatMsg(c.message, t)}
        </div>
        <div className="modal-foot">
          <button onClick={() => answer(false)} title={t('Keep the current project (Esc)')}>
            {t('Cancel')}
          </button>
          <button ref={okRef} className="primary" onClick={() => answer(true)} title="Enter">
            {formatMsg(c.ok, t)}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * True when nothing would be exported or seen: no visible non-guide content layer (layers inside
 * a hidden group count as hidden; groups and adjustment layers draw nothing of their own).
 */
function useCompEmpty() {
  return useEditor((s) => {
    const layers = s.project.layers;
    return !layers.some((l) => l.visible && !l.guide && l.kind !== 'group' && l.kind !== 'adjustment' && ancestorsOf(layers, l.id).every((g) => g.visible));
  });
}

/** First-step card over an empty canvas: the ways to start, with their shortcuts. */
function EmptyCanvasCard({ onTemplates }: { onTemplates: () => void }) {
  const t = useT();
  return (
    <div className="empty-card-wrap">
      <div className="empty-card" role="region" aria-label={t('Start your title')}>
        <div className="empty-card-title">{t('Empty comp — start with')}</div>
        <div className="empty-card-actions">
          <button className="primary" title={t('Add a 2D text layer (bevel + rims, Eye Candy style) and type (T)')} onClick={() => addTextLayer('2d')}>
            {t('2D text')} <kbd>T</kbd>
          </button>
          <button title={t('Add an extruded 3D text layer (Element 3D style) and type (⇧T)')} onClick={() => addTextLayer('3d')}>
            {t('3D text')} <kbd>⇧T</kbd>
          </button>
          <Menu label={t('Shape ▾')} title={t('Add a plate, band, burst, bubble or orb (2D or 3D)')} items={shapeItems(t)} />
          <button title={t('Pick one of the ready-made pachislot titles')} onClick={onTemplates}>
            {t('Start from template…')}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [ready, setReady] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const toggleSheet = useCallback(() => setSheetOpen((o) => !o), []);
  const closeSheet = useCallback(() => setSheetOpen(false), []);
  const closeTemplates = useCallback(() => setTemplatesOpen(false), []);
  const empty = useCompEmpty();
  const splitLayerId = useSplitImage((s) => s.layerId);
  useShortcuts(setExportOpen, toggleSheet);

  useEffect(() => {
    let stop = () => {};
    let cancelled = false;
    (async () => {
      await loadBuiltinFonts();
      const st = useEditor.getState();
      let restored = false;
      try {
        const saved = await loadAutosave();
        if (!cancelled && saved.kind === 'restored') {
          restored = true;
          st.loadProject(saved.project);
          // Migration notes (“upgraded from v4”) are news, font failures are errors.
          if (saved.errors.length) st.notify(joinMsgs([...saved.notes, ...saved.errors], '; '), 'error');
          else if (saved.notes.length) st.notify(joinMsgs(saved.notes, '; '));
        }
        if (!cancelled && saved.kind === 'discarded')
          st.notify(msg("The autosaved project was from an older version (v{version}) and can't be restored by this version; starting a new project.", { version: saved.version }), 'error');
      } catch (e) {
        console.warn('Autosave restore failed', e);
      }
      if (cancelled) return;
      // The first-run demo gets the same fresh-project selection as a restored one.
      if (!restored) st.loadProject(useEditor.getState().project);
      stop = startAutosave(
        (cb) => useEditor.subscribe((s, prev) => s.project !== prev.project && cb(s.project)),
        (message) => useEditor.getState().notify(message, 'error'),
      );
      setReady(true);
    })().catch((e: unknown) => setBootError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
      stop();
    };
  }, []);

  if (bootError) return <div className="boot error">{tr('Failed to start: {error}', { error: bootError })}</div>;
  if (!ready) return <div className="boot">{tr('Loading…')}</div>;
  // DOM order is the Tab order: top bar, options bar, tools, canvas, dock.
  return (
    <div className="app">
      <TopBar exportOpen={exportOpen} setExportOpen={setExportOpen} onHelp={toggleSheet} />
      <OptionsBar />
      <div className="main">
        <Toolbar />
        <main className="viewport-col">
          <Viewport />
          {empty && <EmptyCanvasCard onTemplates={() => setTemplatesOpen(true)} />}
        </main>
        <Dock />
      </div>
      <Toast />
      {sheetOpen && (
        <Suspense fallback={<Loading modal />}>
          <ShortcutSheet onClose={closeSheet} />
        </Suspense>
      )}
      {templatesOpen && (
        <Suspense fallback={<Loading modal />}>
          <TemplateDialog onClose={closeTemplates} />
        </Suspense>
      )}
      {splitLayerId && (
        <Suspense fallback={<Loading modal />}>
          <SplitImageDialog layerId={splitLayerId} onClose={closeSplitImage} />
        </Suspense>
      )}
      <ConfirmDialog />
    </div>
  );
}
