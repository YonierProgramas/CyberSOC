// Node run of our own tests/benchmarks without installing an extra loader.
import { registerHooks } from 'node:module';
const root = new URL('../', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (
        error.code === 'ERR_MODULE_NOT_FOUND' &&
        context.parentURL?.startsWith(root) &&
        specifier.startsWith('.') &&
        !specifier.endsWith('.ts')
      )
        return nextResolve(specifier + '.ts', context);
      throw error;
    }
  },
});
