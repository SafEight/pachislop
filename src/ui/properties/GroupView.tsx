import type { GroupLayer } from '../../model/types';
import { useEditor } from '../../store/store';
import { childrenOf } from '../../store/tree';
import { Section } from '../controls';
import { useCompanionSides } from '../companions';
import { useT } from '../i18n';
import { EffectStack } from './EffectCard';
import { InfoTip } from './InfoTip';
import { GroupTransformSection } from './TransformSection';

/** Group node: its members' transform as one (with align), then the effects that run on their composite. Blend and opacity are the Layers panel header's; Ungroup is ⇧⌘G / the context menu. */
export function GroupView({ layer }: { layer: GroupLayer }) {
  const t = useT();
  const n = useEditor((s) => childrenOf(s.project.layers, layer.id).length);
  const { front, back } = useCompanionSides(layer.id);
  const fx = layer.effects.length + front.length + back.length;
  return (
    <>
      <GroupTransformSection layer={layer} />
      <Section
        id="effects"
        title={
          <>
            {fx ? t('Effects {n}', { n: fx }) : t('Effects')}
            <InfoTip
              text={t(
                n === 1
                  ? '{n} layer composited together, then the group’s effects run on the result (one glow around burst + text).'
                  : '{n} layers composited together, then the group’s effects run on the result (one glow around burst + text).',
                { n },
              )}
            />
          </>
        }
      >
        <EffectStack owner={{ layerId: layer.id, part: null }} />
      </Section>
    </>
  );
}
