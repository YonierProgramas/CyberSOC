import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { win32 } from 'node:path';
import { windowsPowerShellPath } from './windows-tools';

// A single process per scan. It receives each path as UTF-8 Base64 via stdin, never
// as code. It only queries attributes; it neither opens content nor modifies files. Cache
// bounded by parents: Dictionary lookup is O(1) average and avoids repeating the ancestry.
// Uses only .NET and operators, no cmdlets: with the minimal environment there is no
// module analysis cache and ConvertFrom-Json autoloading could walk all installed
// modules and exceed the 10 s deadline (Windows CI failure B12-03).
export const hiddenPathScript = `
$ErrorActionPreference = 'Stop'
$cache = [System.Collections.Generic.Dictionary[string,bool]]::new([System.StringComparer]::OrdinalIgnoreCase)
while (($line = [Console]::ReadLine()) -ne $null) {
  try {
    $path = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($line))
    $hidden = $false
    $current = $path
    # Windows marks the volume root Hidden/System: that does not make all its
    # descendants hidden. Only files and folders below it are considered.
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
    # Do not cache the parent from a hidden file: the signal may be its own only.
    if (-not $hidden -and $parent) {
      if ($cache.Count -ge 512) { $cache.Clear() }
      $cache[$parent] = $false
    }
    if ($hidden) { [Console]::WriteLine('{"hidden":true}') } else { [Console]::WriteLine('{"hidden":false}') }
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
      const executable = windowsPowerShellPath();
      const system32 = win32.dirname(win32.dirname(win32.dirname(executable)));
      const env = {
        SystemRoot: win32.dirname(system32),
        WINDIR: win32.dirname(system32),
        PATH: system32,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
      };
      this.child = spawn(
        executable,
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          hiddenPathScript,
        ],
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
      this.child!.stdin.write(
        `${Buffer.from(path, 'utf8').toString('base64')}\n`,
      );
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
