import { defaultComp } from '../../model/defaults';
import { lightingKeysSet } from '../../model/lighting';
import type { Comp } from '../../model/types';
import { useEditor, type PropRef } from '../../store/store';
import { RefColor, RefNum, Row, Section, Seg, type Option } from '../controls';
import { useT } from '../i18n';
import { LightSphere } from '../LightSphere';
import { oneShot } from '../util';
import { InfoTip } from './InfoTip';
import { CompEnvironment, CompTone, LightsEditor } from './style/Lighting3D';
import { tOpts } from './style/shared';

const SIZES: [number, number, string][] = [
  [1920, 1080, 'Full HD 1920×1080'],
  [1280, 720, 'HD 1280×720'],
  [1080, 1920, 'Vertical 1080×1920'],
  [800, 600, 'Sub-LCD 800×600'],
  [640, 480, 'Sub-LCD 640×480'],
  [2048, 2048, 'Square 2048×2048'],
];

const c = (...path: (string | number)[]): PropRef => ({ layerId: null, path: ['comp', ...path] });

const SUPERSAMPLE: Option<'1' | '2' | '3'>[] = [
  { value: '1', label: '1×', title: '3D layers render at the output resolution (fastest)' },
  { value: '2', label: '2×', title: '3D layers render at 2× and downsample: smoother bevel edges and highlights' },
  { value: '3', label: '3×', title: '3D layers render at 3× and downsample: cleanest edges, slowest' },
];

/**
 * Document node (nothing selected): the composition settings, edited live like any layer: frame,
 * output (export background, 3D supersampling), the 3D lighting rig (environment, tone, lights,
 * camera) and the 2D global light.
 */
export function DocumentView() {
  const t = useT();
  const comp = useEditor((s) => s.project.comp);
  /** 3D layers that set some lighting values themselves, out of all 3D layers. */
  const [overriding, layers3D] = useEditor((s) => {
    const all = s.project.layers.filter((l) => l.kind === 'title3d');
    return `${all.filter((l) => lightingKeysSet(l.style3d.lighting).length > 0).length}/${all.length}`;
  })
    .split('/')
    .map(Number);
  const { edit, setAt } = useEditor.getState();
  const preset = SIZES.find(([w, h]) => w === comp.width && h === comp.height);
  const setComp = (patch: Partial<Comp>, key?: string) => edit((p) => ({ ...p, comp: { ...p.comp, ...patch } }), key);

  return (
    <div className="doc-view">
      <Section id="doc-frame" title={t('Frame')}>
        <Row label={t('Size')}>
          <select
            aria-label={t('Size')}
            title={t('Composition size preset')}
            value={preset ? `${preset[0]}x${preset[1]}` : 'custom'}
            onChange={(e) => {
              const s = SIZES.find(([w, h]) => `${w}x${h}` === e.target.value);
              if (s) setComp({ width: s[0], height: s[1] });
            }}
          >
            {SIZES.map(([w, h, label]) => (
              <option key={label} value={`${w}x${h}`}>
                {t(label)}
              </option>
            ))}
            <option value="custom">{t('Custom')}</option>
          </select>
        </Row>
        <RefNum label={t('Width')} refp={c('width')} min={16} max={4096} integer clamp unit="px" />
        <RefNum label={t('Height')} refp={c('height')} min={16} max={4096} integer clamp unit="px" />
        <RefNum
          label={t('DPI')}
          refp={c('dpi')}
          min={72}
          max={1200}
          integer
          clamp
          defaultValue={72}
          title={t('Print resolution written into exported PNG / PSD files (72 = screen; 350 for print proofs). Pixel size is unchanged.')}
        />
        <Row label="">
          <button className="small" title={t('Swap width and height')} onClick={() => setComp({ width: comp.height, height: comp.width }, oneShot('swap'))}>
            ⇄ {t('Swap')}
          </button>
        </Row>
      </Section>
      <Section
        id="doc-output"
        title={
          <>
            {t('Output')}
            <InfoTip text={t('The viewport backdrop (toolbar “{bg}”) is a view setting only; this one is exported.', { bg: t('Bg') })} />
          </>
        }
      >
        <Row label={t('Background')}>
          <Seg
            value={comp.background.transparent ? 't' : 'c'}
            options={[
              { value: 't', label: t('Transparent') },
              { value: 'c', label: t('Colour') },
            ]}
            onChange={(v) => setAt(c('background', 'transparent'), v === 't')}
          />
        </Row>
        {!comp.background.transparent && <RefColor label={t('Colour')} refp={c('background', 'color')} />}
        <Row label={t('Supersample')} title={t('Applies to 3D layers: they render at this multiple of the output size and downsample, for smoother bevel edges and specular highlights (slower)')}>
          <span role="group" aria-label={t('3D supersampling')}>
            <Seg value={String(comp.supersample) as '1' | '2' | '3'} options={tOpts(t, SUPERSAMPLE)} onChange={(v) => setAt(c('supersample'), Number(v))} />
          </span>
        </Row>
      </Section>
      <Section
        id="doc-lighting3d"
        title={
          <>
            {t('3D lighting')}
            <InfoTip text={t('Every 3D layer uses these values, except the ones it sets itself (its Lighting section); a 3D look sets all of them on its layer.')} />
          </>
        }
      >
        {overriding > 0 && <div className="hint-line">{t('{n} of {m} 3D layers set some of these values themselves.', { n: overriding, m: layers3D })}</div>}
        <Section id="doc-environment" title={t('Environment (3D reflections)')}>
          <CompEnvironment comp={comp} />
        </Section>
        <Section id="doc-tone" title={t('Tone')}>
          <CompTone comp={comp} />
        </Section>
        <Section id="doc-lights" title={t('Lights ({n})', { n: comp.lights.length })}>
          <LightsEditor refp={c('lights')} lights={comp.lights} />
        </Section>
        <Section id="doc-camera" title={t('Camera')} defaultOpen={false}>
          <RefNum label={t('FOV')} refp={c('camera', 'fov')} min={5} max={120} step={0.5} unit="deg" title={t('Vertical field of view; low = flatter, high = more perspective')} />
          <RefNum label={t('X')} refp={c('camera', 'x')} min={-2000} max={2000} step={1} unit="px" />
          <RefNum label={t('Y')} refp={c('camera', 'y')} min={-2000} max={2000} step={1} unit="px" />
          <RefNum label={t('Z offset')} refp={c('camera', 'zOffset')} min={-3000} max={3000} step={1} unit="px" />
          <RefNum label={t('Rot X')} refp={c('camera', 'rotX')} min={-90} max={90} step={0.5} unit="deg" />
          <RefNum label={t('Rot Y')} refp={c('camera', 'rotY')} min={-90} max={90} step={0.5} unit="deg" />
          <RefNum label={t('Rot Z')} refp={c('camera', 'rotZ')} min={-180} max={180} step={0.5} unit="deg" />
          <Row label="">
            <button className="small" onClick={() => setComp({ camera: defaultComp().camera }, oneShot('cam-reset'))}>
              {t('Reset camera')}
            </button>
          </Row>
        </Section>
      </Section>
      <Section id="doc-light2d" title={t('2D light')}>
        <div className="hint-line">{t('Global light: drives the 2D bevels, satin and shadows that use global light.')}</div>
        <Row label={t('Light')} title={t('Photoshop Global Light: shared by every bevel, satin and shadow that has “Use global light” on')}>
          <LightSphere
            id="comp-global-light"
            label={t('Global light direction')}
            angle={comp.globalLight.angle}
            altitude={comp.globalLight.altitude}
            onChange={(angle, altitude, key) => setComp({ globalLight: { angle, altitude } }, key)}
          />
        </Row>
        <RefNum
          label={t('Angle')}
          refp={c('globalLight', 'angle')}
          min={0}
          max={360}
          step={1}
          unit="deg"
          defaultValue={120}
          title={t('Direction the light comes from, counter-clockwise from the right (120° = upper left, Photoshop default)')}
        />
        <RefNum
          label={t('Altitude')}
          refp={c('globalLight', 'altitude')}
          min={0}
          max={90}
          step={1}
          clamp
          unit="deg"
          defaultValue={30}
          title={t('Height of the light above the surface: 90° = straight on, low = grazing (longer shadows, stronger bevel shading)')}
        />
      </Section>
    </div>
  );
}
