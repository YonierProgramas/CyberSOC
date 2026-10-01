// Node 24 elimina tipos, pero los imports del core omiten .ts. Este adaptador local
// resuelve solo imports relativos del código propio; no altera paquetes de terceros.
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
