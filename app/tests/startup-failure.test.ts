import { describe, expect, it } from 'vitest';
import { startupFailureMessage } from '../src/main/startup-failure';

const folder = 'C:\\Usuarios\\demo\\AppData\\Roaming\\CyberSOC Defender';

describe('mensaje de arranque fallido (B-03)', () => {
  it('explica un perfil de otra instalación o versión sin pedir borrar datos', () => {
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

  it('distingue copia previa fallida, enlaces y motor', () => {
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

  it('un error desconocido o que no es Error sigue dando guía segura', () => {
    const text = startupFailureMessage('fallo raro', folder);
    expect(text).toContain('error inesperado');
    expect(text).toContain('No borres la carpeta de datos');
    expect(text).toContain('Detalle técnico: fallo raro');
  });
});
