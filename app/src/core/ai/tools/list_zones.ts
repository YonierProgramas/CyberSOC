import { z } from 'zod';
import type { ToolRegistry } from './ToolRegistry';
import { type ToolContext } from './context';
import { zoneSchema } from '../../../shared/protocol';

export function register(registry: ToolRegistry, context: ToolContext) {
  registry.register({
    name: 'list_zones',
    description:
      'Zonas con rutas reales, perfiles configurados y unidades extraíbles actualmente conectadas.',
    arguments: z.strictObject({}),
    execute: async () => {
      const profiles = context.reads.profiles(),
        roots = context.zoneRoots();
      const drives = z
        .array(
          z
            .strictObject({
              driveId: z.string().regex(/^[a-z]:$/i),
              path: z.string().regex(/^[a-z]:[\\\\/]$/i),
            })
            .refine(
              (drive) =>
                drive.path.slice(0, 2).toLowerCase() ===
                drive.driveId.toLowerCase(),
            ),
        )
        .parse(await context.removableDrives());
      return {
        rows: [
          ...zoneSchema.options
            .filter((zone) => zone !== 'EXTRAIBLE')
            .map((zone) => ({
              zoneId: zone,
              paths: roots
                .filter((root) => root.zone === zone)
                .map((root) => root.path),
              profile: profiles[zone],
            })),
          ...drives.map((drive) => ({
            zoneId: 'EXTRAIBLE',
            driveId: drive.driveId.toUpperCase(),
            paths: [drive.path],
            profile: profiles.EXTRAIBLE,
          })),
        ],
      };
    },
  });
}
