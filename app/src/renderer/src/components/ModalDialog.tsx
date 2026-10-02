import { useEffect, useRef, type ReactNode } from 'react';

export function ModalDialog({
  testId,
  titleId,
  title,
  children,
}: {
  testId: string;
  titleId: string;
  title: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node || node.open) return;
    node.showModal();
    return () => {
      if (node.open) node.close();
    };
  }, []);
  return (
    <dialog ref={ref} data-testid={testId} aria-labelledby={titleId}>
      <h2 id={titleId}>{title}</h2>
      {children}
    </dialog>
  );
}
