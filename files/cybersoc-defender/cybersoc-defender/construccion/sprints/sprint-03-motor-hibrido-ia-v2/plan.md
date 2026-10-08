# Sprint 3 — Motor híbrido + zonas y perfiles de capas + IA v2

| Campo | Valor |
|---|---|
| Fechas | 26 oct – 3 nov 2026 |
| Depende de | S2 (modelo de evidencia, servicio de IA, `RiskPolicy` v1) |
| Tag al cerrar | `v0.3.0-s3` |
| Carriles | A: zonas y perfiles (Trie), PriorityQueue, `RiskPolicy` v2, resumen de IA, evaluación de IA · B: reglas, heurísticas, capas por perfil, calibración |

## Antes de empezar

- [ ] S2 cerrado con tag `v0.2.0-s2` y pendientes revisados.
- [ ] Formato de las reglas YAML acordado el día 1.
- [ ] Lista de códigos de heurística acordada (tabla abajo).
- [ ] Carpeta de corpus benigno elegida para la calibración (solo lectura).
- [ ] ADR-008 (zonas, perfiles y `options.layers` en `scan.file`) aprobado: es un cambio de contrato.

## Objetivo

Completar el motor híbrido (reglas + heurística + puntuación con topes y traza), añadir **zonas y perfiles de capas** (cada zona del equipo se escanea con las capas adecuadas) y hacer crecer la IA:

- cola de IA priorizada por riesgo;
- escalamiento acotado de limpio a sospechoso;
- correlación de evidencias;
- resumen por escaneo;
- evaluación medible de la IA.

## Historias de usuario

- **HU-S3-01.** Como usuario, quiero que reglas configurables detecten patrones conocidos.
- **HU-S3-02.** Como usuario, quiero que la heurística señale características sospechosas (entropía, PE, scripts).
- **HU-S3-03.** Como usuario, quiero ver cómo se calculó el riesgo, punto por punto.
- **HU-S3-04.** Como usuario, quiero que la IA analice primero los archivos más peligrosos.
- **HU-S3-05.** Como usuario, quiero un resumen inteligente al terminar cada escaneo.
- **HU-S3-06.** Como equipo, queremos medir falsos positivos y la calidad de la IA.
- **HU-S3-07.** Como usuario, quiero que cada zona (Descargas, USB, Sistema…) se escanee con las capas adecuadas y ver qué perfil se aplicó a cada archivo.

## Entregables

### Motor (B)

- [ ] Lectura única del archivo con varios consumidores (`HashConsumer`, `HeaderConsumer`, `ByteHistogram`); el archivo nunca está completo en memoria.
- [ ] `RuleEngine` con reglas YAML versionadas en `engine/data/rules/`; búsqueda con `bytes.find` sobre los primeros N MiB.
- [ ] `HeuristicEngine` con los códigos de la tabla.
- [ ] Análisis PE con `pefile`: imports, secciones, entropía por sección. Si el PE está malformado → evidencia `ENGINE_ERROR`, sin caer.
- [ ] `RiskScorer` v2 con topes por fuente y desglose.
- [ ] Método `rules.reload`; `engine.stats` incluye la versión del ruleset.
- [ ] `scan.file` acepta `options.layers` (capas activadas por el perfil); las desactivadas quedan `DISABLED` en la traza. `HASH` siempre corre.
- [ ] Método `fs.driveInfo(path)`: tipo de unidad (fija, extraíble, red) con `GetDriveTypeW`, solo lectura.
- [ ] Fixtures: scripts con marcadores de regla, archivo de alta entropía, copias de lectura de PE benignos.

### Core y IA (A)

- [ ] `PathTrie<T>` propio y `ZoneClassifier`: clasifica cada ruta en su zona por el prefijo más largo.
- [ ] `ScanProfiles`: Map zona → perfil (capas activas, incluir ocultos, tamaño máximo), editable en Configuración.
- [ ] UI: selector "Perfil: automático por zona / personalizado" al iniciar el escaneo; zona y perfil visibles en cada resultado y en el resumen.
- [ ] `PriorityQueue<T>` (heap binario propio) con desempate FIFO por secuencia (orden estable).
- [ ] `AIAnalysisQueue` migrada a PriorityQueue.
- [ ] `RiskPolicy` v2 con escalamiento acotado (abajo).
- [ ] Análisis de correlación: el prompt v2 pide correlaciones explícitas entre evidencias.
- [ ] Resumen de escaneo por IA (`kind = JOB_SUMMARY`) al terminar cada trabajo.
- [ ] UI: panel "¿Cómo se decidió?" (traza + desglose de puntos), resumen de escaneo, etiqueta visible "Escalado por IA".
- [ ] Conjunto de evaluación de IA (~15 escenarios) + script `npm run ai:eval`.
- [ ] Calibración con corpus benigno documentada.

## Especificaciones clave

### Zonas y perfiles de capas (D15)

**Zonas.** Se resuelven al iniciar con las rutas reales del usuario (`app.getPath('downloads')`, etc.):

| Zona | Ruta típica |
|---|---|
| `DESCARGAS` | `%USERPROFILE%\Downloads` |
| `ESCRITORIO` | `%USERPROFILE%\Desktop` |
| `DOCUMENTOS` | `%USERPROFILE%\Documents` |
| `TEMPORALES` | `%TEMP%`, `%LOCALAPPDATA%\Temp` |
| `DATOS_APPS` | `%APPDATA%`, `%LOCALAPPDATA%` |
| `EXTRAIBLE` | Unidades extraíbles (USB), según `fs.driveInfo` |
| `PROGRAMAS` | `C:\Program Files`, `C:\Program Files (x86)` |
| `SISTEMA` | `C:\Windows` |
| `OTRA` | Cualquier otra ruta |

**Perfiles por defecto** (Map zona → perfil):

| Zona | Capas activas | Incluir ocultos | Tamaño máx. |
|---|---|---|---|
| `DESCARGAS`, `TEMPORALES`, `EXTRAIBLE` | Todas | Sí | 512 MB |
| `ESCRITORIO`, `DOCUMENTOS`, `DATOS_APPS`, `OTRA` | Todas | No | 256 MB |
| `PROGRAMAS` | HASH, SIGNATURES, FILETYPE, RULES | No | 256 MB |
| `SISTEMA` | HASH, SIGNATURES, FILETYPE | No | 256 MB |

En Sistema y Programas no se activan las heurísticas para evitar falsos positivos en archivos legítimos del sistema; la calibración lo justifica con datos.

**Reglas:**

- Gana el prefijo más largo: `%TEMP%` está dentro de `%LOCALAPPDATA%`, así que un archivo en `%LOCALAPPDATA%\Temp\x.exe` es `TEMPORALES` y no `DATOS_APPS`. Esa es la razón del Trie: recorre la ruta segmento por segmento y se queda con la última zona encontrada, en O(profundidad).
- `HASH` y `SIGNATURES` están activas en todas las zonas.
- El usuario puede elegir un perfil personalizado para un escaneo; queda guardado en `scan_jobs.profile_json`.
- La IA (S5) puede **proponer** un plan con zonas y capas, pero el Core lo valida contra estas reglas y el usuario confirma.

**Contrato (ADR-008):**

```json
→ {"jsonrpc":"2.0","id":77,"method":"scan.file","params":{"jobId":"j_7f","taskId":"t_31","path":"E:\\instalador.exe",
   "options":{"maxBytes":536870912,"zone":"EXTRAIBLE","layers":["HASH","SIGNATURES","FILETYPE","RULES","HEURISTICS","PE","SCRIPTS"]}}}
```

### Heurísticas

| Código | Capa | Qué detecta | Severidad inicial |
|---|---|---|---|
| `TYPE_MISMATCH` | FILETYPE | Tipo real distinto a la extensión (de S2) | MEDIUM (HIGH si es un ejecutable disfrazado) |
| `DOUBLE_EXTENSION` | FILETYPE | `.pdf.exe` (de S2) | HIGH |
| `RLO_IN_NAME` | FILETYPE | Carácter U+202E en el nombre (de S2) | HIGH |
| `HIGH_ENTROPY` | HEURISTICS | Entropía global mayor a 7.2 (empaquetado o cifrado) | MEDIUM |
| `EXEC_IN_DOWNLOADS_OR_TEMP` | HEURISTICS | Ejecutable en Descargas o en una carpeta temporal | LOW |
| `HIDDEN_SYSTEM_USER_FILE` | HEURISTICS | Atributos oculto + sistema en un archivo de usuario | LOW |
| `PE_PACKER_SECTION` | PE | Secciones típicas de empaquetadores (por ejemplo UPX) | LOW |
| `PE_ANOMALOUS_SECTIONS` | PE | Sección ejecutable y escribible, o con entropía muy alta | MEDIUM |
| `PE_SUSPICIOUS_IMPORTS` | PE | Combinación de APIs típicas de inyección de código | MEDIUM |
| `SCRIPT_ENCODED_COMMAND` | SCRIPTS | PowerShell con comando codificado o un blob base64 largo | HIGH |
| `SCRIPT_DOWNLOAD_EXEC` | SCRIPTS | Patrón de descargar y ejecutar en un script | HIGH |

### Formato de regla (YAML)

```yaml
id: R-TEST-DOWNLOADER
name: Marcador de prueba de descargador
description: Regla de prueba que busca un marcador inofensivo en scripts
severity: HIGH
points: 25
decisive: false
conditions:
  fileTypes: [SCRIPT_PS1, TEXT]
  maxScanBytes: 4194304
  strings:
    any: ["CYBERSOC_TEST_RULE_DOWNLOADER"]
```

Condiciones soportadas: `fileTypes`, `extensions`, `sizeRange`, `strings` (ASCII, UTF-16 o hex; con `any` o `all`), `peImports` (`any` o `all`), `entropyAbove`.

### Puntuación v2

- Mismos puntos por severidad que en S2.
- **Topes por grupo de capas:** señales heurísticas (`FILETYPE`, `HEURISTICS`, `PE`, `SCRIPTS`) ≤ 50 en total; `RULES` ≤ 60; total ≤ 100. Así, muchas señales débiles no suman un "detectado".
- **La heurística sola nunca produce `DETECTED`.** Solo lo producen una firma o una regla marcada `decisive: true`.
- El desglose (`scoreBreakdown`) se guarda y se muestra en la UI.

### `RiskPolicy` v2

```
si motor = DETECTED                  → final = DETECTED (la IA nunca baja un veredicto)
si motor = SUSPICIOUS                → final = SUSPICIOUS
    si IA = LIKELY_BENIGN y confianza ≥ 0.8 → review_required ("posible falso positivo")
si motor = CLEAN:
    si IA válida
       y opinión ∈ {SUSPICIOUS, LIKELY_MALICIOUS}
       y confianza ≥ 0.7
       y cita ≥ 1 evidencia existente
       y puntuación del motor > 0
                                     → final = SUSPICIOUS, origen = AI_ESCALATION, nivel máximo MEDIO
    si no                            → final = CLEAN
IA ausente o inválida                → final = motor + etiqueta "IA pendiente / no disponible"
(la allowlist del usuario se añade en S4 y va antes de todo)
```

Cómo se evitan los falsos positivos del modelo:

- La política es asimétrica: la IA nunca produce `DETECTED` ni baja un veredicto.
- Sin evidencia citada que exista, no hay escalamiento.
- El origen del escalamiento es visible para el usuario.
- La tasa de escalamientos sobre el corpus benigno se mide y se reporta.

### Cola de IA con prioridad

- `AITask = { resultId, priority, seq }`.
- `priority` = puntuación del motor + bonificación si el veredicto es `DETECTED`.
- A igual prioridad, gana el menor `seq` (orden de llegada). Esto hace estable la cola, y es un buen punto para la sustentación.

### Resumen de escaneo (`JOB_SUMMARY`)

- **Entrada:** contadores, duración y los 10 resultados de mayor riesgo con sus códigos de evidencia.
- **Salida:** `{ summary, highlights: [{ resultId, why }], recommendations: [], citedResultIds: [] }`.
- **Validación:** todos los `resultId` deben existir.

### Calibración con corpus benigno

1. Escanear en solo lectura `C:\Windows\System32` (o una muestra grande) y `Program Files`.
2. Registrar la distribución de veredictos.
3. Objetivo: 0 `DETECTED`, menos del 1 % `SUSPICIOUS` y 0 escalamientos por IA.
4. Ajustar pesos y umbrales, y documentar antes y después en `pruebas/calibracion.md`.

### Evaluación de IA (~15 escenarios)

**Escenarios:**

- instalador legítimo de alta entropía;
- `.pdf.exe`;
- firma de prueba;
- script con comando codificado;
- nombre de archivo con intento de inyección de prompt;
- evidencia insuficiente;
- PE con imports de inyección;
- casos benignos variados.

**Métricas:**

| Métrica | Objetivo |
|---|---|
| Esquema válido | 100 % |
| Citas válidas | 100 % |
| Escalamientos en casos benignos | 0 |
| Coherencia con el motor en casos claros | Alta |
| Latencia p50 / p95 | Se reporta |
| Coste por análisis | Se reporta |

Los resultados se guardan en `evidencias/ai-eval-<fecha>.md`.

### Migración 004

```sql
ALTER TABLE scan_jobs ADD COLUMN ruleset_version TEXT;
ALTER TABLE scan_jobs ADD COLUMN signatures_version TEXT;
ALTER TABLE scan_jobs ADD COLUMN profile_json TEXT;      -- perfil(es) aplicados o plan aceptado
ALTER TABLE scan_results ADD COLUMN zone TEXT;           -- DESCARGAS, EXTRAIBLE, SISTEMA…
CREATE INDEX idx_results_zone ON scan_results(zone);
```

## Estructuras de datos del sprint

| Estructura | Uso | Evidencia |
|---|---|---|
| PriorityQueue (heap binario) | Cola de IA ordenada por riesgo | Pruebas de invariante del heap, estabilidad, O(log n); demo: el archivo crítico se explica primero |
| Arreglo de 256 posiciones | Histograma de bytes → entropía de Shannon | Pruebas: archivo de ceros = 0, bytes aleatorios ≈ 8 |
| Map / dict | Registro de reglas por id; perfiles por zona | Pruebas |
| Trie de rutas (`PathTrie`, propio) | Zona de cada ruta por prefijo más largo | Pruebas con rutas anidadas; comparación con recorrer una lista de prefijos, O(Z·L) |

## Pruebas

- [ ] Cada heurística con un fixture positivo y uno negativo.
- [ ] Cada condición de regla probada; un YAML inválido se rechaza con un mensaje claro.
- [ ] Topes de puntuación; la heurística sola nunca produce `DETECTED`.
- [ ] Un PE malformado no tumba el motor.
- [ ] PriorityQueue: pruebas de propiedad (extraer siempre devuelve el máximo) y estabilidad.
- [ ] `RiskPolicy` v2: tabla completa de casos, incluidos todos los límites (confianza 0.69 / 0.70, puntuación 0, sin citas).
- [ ] Resumen de escaneo con `FakeAIProvider`; `resultId` inventado → rechazado.
- [ ] Evaluación de IA en vivo (manual).
- [ ] Calibración con el corpus benigno.
- [ ] `PathTrie` / `ZoneClassifier`: rutas anidadas, mayúsculas/minúsculas, rutas con ñ, unidad extraíble, prefijo más largo.
- [ ] Perfil `SISTEMA`: `HEURISTICS`, `PE` y `SCRIPTS` quedan `DISABLED` en la traza.
- [ ] Contrato `scan.file` con `options.layers` validado en TS y en Python.

## Criterios de aceptación

- [ ] **CA-3.1** Un script fixture con el marcador de regla produce la evidencia de la regla con su puntuación.
- [ ] **CA-3.2** El panel "¿Cómo se decidió?" muestra cada evidencia, sus puntos, los topes aplicados y la regla de la política que decidió.
- [ ] **CA-3.3** Con varios resultados pendientes, la IA procesa primero el de mayor riesgo.
- [ ] **CA-3.4** Solo se escala de CLEAN a SUSPICIOUS cuando se cumplen todas las condiciones, y se muestra la etiqueta "Escalado por IA".
- [ ] **CA-3.5** Cada escaneo completado tiene un resumen de IA válido, o el estado de IA pendiente.
- [ ] **CA-3.6** La calibración está documentada: 0 `DETECTED` y 0 escalamientos por IA en el corpus benigno.
- [ ] **CA-3.7** La evaluación de IA está documentada con sus métricas.
- [ ] **CA-3.8** Cada resultado muestra su zona y el perfil aplicado; las capas desactivadas por el perfil aparecen como `DISABLED` en "Capas aplicadas".
- [ ] **CA-3.9** Escanear una USB aplica el perfil `EXTRAIBLE` (todas las capas, incluye ocultos); escanear `C:\Windows\System32` aplica el perfil `SISTEMA`.

## Evidencias a guardar

- [ ] Informe de calibración (antes y después).
- [ ] Informe de evaluación de IA.
- [ ] Captura del panel de decisión.
- [ ] Captura del resumen de escaneo.
- [ ] Demo del orden de la cola de prioridad.
- [ ] Fichas `priority-queue.md`, `histograma-entropia.md` y `trie-zonas.md`.
- [ ] Captura de un escaneo con zonas y perfiles distintos.
- [ ] Reportes de pruebas y CI.

## Riesgos a vigilar

- Falsos positivos de la heurística en instaladores legítimos: calibrar y dejar notas de falso positivo de la IA.
- Rendimiento del análisis PE en archivos grandes: límite de bytes.
- Crecimiento del alcance en las reglas: pocas reglas, pero bien probadas.

## Fuera de alcance

Aho-Corasick y YARA (ideal), cuarentena, Copilot.

## Al cerrar

Completar `cierre.md`, crear el tag `v0.3.0-s3` y actualizar `00-ESTADO.md`.
