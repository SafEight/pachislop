/**
 * ⓘ beside a heading or a row: the explanation shows as a hover / focus tooltip instead of a
 * paragraph that pushes the controls down. Clicks don't reach the section header it sits in.
 */
export function InfoTip({ text }: { text: string }) {
  return (
    <span className="info-tip" tabIndex={0} role="note" aria-label={text} title={text} onClick={(e) => e.stopPropagation()}>
      ⓘ
    </span>
  );
}
