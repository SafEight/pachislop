import { useEffect, useEffectEvent, useRef } from 'react';
import { isTitleLayer } from '../../model/parts';
import type { Comp } from '../../model/types';
import { useEditor } from '../../store/store';
import { useT } from '../i18n';
import { useGesture } from '../util';
import type { StageMap } from './drag';
import { layerView, sourceBounds } from './geometry';
import type { TextLayer } from './glyphEdit';

/** Smallest type size of the inline editor, CSS px (tiny or zoomed-out text stays editable). */
const MIN_PX = 12;

/**
 * Inline text editing (Photoshop double-click on a text layer): a textarea laid IN PLACE over
 * the art — same centre, rotation, font, size, 長体 / 平体, tracking and line height, roughly —
 * while the art behind dims (canvas.css `.stage.text-editing`). ⌘/Ctrl+Enter or clicking
 * elsewhere commits; Esc reverts to the text it opened with. One typing burst is one undo step.
 */
export function TextEditOverlay({ layer, comp, stage, left, top }: { layer: TextLayer; comp: Comp; stage: StageMap; left: number; top: number }) {
  const t = useT();
  const ref = useRef<HTMLTextAreaElement>(null);
  const { setText, endTextEdit } = useEditor.getState();
  const g = useGesture(`inline-text:${layer.id}`);
  const original = useRef(layer.source.text);
  // Opening (a new layer id): remember the text to revert to and start the typing burst.
  const onOpen = useEffectEvent(() => {
    original.current = layer.source.text;
    g.begin();
  });
  useEffect(() => {
    const el = ref.current!;
    onOpen();
    el.focus();
    el.select();
    // Only on open: later renders must not steal the caret.
  }, [layer.id]);

  const revert = () => {
    const s = useEditor.getState();
    const now = s.project.layers.find((l) => l.id === layer.id);
    const typed = isTitleLayer(now) && now.source.kind === 'text' && now.source.text !== original.current;
    // The whole typing burst is the newest undo step: undoing it also restores what setText
    // derived from the text (per-character tweaks, an auto-named layer's name).
    if (typed && s.lastCoalesce === g.key()) s.undo();
    else if (typed) setText(layer.id, original.current, g.key());
  };

  const src = layer.source;
  const xf = layer.transform;
  const view = layerView(comp, layer);
  const b = sourceBounds(layer) ?? { x0: 0, y0: 0, x1: 0, y1: 0 };
  const c = stage.S(view.toComp({ x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 }, 0));
  const fontPx = Math.max(MIN_PX, src.size * Math.abs(xf.scale) * stage.d);
  return (
    <textarea
      ref={ref}
      className={`inline-text ${src.vertical ? 'vertical' : ''}`}
      aria-label={t('Edit the text of {name}', { name: layer.name })}
      title={t('Type to edit · ⌘Enter or click outside: done · Esc: revert')}
      value={src.text}
      spellCheck={false}
      style={{
        left: left + c.x,
        top: top + c.y,
        transform: `translate(-50%, -50%) rotate(${xf.rotZ}deg) scale(${src.hScale * (xf.flipX ? -1 : 1)}, ${src.vScale * (xf.flipY ? -1 : 1)})`,
        fontFamily: `"${src.fontId}", system-ui`,
        fontSize: fontPx,
        lineHeight: src.lineHeight,
        letterSpacing: `${src.tracking / 1000}em`,
        fontStyle: src.shear ? 'oblique' : undefined,
        textAlign: src.align === 'start' ? 'left' : src.align === 'end' ? 'right' : 'center',
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onChange={(e) => setText(layer.id, e.target.value, g.key())}
      onBlur={() => endTextEdit()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') {
          e.preventDefault();
          revert();
          endTextEdit();
        } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          endTextEdit();
        }
      }}
    />
  );
}
