# Prompts — Sprint 3: Motor híbrido + zonas y perfiles + IA v2 (26 oct – 3 nov)

Plan: `construccion/sprints/sprint-03-motor-hibrido-ia-v2/plan.md` · Reglas: `AGENTS.md` y `construccion/ia/asignacion-agentes.md`

**Agentes de este sprint (reparto por tokens):**
- **Codex:** lo crítico y pesado (motor, contratos, integración, calibración, cierre) y revisiones críticas.
- **Claude Code:** alto nivel y robustez (ADR, Risk Policy e IA) y revisiones de seguridad.
- **Cursor:** validaciones, revisiones no críticas, UI y capturas de evidencias.

Los reportes quedan en `construccion/sprints/sprint-03-motor-hibrido-ia-v2/tareas/T3.X-reporte.md`.

## Orden de ejecución (peguen los prompts en este orden)

| Paso | Tarea | Pegar en | Puede ir en paralelo con | Revisión: pegar la plantilla en |
|---|---|---|---|---|
| 1 | T3.0 Validación del Sprint 2 | **Cursor** | — | — (si reporta bloqueos, resolverlos antes de seguir) |
| 2 | T3.1 ADR-008 | **Claude Code** | Pasos 3 y 4 | Cursor |
| 3 | T3.5 PathTrie (modo didáctico) | **Codex** (nube) | Pasos 2 y 4 | Cursor |
| 4 | T3.7 PriorityQueue + cola de IA (modo didáctico) | **Codex** (nube) | Pasos 2 y 3 | Cursor |
| 5 | T3.2 Contrato de capas y zona + `fs.driveInfo` | **Codex** (local) | — (necesita el paso 2 fusionado) | Cursor |
| 6 | T3.3 Lectura única + histograma + RuleEngine (modo didáctico) | **Codex** (nube) | Paso 7 | Cursor |
| 7 | T3.6 ZoneClassifier + perfiles + integración | **Codex** (local) | Paso 6 | Cursor |
| 8 | T3.4 Heurísticas + PE + scripts + RiskScorer v2 | **Codex** (nube) | — | **Claude Code** [CRÍTICO] |
| 9 | T3.8 RiskPolicy v2 + prompt v2 + resumen de escaneo | **Claude Code** | — | **Codex** [CRÍTICO] |
| 10 | T3.9 UI: decisión, zonas, resumen | **Cursor** | Paso 11 | Codex |
| 11 | T3.10 Evaluación de IA | **Codex** (local) | Paso 10 | Cursor |
| 12 | T3.11 Calibración con corpus benigno | **Codex** (local) | — | **Claude Code** [CRÍTICO] |
| 13 | T3.12 Capturador: guion del Sprint 3 | **Cursor** | — | Codex |
| 14 | T3.13 Cierre del Sprint 3 | **Codex** (local) | — | Cursor (verifica que el informe no tenga datos inventados) |

**Después de cada tarea, siempre igual:**
1. Pegar la plantilla de revisión de `asignacion-agentes.md` en el **agente revisor de la tabla**, con la rama y la tarea. Usen la plantilla de seguridad si dice [CRÍTICO] y la general en los demás casos.
2. Si hay puntos [BLOQUEANTE] o [IMPORTANTE], pegarlos al agente autor con la plantilla de corrección.
3. Leer el "Resumen para el equipo" y fusionar la PR cuando el CI esté en verde.
4. Pasar al siguiente paso.

**API key:** los pasos 9, 11 y 12 usan la API de Claude real. En la terminal del agente:

```powershell
$env:CYBERSOC_ANTHROPIC_API_KEY = "sk-ant-..."
```

---

## Paso 1 · T3.0 — Validación del Sprint 2 · Cursor (modo agente)

```text
Validación del Sprint 2, SOLO LECTURA salvo el reporte. Rama: s3/chore-validacion-s2 (créala desde main actualizado).
Lee AGENTS.md, construccion/00-ESTADO.md, construccion/ia/prompts/cierre-sprint.md y las carpetas
construccion/sprints/sprint-01-escaneo-real/ y construccion/sprints/sprint-02-evidencia-ia-v1/.
Verifica y reporta en una tabla (OK / FALTA / NO CUMPLE):
1. Tags v0.1.0-s1 y v0.2.0-s2 existen (git tag).
2. En CyberSOC/app: npm run typecheck, lint y test pasan. En CyberSOC/engine: uv run ruff check y uv run pytest pasan.
3. npm run evidence:capture existe y funciona con --sprint 01 y --sprint 02 (no sobrescribas evidencias existentes:
   usa una carpeta temporal para probar).
4. Informes de S1 y S2: no quedan "____" ni "PENDIENTE" sin justificar; todos los CA tienen estado y evidencia.
5. Cada archivo de evidencia nombrado en la sección 8 de ambos informes existe en su carpeta evidencias/.
6. Fichas de S1 (stack-dfs, queue-acotada, set-visitados) y de S2 (hashmap-firmas, map-magic-numbers) completas,
   con sección "Guía de estudio".
7. Cada tarea de S1 y S2 tiene su reporte en tareas/.
8. 00-ESTADO.md: S2 "Cerrado", S3 "En curso", último tag v0.2.0-s2.
9. Funcionalidad clave de S2 presente en el código: result_layers, RiskPolicy v1, AIResponseValidator,
   AIAnalysisWorker con reintentos y circuit breaker, SecretStore, panel "Qué se envió".
Para cada FALTA o NO CUMPLE indica cómo resolverlo:
- si es de documentación o evidencias: qué parte de cierre-sprint.md ejecutar;
- si es de código: una tarea de corrección propuesta (rama s2/fix-<tema>).
Guarda el reporte en construccion/sprints/sprint-03-motor-hibrido-ia-v2/tareas/T3.0-reporte.md, con un
"Resumen para el equipo" que diga claramente: "Se puede continuar" o "Hay que resolver primero: …".
Archivos permitidos: solo ese reporte. Commit, push y PR. No hagas merge.
```

## Paso 2 · T3.1 — ADR-008 · Claude Code

```text
Lee AGENTS.md, construccion/00-ESTADO.md (D15) y construccion/sprints/sprint-03-motor-hibrido-ia-v2/plan.md
(sección "Zonas y perfiles de capas").
Tarea T3.1 — ADR-008. Rama: s3/docs-adr-008.
Escribe construccion/decisiones/ADR-008-zonas-perfiles-capas.md (máximo una página):
- contexto;
- decisión;
- alternativas (capas fijas para todo; perfiles por extensión; perfiles por zona con Trie);
- consecuencias (cambio del contrato scan.file con options.zone y options.layers, nuevo estado DISABLED en la
  traza, HASH y SIGNATURES siempre activas, justificación del Trie por prefijo más largo);
- estado: Aprobado.
En 00-ESTADO.md marca D15 como APROBADA con referencia a ADR-008.
Archivos permitidos: ese ADR y 00-ESTADO.md. Guarda el reporte en tareas/T3.1-reporte.md. Commit, push y PR. No hagas merge.
```

## Paso 3 · T3.5 — PathTrie · Codex (nube) · modo didáctico

```text
Lee AGENTS.md (sección "Modo didáctico") y construccion/sprints/sprint-03-motor-hibrido-ia-v2/plan.md
(sección "Zonas y perfiles de capas", subsección "Reglas").
Tarea T3.5 — PathTrie. Rama: s3/feat-path-trie.
1. CyberSOC/app/src/core/structures/PathTrie.ts: trie genérico PathTrie<T> por SEGMENTOS de ruta de Windows,
   normalizados (minúsculas, \ y / equivalentes, letra de unidad), con:
   - insert(prefijo, valor);
   - longestPrefixMatch(ruta) → valor | undefined (recorre segmento a segmento y recuerda la última coincidencia);
   - size.
2. Comentarios didácticos: invariante del trie, por qué por segmentos ("C:\Win" no debe coincidir con "C:\Windows")
   y complejidad O(d), con d = número de segmentos.
3. Pruebas Vitest: rutas anidadas (TEMP dentro de LOCALAPPDATA), mayúsculas/minúsculas, / y \, rutas con ñ,
   coincidencia parcial de nombre, ruta sin coincidencia, raíz de unidad.
4. scripts/bench-trie.ts: 100 000 clasificaciones con PathTrie contra una lista de prefijos ordenada por longitud.
   Guarda la salida en construccion/sprints/sprint-03-motor-hibrido-ia-v2/evidencias/14-bench-trie-vs-lista.txt.
Archivos permitidos: src/core/structures/PathTrie.ts, tests/**, scripts/bench-trie.ts, ese archivo de evidencia,
y tareas/T3.5-reporte.md (con la "Explicación para estudiantes"). Commit, push y PR. No hagas merge.
```

## Paso 4 · T3.7 — PriorityQueue + cola de IA · Codex (nube) · modo didáctico

```text
Lee AGENTS.md (sección "Modo didáctico") y construccion/sprints/sprint-03-motor-hibrido-ia-v2/plan.md
(sección "Cola de IA con prioridad").
Tarea T3.7 — PriorityQueue. Rama: s3/feat-priority-queue.
1. CyberSOC/app/src/core/structures/PriorityQueue.ts: heap binario (max-heap) sobre un arreglo, con desempate FIFO
   por número de secuencia (orden estable). Operaciones: push, pop, peek, size, isEmpty, peakSize.
   Comentarios didácticos: invariante del heap, cálculo de padre e hijos en el arreglo, siftUp y siftDown, y por qué
   push y pop son O(log n).
2. Pruebas: prueba de propiedad (pop siempre devuelve la mayor prioridad y, a igual prioridad, la más antigua),
   vacía, un elemento, muchos empates.
3. AIAnalysisWorker: reemplaza la cola FIFO por PriorityQueue.
   priority = engine_score + 100 si el veredicto es DETECTED; seq = orden de llegada.
   Prueba: con 3 pendientes, se analiza primero el de mayor riesgo.
   Guarda la salida de esa prueba en construccion/sprints/sprint-03-motor-hibrido-ia-v2/evidencias/03-orden-cola-prioridad.txt.
4. scripts/bench-heap.ts: 50 000 inserciones y extracciones con el heap contra un arreglo ordenado.
   Salida en evidencias/15-bench-heap.txt.
Archivos permitidos: src/core/structures/PriorityQueue.ts, src/core/ai/AIAnalysisWorker.ts, tests/**,
scripts/bench-heap.ts, esos archivos de evidencia, y tareas/T3.7-reporte.md (con la "Explicación para estudiantes").
Commit, push y PR. No hagas merge.
```

## Paso 5 · T3.2 — Contrato de capas y zona + `fs.driveInfo` · Codex (local)

```text
Lee AGENTS.md, construccion/decisiones/ADR-008-zonas-perfiles-capas.md y
construccion/sprints/sprint-03-motor-hibrido-ia-v2/plan.md (sección "Zonas y perfiles de capas", bloque "Contrato (ADR-008)").
Tarea T3.2 — Contrato de capas y zona. Rama: s3/feat-contract-layers.
1. scan.file acepta options.zone y options.layers en contracts, zod y pydantic, con ejemplos nuevos.
2. Motor: las capas que no están en options.layers quedan DISABLED en la traza. HASH y SIGNATURES siempre corren.
3. Nuevo método fs.driveInfo(path) → { driveType: FIXED|REMOVABLE|NETWORK|CDROM|UNKNOWN },
   con GetDriveTypeW (ctypes). Solo lectura.
4. Pruebas de contrato y del motor.
Archivos permitidos: CyberSOC/contracts/**, app/src/shared/protocol.ts, app/tests/**, CyberSOC/engine/**,
tareas/T3.2-reporte.md. Commit, push y PR. No hagas merge.
```

## Paso 6 · T3.3 — Lectura única + histograma + RuleEngine · Codex (nube) · modo didáctico

```text
Lee AGENTS.md (sección "Modo didáctico") y construccion/sprints/sprint-03-motor-hibrido-ia-v2/plan.md
(secciones "Formato de regla (YAML)" y "Entregables — Motor").
Tarea T3.3 — Lectura única + RuleEngine. Rama: s3/feat-engine-rules.
1. analysis/stream.py:
   - un solo recorrido del archivo en chunks de 1 MiB;
   - consumidores HashConsumer, HeaderConsumer (64 KiB) y ByteHistogram;
   - el archivo nunca se carga completo en memoria.
   ByteHistogram es un ARREGLO DE 256 CONTADORES (índice = valor del byte) con un método entropy() de Shannon.
   Comentarios didácticos: por qué un arreglo fijo, la fórmula y su rango 0–8.
2. engines/rule_engine.py (capa RULES):
   - carga engine/data/rules/*.yaml y las valida (un YAML inválido da un error claro);
   - condiciones fileTypes, extensions, sizeRange, strings (ascii/utf16/hex, any/all), peImports, entropyAbove;
   - búsqueda con bytes.find sobre los primeros maxScanBytes.
3. Reglas iniciales: R-TEST-DOWNLOADER (marcador inofensivo del plan) y 2–3 reglas más de prueba.
   Fixtures con los marcadores en generate.py.
4. Método rules.reload; engine.stats incluye rulesetVersion.
5. Pruebas por cada condición, más una regla inválida; ByteHistogram: archivo de ceros → 0; bytes aleatorios ≈ 8;
   texto ≈ 4–5. Guarda la salida de las pruebas de entropía en
   construccion/sprints/sprint-03-motor-hibrido-ia-v2/evidencias/16-entropia-pruebas.txt.
Archivos permitidos: CyberSOC/engine/**, ese archivo de evidencia, tareas/T3.3-reporte.md
(con la "Explicación para estudiantes"). Dependencia permitida: PyYAML. Commit, push y PR. No hagas merge.
```

## Paso 7 · T3.6 — ZoneClassifier + perfiles + integración · Codex (local)

```text
Lee AGENTS.md y construccion/sprints/sprint-03-motor-hibrido-ia-v2/plan.md
(secciones "Zonas y perfiles de capas" y "Migración 004").
Tarea T3.6 — Zonas y perfiles. Rama: s3/feat-zones.
1. src/core/zones/ZoneClassifier.ts:
   - usa PathTrie (src/core/structures/PathTrie.ts, sin modificarlo);
   - rutas reales resueltas con app.getPath (inyectadas desde main), %TEMP%, %APPDATA%, %LOCALAPPDATA%,
     Program Files y Windows;
   - EXTRAIBLE según fs.driveInfo.
2. src/core/zones/ScanProfiles.ts: Map zona → perfil con los valores del plan, persistido en settings;
   HASH y SIGNATURES obligatorias.
3. Migración 004 del plan (zone en scan_results, profile_json en scan_jobs, versiones de reglas y firmas).
4. ScanOrchestrator:
   - envía options.zone y options.layers por archivo;
   - guarda zone y profile_json;
   - scan.start acepta profile: "AUTO" | perfil personalizado (validado con zod).
5. Pruebas: zonas anidadas (TEMP dentro de LOCALAPPDATA), unidad extraíble simulada, perfil SISTEMA con
   HEURISTICS/PE/SCRIPTS en DISABLED, perfil personalizado inválido rechazado.
   Guarda la salida en construccion/sprints/sprint-03-motor-hibrido-ia-v2/evidencias/11-zonas-pruebas.txt.
Archivos permitidos: src/core/zones/**, src/core/scan/ScanOrchestrator.ts, src/core/persistence/**, src/main/**,
src/shared/**, tests/**, ese archivo de evidencia, tareas/T3.6-reporte.md.
No modifiques src/core/structures/**. Commit, push y PR. No hagas merge.
```

## Paso 8 · T3.4 — Heurísticas + PE + scripts + RiskScorer v2 · Codex (nube) · revisa Claude Code

```text
Lee AGENTS.md y construccion/sprints/sprint-03-motor-hibrido-ia-v2/plan.md (secciones "Heurísticas" y "Puntuación v2").
Tarea T3.4 — Heurísticas y puntuación v2. Rama: s3/feat-engine-heuristics.
1. Capas HEURISTICS, PE y SCRIPTS con los códigos, capas y severidades de la tabla del plan.
   - Entropía de Shannon desde ByteHistogram.
   - PE con pefile: un PE malformado produce la evidencia ENGINE_ERROR sin caer.
     Límite de bytes y de tiempo por archivo para el análisis PE.
2. RiskScorer v2:
   - topes por grupo de capas (FILETYPE+HEURISTICS+PE+SCRIPTS ≤ 50; RULES ≤ 60; total ≤ 100);
   - solo la evidencia decisiva produce DETECTED;
   - desglose scoreBreakdown.
3. Fixtures benignos: bytes aleatorios (alta entropía) y script con un marcador de comando codificado (texto inofensivo).
   Pruebas PE con copias de lectura de ejecutables benignos de C:\Windows\System32, que se saltan si no existen
   (por ejemplo, en la nube).
4. Pruebas: positivo y negativo por heurística; topes; "heurística sola nunca DETECTED"; PE malformado (bytes
   truncados tras la cabecera MZ).
Archivos permitidos: CyberSOC/engine/**, tareas/T3.4-reporte.md. Dependencia permitida: pefile.
Commit, push y PR. No hagas merge.
```

Revisión: **Claude Code**, con la plantilla de revisión de seguridad. Foco: entrada hostil al parser PE, límites y topes de puntuación.

## Paso 9 · T3.8 — RiskPolicy v2 + prompt v2 + resumen de escaneo · Claude Code · revisa Codex

```text
Lee AGENTS.md y construccion/sprints/sprint-03-motor-hibrido-ia-v2/plan.md
(secciones "RiskPolicy v2" y "Resumen de escaneo (JOB_SUMMARY)").
Tarea T3.8 — IA v2. Rama: s3/feat-ai-v2.
1. RiskPolicy v2 (policyVersion "2"): escalamiento acotado CLEAN→SUSPICIOUS con TODAS las condiciones del plan
   (confianza ≥ 0.7, al menos una cita existente, puntuación > 0, nivel máximo MEDIO, origin AI_ESCALATION).
   Nunca DETECTED; nunca bajar un veredicto. La traza explica qué regla se aplicó.
2. prompts/analysis.v2.ts: pide correlaciones explícitas entre evidencias y menciona la capa de cada una.
   Mismas reglas de datos no confiables.
3. JOB_SUMMARY:
   - prompts/job-summary.v1.ts;
   - esquema { summary, highlights[{resultId, why}], recommendations[], citedResultIds[] };
   - validación de que los resultId existen;
   - se encola al terminar cada escaneo.
4. Pruebas: tabla completa de RiskPolicy v2, incluidos los límites (confianza 0.69/0.70, puntuación 0, sin citas);
   JOB_SUMMARY con un resultId inventado → rechazado.
   Guarda la salida en construccion/sprints/sprint-03-motor-hibrido-ia-v2/evidencias/05-riskpolicy-v2-pruebas.txt.
5. Con CYBERSOC_ANTHROPIC_API_KEY: un JOB_SUMMARY real sobre los fixtures; salida (sin la clave) en
   evidencias/17-job-summary-real.txt.
Archivos permitidos: src/core/risk/**, src/core/ai/prompts/**, src/core/ai/JobSummary*.ts, src/core/ai/schemas.ts,
src/core/ai/AIAnalysisWorker.ts (solo encolar JOB_SUMMARY), tests/**, esos archivos de evidencia, tareas/T3.8-reporte.md.
Commit, push y PR. No hagas merge.
```

## Paso 10 · T3.9 — UI de decisión, zonas y resumen · Cursor (modo agente)

```text
Lee AGENTS.md y construccion/sprints/sprint-03-motor-hibrido-ia-v2/plan.md (CA-3.2, CA-3.4, CA-3.5, CA-3.8).
Tarea T3.9 — UI de decisión y zonas. Rama: s3/feat-ui-decision-zones.
1. Panel "¿Cómo se decidió?": cada evidencia con su capa y sus puntos, los topes aplicados,
   la regla de la política y la versión de la política.
2. Etiqueta "Escalado por IA" cuando origin = AI_ESCALATION.
3. Zona y perfil visibles en cada resultado; en "Capas aplicadas", DISABLED se muestra como "desactivada por el perfil".
4. Al iniciar un escaneo: selector "Perfil: automático por zona / personalizado" (casillas de capas;
   HASH y SIGNATURES bloqueadas).
5. Tarjeta del resumen del escaneo (JOB_SUMMARY), con los highlights enlazados a cada resultado.
6. Todo texto de la IA, como texto plano.
7. Atributos data-testid estables en los elementos nuevos (los usará el capturador).
Archivos permitidos: CyberSOC/app/src/renderer/**, tareas/T3.9-reporte.md. Commit, push y PR. No hagas merge.
```

## Paso 11 · T3.10 — Evaluación de IA · Codex (local)

```text
Lee AGENTS.md y construccion/sprints/sprint-03-motor-hibrido-ia-v2/plan.md (sección "Evaluación de IA").
Tarea T3.10 — ai:eval. Rama: s3/test-ai-eval.
1. tests/ai-eval/scenarios/*.json: ~15 contextos ai-context/v1 que cubran los escenarios del plan,
   cada uno con sus expectativas (opiniones aceptables, no escalar, citas mínimas).
2. scripts/ai-eval.ts:
   - ejecuta los escenarios contra ClaudeProvider (requiere CYBERSOC_ANTHROPIC_API_KEY);
   - mide esquema válido, citas válidas, escalamientos en casos benignos, coherencia, latencia p50/p95 y costo estimado;
   - escribe un reporte markdown;
   - modo --fake para probar el script sin red en CI.
3. Ejecuta la evaluación real UNA vez y guarda el reporte en
   construccion/sprints/sprint-03-motor-hibrido-ia-v2/evidencias/08-ai-eval.md.
Archivos permitidos: CyberSOC/app/tests/ai-eval/**, CyberSOC/app/scripts/ai-eval.ts, package.json (script ai:eval),
ese archivo de evidencia, tareas/T3.10-reporte.md. Commit, push y PR. No hagas merge.
```

## Paso 12 · T3.11 — Calibración con corpus benigno · Codex (local) · revisa Claude Code

```text
Lee AGENTS.md y construccion/sprints/sprint-03-motor-hibrido-ia-v2/plan.md (sección "Calibración con corpus benigno").
Tarea T3.11 — Calibración. Rama: s3/chore-calibration.
1. CyberSOC/app/scripts/calibrate.ts:
   - escanea en SOLO LECTURA las rutas indicadas (C:\Windows\System32 y C:\Program Files) con el orquestador real
     y el perfil AUTO;
   - genera un resumen: conteo por veredicto, por zona, por código de evidencia, y escalamientos por IA
     (con la API real; respeta el tope de 50 análisis por escaneo).
2. Ejecútalo ("antes"). Si hay DETECTED o más de 1 % de SUSPICIOUS o algún escalamiento por IA, ajusta SOLO pesos y
   umbrales del motor (sin cambiar la lógica), explicando cada ajuste, y vuelve a ejecutarlo ("después").
   No desactives heurísticas solo para bajar números.
3. Documenta antes, después y cada ajuste en construccion/pruebas/calibracion.md.
   Copia la salida a construccion/sprints/sprint-03-motor-hibrido-ia-v2/evidencias/07-calibracion-salida.txt.
Archivos permitidos: CyberSOC/app/scripts/calibrate.ts, package.json (script calibrate), archivos de pesos y umbrales
del motor, construccion/pruebas/calibracion.md, ese archivo de evidencia, tareas/T3.11-reporte.md.
Commit, push y PR. No hagas merge.
```

Revisión: **Claude Code**, con la plantilla de revisión de seguridad. Foco: que los ajustes no oculten detecciones reales y estén justificados.

## Paso 13 · T3.12 — Capturador: guion del Sprint 3 · Cursor (modo agente)

```text
Lee AGENTS.md y construccion/sprints/sprint-03-motor-hibrido-ia-v2/entrega/informe-sprint-03.md (sección 8).
Tarea T3.12 — Guion de evidencias del Sprint 3. Rama: s3/feat-evidence-s3.
1. scripts/evidence/sprint-03.json para npm run evidence:capture -- --sprint 03. Debe generar, con los nombres
   exactos del informe:
   - 01-regla-marcador.png;
   - 02-como-se-decidio.png;
   - 04-escalado-por-ia.png (FakeAIProvider con una respuesta de escalamiento válida);
   - 06-resumen-escaneo.png;
   - 09-zona-perfil-capas.png (un resultado con capas DISABLED por el perfil);
   - 10-perfil-sistema.png (escaneo de una subcarpeta pequeña de C:\Windows\System32, solo lectura).
2. Amplía el modo evidencia y los fixtures solo si hace falta; agrega data-testid faltantes (solo atributos).
3. Ejecuta el capturador y verifica que existan todos los archivos.
Archivos permitidos: CyberSOC/app/scripts/evidence/**, scripts/capture-evidence.ts, src/main/composition-root.ts
(solo el modo evidencia), src/renderer/** (solo data-testid), construccion/sprints/sprint-03-motor-hibrido-ia-v2/evidencias/**,
tareas/T3.12-reporte.md. Commit, push y PR. No hagas merge.
```

## Paso 14 · T3.13 — Cierre del Sprint 3 · Codex (local)

Ejecuten `construccion/ia/prompts/cierre-sprint.md` con N = 3:

| Parte | Qué hace |
|---|---|
| Parte 1 | Verificación, evidencias de texto, informe, fichas y estado |
| Parte 2 | `npm run evidence:capture -- --sprint 03` (vuelve a generar las capturas con el código final) |
| Fusionar la PR y Parte 3 | Tag `v0.3.0-s3` |

**Opcional:** si tienen una USB, conéctenla y pídanle a Codex en local: *"Escanea la unidad USB y guarda una captura del resultado en evidencias/11b-escaneo-usb.png"*.
