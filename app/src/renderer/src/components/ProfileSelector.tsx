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
      <legend>Perfil: automático por zona / personalizado</legend>
      <label>
        <input
          type="radio"
          name="profile-mode"
          data-testid="profile-mode-auto"
          checked={mode === 'AUTO'}
          onChange={() => onMode('AUTO')}
        />
        Automático por zona
      </label>
      <label>
        <input
          type="radio"
          name="profile-mode"
          data-testid="profile-mode-custom"
          checked={mode === 'CUSTOM'}
          onChange={() => onMode('CUSTOM')}
        />
        Personalizado
      </label>
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
