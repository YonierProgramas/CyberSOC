# Sprint 1 — Escaneo real de archivos

| Campo | Valor |
|---|---|
| Fechas | 7 – 16 oct 2026 |
| Depende de | S0 (protocolo, BD, Queue, Stack) |
| Tag al cerrar | `v0.1.0-s1` |
| Carriles | A: core, IPC, UI · B: motor Python · Ambos: contrato del día 1 e integración |

## Antes de empezar

- [ ] S0 cerrado con tag `v0.0.0-s0` y `cierre.md` escrito.
- [ ] Pendientes de S0 revisados.
- [ ] Contrato `scan.file` acordado el día 1 (tarea T1.1).
- [ ] Tarjetas creadas en `tareas/`.

## Objetivo

Demostrar el pipeline real de extremo a extremo:

**Usuario selecciona una carpeta real → se descubren archivos → Queue → Python calcula SHA-256 → ScanResult → TypeScript actualiza el estado → SQLite registra → la UI muestra el progreso y los resultados.**

En este sprint todavía no hay motor de detección, así que el veredicto siempre se muestra como **"Sin evaluar"**, nunca como "Limpio".

## Historias de usuario

- **HU-S1-01.** Como usuario, quiero seleccionar una carpeta real y escanearla.
- **HU-S1-02.** Como usuario, quiero seleccionar un único archivo y escanearlo.
- **HU-S1-03.** Como usuario, quiero ver el progreso: descubiertos, analizados, errores, omitidos y archivo actual.
- **HU-S1-04.** Como usuario, quiero cancelar un escaneo sin dejar la aplicación en un estado inconsistente.
- **HU-S1-05.** Como usuario, quiero ver cada archivo con su SHA-256 y su estado.
- **HU-S1-06.** Como usuario, quiero que el escaneo quede en el historial y siga visible después de reiniciar.
- **HU-S1-07.** Como usuario, quiero que los archivos inaccesibles no detengan el escaneo.

## Entregables (en orden)

- [ ] **T1.1 [A+B, día 1]** Contrato `scan.file`: mensajes de referencia de éxito, `ACCESS_DENIED`, `SKIPPED` y nombre con ñ; esquemas zod y pydantic.
- [ ] **T1.2 [B]** `FileInspector`:
  - `stat` y atributos;
  - omite placeholders de OneDrive (atributo de recall) y archivos mayores al máximo;
  - abre en modo `rb`;
  - calcula `sha256` en streaming con chunks de 1 MiB;
  - mapea errores a códigos.
- [ ] **T1.3 [B]** Handler `scan.file` + pruebas Python + generador de fixtures `tests/fixtures/generate.py`.
- [ ] **T1.4 [A]** Migración 002 + `ScanJobRepository` + `ScanResultRepository`.
- [ ] **T1.5 [A]** `ScanJob` (máquina de estados) + `FileDiscovery` (DFS con Stack, Set de visitados, sin seguir symlinks ni junctions, exclusiones) + pruebas.
- [ ] **T1.6 [A]** `ScanQueue` acotada + `ScanOrchestrator`:
  - productor y consumidor en paralelo;
  - cancelación con `AbortController`;
  - supervisión y reinicio del motor (máximo 3 por trabajo);
  - `ProgressThrottle`;
  - pruebas con un `FakeEngineClient`.
- [ ] **T1.7 [A]** IPC `dialog.*` y `scan.*` + preload tipado + validación zod en main.
- [ ] **T1.8 [A/B]** UI:
  - pantalla de escaneo (seleccionar archivo o carpeta, progreso, cancelar);
  - tabla de resultados paginada;
  - lista de historial.
- [ ] **T1.9 [A+B]** Integración real + verificación cruzada de hashes (TS con `node:crypto` contra Python).
- [ ] **T1.10 [Carril IA]** Esquemas `ai-context/v1` y `ai-assessment/v1` (ver plan de S2) + `AIContextBuilder` v0, solo con los hechos del archivo y pruebas unitarias, sin UI.
- [ ] **T1.11** Pruebas manuales, evidencias, fichas (Set, Queue acotada, comparación DFS/BFS opcional), cierre y tag.

## Especificaciones clave

### Reglas del escaneo

- Un solo escaneo activo a la vez. Un segundo `scan.start` se rechaza con un mensaje.
- La `ScanQueue` tiene capacidad acotada (por ejemplo 1 000). Si está llena, el productor espera (backpressure).
- Mientras dura el descubrimiento, el progreso es indeterminado y muestra contadores. Cuando termina, se muestra el porcentaje.
- Los eventos de progreso se limitan a unos 5 por segundo.
- La cancelación es por archivo: el archivo en curso termina, el productor se detiene, la cola se vacía y el trabajo queda `CANCELLED`.
- El timeout por archivo es una base fija más una parte proporcional al tamaño. Si vence, la tarea queda `TIMEOUT` y el motor se reinicia.
- Si el motor se cae, la tarea queda `ENGINE_CRASHED`, el motor se reinicia (máximo 3 veces por trabajo) y el escaneo continúa. Al cuarto fallo el trabajo queda `FAILED` con mensaje.
- Los errores de archivo son resultados (`status: ERROR`), no fallas del motor.

### Contratos TypeScript

```ts
type ScanJobStatus = 'CREATED'|'DISCOVERING'|'SCANNING'|'CANCELLING'|'CANCELLED'|'COMPLETED'|'FAILED';
type FileScanStatus = 'SCANNED'|'ERROR'|'SKIPPED';
type FileErrorCode = 'FILE_NOT_FOUND'|'ACCESS_DENIED'|'FILE_LOCKED'|'IO_ERROR'
                   |'TOO_LARGE'|'CLOUD_PLACEHOLDER'|'TIMEOUT'|'ENGINE_CRASHED';

interface FileTask { jobId: string; taskId: string; seq: number; path: string; }
interface ScanFileParams { jobId: string; taskId: string; path: string; options: { maxBytes: number } }
interface EngineResult {
  taskId: string; status: FileScanStatus;
  file?: { name: string; extension: string | null; sizeBytes: number; modifiedAt: string };
  hashes?: { sha256: string };
  evidence: unknown[];                         // vacío en S1; se define en S2
  error?: { code: FileErrorCode; message: string };
  durationMs: number; engineVersion: string;
}
interface ScanProgress {
  jobId: string; status: ScanJobStatus; discovered: number; processed: number;
  errors: number; skipped: number; discoveryDone: boolean; percent: number | null;
  currentPath?: string; elapsedMs: number;
}

// window.cybersoc (preload)
dialog: { selectFolder(): Promise<string | null>; selectFile(): Promise<string | null> };
scan: {
  start(t: { kind: 'FILE' | 'FOLDER'; path: string }): Promise<{ jobId: string }>;
  cancel(jobId: string): Promise<void>;
  getJob(jobId: string): Promise<ScanJobDTO>;
  listJobs(limit?: number): Promise<ScanJobDTO[]>;
  listResults(q: { jobId: string; offset: number; limit: number }): Promise<Page<ScanResultDTO>>;
  onProgress(cb: (p: ScanProgress) => void): () => void;   // devuelve función para desuscribirse
  onFinished(cb: (j: ScanJobDTO) => void): () => void;
};
```

### Mensajes de referencia `scan.file`

```json
→ {"jsonrpc":"2.0","id":42,"method":"scan.file","params":{"jobId":"j_7f","taskId":"t_12","path":"C:\\Users\\ana\\Documentos\\Año 2026\\informe_económico.pdf","options":{"maxBytes":536870912}}}
← {"jsonrpc":"2.0","id":42,"result":{"taskId":"t_12","status":"SCANNED","file":{"name":"informe_económico.pdf","extension":".pdf","sizeBytes":183244,"modifiedAt":"2026-09-20T14:03:11Z"},"hashes":{"sha256":"<64 hex>"},"evidence":[],"durationMs":4,"engineVersion":"0.1.0"}}
← {"jsonrpc":"2.0","id":43,"result":{"taskId":"t_13","status":"ERROR","error":{"code":"ACCESS_DENIED","message":"Permiso denegado"},"evidence":[],"durationMs":1,"engineVersion":"0.1.0"}}
← {"jsonrpc":"2.0","id":44,"result":{"taskId":"t_14","status":"SKIPPED","error":{"code":"CLOUD_PLACEHOLDER","message":"Archivo de OneDrive no descargado"},"evidence":[],"durationMs":0,"engineVersion":"0.1.0"}}
```

### Migración 002

```sql
CREATE TABLE scan_jobs (
  id TEXT PRIMARY KEY,
  target_path TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('FILE','FOLDER')),
  status TEXT NOT NULL CHECK (status IN ('CREATED','DISCOVERING','SCANNING','CANCELLING','CANCELLED','COMPLETED','FAILED')),
  files_discovered INTEGER NOT NULL DEFAULT 0,
  files_processed  INTEGER NOT NULL DEFAULT 0,
  files_error      INTEGER NOT NULL DEFAULT 0,
  files_skipped    INTEGER NOT NULL DEFAULT 0,
  bytes_processed  INTEGER NOT NULL DEFAULT 0,
  engine_version TEXT,
  protocol_version TEXT,
  metrics_json TEXT,            -- pico de pila y cola, tiempo bloqueado del productor, duración por fase
  error_message TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);

CREATE TABLE scan_results (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES scan_jobs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  path TEXT NOT NULL,
  file_name TEXT NOT NULL,
  extension TEXT,
  size_bytes INTEGER,
  modified_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('SCANNED','ERROR','SKIPPED')),
  sha256 TEXT CHECK (sha256 IS NULL OR length(sha256) = 64),
  verdict TEXT NOT NULL DEFAULT 'NOT_EVALUATED'
    CHECK (verdict IN ('NOT_EVALUATED','CLEAN','SUSPICIOUS','DETECTED','NOT_ANALYZED')),
  error_code TEXT,
  error_message TEXT,
  duration_ms INTEGER,
  scanned_at TEXT NOT NULL,
  UNIQUE (job_id, seq)
);
CREATE INDEX idx_results_job    ON scan_results(job_id);
CREATE INDEX idx_results_sha256 ON scan_results(sha256);
```

### Clases del sprint

| Clase / módulo | Responsabilidad | Métodos clave |
|---|---|---|
| `ScanJob` | Estado del trabajo; lanza un error ante una transición inválida | `beginDiscovery`, `beginScanning`, `requestCancel`, `markCancelled`, `complete`, `fail` |
| `FileDiscovery` | DFS iterativo con Stack, Set de visitados, exclusiones | `discover(root, opts, signal): AsyncIterable<DiscoveredFile>`; estadísticas: `peakStackSize`, `dirsVisited`, `skippedLinks` |
| `ScanQueue` | Cola acotada productor-consumidor sobre `Queue<T>` | `put` (espera si está llena), `take` (espera si está vacía), `close`, `drain`; `peakSize` |
| `ScanOrchestrator` | Ciclo de vida del trabajo, coordinación, progreso | `start(target)`, `cancel(jobId)`; eventos `progress`, `finished` |
| `ProgressThrottle` | Limitar los eventos hacia la UI | `push(progress)` |
| `ScanJobRepository` / `ScanResultRepository` | SQL con sentencias preparadas | `create`, `updateStatus`, `updateCounters`, `get`, `listRecent`, `insertResult`, `listByJob` |
| Python `FileInspector` | Stat, atributos, apertura segura | `inspect(path, opts)` |
| Python `hashing` | Hash en streaming | `sha256_stream(fh, chunk=1 MiB)` |

### Archivos nuevos esperados

- **Python:** `analysis/file_inspector.py`, `analysis/hashing.py`, `models.py`, `errors.py`, handler en `rpc/handlers.py`; pruebas `test_hashing.py`, `test_file_inspector.py`, `test_scan_file.py`, `tests/fixtures/generate.py`.
- **TS:**
  - `core/domain/` (`ScanJob.ts`, `types.ts`);
  - `core/scan/` (`FileDiscovery.ts`, `ScanQueue.ts`, `ScanOrchestrator.ts`, `ProgressThrottle.ts`);
  - `core/persistence/` (`migrations/002_scans.ts`, `ScanJobRepository.ts`, `ScanResultRepository.ts`);
  - `core/ai/` (`schemas.ts`, `AIContextBuilder.ts`);
  - `main/ipc/` (`scan.ipc.ts`, `dialog.ipc.ts`);
  - `renderer/src/pages/` (`ScanPage.tsx`, `HistoryPage.tsx`);
  - `renderer/src/components/` (`ProgressPanel.tsx`, `ResultsTable.tsx`).
- **Contratos:** `contracts/protocol-v1/scan.file.*.json`.

## Estructuras de datos del sprint

| Estructura | Uso | Evidencia |
|---|---|---|
| Stack | DFS iterativo en `FileDiscovery` | `peakStackSize` guardado en `metrics_json` y mostrado en el detalle del escaneo |
| Queue acotada | Productor-consumidor con backpressure | `peakSize` y tiempo bloqueado del productor |
| Set | Rutas reales visitadas (junctions que crean ciclos) | Prueba con una junction que apunta a su carpeta padre |
| Map | Peticiones RPC pendientes; trabajos activos | Pruebas del cliente |
| Opcional | Comparar DFS (Stack) contra BFS (Queue) sobre el mismo árbol | Tabla con frontera máxima y orden de visita |

## Pruebas

**Unitarias TS**

- [ ] `FileDiscovery` sobre carpetas temporales reales: anidadas, vacías, nombres con ñ, tildes y emoji, profundidad de más de 50 niveles.
- [ ] `FileDiscovery`: una junction con ciclo termina, y los enlaces no se siguen.
- [ ] `ScanJob`: transiciones válidas e inválidas.
- [ ] `ScanOrchestrator` con `FakeEngineClient`:
  - orden FIFO;
  - cancelación a mitad;
  - errores contados;
  - motor caído y reiniciado;
  - eventos de progreso.
- [ ] Repositorios sobre una BD temporal.

**Unitarias Python**

- [ ] SHA-256 de un archivo vacío = `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
- [ ] SHA-256 de `"abc"` = `ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad`.
- [ ] Un archivo de 50 MB en streaming da el mismo hash que leído completo.
- [ ] Ruta inexistente → `FILE_NOT_FOUND`.
- [ ] Permiso denegado (simulado) → `ACCESS_DENIED`.
- [ ] Rutas Unicode.
- [ ] Archivo mayor al máximo → `SKIPPED/TOO_LARGE`.

**Integración**

- [ ] Motor real + SQLite temporal + carpeta de 25 fixtures → 25 filas con hashes que coinciden con `node:crypto`.
- [ ] Contratos `scan.file` validados en ambos lados.

**Manuales**

- [ ] Escanear una carpeta real (por ejemplo Documentos) y verificar el hash de un archivo con `certutil -hashfile`.
- [ ] Cancelar a mitad del escaneo.
- [ ] Reiniciar la app y ver el historial.
- [ ] Abrir un archivo en Excel (queda bloqueado) y escanear: debe aparecer como error y el escaneo continúa.
- [ ] Escanear una carpeta con unos 5 000 archivos y medir archivos por segundo.

## Criterios de aceptación

- [ ] **CA-1.1** Una carpeta de fixtures con 25 archivos en 3 niveles (con ñ, tildes y emoji) produce 25 resultados, con SHA-256 idéntico al de `node:crypto`, y el trabajo queda `COMPLETED`.
- [ ] **CA-1.2** El progreso se actualiza al menos una vez por segundo, y los contadores finales coinciden con las filas en la BD.
- [ ] **CA-1.3** Al cancelar a mitad, el trabajo queda `CANCELLED` como máximo 2 s después de terminar el archivo en curso. No se insertan resultados posteriores y el motor sigue respondiendo a `ping`.
- [ ] **CA-1.4** Un archivo bloqueado o sin permiso queda `ERROR` con su código, y el escaneo continúa.
- [ ] **CA-1.5** Después de reiniciar la app, el trabajo y sus resultados se ven en el historial.
- [ ] **CA-1.6** Una junction con ciclo no provoca un bucle infinito, y los enlaces no se siguen.
- [ ] **CA-1.7** Si se mata Python durante un escaneo, la tarea queda `ENGINE_CRASHED`, el motor se reinicia y el escaneo continúa (máximo 3 reinicios, después `FAILED`).
- [ ] **CA-1.8** Toda la UI muestra "Sin evaluar". Nunca aparece "Limpio".
- [ ] **CA-1.9** Los archivos escaneados no se modifican: mismo `mtime` y mismo hash antes y después.
- [ ] **CA-1.10** Un escaneo de unos 5 000 archivos termina sin congelar la UI, y los archivos por segundo quedan registrados.
- [ ] **CA-1.11** El escaneo de un único archivo funciona igual que el de una carpeta.

## Evidencias a guardar (`evidencias/`)

- [ ] Video corto: escaneo, progreso y cancelación.
- [ ] Comparación del hash de un archivo con `certutil -hashfile`.
- [ ] Salida de una consulta SQL sobre `scan_jobs` y `scan_results`.
- [ ] `metrics_json` con el pico de la pila y de la cola.
- [ ] Medición de archivos por segundo.
- [ ] Reportes de pruebas y captura del CI.
- [ ] Fichas `set.md` y actualización de `queue.md` (versión acotada).

## Riesgos a vigilar

- Codificación de rutas: UTF-8 explícito en ambos lados.
- Rutas de más de 260 caracteres: se registran como error.
- OneDrive: omitir los placeholders para no provocar descargas.
- Defender puede ralentizar la lectura.
- Tabla de resultados con miles de filas: paginar.

## Fuera de alcance

Detección (firmas, reglas, heurística), veredictos, llamadas a IA, cuarentena.

## Al cerrar

Completar `cierre.md`, crear el tag `v0.1.0-s1` y actualizar `00-ESTADO.md`.
