import { describe, expect, it } from 'vitest';
import { startupFailureMessage } from '../src/main/startup-failure';

const folder = 'C:\\Usuarios\\demo\\AppData\\Roaming\\CyberSOC Defender';

describe('failed startup message (B-03)', () => {
  it('explains a profile from another installation or version without asking to delete data', () => {
    const text = startupFailureMessage(
      new Error('Esquema incompatible. No hay downgrade.'),
      folder,
    );
    expect(text).toContain('versión más nueva');
    expect(text).toContain('Tus datos no se borraron');
    expect(text).toContain(`Carpeta de datos: ${folder}`);
    expect(text).toContain('Detalle técnico: Esquema incompatible');
    expect(text).not.toMatch(/\bborra (la|los|el)\b/i);
  });

  it('distinguishes failed prior copy, links and engine', () => {
    expect(
      startupFailureMessage(
        new Error('La base o su copia no superan integridad/FK.'),
        folder,
      ),
    ).toContain('copia verificada');
    expect(
      startupFailureMessage(
        new Error('El perfil/backup no puede atravesar enlaces.'),
        folder,
      ),
    ).toContain('enlace');
    expect(
      startupFailureMessage(new Error('No se pudo iniciar el motor.'), folder),
    ).toContain('Reinstala');
  });

  it('an unknown error or non-Error still gives safe guidance', () => {
    const text = startupFailureMessage('fallo raro', folder);
    expect(text).toContain('error inesperado');
    expect(text).toContain('No borres la carpeta de datos');
    expect(text).toContain('Detalle técnico: fallo raro');
  });
});
