# Prompts — Sprint 5: Copilot con herramientas (reportes, capas y planificador) (11 – 17 nov)

Plan: `construccion/sprints/sprint-05-copilot-herramientas-reportes/plan.md` · Reglas: `AGENTS.md` y `construccion/ia/asignacion-agentes.md`

**Congelación funcional el 17 de noviembre:** lo que no esté terminado ese día se recorta.

**Agentes de este sprint (reparto por tokens):**
- **Codex:** lo crítico y pesado (herramientas, reportes, conversaciones, top-k, cierre) y revisiones críticas.
- **Claude Code:** alto nivel y robustez (orquestador del Copilot, planificador, pruebas de inyección) y la revisión de seguridad de los reportes.
- **Cursor:** validaciones, revisiones no críticas, UI y capturas de evidencias.

Los reportes quedan en `construccion/sprints/sprint-05-copilot-herramientas-reportes/tareas/T5.X-reporte.md`.

## Orden de ejecución (peguen los prompts en este orden)

| Paso | Tarea | Pegar en | Puede ir en paralelo con | Revisión: pegar la plantilla en |
|---|---|---|---|---|
| 1 | T5.0 Validación del Sprint 4 | **Cursor** | — | — (si reporta bloqueos, resolverlos antes de seguir) |
| 2 | T5.1 Heap top-k (modo didáctico) | **Codex** (nube) | Paso 3 | Cursor |
| 3 | T5.2 Migración 006 + conversaciones guardadas | **Codex** (nube) | Paso 2 | Cursor |
| 4 | T5.3 ToolRegistry + herramientas de solo lectura (modo didáctico) | **Codex** (nube) | — (necesita el paso 2) | Cursor |
| 5 | T5.4 Reportes por conversación + exportación | **Codex** (nube) | Paso 6 | **Claude Code** [CRÍTICO] |
| 6 | T5.5 Orquestador v2 + planificador + transcripciones reales | **Claude Code** | Paso 5 | **Codex** [CRÍTICO] |
| 7 | T5.6 UI: tarjetas, chips, acciones, historial | **Cursor** | Paso 8 | Codex |
| 8 | T5.7 Pruebas de inyección y abuso de herramientas | **Claude Code** | Paso 7 | Codex |
| 9 | T5.8 Capturador: guion del Sprint 5 | **Cursor** | — | Codex |
| 10 | T5.9 Cierre del Sprint 5 + congelación | **Codex** (local) | — | Cursor (verifica que el informe no tenga datos inventados) |

**Dependencias que importan:**
- Los pasos 5 y 6 necesitan el 4 fusionado.
- El paso 7 necesita el 5 y el 6.
- El paso 8 necesita el 6.

**Después de cada tarea, siempre igual:**
1. Pegar la plantilla de revisión de `asignacion-agentes.md` en el **agente revisor de la tabla**, con la rama y la tarea. Usen la plantilla de seguridad si dice [CRÍTICO] y la general en los demás casos.
2. Si hay puntos [BLOQUEANTE] o [IMPORTANTE], pegarlos al agente autor con la plantilla de corrección.
3. Leer el "Resumen para el equipo" y fusionar la PR cuando el CI esté en verde.
4. Pasar al siguiente paso.

**API key:** los pasos 6 y 8 usan la API de Claude real. En la terminal del agente:

```powershell
$env:CYBERSOC_ANTHROPIC_API_KEY = "sk-ant-..."
```

---

## Paso 1 · T5.0 — Validación del Sprint 4 · Cursor (modo agente)

```text
Validación del Sprint 4, SOLO LECTURA salvo el reporte. Rama: s5/chore-validacion-s4 (créala desde main actualizado).
Lee AGENTS.md, construccion/00-ESTADO.md, construccion/ia/prompts/cierre-sprint.md y la carpeta
construccion/sprints/sprint-04-cuarentena-copilot-v1/.
Verifica y reporta en una tabla (OK / FALTA / NO CUMPLE):
1. El tag v0.4.0-s4 existe (git tag).
2. En CyberSOC/app: npm run typecheck, lint y test pasan. En CyberSOC/engine: uv run ruff check y uv run pytest pasan.
3. No quedan pruebas marcadas con it.fails en CyberSOC/app/tests/quarantine/.
4. npm run evidence:capture -- --sprint 04 funciona (pruébalo en una carpeta temporal; no sobrescribas evidencias).
5. Informe de S4: no quedan "____" ni "PENDIENTE" sin justificar; todos los CA tienen estado y evidencia.
6. Cada archivo de evidencia de la sección 8 del informe de S4 existe en evidencias/.
7. Fichas de S4 (set-rutas-protegidas, queue-ventana-chat) completas, con "Guía de estudio".
8. Cada tarea de S4 tiene su reporte en tareas/.
9. 00-ESTADO.md: S4 "Cerrado", S5 "En curso", último tag v0.4.0-s4; D8 APROBADA (ADR-006).
10. Funcionalidad clave de S4 presente en el código: QuarantineVault (AES-256-GCM), QuarantineManager con
    reconcile, rutas protegidas, allowlist en RiskPolicy, AssistantOrchestrator v1 con ventana de 10 turnos,
    panel de chat con texto plano.
Para cada FALTA o NO CUMPLE indica cómo resolverlo:
- si es de documentación o evidencias: qué parte de cierre-sprint.md ejecutar;
- si es de código: una tarea de corrección propuesta (rama s4/fix-<tema>).
Guarda el reporte en construccion/sprints/sprint-05-copilot-herramientas-reportes/tareas/T5.0-reporte.md, con un
"Resumen para el equipo" que diga claramente: "Se puede continuar" o "Hay que resolver primero: …".
Archivos permitidos: solo ese reporte. Commit, push y PR. No hagas merge.
```

## Paso 2 · T5.1 — Heap top-k · Codex (nube) · modo didáctico

```text
Lee AGENTS.md (sección "Modo didáctico") y construccion/sprints/sprint-05-copilot-herramientas-reportes/plan.md
(sección "Estructuras de datos del sprint").
Tarea T5.1 — Heap top-k. Rama: s5/feat-topk-heap.
1. CyberSOC/app/src/core/structures/TopK.ts:
   - topK(items, k, score) con un MIN-heap de tamaño k: el mínimo del top está en la raíz; si llega un elemento
     mayor que la raíz, la reemplaza y baja (siftDown);
   - empate estable (a igual puntuación, gana el que llegó antes);
   - devuelve el resultado ordenado de mayor a menor.
   Puedes reutilizar la lógica de src/core/structures/PriorityQueue.ts (sin modificarla) o escribir un heap mínimo aparte.
2. Comentarios didácticos: por qué un MIN-heap para obtener los MAYORES, y por qué O(n log k) frente a O(n log n).
3. Pruebas: k = 0, k > n, empates, comparación con ordenar todo sobre 1 000 casos aleatorios.
4. scripts/bench-topk.ts: top-10 de 100 000 elementos, TopK contra sort. Guarda la salida en
   construccion/sprints/sprint-05-copilot-herramientas-reportes/evidencias/16-bench-topk.txt.
5. Usa TopK para el "top de riesgo en vivo" del ScanOrchestrator (los 10 de mayor riesgo durante el escaneo, expuestos
   en el evento de progreso).
Archivos permitidos: src/core/structures/TopK.ts, src/core/scan/ScanOrchestrator.ts, src/shared/ipc.ts (solo el campo del
progreso), tests/**, scripts/bench-topk.ts, ese archivo de evidencia, tareas/T5.1-reporte.md (con la "Explicación para estudiantes").
Commit, push y PR. No hagas merge.
```

## Paso 3 · T5.2 — Migración 006 + conversaciones guardadas · Codex (nube)

```text
Lee AGENTS.md y construccion/sprints/sprint-05-copilot-herramientas-reportes/plan.md (sección "Migración 006").
Tarea T5.2 — Conversaciones. Rama: s5/feat-conversations.
1. migrations/006_conversations.ts: exactamente el SQL del plan. ConversationRepository.
2. Guarda cada turno (usuario, asistente, llamadas a herramientas, modelo, tokens).
3. IPC assistant.listConversations y assistant.openConversation, validados con zod.
4. Al abrir una conversación guardada, la ventana deslizante de 10 turnos (S4) se carga con los últimos 10.
5. Pruebas con una BD temporal.
Archivos permitidos: src/core/persistence/**, src/core/ai/AssistantOrchestrator.ts (solo cargar y guardar turnos),
src/main/ipc/assistant.ipc.ts, src/preload/**, src/shared/ipc.ts, tests/**, tareas/T5.2-reporte.md.
Commit, push y PR. No hagas merge.
```

## Paso 4 · T5.3 — ToolRegistry + herramientas · Codex (nube) · modo didáctico

```text
Lee AGENTS.md y construccion/sprints/sprint-05-copilot-herramientas-reportes/plan.md
(secciones "Herramientas (todas de solo lectura)", "Límites del orquestador" y "Consulta de capas").
Tarea T5.3 — ToolRegistry + herramientas. Rama: s5/feat-tools.
1. src/core/ai/tools/ToolRegistry.ts: Map nombre → { descripción, esquema zod de argumentos, JSON Schema estricto,
   ejecutor }.
   MODO DIDÁCTICO: comenta por qué un Map funciona como "tabla de despacho" (buscar la herramienta por nombre en O(1)
   en lugar de una cadena de if/else).
2. Una herramienta por archivo, todas de SOLO LECTURA sobre los repositorios:
   get_scan_summary, list_scans, list_results, get_top_risk_results (usa TopK de T5.1), get_result_detail,
   get_evidence, get_rule_info, get_ai_analysis, get_quarantine_items, compare_results, lookup_hash, list_zones,
   get_layer_report. get_layer_report agrega result_layers con SQL (GROUP BY layer, status) por resultado,
   por escaneo o por zona.
3. Límites: máximo 20 filas y 8 000 caracteres por resultado (truncated: true); argumentos validados; un error se
   devuelve como resultado de error, sin excepción hacia el orquestador.
4. Pruebas por herramienta: argumentos válidos e inválidos, límites, y cifras idénticas a consultas SQL directas.
   Guarda la comparación de get_layer_report y get_scan_summary contra SQL en
   construccion/sprints/sprint-05-copilot-herramientas-reportes/evidencias/12-capas-vs-sql.txt.
Archivos permitidos: src/core/ai/tools/**, src/core/persistence/** (solo consultas de lectura), tests/**,
ese archivo de evidencia, tareas/T5.3-reporte.md (con la "Explicación para estudiantes").
Commit, push y PR. No hagas merge.
```

## Paso 5 · T5.4 — Reportes por conversación + exportación · Codex (nube) · revisa Claude Code [CRÍTICO]

```text
Lee AGENTS.md y construccion/sprints/sprint-05-copilot-herramientas-reportes/plan.md
(secciones "Reporte por conversación (D17)" y "Contenido del reporte").
Tarea T5.4 — Reportes. Rama: s5/feat-reports.
1. src/core/reports/ReportBuilder.ts: build({ jobId?, zone?, verdicts?, from?, to? }) → datos del reporte calculados
   SOLO desde SQLite (contadores, resultados, evidencias, capas, versiones), guardados en un caché en memoria con
   reportDraftId. No escribe archivos.
2. Herramienta build_report en el ToolRegistry, que llama a ReportBuilder.
3. src/core/reports/exporters/:
   - HTML autocontenido con TODO texto escapado; la sección de IA marcada como "Generado por IA";
   - CSV con comas y comillas correctas;
   - JSON.
4. IPC reports.export({ reportDraftId, format }): abre el diálogo de guardar; es el usuario quien guarda.
5. Pruebas:
   - cifras iguales a SQL directo;
   - HTML con un nombre de archivo "<script>alert(1)</script>.exe" queda escapado;
   - CSV con comas y comillas.
   Guarda la salida de la prueba de escape en
   construccion/sprints/sprint-05-copilot-herramientas-reportes/evidencias/08-html-escapado.txt.
6. Genera un reporte de ejemplo sobre los fixtures en los tres formatos, en evidencias/:
   07-reporte-exportado.html, 07-reporte-exportado.csv y 07-reporte-exportado.json.
Archivos permitidos: src/core/reports/**, src/core/ai/tools/buildReport.ts, src/main/ipc/reports.ipc.ts, src/preload/**,
src/shared/ipc.ts, tests/**, esos archivos de evidencia, tareas/T5.4-reporte.md.
Commit, push y PR. No hagas merge.
```

Revisión: **Claude Code**, con la plantilla de seguridad. Foco: escape del HTML exportado y que los datos del reporte vengan solo de la BD.

## Paso 6 · T5.5 — Orquestador v2 + planificador + transcripciones reales · Claude Code · revisa Codex [CRÍTICO]

```text
Lee AGENTS.md y construccion/sprints/sprint-05-copilot-herramientas-reportes/plan.md
(secciones "Límites del orquestador", "Respuesta final del Copilot" y "Planificador de escaneo (scan-plan/v1, D16)").
Tarea T5.5 — Copilot v2. Rama: s5/feat-copilot-v2.
1. ClaudeProvider.runAssistantTurn con herramientas en modo estricto (strict: true) y respuesta final estructurada
   (answer, references, suggestedActions, report?, scanPlan?). Verifica en la documentación actual cómo combinar
   tool use estricto con output_config.format.
2. AssistantOrchestrator v2:
   - bucle de herramientas con máximo 6 rondas y 60 s en total;
   - los resultados de las herramientas se tratan como datos no confiables;
   - validación final: IDs, reportDraftId y citedResultIds existentes; acciones del enum.
3. src/core/ai/ScanPlanValidator.ts:
   - destinos solo de list_zones (la IA no puede inventar rutas);
   - HASH y SIGNATURES obligatorias; capas del enum; rangos permitidos.
   Un plan válido se devuelve a la UI como tarjeta: NUNCA inicia un escaneo.
4. prompts/assistant.v2.ts: amplía v1 con el uso de herramientas, reportes, consulta de capas y planificador
   (proponer, nunca ejecutar).
5. Pruebas con FakeAIProvider:
   - pregunta que necesita 2 herramientas;
   - bucle de más de 6 rondas → se corta;
   - herramienta desconocida;
   - ID inventado;
   - plan con ruta inventada, sin HASH o con una capa desconocida → rechazado.
   Guarda la salida de las pruebas del planificador en
   construccion/sprints/sprint-05-copilot-herramientas-reportes/evidencias/14-plan-rechazado.txt.
6. TRANSCRIPCIONES REALES (con CYBERSOC_ANTHROPIC_API_KEY, sobre una BD con los fixtures escaneados):
   a) las 10 preguntas del documento 7.2:
      1. ¿Por qué este archivo fue marcado como sospechoso?   2. Explícame esta detección.
      3. ¿Qué regla se activó?                                  4. ¿Qué significa este SHA-256?
      5. ¿Qué comportamiento resulta sospechoso?                6. Resume el último escaneo.
      7. Muéstrame los archivos con mayor riesgo.               8. ¿Qué debería hacer con esta detección?
      9. Explícame este resultado de forma sencilla.           10. ¿Qué diferencias existen entre estas dos detecciones?
      más las 4 del profesor: "¿Qué capa detectó este archivo?", "¿Qué capas revisaron Descargas?",
      "Hazme un reporte de los sospechosos de hoy" y "Voy a revisar mi USB, ¿cómo la escaneo?".
      Guarda pregunta, herramientas llamadas, respuesta y referencias en evidencias/02-transcripciones-preguntas.md;
   b) para "Resume el último escaneo", compara las cifras de la respuesta con SQL directo en
      evidencias/01-resumen-vs-sql.txt.
   Nunca guardes la clave.
Archivos permitidos: src/core/ai/** (excepto tools/**), src/main/ipc/assistant.ipc.ts, src/shared/**, tests/**,
esos archivos de evidencia, tareas/T5.5-reporte.md.
Commit, push y PR. No hagas merge.
```

## Paso 7 · T5.6 — UI: tarjetas, chips, acciones e historial · Cursor (modo agente)

```text
Lee AGENTS.md y construccion/sprints/sprint-05-copilot-herramientas-reportes/plan.md (CA-5.2, CA-5.5, CA-5.6, CA-5.8, CA-5.10).
Tarea T5.6 — UI de tarjetas e historial. Rama: s5/feat-copilot-cards-ui.
1. Chips de referencias en el chat: abren el resultado, escaneo, regla o zona citados.
2. Tarjeta de reporte:
   - resumen ejecutivo y conclusiones (marcados "Generado por IA");
   - tabla de cifras (del Core);
   - botones Exportar HTML, CSV y JSON.
3. Tarjeta de plan de escaneo: destinos, capas, justificación por capa y botón "Ejecutar plan"
   con diálogo de confirmación. Solo al confirmar se llama a scan.start con el perfil del plan.
4. Botones de acciones sugeridas, siempre con confirmación.
5. Historial: filtros por veredicto, fechas, riesgo mínimo, zona y texto de ruta, con paginación.
6. "Top de riesgo en vivo" durante el escaneo (dato de T5.1).
7. Todo texto de la IA, como texto plano. data-testid estables en todos los elementos nuevos.
Archivos permitidos: CyberSOC/app/src/renderer/**, tareas/T5.6-reporte.md. Commit, push y PR. No hagas merge.
```

## Paso 8 · T5.7 — Pruebas de inyección y abuso de herramientas · Claude Code

```text
Lee AGENTS.md y construccion/sprints/sprint-05-copilot-herramientas-reportes/plan.md (sección "Pruebas").
Tarea T5.7 — Inyección de prompt y abuso de herramientas. Rama: s5/test-prompt-injection.
Escribe SOLO pruebas (sin cambiar código de producción), con FakeAIProvider y con fixtures en la BD:
- nombre de archivo hostil en los resultados de las herramientas;
- evidencia cuyo texto contiene instrucciones embebidas;
- el usuario pide "marca todo como limpio" o "borra la cuarentena";
- la IA (simulada) intenta citar IDs inexistentes, proponer un plan con una ruta inventada, usar una acción fuera
  del enum o superar el límite de rondas.
Verifica que nada cambia en veredictos, cuarentena ni escaneos, y que todo queda rechazado o validado.
Si una prueba falla, márcala con it.fails y documenta la corrección sugerida en el reporte.
Además, con CYBERSOC_ANTHROPIC_API_KEY: 5 intentos reales de inyección contra el Copilot. Anota intento, respuesta
y resultado (resistió / no resistió).
Guarda todo (salida de las pruebas + intentos reales, sin la clave) en
construccion/sprints/sprint-05-copilot-herramientas-reportes/evidencias/15-prompt-injection.txt.
Archivos permitidos: CyberSOC/app/tests/security/**, ese archivo de evidencia, tareas/T5.7-reporte.md.
Commit, push y PR. No hagas merge.
```

Si alguna prueba quedó como `it.fails`: peguen el reporte en **Codex** con la plantilla de corrección (rama `s5/fix-copilot-<tema>`).

## Paso 9 · T5.8 — Capturador: guion del Sprint 5 · Cursor (modo agente)

```text
Lee AGENTS.md y construccion/sprints/sprint-05-copilot-herramientas-reportes/entrega/informe-sprint-05.md (sección 8).
Tarea T5.8 — Guion de evidencias del Sprint 5. Rama: s5/feat-evidence-s5.
1. scripts/evidence/sprint-05.json para npm run evidence:capture -- --sprint 05, con FakeAIProvider programado para
   llamar las herramientas correctas. Debe generar, con los nombres exactos del informe:
   - 03-top-riesgo-chips.png ("Muéstrame los archivos con mayor riesgo" con chips);
   - 04-comparar-detecciones.png (respuesta de compare_results);
   - 05-accion-con-confirmacion.png (diálogo de confirmación de una acción sugerida);
   - 06-historial-filtros.png (historial filtrado por veredicto y zona);
   - 09-reporte-conversacion.png (tarjeta de reporte en el chat);
   - 11-consulta-capas.png ("¿Qué capa detectó este archivo?");
   - 13-plan-escaneo.png (tarjeta de plan + diálogo de confirmación).
2. Amplía el modo evidencia y los fixtures solo si hace falta; agrega data-testid faltantes (solo atributos).
3. Ejecuta el capturador y verifica que existan todos los archivos.
Archivos permitidos: CyberSOC/app/scripts/evidence/**, scripts/capture-evidence.ts, src/main/composition-root.ts
(solo el modo evidencia), src/renderer/** (solo data-testid),
construccion/sprints/sprint-05-copilot-herramientas-reportes/evidencias/**, tareas/T5.8-reporte.md.
Commit, push y PR. No hagas merge.
```

## Paso 10 · T5.9 — Cierre del Sprint 5 + congelación · Codex (local)

Ejecuten `construccion/ia/prompts/cierre-sprint.md` con N = 5:

| Parte | Qué hace |
|---|---|
| Parte 1 | Verificación, evidencias de texto, informe, fichas y estado |
| Parte 2 | `npm run evidence:capture -- --sprint 05` (vuelve a generar las capturas con el código final) |
| Fusionar la PR y Parte 3 | Tag `v0.5.0-s5` |

En la **Parte 1**, peguen además este extra debajo del prompt:

```text
Además, solo en este cierre:
a) En construccion/00-ESTADO.md agrega, debajo de la tabla inicial: "**Congelación funcional vigente desde <fecha de hoy>:**
   en S6 solo entran correcciones con prueba de regresión, sin funcionalidades nuevas". Agrega la fila a la bitácora.
b) En el informe, sección 11, lista todo lo que quedó fuera por la congelación (si algo quedó fuera) y en qué lugar
   de la lista de recortes de 01-resumen-general.md está.
c) Verifica que los pedidos del profesor (RF-IA-10 reportes por conversación, RF-IA-11 consulta de capas,
   RF-IA-12 planificador, RF-17 zonas) estén CUMPLIDOS con evidencia, y repórtalo en una tabla aparte del cierre.
```

Antes de fusionar, Cursor verifica la PR del cierre con la plantilla de revisión general: que ningún dato del informe sea inventado y que cada CA tenga su evidencia.
