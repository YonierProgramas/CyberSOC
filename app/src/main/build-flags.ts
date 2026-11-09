// Vite replaces these constants and removes instrumentation branches from the release.
// In TS tests without a bundler the historical evidence behavior is kept.
declare const __CYBERSOC_RELEASE__: boolean;
declare const __CYBERSOC_RESOURCE_DIGEST__: string;
export const RELEASE =
  typeof __CYBERSOC_RELEASE__ !== 'undefined' && __CYBERSOC_RELEASE__;
export const RESOURCE_DIGEST =
  typeof __CYBERSOC_RESOURCE_DIGEST__ !== 'undefined'
    ? __CYBERSOC_RESOURCE_DIGEST__
    : '';
