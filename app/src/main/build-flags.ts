// Vite reemplaza estas constantes y elimina ramas de instrumentación del release.
// En tests TS sin bundler se conserva el comportamiento histórico de evidencia.
declare const __CYBERSOC_RELEASE__: boolean;
declare const __CYBERSOC_RESOURCE_DIGEST__: string;
export const RELEASE =
  typeof __CYBERSOC_RELEASE__ !== 'undefined' && __CYBERSOC_RELEASE__;
export const RESOURCE_DIGEST =
  typeof __CYBERSOC_RESOURCE_DIGEST__ !== 'undefined'
    ? __CYBERSOC_RESOURCE_DIGEST__
    : '';
