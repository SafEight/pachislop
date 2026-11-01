import { useRef, useState, type DragEvent } from 'react';
import { useT } from '../i18n';
import { draggingFiles, draggingFonts, importFiles } from '../layerActions';
import type { Pt } from './geometry';

type Half = '2d' | '3d';

/** The half of the canvas area under the pointer: left = 2D layer, right = 3D layer. */
function halfAt(e: DragEvent<HTMLElement>): Half {
  const r = e.currentTarget.getBoundingClientRect();
  return e.clientX < r.left + r.width / 2 ? '2d' : '3d';
}

/**
 * Files dragged from the desktop onto the canvas. While they are over it a full-canvas overlay
 * splits it into a 2D layer half and a 3D layer (extruded) half, or shows one Install font zone
 * when only fonts are dragged; the drop imports each file as a layer of the half's kind (a GLB
 * model always goes 3D), centred where it was dropped and stacked in file order (importFiles).
 * `handlers` go on the canvas area element, `overlay` inside it; `toComp` maps client px to comp px.
 */
export function useFileDrop(toComp: (clientX: number, clientY: number) => Pt) {
  const t = useT();
  /** null: no file drag over the area; else whether it carries only fonts. */
  const [fontsOnly, setFontsOnly] = useState<boolean | null>(null);
  const [half, setHalf] = useState<Half>('2d');
  // dragenter / dragleave also fire between the area's children: count them.
  const depth = useRef(0);
  const end = () => {
    depth.current = 0;
    setFontsOnly(null);
  };
  const handlers = {
    onDragEnter(e: DragEvent<HTMLDivElement>) {
      if (!draggingFiles(e.dataTransfer)) return;
      e.preventDefault();
      if (depth.current++ === 0) setFontsOnly(draggingFonts(e.dataTransfer));
    },
    onDragOver(e: DragEvent<HTMLDivElement>) {
      if (!draggingFiles(e.dataTransfer)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      setHalf(halfAt(e));
    },
    onDragLeave(e: DragEvent<HTMLDivElement>) {
      if (draggingFiles(e.dataTransfer) && --depth.current <= 0) end();
    },
    onDrop(e: DragEvent<HTMLDivElement>) {
      if (!draggingFiles(e.dataTransfer)) return;
      e.preventDefault();
      end();
      void importFiles([...e.dataTransfer.files], { dim: halfAt(e), at: toComp(e.clientX, e.clientY) });
    },
  };
  const overlay =
    fontsOnly === null ? null : (
      <div className="file-drop" aria-hidden>
        {fontsOnly ? (
          <div className="file-drop-zone on">
            <span className="file-drop-label">{t('Install font')}</span>
            <span className="file-drop-hint">{t('TTF / OTF, for text layers')}</span>
          </div>
        ) : (
          <>
            <div className={`file-drop-zone ${half === '2d' ? 'on' : ''}`}>
              <span className="file-drop-label">{t('2D layer')}</span>
              <span className="file-drop-hint">{t('Image or SVG with layer style (a GLB model always becomes 3D)')}</span>
            </div>
            <div className={`file-drop-zone ${half === '3d' ? 'on' : ''}`}>
              <span className="file-drop-label">{t('3D layer (extruded)')}</span>
              <span className="file-drop-hint">{t('Image or SVG extruded, the picture on its face; GLB model')}</span>
            </div>
          </>
        )}
      </div>
    );
  return { handlers, overlay };
}
