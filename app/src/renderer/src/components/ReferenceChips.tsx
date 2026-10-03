import type { AssistantReferenceDTO } from '../../../shared/ipc';
import { useShell } from '../navigation/shell';
import { zoneLabel } from '../scan/format';

const typeLabel: Record<AssistantReferenceDTO['type'], string> = {
  result: 'Resultado',
  job: 'Escaneo',
  rule: 'Regla',
  zone: 'Zona',
};

function chipLabel(reference: AssistantReferenceDTO): string {
  if (reference.type === 'zone') {
    const label = zoneLabel(reference.id);
    return label === '—' ? `Zona ${reference.id}` : `Zona ${label}`;
  }
  const short =
    reference.id.length > 12 ? `${reference.id.slice(0, 8)}…` : reference.id;
  return `${typeLabel[reference.type]} ${short}`;
}

export function ReferenceChips({
  references,
}: {
  references: readonly AssistantReferenceDTO[];
}) {
  const { openReference } = useShell();
  if (references.length === 0) return null;
  return (
    <div className="copilot-chips" data-testid="copilot-references">
      {references.map((reference, index) => (
        <button
          key={`${reference.type}:${reference.id}:${index}`}
          type="button"
          className="chip"
          data-testid="copilot-reference"
          data-reference-type={reference.type}
          data-reference-id={reference.id}
          onClick={() => openReference(reference)}
        >
          {chipLabel(reference)}
        </button>
      ))}
    </div>
  );
}
