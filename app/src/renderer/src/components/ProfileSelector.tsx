import type { ScanProfile } from '../../../shared/scan-profile';

const layers = [
  'HASH',
  'SIGNATURES',
  'FILETYPE',
  'RULES',
  'HEURISTICS',
  'PE',
  'SCRIPTS',
] as const;

const locked = new Set<string>(['HASH', 'SIGNATURES']);

export type ProfileMode = 'AUTO' | 'CUSTOM';

export function ProfileSelector({
  mode,
  selected,
  onMode,
  onToggle,
}: {
  mode: ProfileMode;
  selected: ReadonlySet<string>;
  onMode: (mode: ProfileMode) => void;
  onToggle: (layer: (typeof layers)[number]) => void;
}) {
  return (
    <fieldset className="panel" data-testid="profile-selector">
      <legend>Perfil de capas</legend>
      <div className="choice-grid">
        <label
          className={
            mode === 'AUTO' ? 'choice-card is-selected' : 'choice-card'
          }
        >
          <input
            type="radio"
            name="profile-mode"
            data-testid="profile-mode-auto"
            checked={mode === 'AUTO'}
            onChange={() => onMode('AUTO')}
          />
          <span>
            <strong>Automático por zona</strong>
            <small className="hint">
              Cada ruta usa el perfil de su zona. Los valores del motor no
              cambian.
            </small>
          </span>
        </label>
        <label
          className={
            mode === 'CUSTOM' ? 'choice-card is-selected' : 'choice-card'
          }
        >
          <input
            type="radio"
            name="profile-mode"
            data-testid="profile-mode-custom"
            checked={mode === 'CUSTOM'}
            onChange={() => onMode('CUSTOM')}
          />
          <span>
            <strong>Personalizado</strong>
            <small className="hint">
              Eliges capas. Hash y firmas siguen siendo obligatorias.
            </small>
          </span>
        </label>
      </div>
      {mode === 'CUSTOM' && (
        <div className="layer-choices">
          {layers.map((layer) => (
            <label key={layer}>
              <input
                type="checkbox"
                data-testid={`layer-${layer}`}
                checked={selected.has(layer)}
                disabled={locked.has(layer)}
                onChange={() => onToggle(layer)}
              />
              {layer}
              {locked.has(layer) ? ' (obligatoria)' : ''}
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}

export function customProfile(selected: ReadonlySet<string>): ScanProfile {
  return {
    layers: layers.filter((layer) => selected.has(layer)),
    includeHidden: false,
    maxFileSizeMB: 256,
  };
}

export function toggleLayer(
  selected: ReadonlySet<string>,
  layer: (typeof layers)[number],
): Set<string> {
  const next = new Set(selected);
  if (!locked.has(layer)) {
    if (next.has(layer)) next.delete(layer);
    else next.add(layer);
  }
  next.add('HASH');
  next.add('SIGNATURES');
  return next;
}

export const allLayers = new Set<string>(layers);
