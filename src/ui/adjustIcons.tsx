import type { ReactNode } from 'react';
import type { AdjustmentType } from '../model/types';

// 16 px adjustment-layer glyphs (after Photoshop's Adjustments panel), drawn in currentColor.

const GLYPHS: Record<AdjustmentType, ReactNode> = {
  brightnessContrast: (
    <>
      <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" />
      <path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor" />
    </>
  ),
  levels: (
    <>
      <path d="M1.5 11.5 4 7l2 2 3-6 2.5 5 3 3.5z" fill="currentColor" />
      <path d="M1 14.5h2.5L2.25 12.5zM6.75 14.5h2.5L8 12.5zM12.5 14.5H15l-1.25-2z" fill="currentColor" />
    </>
  ),
  curves: (
    <>
      <rect x="1.5" y="1.5" width="13" height="13" fill="none" stroke="currentColor" strokeOpacity="0.5" />
      <path d="M2.5 13.5C8 13.5 8 2.5 13.5 2.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </>
  ),
  exposure: (
    <>
      <rect x="1.5" y="1.5" width="13" height="13" fill="none" stroke="currentColor" />
      <path d="M14.5 1.5v13h-13zM9 10.5h4.5v1H9z" fill="currentColor" fillRule="evenodd" />
      <path d="M3.5 5h4M5.5 3v4" stroke="currentColor" />
    </>
  ),
  vibrance: (
    <>
      <path d="M1.5 2.5h13L8 14z" fill="none" stroke="currentColor" />
      <path d="M5 5.5h6L8 11z" fill="currentColor" />
    </>
  ),
  hueSaturation: (
    <>
      <rect x="1.5" y="8" width="3" height="6.5" fill="currentColor" />
      <rect x="6.5" y="4" width="3" height="10.5" fill="currentColor" fillOpacity="0.7" />
      <rect x="11.5" y="1.5" width="3" height="13" fill="currentColor" fillOpacity="0.45" />
    </>
  ),
  colorBalance: (
    <>
      <path d="M8 2v11M4 14.5h8M2 4.5h12" fill="none" stroke="currentColor" />
      <path d="M2 4.5 0.5 9h3zM14 4.5 12.5 9h3z" fill="none" stroke="currentColor" strokeLinejoin="round" />
    </>
  ),
  blackWhite: (
    <>
      <rect x="1.5" y="1.5" width="13" height="13" fill="none" stroke="currentColor" />
      <path d="M1.5 14.5 14.5 1.5v13z" fill="currentColor" />
    </>
  ),
  photoFilter: (
    <>
      <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" />
      <circle cx="8" cy="8" r="3.5" fill="currentColor" fillOpacity="0.6" />
    </>
  ),
  gradientMap: (
    <>
      <rect x="1.5" y="3.5" width="13" height="9" fill="none" stroke="currentColor" />
      <rect x="2" y="4" width="3" height="8" fill="currentColor" />
      <rect x="5" y="4" width="3" height="8" fill="currentColor" fillOpacity="0.66" />
      <rect x="8" y="4" width="3" height="8" fill="currentColor" fillOpacity="0.33" />
    </>
  ),
  invert: (
    <>
      <rect x="1.5" y="1.5" width="13" height="13" fill="none" stroke="currentColor" />
      <path d="M1.5 1.5H8v13H1.5zM8 5a3 3 0 0 0 0 6a3 3 0 0 0 0-6z" fill="currentColor" fillRule="evenodd" />
    </>
  ),
  posterize: <path d="M1.5 14.5V11h3.25V7.75H8V4.5h3.25V1.5h3.25v13z" fill="currentColor" />,
  threshold: (
    <>
      <rect x="1.5" y="1.5" width="13" height="13" fill="none" stroke="currentColor" />
      <path d="M1.5 1.5h6c-2 2 2 4 0 6.5s2 4.5 0 6.5h-6z" fill="currentColor" />
    </>
  ),
  effectsOnly: (
    <>
      <path d="M7.5 2.6C6.1 1.9 5 2.6 4.8 4L3.4 13.5M2.5 6.5h4.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M8.75 7l4.75 6.5M13.5 7l-4.75 6.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </>
  ),
};

/** 16 px icon of an adjustment type (Layers rows, menus). Decorative: label the surrounding control. */
export function AdjustmentIcon({ type }: { type: AdjustmentType }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false" style={{ flex: 'none' }}>
      {GLYPHS[type]}
    </svg>
  );
}
