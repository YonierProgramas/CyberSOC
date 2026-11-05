import { useEffect, useRef, type ReactNode } from 'react';

export function ModalDialog({
  testId,
  titleId,
  title,
  children,
  onCancel,
  cancelDisabled = false,
}: {
  testId: string;
  titleId: string;
  title: string;
  children: ReactNode;
  onCancel: () => void;
  cancelDisabled?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node || node.open) return;
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    node.showModal();
    return () => {
      if (node.open) node.close();
      if (opener?.isConnected && !opener.closest('[hidden], [inert]'))
        opener.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      data-testid={testId}
      aria-labelledby={titleId}
      onKeyDown={(event) => {
        // El diálogo nativo gestiona Tab/Escape sin cerrar ni activar la
        // trampa de foco del panel exterior que contiene la confirmación.
        if (event.key === 'Escape' || event.key === 'Tab')
          event.stopPropagation();
      }}
      onCancel={(event) => {
        // Actualizar también React permite reabrir la misma confirmación.
        event.preventDefault();
        if (!cancelDisabled) onCancel();
      }}
    >
      <h2 id={titleId}>{title}</h2>
      {children}
    </dialog>
  );
}
