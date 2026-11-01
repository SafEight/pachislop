import type { PartKey } from '../../model/types';
import { effectsOf } from '../../store/effects';
import { useEditor } from '../../store/store';
import { EffectCard } from './EffectCard';

/**
 * Effect node: that effect's card at full height. Its on-canvas handles show because the
 * selected node is this effect. Null when the effect is gone (the panel falls back to its owner).
 */
export function EffectView({ layerId, part, effectId }: { layerId: string; part: PartKey | null; effectId: string }) {
  const owner = { layerId, part };
  const effects = effectsOf(useEditor((s) => s.project), owner);
  const index = effects.findIndex((e) => e.id === effectId);
  if (index < 0) return null;
  return <EffectCard owner={owner} fx={effects[index]} index={index} count={effects.length} full />;
}
