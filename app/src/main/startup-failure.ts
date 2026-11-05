// Mensaje para la persona cuando la app no puede arrancar (B-03 de 11.B). Antes se cerraba
// sin explicar nada. Los textos salen de los errores de UpgradeBackup/perfil y nunca piden
// borrar datos: la base, su WAL y el marcador del perfil son lo que permite recuperar.

const KEEP_DATA =
  'Tus datos no se borraron. No borres la carpeta de datos ni los archivos cybersoc.db, cybersoc.db-wal o distribution-profile.json: la guía de instalación explica cómo recuperarlos.';

// Patrones de los mensajes de error de arranque -> explicación. Se recorren en orden
// (lista cerrada de 4 entradas, O(1) en la práctica) y gana el primero que coincide.
const causes: readonly { pattern: RegExp; explanation: string }[] = [
  {
    pattern: /incompatible|downgrade|Versión de perfil inválida/i,
    explanation:
      'Los datos pertenecen a otra instalación o a una versión más nueva de CyberSOC Defender. Instala la versión más reciente en lugar de una anterior.',
  },
  {
    pattern: /integridad|Copia distinta|copia/i,
    explanation:
      'No se pudo crear una copia verificada de tus datos antes de actualizarlos, así que no se cambió nada. Comprueba que haya espacio libre en el disco y vuelve a abrir la aplicación.',
  },
  {
    pattern: /enlaces|enlazada/i,
    explanation:
      'La carpeta de datos usa un enlace o acceso directo del sistema de archivos, que no se admite por seguridad.',
  },
  {
    pattern: /motor|engine/i,
    explanation:
      'No se pudo iniciar el motor de análisis incluido en la instalación. Reinstala la aplicación con el mismo instalador.',
  },
];

export function startupFailureMessage(
  error: unknown,
  userDataPath: string,
): string {
  const detail = error instanceof Error ? error.message : String(error);
  const cause =
    causes.find(({ pattern }) => pattern.test(detail))?.explanation ??
    'Ocurrió un error inesperado al abrir tus datos.';
  return `${cause}\n\n${KEEP_DATA}\n\nCarpeta de datos: ${userDataPath}\nDetalle técnico: ${detail}`;
}
