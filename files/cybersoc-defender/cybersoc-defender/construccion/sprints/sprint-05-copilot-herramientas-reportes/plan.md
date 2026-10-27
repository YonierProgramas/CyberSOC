# Sprint 5 — SOC Copilot con herramientas: reportes, capas y planificador

| Campo | Valor |
|---|---|
| Fechas | 11 – 17 nov 2026 · **congelación funcional el 17 nov** |
| Depende de | S2 (IA), S3 (datos de riesgo), S4 (cuarentena y chat) |
| Tag al cerrar | `v0.5.0-s5` |
| Carriles | A: orquestador, herramientas y planificador · B: reportes por conversación, historial, pruebas de inyección |

## Antes de empezar

- [ ] S4 cerrado con tag `v0.4.0-s4` y pendientes revisados.
- [ ] Lista de herramientas y sus esquemas acordada el día 1.
- [ ] Recordatorio: después del 17 de noviembre no entra ninguna funcionalidad nueva.

## Objetivo

Que el Copilot consulte **datos reales** de CyberSOC mediante herramientas de solo lectura, en lugar de recibir la base de datos completa, y que cumpla los pedidos del profesor:

- **Reportes por conversación:** "hazme un reporte de…" → reporte con datos reales, exportable.
- **Capas:** "¿qué capa detectó esto?", "¿qué capas revisaron Descargas?".
- **Planificador:** "voy a revisar mi USB, ¿cómo la escaneo?" → plan con zonas y capas, que el usuario confirma.

Además: historial con filtros y exportación de reportes.

## Historias de usuario

- **HU-S5-01.** Como usuario, quiero preguntar "resume el último escaneo" y recibir datos reales.
- **HU-S5-02.** Como usuario, quiero preguntar "muéstrame los archivos con mayor riesgo".
- **HU-S5-03.** Como usuario, quiero preguntar "¿qué diferencias hay entre estas dos detecciones?".
- **HU-S5-04.** Como usuario, quiero preguntar "¿qué significa este SHA-256?" y saber si CyberSOC lo ha visto antes.
- **HU-S5-05.** Como usuario, quiero filtrar el historial por veredicto, fecha, riesgo o ruta.
- **HU-S5-06.** Como usuario, quiero exportar un reporte de un escaneo.
- **HU-S5-07.** Como usuario, quiero pedirle al Copilot un reporte (por escaneo, zona, veredicto o fechas) y recibirlo con datos reales, listo para exportar.
- **HU-S5-08.** Como usuario, quiero preguntar qué capas trabajaron en un archivo, un escaneo o una zona, y qué encontró cada una.
- **HU-S5-09.** Como usuario, quiero que el Copilot me proponga cómo escanear una zona (qué capas y por qué) y que el plan se ejecute solo si lo confirmo.

## Entregables

- [ ] `ToolRegistry` (Map nombre → herramienta) con esquemas zod y modo estricto.
- [ ] Herramientas de solo lectura (tabla abajo) implementadas sobre los repositorios.
- [ ] Herramientas nuevas por pedido del profesor: `list_zones`, `get_layer_report`, `build_report`.
- [ ] Tarjeta de reporte en el chat (vista previa + botones Exportar HTML/CSV/JSON).
- [ ] Tarjeta de plan de escaneo en el chat (zonas, capas y justificación) con botón "Ejecutar plan" que pide confirmación.
- [ ] `AssistantOrchestrator` v2: bucle de herramientas con límites y respuesta final estructurada y validada.
- [ ] `ClaudeProvider.runAssistantTurn` sobre la API de Claude, con herramientas en modo estricto (`strict: true`).
- [ ] Chips de referencias en la UI que abren el resultado, escaneo o regla citados.
- [ ] Botones de acciones sugeridas, siempre con confirmación del usuario.
- [ ] Conversaciones guardadas (migración 006).
- [ ] Historial con filtros y paginación.
- [ ] Exportar reportes en HTML (autocontenido, texto escapado), CSV y JSON.
- [ ] Top-k de riesgo con heap (en vivo durante el escaneo y como herramienta).
- [ ] Opcional: vista de resultados por carpeta (trie de rutas).

## Especificaciones clave

### Herramientas (todas de solo lectura)

| Herramienta | Argumentos | Devuelve |
|---|---|---|
| `get_scan_summary` | `jobId?` (por defecto, el último) | Contadores, duración, veredictos, top 5, resumen de IA si existe |
| `list_scans` | `limit ≤ 20` | Escaneos recientes |
| `list_results` | `jobId`, `verdict?`, `minScore?`, `limit ≤ 20` | Resultados resumidos |
| `get_top_risk_results` | `jobId?`, `k ≤ 10` | Top-k por riesgo (heap) |
| `get_result_detail` | `resultId` | Archivo, hashes, veredicto, traza |
| `get_evidence` | `resultId` | Evidencias |
| `get_rule_info` | `ruleId` | Descripción, severidad, condiciones resumidas |
| `get_ai_analysis` | `resultId` | Último análisis válido |
| `get_quarantine_items` | `status?` | Ítems en cuarentena |
| `compare_results` | `resultIdA`, `resultIdB` | Diferencias de evidencias, puntuación y veredicto |
| `lookup_hash` | `sha256` | Si se vio antes, si tiene firma local, si está en la allowlist |
| `list_zones` | — | Zonas conocidas con sus rutas reales, unidades extraíbles conectadas y perfil por defecto de cada una |
| `get_layer_report` | `resultId` \| `jobId` \| `zone` (+ `jobId?`) | Por capa: archivos analizados, omitidos (con motivo), desactivados, aciertos, puntos y tiempo |
| `build_report` | `jobId?`, `zone?`, `verdicts?`, `from?`, `to?` | Datos del reporte calculados por el Core desde SQLite + `reportDraftId`; no guarda archivos |

No existe ninguna herramienta que escriba. `build_report` solo calcula; guardar o exportar lo hace el usuario con un botón. Las acciones y los planes solo se sugieren, y el usuario los confirma en la UI.

### Límites del orquestador

- Máximo 6 rondas de herramientas por pregunta y 60 s en total.
- Máximo 20 filas y 8 000 caracteres por resultado de herramienta (se recorta y se indica `truncated: true`).
- Argumentos validados con zod. Un error de herramienta se devuelve al modelo como `tool_result` de error; no tumba el chat.
- Los resultados de las herramientas son datos no confiables (pueden contener nombres de archivo hostiles).

### Respuesta final del Copilot

```json
{
  "answer": "…",
  "references": [ { "type": "result | job | rule | zone", "id": "…" } ],
  "suggestedActions": [ { "action": "OPEN_RESULT | QUARANTINE | ANALYZE_WITH_AI | OPEN_QUARANTINE | EXPORT_REPORT | RUN_SCAN_PLAN", "targetId": "…" } ],
  "report":   { "reportDraftId": "…", "executiveSummary": "…", "conclusions": ["…"], "citedResultIds": ["…"] },
  "scanPlan": { "…": "ver scan-plan/v1" }
}
```

`report` y `scanPlan` son opcionales. Validación: todos los `id`, `targetId`, `reportDraftId` y `citedResultIds` deben existir; las acciones deben estar en el enum; `scanPlan` se valida con sus propias reglas (abajo). `answer` se muestra como texto plano.

### Reporte por conversación (D17)

1. El usuario pide: "Hazme un reporte de los sospechosos de esta semana en Descargas".
2. La IA llama `build_report({ zone: "DESCARGAS", verdicts: ["SUSPICIOUS","DETECTED"], from: …, to: … })`.
3. El Core calcula los datos desde SQLite (contadores, tabla de resultados, evidencias, capas) y devuelve un `reportDraftId`.
4. La IA redacta `executiveSummary` y `conclusions`, citando `resultId` reales.
5. El chat muestra la tarjeta del reporte; el usuario lo exporta en HTML, CSV o JSON.

Los números y las tablas del reporte **nunca** los escribe la IA: vienen del Core. Lo redactado por la IA queda marcado como "Generado por IA".

### Consulta de capas

`get_layer_report` agrega la tabla `result_layers` (S2) con SQL (`GROUP BY layer, status`). Preguntas que debe responder con datos exactos:

- "¿Qué capa detectó este archivo?"
- "¿Qué capas revisaron Descargas en el último escaneo y qué encontró cada una?"
- "¿Por qué no se analizó el PE de este archivo?" (→ `SKIPPED` o `DISABLED`, con motivo)

### Planificador de escaneo (`scan-plan/v1`, D16)

```json
{
  "schema": "cybersoc.scan-plan/v1",
  "targets": [ { "zoneId": "EXTRAIBLE", "driveId": "E:" } ],
  "layers": ["HASH","SIGNATURES","FILETYPE","RULES","HEURISTICS","PE","SCRIPTS"],
  "includeHidden": true,
  "maxFileSizeMB": 512,
  "rationale": "Las USB suelen traer ejecutables y accesos directos…",
  "layerRationale": [ { "layer": "SCRIPTS", "why": "…" } ]
}
```

Reglas de validación del Core:

- Los destinos solo pueden ser zonas o unidades devueltas por `list_zones`: la IA no puede inventar rutas.
- `HASH` y `SIGNATURES` son obligatorias; las capas deben estar en el enum.
- Tamaños y opciones dentro de los rangos permitidos.
- El plan se muestra como tarjeta; **solo el botón "Ejecutar plan" + la confirmación del usuario** inician el escaneo.
- El plan aceptado se guarda en `scan_jobs.profile_json`, así queda trazado qué propuso la IA.

### Migración 006

```sql
CREATE TABLE ai_conversations (
  id TEXT PRIMARY KEY, title TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE ai_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant','tool')),
  content TEXT NOT NULL,
  tool_calls_json TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER,
  created_at TEXT NOT NULL
);
```

### Contenido del reporte

- Datos del escaneo: ruta, fechas, versiones del motor, las firmas y las reglas.
- Contadores por veredicto.
- Resultados: nombre, ruta, SHA-256, veredicto, puntuación y evidencias.
- Resumen de IA, marcado claramente como generado por IA.
- Versión de la política de riesgo.

## Estructuras de datos del sprint

| Estructura | Uso | Evidencia |
|---|---|---|
| Map | `ToolRegistry` (nombre → definición + ejecutor) | Pruebas |
| Heap (min-heap de tamaño k) | Top-k de riesgo en O(n log k) | Prueba contra ordenar todo; benchmark |
| Trie de rutas (opcional) | Vista por carpetas con riesgo agregado | Captura + pruebas |

## Pruebas

- [ ] Cada herramienta: argumentos válidos e inválidos, límites de filas y caracteres.
- [ ] Orquestador con `FakeAIProvider`:
  - pregunta que requiere 2 herramientas;
  - bucle que supera las 6 rondas → se corta;
  - herramienta desconocida → error controlado;
  - ID inventado en `references` → se rechaza.
- [ ] Inyección de prompt:
  - nombre de archivo hostil;
  - resultado de herramienta con instrucciones embebidas;
  - pedir que "marque todo como limpio".

  Resultado esperado: no obedece y nada cambia.
- [ ] Exportación: HTML con nombres que contienen `<script>` queda escapado; CSV con comas y comillas es correcto.
- [ ] `build_report`: filtros por zona, veredicto y fechas; cifras idénticas a consultas SQL directas.
- [ ] `get_layer_report`: por resultado, por escaneo y por zona.
- [ ] Planificador: plan válido → tarjeta; plan con ruta inventada, sin `HASH` o con una capa desconocida → rechazado; el escaneo no inicia sin confirmación.
- [ ] Manual con la API de Claude: las 10 preguntas del documento 7.2 + preguntas de reportes, capas y planificador.

## Criterios de aceptación

- [ ] **CA-5.1** "Resume el último escaneo" responde con cifras que coinciden con la BD.
- [ ] **CA-5.2** "Muéstrame los archivos con mayor riesgo" devuelve el top real, con chips que abren cada resultado.
- [ ] **CA-5.3** "¿Qué diferencias existen entre estas dos detecciones?" usa `compare_results` y es coherente con la evidencia.
- [ ] **CA-5.4** Las 10 preguntas de ejemplo del documento 7.2 tienen respuestas basadas en datos reales. La transcripción se guarda.
- [ ] **CA-5.5** El Copilot no puede ejecutar acciones: toda acción pasa por un botón con confirmación.
- [ ] **CA-5.6** El historial se filtra por veredicto, fecha, riesgo y texto de ruta.
- [ ] **CA-5.7** Un reporte exportado se abre correctamente en HTML, CSV y JSON.
- [ ] **CA-5.8** "Hazme un reporte de los sospechosos de esta semana en Descargas" produce una tarjeta con cifras que coinciden con la BD y un resumen de IA con citas válidas; se exporta en HTML, CSV y JSON.
- [ ] **CA-5.9** "¿Qué capa detectó este archivo?" y "¿Qué capas revisaron Descargas?" responden con datos exactos de `result_layers`.
- [ ] **CA-5.10** "Voy a revisar mi USB, ¿cómo la escaneo?" produce un plan con zonas, capas y justificación; el escaneo solo inicia tras la confirmación del usuario.
- [ ] **CA-5.11** Un plan con un destino que no viene de `list_zones` es rechazado por el Core.

## Evidencias a guardar

- [ ] Transcripciones del Copilot que muestran las llamadas a herramientas (del registro de `ai_messages`).
- [ ] Resultados de las pruebas de inyección de prompt.
- [ ] Reportes exportados de ejemplo, incluido uno generado por conversación.
- [ ] Transcripción de consultas de capas y de un plan de escaneo propuesto, confirmado y ejecutado.
- [ ] Benchmark del top-k con heap.
- [ ] Ficha `heap-top-k.md` (y `trie-rutas.md` si se hizo).
- [ ] Reportes de pruebas y CI.

## Riesgos a vigilar

- Coste por pregunta: limitar las rondas y el tamaño de los resultados.
- Respuestas que mezclan datos reales con suposiciones: exigir referencias.
- Crecimiento del alcance antes de la congelación: lo que no esté terminado el 17 de noviembre se recorta según la lista de `01-resumen-general.md`.

## Fuera de alcance

Herramientas que escriben, segundo proveedor de IA (opcional en S6), PDF.

## Al cerrar

Completar `cierre.md`, crear el tag `v0.5.0-s5`, declarar la congelación funcional en `00-ESTADO.md`.
