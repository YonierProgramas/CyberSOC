import { execFile } from 'node:child_process';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { QuarantineError } from './paths';

// Código constante: la ruta y el hash viajan en variables de entorno, nunca interpolados.
// Windows abre con READ + DELETE, sin compartir escritura/borrado. Recalcula el hash
// con ese handle y lo marca para borrar: cambiar un nombre no cambia el objeto abierto.
// SetFileInformationByHandle(FileDispositionInfo):
// https://learn.microsoft.com/windows/win32/api/fileapi/nf-fileapi-setfileinformationbyhandle
const DELETE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try {
  # Cargar el módulo incorporado por ruta evita buscar por todos los módulos instalados.
  # Con el entorno mínimo, ese descubrimiento añade decenas de segundos en Windows CI.
  # PSHOME lo fija PowerShell; no heredamos PSModulePath ni credenciales del proceso main.
  Import-Module "$PSHOME\Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1" -ErrorAction Stop
  Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Security.Cryptography;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class VerifiedDelete {
  public static bool Marked = false;
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFileW(string p, uint a, uint s, IntPtr sa, uint c, uint f, IntPtr t);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern uint GetFinalPathNameByHandleW(SafeFileHandle h, StringBuilder p, uint n, uint f);
  [StructLayout(LayoutKind.Sequential)]
  struct Disposition { [MarshalAs(UnmanagedType.U1)] public bool DeleteFile; }
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool SetFileInformationByHandle(SafeFileHandle h, int c, ref Disposition d, uint n);
  public static int Run(string path, string expected) {
    using (var handle = CreateFileW(path, 0x80010000, 1, IntPtr.Zero, 3, 0x08000000, IntPtr.Zero)) {
      if (handle.IsInvalid) return 4;
      var actualPath = new StringBuilder(32768);
      uint size = GetFinalPathNameByHandleW(handle, actualPath, (uint)actualPath.Capacity, 0);
      if (size == 0 || size >= actualPath.Capacity) return 4;
      string actual = actualPath.ToString();
      if (actual.StartsWith(@"\\?\")) actual = actual.Substring(4);
      if (!String.Equals(actual, path, StringComparison.OrdinalIgnoreCase)) return 3;
      using (var stream = new FileStream(handle, FileAccess.Read, 1048576, false))
      using (var hash = SHA256.Create()) {
        string digest = BitConverter.ToString(hash.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
        if (!String.Equals(digest, expected, StringComparison.Ordinal)) return 3;
        var disposition = new Disposition { DeleteFile = true };
        if (!SetFileInformationByHandle(handle, 4, ref disposition, 1)) return 4;
        Marked = true;
        return 0;
      }
    }
  }
}
'@
  exit [VerifiedDelete]::Run($env:CYBERSOC_DELETE_PATH, $env:CYBERSOC_DELETE_HASH)
} catch {
  if ('VerifiedDelete' -as [type]) { if ([VerifiedDelete]::Marked) { exit 5 } }
  exit 4
}
`;

export async function deleteVerifiedOriginal(
  path: string,
  sha256: string,
): Promise<void> {
  if (process.platform !== 'win32') {
    // Soporte de las pruebas portables. El endurecimiento por handle es específico de Windows.
    await unlink(path);
    return;
  }
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const executable = join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  await new Promise<void>((resolve, reject) => {
    execFile(
      executable,
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(DELETE_SCRIPT, 'utf16le').toString('base64'),
      ],
      {
        windowsHide: true,
        timeout: 120_000,
        maxBuffer: 4096,
        // No hereda API keys, tokens GitHub ni otras credenciales del proceso main.
        env: {
          SystemRoot: systemRoot,
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
          CYBERSOC_DELETE_PATH: path,
          CYBERSOC_DELETE_HASH: sha256,
        },
      },
      (error) => {
        if (!error) {
          resolve();
          return;
        }
        if (error.code === 3)
          reject(
            new QuarantineError(
              'FILE_CHANGED',
              'El archivo o su ruta cambió. Vuelve a escanearlo.',
            ),
          );
        else if (error.code === 4)
          reject(
            new QuarantineError(
              'DELETE_FAILED',
              'No se pudo borrar el original; puede estar bloqueado.',
            ),
          );
        else
          reject(
            new QuarantineError(
              'DELETE_UNCERTAIN',
              'No se pudo confirmar el borrado. Se conserva PENDING para reconciliar.',
            ),
          );
      },
    );
  });
}
