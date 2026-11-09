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
        // The native dialog handles Tab/Escape without closing or triggering the
        // focus trap of the outer panel that contains the confirmation.
        if (event.key === 'Escape' || event.key === 'Tab')
          event.stopPropagation();
      }}
      onCancel={(event) => {
        // Updating React as well allows reopening the same confirmation.
        event.preventDefault();
        if (!cancelDisabled) onCancel();
      }}
    >
      <h2 id={titleId}>{title}</h2>
      {children}
    </dialog>
  );
}
