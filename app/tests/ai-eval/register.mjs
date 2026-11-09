// Node 24 strips types, but core imports omit .ts. This local adapter
// resolves only relative imports of our own code; it does not alter third-party packages.
import { registerHooks } from 'node:module';

const appUrl = new URL('../../', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const ownCode = ['src/', 'scripts/'].some((dir) =>
        context.parentURL?.startsWith(appUrl + dir),
      );
      if (
        error.code === 'ERR_MODULE_NOT_FOUND' &&
        ownCode &&
        specifier.startsWith('.') &&
        !specifier.endsWith('.ts')
      ) {
        return nextResolve(specifier + '.ts', context);
      }
      throw error;
    }
  },
});
