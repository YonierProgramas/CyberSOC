import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { z } from 'zod';

// Un solo proceso por escaneo. Recibe rutas como JSON por stdin, nunca como código.
// Solo consulta atributos; no abre contenido ni modifica archivos. Caché acotada
// de padres: Dictionary consulta O(1) promedio y evita repetir toda la ascendencia.
const script = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
$cache = [System.Collections.Generic.Dictionary[string,bool]]::new([System.StringComparer]::OrdinalIgnoreCase)
while (($line = [Console]::ReadLine()) -ne $null) {
  try {
    $path = ConvertFrom-Json -InputObject $line
    $hidden = $false
    $current = $path
    # Windows marca la raíz del volumen Hidden/System: no convierte todos sus
    # descendientes en ocultos. Solo se consideran archivos y carpetas bajo ella.
    $root = [System.IO.Path]::GetPathRoot($path)
    while ($current -and $current -ne $root) {
      if ($current -ne $path -and $cache.ContainsKey($current)) {
        $hidden = $cache[$current]
        break
      }
      try {
        $attributes = [System.IO.File]::GetAttributes($current)
        if (($attributes -band [System.IO.FileAttributes]::Hidden) -ne 0) {
          $hidden = $true
          break
        }
      } catch [System.IO.FileNotFoundException] {} catch [System.IO.DirectoryNotFoundException] {} catch [System.UnauthorizedAccessException] {}
      $parent = [System.IO.Path]::GetDirectoryName($current)
      if ($parent -eq $current) { break }
      $current = $parent
    }
    $parent = [System.IO.Path]::GetDirectoryName($path)
    # No cachear el padre a partir de un archivo oculto: la señal puede ser solo suya.
    if (-not $hidden -and $parent) {
      if ($cache.Count -ge 512) { $cache.Clear() }
      $cache[$parent] = $false
    }
    [Console]::WriteLine((@{ hidden = $hidden } | ConvertTo-Json -Compress))
  } catch {
    [Console]::WriteLine('{"error":true}')
  }
}
`;

export class HiddenPathReader {
  private child?: ChildProcessWithoutNullStreams;
  private pending?: {
    resolve(value: boolean): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  };
  private closed = false;

  async isHidden(path: string): Promise<boolean> {
    if (this.closed) throw new Error('Consulta de atributos cerrada.');
    if (process.platform !== 'win32')
      return path
        .split('/')
        .some((part) => part.startsWith('.') && part !== '.' && part !== '..');
    if (this.pending)
      throw new Error('La consulta de atributos debe ser secuencial.');
    if (!this.child) {
      const env = { ...process.env };
      delete env.CYBERSOC_ANTHROPIC_API_KEY;
      this.child = spawn(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
        {
          windowsHide: true,
          shell: false,
          stdio: 'pipe',
          env,
        },
      );
      const lines = createInterface({
        input: this.child.stdout,
        crlfDelay: Infinity,
      });
      lines.on('line', (line) => {
        const pending = this.pending;
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending = undefined;
        try {
          pending.resolve(
            z.strictObject({ hidden: z.boolean() }).parse(JSON.parse(line))
              .hidden,
          );
        } catch {
          pending.reject(
            new Error('No se pudieron consultar los atributos de Windows.'),
          );
        }
      });
      this.child.once('error', () => this.close());
      this.child.once('exit', () => {
        lines.close();
        this.close();
      });
      this.child.stdin.on('error', () => this.close());
      this.child.stderr.resume();
    }
    return new Promise((resolve, reject) => {
      this.pending = {
        resolve,
        reject,
        timer: setTimeout(() => this.close(), 10_000),
      };
      this.child!.stdin.write(`${JSON.stringify(path)}\n`);
    });
  }

  close(): void {
    this.closed = true;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new Error('Consulta de atributos interrumpida.'));
      this.pending = undefined;
    }
    this.child?.kill();
  }
}
