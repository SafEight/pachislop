import { useT } from './i18n';

/**
 * Suspense fallback while a lazily loaded chunk arrives: a small inline spinner. `modal` dims
 * the screen like the dialog it stands in for, so a shortcut (⌘E, ?) answers on the first press.
 */
export function Loading({ modal = false }: { modal?: boolean }) {
  const t = useT();
  const spinner = (
    <span className="loading" role="status" aria-live="polite">
      <span className="loading-spin" aria-hidden />
      {t('Loading…')}
    </span>
  );
  return modal ? <div className="modal-back">{spinner}</div> : spinner;
}
