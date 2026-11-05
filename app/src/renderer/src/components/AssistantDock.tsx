import { useEffect, useRef, useState } from 'react';

const narrowQuery = '(max-width: 720px)';

export function useAssistantChrome() {
  const [open, setOpen] = useState(false);
  const [narrow, setNarrow] = useState(
    () => window.matchMedia(narrowQuery).matches,
  );
  const opener = useRef<HTMLButtonElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const media = window.matchMedia(narrowQuery);
    const onChange = () => setNarrow(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    if (open && narrow) main.setAttribute('inert', '');
    else main.removeAttribute('inert');
    return () => main.removeAttribute('inert');
  }, [open, narrow]);

  function close() {
    mainRef.current?.removeAttribute('inert');
    setOpen(false);
    opener.current?.focus();
  }

  return {
    open,
    narrow,
    opener,
    mainRef,
    openAssistant: () => setOpen(true),
    close,
  };
}
