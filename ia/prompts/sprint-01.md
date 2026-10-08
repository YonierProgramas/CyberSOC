# Prompts — Sprint 1: Escaneo real (7 – 16 oct)

Plan: `construccion/sprints/sprint-01-escaneo-real/plan.md` · Reglas: `construccion/ia/asignacion-agentes.md`

**Antes de pegar cualquier prompt:** si en S0 cambió algún nombre de archivo, clase o ruta, corríjanlo en el prompt.

**Reportes de los agentes:** guárdenlos en `construccion/sprints/sprint-01-escaneo-real/tareas/T1.X-reporte.md`.

| Tarea | Qué | Agente | Revisa | Rama | Depende de |
|---|---|---|---|---|---|
| T1.1 | Contrato `scan.file` | Codex (nube) | Ustedes (ambos) | `s1/feat-contract-scan-file` | — |
| T1.2 | FileInspector + SHA-256 + handler + fixtures | Codex (local) | Cursor | `s1/feat-engine-scan-file` | T1.1 |
| T1.3 | Migración 002 + repositorios | Codex (nube) | Cursor | `s1/feat-scan-repos` | T1.1 |
| T1.4 | `ScanJob` (máquina de estados) | Codex (nube) | Cursor | `s1/feat-scan-job` | T1.1 |
| T1.5 | `FileDiscovery` (DFS con Stack + Set) | **Ustedes** + Cursor (tutor) | Codex | `s1/feat-file-discovery` | — |
| T1.6 | `ScanQueue` + `ScanOrchestrator` | Codex (local) | **Claude Code [CRÍTICO]** | `s1/feat-scan-orchestrator` | T1.3, T1.4, T1.5 |
| T1.7 | IPC `dialog.*` y `scan.*` + preload | Codex (local) | **Claude Code [CRÍTICO]** | `s1/feat-scan-ipc` | T1.6 |
| T1.8 | UI: escaneo, progreso, resultados, historial | Cursor | Codex | `s1/feat-scan-ui` | T1.7 |
| T1.9 | Integración real + hash cruzado + rendimiento | Codex (local) | Cursor | `s1/test-integration` | T1.2, T1.7 |
| T1.10 | Esquemas IA + AIContextBuilder v0 | Claude Code | Codex | `s1/feat-ai-context-v0` | — |
| T1.11 | Evidencias, fichas, informe de entrega y tag | Ustedes + ChatGPT/Claude Chat | — | `s1/docs-entrega` | Todo |

**Orden sugerido:**
- Día 1: T1.1, con ambos.
- Persona B: T1.2 → T1.9.
- Persona A: T1.3 y T1.4 (Codex en la nube, en paralelo) → T1.6 → T1.7 → T1.8.
- Ambos: T1.5 mientras Codex trabaja.
- Claude Code: T1.10 en cualquier momento; al final, una sola sesión revisa T1.6 y T1.7 juntas.

---

## T1.1 — Contrato `scan.file` · Codex (nube)

```text
Lee AGENTS.md, construccion/00-ESTADO.md y construccion/sprints/sprint-01-escaneo-real/plan.md
(secciones "Contratos TypeScript" y "Mensajes de referencia scan.file").
Tarea T1.1 — Contrato scan.file. Rama: s1/feat-contract-scan-file.
Alcance:
1. CyberSOC/contracts/protocol-v1/ con estos ejemplos:
   - scan.file.request.json;
   - scan.file.response.scanned.json (nombre con ñ y tildes);
   - scan.file.response.error-access-denied.json;
   - scan.file.response.skipped-cloud.json;
   - scan.file.response.skipped-too-large.json.
2. TS: esquemas zod de ScanFileParams y EngineResult en src/shared/protocol.ts, y los tipos del plan
   (FileScanStatus, FileErrorCode, FileTask) en src/core/domain/types.ts.
3. Python: modelos pydantic equivalentes en cybersoc_engine/models.py.
4. Pruebas de contrato en ambos lados sobre los nuevos ejemplos.
Archivos permitidos: CyberSOC/contracts/**, app/src/shared/protocol.ts, app/src/core/domain/types.ts, app/tests/**,
engine/src/cybersoc_engine/models.py, engine/tests/test_contracts.py.
Terminado cuando: ambos lados validan todos los ejemplos, y alterar un campo obligatorio hace fallar ambas pruebas.
Entrega el reporte de construccion/ia/reglas-agentes.md. No hagas merge.
```

## T1.2 — FileInspector + SHA-256 + handler `scan.file` · Codex (local)

Local porque usa atributos de archivo de Windows (placeholders de OneDrive, permisos, bloqueos).

```text
Lee AGENTS.md y construccion/sprints/sprint-01-escaneo-real/plan.md (T1.2 y la sección "Reglas del escaneo").
Tarea T1.2 — FileInspector + SHA-256 + handler scan.file. Rama: s1/feat-engine-scan-file.
Alcance:
1. analysis/file_inspector.py:
   - stat y atributos (st_file_attributes en Windows);
   - omitir placeholders de OneDrive (atributos de recall/offline) → SKIPPED/CLOUD_PLACEHOLDER;
   - archivos mayores a options.maxBytes → SKIPPED/TOO_LARGE;
   - abrir SIEMPRE en modo 'rb'.
2. analysis/hashing.py: sha256_stream(fh, chunk=1 MiB).
3. errors.py: mapear FileNotFoundError → FILE_NOT_FOUND, PermissionError → ACCESS_DENIED,
   archivo bloqueado (winerror 32/33) → FILE_LOCKED, otros OSError → IO_ERROR.
   Un error de archivo es un RESULTADO (status ERROR), no un error JSON-RPC.
4. Handler scan.file en rpc/handlers.py; evidence siempre [] en S1.
5. tests/fixtures/generate.py: genera en una carpeta temporal 25 archivos benignos en 3 niveles,
   con nombres que incluyan ñ, tildes y un emoji. Sin EICAR ni contenido ejecutable.
6. Pruebas pytest:
   - SHA-256 de un archivo vacío y de "abc" (valores del plan);
   - 50 MB en streaming dan el mismo hash que leer todo el archivo;
   - ruta inexistente; permiso denegado (simulado); rutas Unicode; tamaño máximo.
Archivos permitidos: CyberSOC/engine/**.
No hagas: escribir, mover ni borrar archivos del usuario; usar la red.
Terminado cuando: uv run pytest y uv run ruff check pasan en Windows.
Entrega el reporte de construccion/ia/reglas-agentes.md. No hagas merge.
```

## T1.3 — Migración 002 + repositorios · Codex (nube)

```text
Lee AGENTS.md, construccion/decisiones/ADR-002* y construccion/sprints/sprint-01-escaneo-real/plan.md
(secciones "Migración 002" y "Clases del sprint").
Tarea T1.3 — Migración 002 + repositorios. Rama: s1/feat-scan-repos.
Alcance:
1. src/core/persistence/migrations/002_scans.ts: exactamente el SQL del plan, con la librería de SQLite de ADR-002.
2. ScanJobRepository: create, updateStatus, updateCounters, get, listRecent.
3. ScanResultRepository: insertResult (dentro de una transacción) y listByJob(jobId, offset, limit).
4. SQL explícito con sentencias preparadas; sin ORM.
5. Pruebas con una BD temporal: crear un trabajo, insertar resultados, paginar,
   CHECK de estados inválidos, borrado en cascada.
Archivos permitidos: CyberSOC/app/src/core/persistence/**, CyberSOC/app/tests/**.
Terminado cuando: las pruebas pasan y la migración 002 se aplica sobre una BD en versión 1.
Entrega el reporte de construccion/ia/reglas-agentes.md. No hagas merge.
```

## T1.4 — `ScanJob` · Codex (nube)

```text
Lee construccion/sprints/sprint-01-escaneo-real/plan.md (secciones "Clases del sprint" y "Reglas del escaneo").
Tarea T1.4 — ScanJob. Rama: s1/feat-scan-job.
1. src/core/domain/ScanJob.ts: entidad con los estados del plan y los métodos beginDiscovery, beginScanning,
   requestCancel, markCancelled, complete y fail(reason). Una transición inválida lanza un error.
   Guarda contadores y timestamps.
2. Pruebas: todas las transiciones válidas y las inválidas relevantes, en una tabla de casos.
Archivos permitidos: src/core/domain/ScanJob.ts, tests/**.
Terminado cuando: las pruebas pasan con cobertura ≥ 90 % en ScanJob.
Entrega el reporte de construccion/ia/reglas-agentes.md. No hagas merge.
```

## T1.5 — `FileDiscovery` · Ustedes + Cursor como tutor

**La escriben ustedes**, porque es la evidencia principal de Stack y Set. La ficha precompletada (`entrega/fichas/stack-dfs.md`) explica el algoritmo paso a paso.

```text
Voy a implementar YO FileDiscovery en CyberSOC/app/src/core/scan/FileDiscovery.ts, según
construccion/sprints/sprint-01-escaneo-real/plan.md (sección "Clases del sprint"), usando MI Stack<T> y un Set:
- DFS iterativo;
- sin seguir symlinks ni junctions (lstat);
- Set de rutas reales visitadas (normalizadas a minúsculas);
- exclusiones;
- AbortSignal para cancelar entre pasos;
- estadísticas peakStackSize, dirsVisited y skippedLinks.
Devuelve un AsyncIterable de archivos descubiertos.
No escribas la implementación completa. Actúa como tutor:
- revisa mi código;
- señala casos borde: carpetas sin permiso, junction que apunta a su carpeta padre, rutas con ñ, más de 50 niveles;
- propón pruebas Vitest con carpetas temporales reales.
Para crear junctions en las pruebas: fs.symlink(target, path, 'junction'). No requiere admin.
Opcional: agregar una estrategia 'bfs' con mi Queue y comparar la frontera máxima.
```

Después: revisión por Codex con la plantilla general de `asignacion-agentes.md`.

## T1.6 — `ScanQueue` + `ScanOrchestrator` · Codex (local) · [CRÍTICO]

```text
Lee AGENTS.md y construccion/sprints/sprint-01-escaneo-real/plan.md (secciones "Reglas del escaneo" y "Clases del sprint").
Tarea T1.6 — ScanQueue + ScanOrchestrator. Rama: s1/feat-scan-orchestrator.
Alcance:
1. src/core/scan/ScanQueue.ts: cola ACOTADA productor-consumidor construida SOBRE la Queue<T> del equipo
   (src/core/structures/Queue.ts, sin modificarla).
   - put espera si está llena; take espera si está vacía; close y drain;
   - capacidad desde AppConfig (scan.queueCapacity);
   - métricas: peakSize y tiempo que el productor pasó bloqueado.
2. src/core/scan/ProgressThrottle.ts: máximo ~5 eventos por segundo.
3. src/core/scan/ScanOrchestrator.ts:
   - start(target) → jobId; cancel(jobId); eventos progress y finished;
   - FileDiscovery (del equipo) como productor y el motor como consumidor, en paralelo;
   - un solo escaneo activo a la vez;
   - timeout por archivo = engine.requestTimeoutMs + proporcional al tamaño;
   - motor caído o sin respuesta → tarea ENGINE_CRASHED o TIMEOUT, reinicio del motor
     (máximo 3 por trabajo, luego FAILED);
   - persistencia con los repositorios de T1.3;
   - veredicto siempre NOT_EVALUATED;
   - métricas (pico de la pila y de la cola, duración por fase) en metrics_json.
4. Pruebas con FakeEngineClient: orden FIFO, cancelación a mitad (no se insertan resultados después),
   errores contados, motor que se cae y se reinicia, backpressure con una cola de capacidad 2,
   frecuencia de eventos de progreso.
Archivos permitidos: CyberSOC/app/src/core/scan/** (excepto FileDiscovery.ts), src/core/engine/** (solo si hace falta
el reinicio), src/main/composition-root.ts, tests/**.
No hagas: modificar Queue.ts, Stack.ts ni FileDiscovery.ts (son del equipo; si ves un problema, repórtalo).
Terminado cuando: las pruebas pasan y la lógica cumple CA-1.2, CA-1.3 y CA-1.7 con el FakeEngineClient.
Entrega el reporte de construccion/ia/reglas-agentes.md. No hagas merge.
```

## T1.7 — IPC `dialog.*` y `scan.*` + preload · Codex (local) · [CRÍTICO]

```text
Lee AGENTS.md y construccion/sprints/sprint-01-escaneo-real/plan.md (sección "Contratos TypeScript", bloque window.cybersoc).
Tarea T1.7 — IPC de escaneo. Rama: s1/feat-scan-ipc.
Alcance:
1. src/main/ipc/dialog.ipc.ts: selectFolder y selectFile con el diálogo nativo.
2. src/main/ipc/scan.ipc.ts: start, cancel, getJob, listJobs y listResults.
   Todas las entradas se validan con zod; las rutas deben ser absolutas y existir.
   listResults tiene un límite máximo de 200 por página.
3. Eventos onProgress y onFinished (webContents.send), expuestos en el preload con una función para desuscribirse.
4. Tipos compartidos en src/shared/ipc.ts.
5. El preload expone SOLO lo definido en el plan; nada de ipcRenderer genérico.
Archivos permitidos: src/main/ipc/**, src/preload/**, src/shared/ipc.ts, tests/**.
Terminado cuando: las pruebas de validación pasan (entradas inválidas rechazadas) y el renderer puede iniciar
y cancelar un escaneo.
Entrega el reporte de construccion/ia/reglas-agentes.md. No hagas merge.
```

**Revisión conjunta de T1.6 y T1.7 con Claude Code:** usen la plantilla de revisión de seguridad con los dos diffs en la misma sesión.

## T1.8 — UI de escaneo · Cursor (modo agente)

```text
Lee construccion/sprints/sprint-01-escaneo-real/plan.md (T1.8, CA-1.2, CA-1.8).
Tarea T1.8 — UI de escaneo. Rama: s1/feat-scan-ui.
1. pages/ScanPage.tsx:
   - botones "Escanear carpeta" y "Escanear archivo";
   - ProgressPanel: barra indeterminada durante el descubrimiento y con porcentaje después;
     contadores de descubiertos, analizados, errores y omitidos; archivo actual;
   - botón Cancelar.
2. components/ResultsTable.tsx:
   - paginada (200 por página);
   - columnas: nombre, ruta, tamaño, SHA-256 (abreviado, con botón copiar), estado, veredicto.
   - El veredicto se muestra como "Sin evaluar"; nunca "Limpio".
3. pages/HistoryPage.tsx: lista de trabajos recientes; al abrir uno se ven sus resultados.
4. Detalle del trabajo: métricas (pico de la pila, pico de la cola, tiempo bloqueado del productor, duración).
Usa solo window.cybersoc.*; no uses APIs de Node en el renderer.
Archivos permitidos: CyberSOC/app/src/renderer/**.
No hagas merge.
```

## T1.9 — Integración real + hash cruzado + rendimiento · Codex (local)

```text
Lee construccion/sprints/sprint-01-escaneo-real/plan.md (secciones "Pruebas" y "Criterios de aceptación").
Tarea T1.9 — Pruebas de integración. Rama: s1/test-integration.
1. Prueba de integración: motor Python real + SQLite temporal + carpeta generada con
   engine/tests/fixtures/generate.py (25 archivos) → 25 filas cuyo SHA-256 coincide con el de node:crypto.
2. Prueba: una junction con ciclo dentro de la carpeta no provoca un bucle infinito (CA-1.6).
3. Prueba: los archivos escaneados conservan su mtime y su hash (CA-1.9).
4. Script scripts/perf-scan.ts: genera N archivos pequeños (por defecto 5000), escanea y reporta
   archivos por segundo y los picos de la pila y de la cola. Salida en texto, para guardarla como evidencia.
Archivos permitidos: CyberSOC/app/tests/integration/**, CyberSOC/app/scripts/perf-scan.ts, package.json (script perf:scan).
Terminado cuando: las pruebas pasan en Windows; el reporte incluye la salida de perf-scan.
No hagas merge.
```

## T1.10 — Esquemas IA + AIContextBuilder v0 · Claude Code

```text
Lee AGENTS.md y construccion/sprints/sprint-02-evidencia-ia-v1/plan.md
(secciones "ai-context/v1", "ai-assessment/v1", "Capas del motor y traza de capas" y "Validación de la respuesta").
Tarea T1.10 — Esquemas IA + AIContextBuilder v0. Rama: s1/feat-ai-context-v0.
1. src/core/ai/schemas.ts:
   - esquemas zod de ai-context/v1 y ai-assessment/v1, con enums y longitudes máximas;
   - una función que produzca su JSON Schema (se usará en output_config.format);
   - campos OPCIONALES que llegan después: layers[] (S2), file.zone y profile (S3).
2. src/core/ai/AIContextBuilder.ts v0: construye ai-context/v1 desde un ScanResult con solo los hechos del archivo:
   - anonimiza rutas (C:\Users\<usuario>\ → %USERPROFILE%\);
   - respeta ai.sendFileNames de AppConfig (si es false, usa un seudónimo);
   - aplica límites de tamaño;
   - calcula context_sha256;
   - nunca incluye contenido del archivo.
3. Pruebas: snapshot, anonimización, seudónimo, límites, y que un nombre de archivo con instrucciones
   hostiles se trate como dato (quede tal cual dentro del campo, sin romper el JSON).
Archivos permitidos: CyberSOC/app/src/core/ai/schemas.ts, src/core/ai/AIContextBuilder.ts, tests/**.
Terminado cuando: las pruebas pasan. Sin llamadas a la red.
Entrega el reporte de construccion/ia/reglas-agentes.md. No hagas merge.
```

## T1.11 — Evidencias, fichas, informe de entrega y tag · Ustedes

1. Ejecuten las pruebas manuales del plan y guarden las evidencias en `evidencias/`, con los nombres de la tabla del informe.
2. Completen las tres fichas de `entrega/fichas/`: las partes de implementación y evidencia están marcadas con `____`.
3. Completen `entrega/informe-sprint-01.md`. Si quieren ayuda para redactar, usen ChatGPT o Claude Chat con este prompt:

```text
Adjunto el plan del Sprint 1, los reportes de los agentes (tareas/), la salida de las pruebas y la lista de
evidencias. Completa construccion/sprints/sprint-01-escaneo-real/entrega/informe-sprint-01.md respetando su
estructura. Marca cada criterio de aceptación como cumplido o no SOLO según la evidencia; no inventes resultados
ni cifras. Deja "____" donde falte información.
```

4. Creen el tag `v0.1.0-s1` y actualicen `00-ESTADO.md`.
