import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { link, mkdir, open, unlink, type FileHandle } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { assertNoLinks, exists, QuarantineError } from './paths';

const CHUNK = 1024 * 1024;
const HEADER_SIZE = 17; // CSQ1 (4) + versión 1 (1) + IV aleatorio (12).
const TAG_SIZE = 16; // Tag GCM al final; permite recuperar PENDING sin depender del último UPDATE.
export interface VaultKey {
  keyB64: string;
  ivB64: string;
}
export interface VaultItem extends VaultKey {
  id: string;
  sha256: string;
  sizeBytes: number;
  authTagB64: string | null;
}

export async function writeAll(file: FileHandle, data: Buffer): Promise<void> {
  let offset = 0;
  while (offset < data.length) {
    const { bytesWritten } = await file.write(
      data,
      offset,
      data.length - offset,
    );
    if (!bytesWritten) throw new Error('Escritura incompleta.');
    offset += bytesWritten;
  }
}
/** Lectura acotada; posiciones explícitas permiten volver a verificar el mismo descriptor. */
export async function* chunks(file: FileHandle, start = 0, end = Infinity) {
  const buffer = Buffer.alloc(CHUNK);
  for (let position = start; position < end;) {
    const { bytesRead } = await file.read(
      buffer,
      0,
      Math.min(CHUNK, end - position),
      position,
    );
    if (!bytesRead) break;
    position += bytesRead;
    yield buffer.subarray(0, bytesRead);
  }
}
export async function hashFile(file: FileHandle): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of chunks(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** Formato CSQ1 v1: cabecera autenticada como AAD, ciphertext y tag de 16 bytes.
 * Nunca se carga el archivo completo. La clave por ítem está en SQLite: neutralización,
 * no secreto frente a quien acceda al perfil. No se cambian ACL ni asociaciones de archivos.
 */
export class QuarantineVault {
  readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }
  key(): VaultKey {
    return {
      keyB64: randomBytes(32).toString('base64'),
      ivB64: randomBytes(12).toString('base64'),
    };
  }
  path(id: string, temporary = false): string {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        id,
      )
    )
      throw new QuarantineError(
        'INVALID_ITEM',
        'Identificador de bóveda inválido.',
      );
    return join(this.root, `${id}.csq${temporary ? '.tmp' : ''}`);
  }
  async initialize(): Promise<void> {
    let parent = this.root;
    while (!(await exists(parent))) parent = dirname(parent);
    await assertNoLinks(parent);
    await mkdir(this.root, { recursive: true });
    await assertNoLinks(this.root);
  }
  async check(): Promise<void> {
    await assertNoLinks(this.root);
  }
  async remove(id: string, temporary = false): Promise<void> {
    await this.check();
    const path = this.path(id, temporary);
    if (!(await exists(path))) return;
    await assertNoLinks(path);
    await unlink(path);
  }
  async encrypt(file: FileHandle, item: VaultItem): Promise<string> {
    await this.check();
    const header = Buffer.concat([
      Buffer.from('CSQ1'),
      Buffer.from([1]),
      Buffer.from(item.ivB64, 'base64'),
    ]);
    const cipher = createCipheriv(
      'aes-256-gcm',
      Buffer.from(item.keyB64, 'base64'),
      Buffer.from(item.ivB64, 'base64'),
    );
    cipher.setAAD(header);
    const output = await open(this.path(item.id, true), 'wx', 0o600);
    try {
      await writeAll(output, header);
      for await (const chunk of chunks(file))
        await writeAll(output, cipher.update(chunk));
      await writeAll(output, cipher.final());
      await writeAll(output, cipher.getAuthTag());
      await output.sync();
    } finally {
      await output.close();
    }
    const tag = await this.verify(item, true);
    // Publicación sin reemplazo, equivalente a mover dentro del mismo volumen.
    // link es atómico y falla si existe el destino; rename podría sobrescribirlo.
    await this.check();
    await link(this.path(item.id, true), this.path(item.id));
    await unlink(this.path(item.id, true));
    return tag;
  }
  async verify(item: VaultItem, temporary = false): Promise<string> {
    return this.decrypt(item, undefined, temporary);
  }
  /** Descifra a un descriptor temporal exclusivo, o solo verifica sin escribir plaintext. */
  async decrypt(
    item: VaultItem,
    output?: FileHandle,
    temporary = false,
  ): Promise<string> {
    await this.check();
    const path = this.path(item.id, temporary);
    await assertNoLinks(path);
    const file = await open(path, 'r');
    try {
      const info = await file.stat();
      if (
        !info.isFile() ||
        info.size !== HEADER_SIZE + item.sizeBytes + TAG_SIZE
      )
        throw new QuarantineError('CORRUPT_BLOB', 'Tamaño de blob inválido.');
      const header = Buffer.alloc(HEADER_SIZE);
      const tag = Buffer.alloc(TAG_SIZE);
      await file.read(header, 0, header.length, 0);
      await file.read(tag, 0, tag.length, info.size - TAG_SIZE);
      if (
        header.subarray(0, 4).toString() !== 'CSQ1' ||
        header[4] !== 1 ||
        !header.subarray(5).equals(Buffer.from(item.ivB64, 'base64')) ||
        (item.authTagB64 !== null && tag.toString('base64') !== item.authTagB64)
      )
        throw new QuarantineError(
          'CORRUPT_BLOB',
          'Cabecera o tag de blob inválido.',
        );
      const decipher = createDecipheriv(
        'aes-256-gcm',
        Buffer.from(item.keyB64, 'base64'),
        header.subarray(5),
      );
      decipher.setAAD(header);
      decipher.setAuthTag(tag);
      const hash = createHash('sha256');
      for await (const chunk of chunks(
        file,
        HEADER_SIZE,
        info.size - TAG_SIZE,
      )) {
        const plain = decipher.update(chunk);
        hash.update(plain);
        if (output) await writeAll(output, plain);
      }
      const final = decipher.final(); // GCM debe autenticar ANTES de publicar un archivo restaurado.
      hash.update(final);
      if (output) await writeAll(output, final);
      if (hash.digest('hex') !== item.sha256)
        throw new QuarantineError(
          'HASH_MISMATCH',
          'El blob no coincide con el SHA-256 original.',
        );
      if (output) await output.sync();
      return tag.toString('base64');
    } finally {
      await file.close();
    }
  }
}
