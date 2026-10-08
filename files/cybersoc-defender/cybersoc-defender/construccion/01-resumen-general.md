# 01 — Resumen general de CyberSOC Defender

## Qué construimos

Un antivirus académico para Windows 10/11 que:

- escanea archivos reales;
- detecta con un motor híbrido (hashes, firmas, reglas y heurística);
- decide de forma determinista y con traza;
- usa IA para analizar, explicar y correlacionar;
- incluye un SOC Copilot que consulta datos reales;
- tiene cuarentena segura e historial en SQLite.

No es una simulación. Los archivos son reales y sus SHA-256 se pueden verificar con `certutil -hashfile`. La cuarentena aísla realmente el archivo, las llamadas al modelo de IA son reales y la persistencia sobrevive a reinicios.

## Arquitectura

| Pieza | Tecnología | Responsabilidad | Nunca hace |
|---|---|---|---|
| UI | Electron renderer · TypeScript + React | Mostrar y capturar intenciones | Acceder a disco, red o secretos |
| Core | Electron main · TypeScript | Cola, estados, SQLite, cuarentena, IA, veredicto final | Parsear contenido binario |
| Motor | Python 3.12 (proceso hijo) | Hashes, tipo real, firmas, reglas, heurística, puntuación | Red, BD, escribir archivos |
| Comunicación | JSON-RPC 2.0 por stdin/stdout | Una línea JSON UTF-8 por mensaje; logs por stderr | — |
| Persistencia | SQLite local | Solo el core escribe | — |
| IA | API de Claude (Anthropic) mediante `AIProvider` → `ClaudeProvider` · modelo `claude-haiku-4-5-20251001` · `FakeAIProvider` en pruebas | Planificar (propone), analizar, explicar, correlacionar, conversar, redactar reportes | Decidir veredictos, ejecutar acciones, ver contenido |

```
Usuario
  │
UI (renderer, sandbox) ──IPC tipado (zod)──► Core (main, TypeScript)
                                               ├─► Motor Python ──► archivos del usuario (solo lectura)
                                               ├─► SQLite (único escritor)
                                               ├─► Bóveda de cuarentena
                                               └─► AIProvider ──► API de Claude (solo metadatos)
```

Diagrama completo: `arquitectura/diagramas/arquitectura-v2.png` (editable: `arquitectura-v2.svg`).

## Reglas de oro

1. Quien ve el contenido de los archivos (Python) no tiene red. Quien tiene red (el core) no ve contenido.
2. El veredicto lo decide `RiskPolicy`, de forma determinista y con traza guardada.
3. La IA nunca declara "detectado" y nunca baja un veredicto. Solo puede escalar limpio → sospechoso citando evidencia real (desde S3).
4. A la IA nunca se envía el contenido de los archivos: solo metadatos, hashes y evidencias.
5. La IA está fuera del camino crítico: el escaneo nunca espera a la red.
6. Toda acción destructiva requiere confirmación del usuario y queda en auditoría.
7. La IA participa en tres momentos: **planificar** (propone un plan de escaneo por zonas y capas), **analizar** (opina sobre cada detección) y **responder/reportar** (con datos reales mediante herramientas). Siempre propone; el usuario confirma y el Core ejecuta.

## Frontera TypeScript ↔ Python

Regla práctica: si necesita leer bytes de un archivo, va a Python. Si necesita estado, red, escritura en disco o UI, va a TypeScript.

| Responsabilidad | Lado |
|---|---|
| UI, diálogos, eventos | TS |
| Descubrimiento de archivos y cola | TS |
| Leer contenido, hashes, tipo real | Python |
| Firmas, reglas, heurística, puntuación del motor | Python |
| Veredicto final (política, allowlist, IA) | TS |
| Persistencia (SQLite) | TS |
| Cuarentena (mover, cifrar, restaurar) | TS |
| IA (contexto, llamadas, validación, Copilot) | TS |
| Configuración | TS la guarda; Python la recibe como parámetros |
| Zonas y perfiles de capas | TS decide; Python recibe las capas activas por archivo |

## Flujo de un escaneo

1. El usuario elige un archivo, una carpeta o una unidad en el diálogo nativo, o acepta un plan de escaneo propuesto por la IA.
2. El core crea un `ScanJob` y lo guarda. Cada ruta se clasifica en una zona (Trie de rutas) y recibe el perfil de capas de esa zona.
3. `FileDiscovery` recorre las carpetas con una Stack y alimenta la `ScanQueue`, en paralelo con el análisis.
4. Por cada tarea, el motor Python aplica las capas del perfil y devuelve un `EngineResult` con evidencia y traza de capas.
5. `RiskPolicy` decide y todo se guarda en una sola transacción.
6. La UI recibe el progreso (máximo 5 eventos por segundo).
7. Los resultados con evidencia entran en la cola de IA, que es asíncrona.
8. La IA analiza, la respuesta se valida y se guarda, y se recalcula la evaluación final. Si la IA falla, el resultado se muestra como "Análisis local completado — análisis inteligente pendiente".
9. En cualquier momento, el usuario puede preguntar al Copilot, pedirle un reporte o consultar qué capas trabajaron en un archivo, un escaneo o una zona.

## Requisitos (IDs oficiales)

| ID | Requisito | Sprint |
|---|---|---|
| RF-01 | Seleccionar y escanear un archivo | S1 |
| RF-02 | Seleccionar y escanear una carpeta recursivamente | S1 |
| RF-03 | Mostrar el progreso en tiempo real | S1 |
| RF-04 | Cancelar un escaneo de forma segura | S1 |
| RF-05 | Calcular el SHA-256 de cada archivo | S1 |
| RF-06 | Identificar el tipo real (magic bytes) y las discrepancias con la extensión | S2 |
| RF-07 | Comparar hashes contra la base local de firmas | S2 |
| RF-08 | Evaluar reglas configurables | S3 |
| RF-09 | Aplicar análisis heurístico | S3 |
| RF-10 | Clasificar cada archivo (limpio / sospechoso / detectado / error-no analizado) con traza | S2–S3 |
| RF-11 | Poner archivos en cuarentena | S4 |
| RF-12 | Restaurar desde cuarentena de forma controlada | S4 |
| RF-13 | Eliminar de cuarentena con confirmación | S4 |
| RF-14 | Consultar el historial persistente de escaneos y resultados | S1–S5 |
| RF-15 | Exportar reportes | S5 |
| RF-16 | Configurar exclusiones, límites e IA | S2–S5 |
| RF-17 | Clasificar rutas en zonas y aplicar un perfil de capas por zona | S3 |
| RF-IA-01 | Analizar automáticamente con IA los resultados con evidencia | S2 |
| RF-IA-02 | Recibir respuestas de IA estructuradas y validadas | S2 |
| RF-IA-03 | Explicar detecciones (técnica y sencilla) y recomendar acciones | S2 |
| RF-IA-04 | Correlacionar evidencias y resumir escaneos | S3 |
| RF-IA-05 | Ofrecer un asistente conversacional integrado (SOC Copilot) | S4 |
| RF-IA-06 | Permitir que el asistente consulte datos reales mediante herramientas de solo lectura | S5 |
| RF-IA-07 | Mostrar exactamente qué datos se enviaron a la IA | S2 |
| RF-IA-08 | Degradarse de forma controlada ante fallos de IA | S2 |
| RF-IA-09 | Gestionar la API key de forma segura | S2 |
| RF-IA-10 | Generar reportes por conversación (datos reales + resumen de IA con citas) | S5 |
| RF-IA-11 | Consultar qué capas trabajaron en archivos, escaneos o zonas | S2 (traza) / S5 (consulta) |
| RF-IA-12 | Proponer planes de escaneo por zona y capas, que el usuario confirma | S5 |

| ID | Requisito no funcional |
|---|---|
| RNF-01 Seguridad | Electron endurecido; motor de solo lectura; sin permisos de administrador |
| RNF-02 Privacidad | Nunca se envía contenido de archivos a la IA; rutas anonimizadas |
| RNF-03 Confiabilidad | Una cancelación o un fallo no pierden resultados ya guardados |
| RNF-04 Rendimiento | La UI nunca se congela; rendimiento medido y documentado |
| RNF-05 Mantenibilidad | Capas separadas, pruebas automatizadas, CI |
| RNF-06 Plataforma | Windows 10/11 x64 |
| RNF-07 Usabilidad | Interfaz en español |
| RNF-08 Trazabilidad | Cada decisión y cada llamada a IA quedan registradas |

## Estructuras de datos

| Estructura | Problema real que resuelve | Dónde | Complejidad clave | Sprint |
|---|---|---|---|---|
| Queue (buffer circular propio) | El descubrimiento y el análisis van a velocidades distintas (productor-consumidor) | `ScanQueue` | enqueue/dequeue O(1) | S0–S1 |
| Stack (propia) | Recorrer directorios profundos sin recursión y poder cancelar entre pasos | `FileDiscovery` | push/pop O(1) | S0–S1 |
| Set | Evitar ciclos causados por junctions; rutas protegidas | `FileDiscovery`, `QuarantineManager` | O(1) promedio | S1, S4 |
| Map / dict | Firmas por hash, peticiones RPC pendientes, magic numbers, reglas, perfiles por zona, herramientas del Copilot | Varios | O(1) promedio | S0–S5 |
| Trie de rutas (propio) | Clasificar cada ruta en su zona por el prefijo más largo | `ZoneClassifier` | O(profundidad de la ruta) | S3 |
| PriorityQueue (heap propio) | La IA es limitada: analizar primero lo más riesgoso | `AIAnalysisQueue` | insert/extract O(log n) | S3 |
| Heap top-k | "Archivos de mayor riesgo" | Copilot / orquestador | O(n log k) | S5 |
| Arreglo de 256 posiciones | Entropía de Shannon | `ByteHistogram` | O(n), una pasada | S3 |
| Listas | Evidencias, resultados paginados, mensajes del chat | Varios | — | S1+ |
| Árbol B (solo explicación) | Índices de SQLite | BD | O(log n) | S1+ |

Cada estructura usada tiene su ficha en `estructuras-de-datos/` (plantilla: `estructuras-de-datos/plantilla-ficha.md`).

## Repositorio

```
/
├─ AGENTS.md · CLAUDE.md · README.md
├─ .github/ (workflows/ci.yml, pull_request_template.md)
├─ construccion/
│  ├─ 00-ESTADO.md · 01-resumen-general.md
│  ├─ ia/ (reglas-agentes.md, plantilla-tarea.md, prompts/)
│  ├─ decisiones/ (ADR-xxx)
│  ├─ propuesta/ · requisitos/ · arquitectura/diagramas/
│  ├─ estructuras-de-datos/ · pruebas/ · manuales/
│  └─ sprints/ (plantilla-cierre.md, sprint-0X-…/plan.md, tareas/, evidencias/)
└─ CyberSOC/
   ├─ app/        Electron + TypeScript (main, preload, renderer, core)
   ├─ engine/     Python (motor de detección)
   └─ contracts/  mensajes de referencia del protocolo TS↔Python
```

## Definition of Done (todos los sprints)

- [ ] Criterios de aceptación del plan cumplidos.
- [ ] Pruebas en verde, localmente y en CI.
- [ ] La persona que no fue autora explicó cada cambio antes del merge.
- [ ] Documentación actualizada, solo en `construccion/`.
- [ ] Evidencias guardadas en `sprints/<sprint>/evidencias/`.
- [ ] Fichas de las estructuras de datos del sprint escritas.
- [ ] `00-ESTADO.md` actualizado y `cierre.md` escrito (riesgos + pendientes).
- [ ] Tag creado, y la app arranca desde ese tag.

## Seguridad permanente

- Nada de malware real ni de ejecutar muestras.
- Nada de EICAR en el repositorio; se usan firmas de prueba propias.
- Nada de permisos de administrador.
- Nada de borrados automáticos ni de modificar archivos del sistema.
- La API key nunca aparece en el código, en los logs ni en el renderer.
- Las dependencias nuevas requieren un ADR.

## Mínimos de IA (documento 7.8) y sprint donde se cumplen

| # | Mínimo | Sprint |
|---|---|---|
| 1 | Integración real con un modelo de IA | S0 (smoke) / S2 |
| 2 | AI Context Builder | S1 (v0) / S2 |
| 3 | Análisis inteligente sobre resultados reales | S2 |
| 4 | Respuestas estructuradas | S2 |
| 5 | Asistente conversacional integrado | S4 |
| 6 | Consultas del asistente sobre datos reales | S5 |
| 7 | Explicación inteligente de detecciones | S2 |
| 8 | Manejo seguro de errores de IA | S2 |
| 9 | Protección de la API key | S2 |
| 10 | Pruebas que demuestren la integración | S2–S5 |

## Pedidos adicionales del profesor

| Pedido | Cómo se cumple | Sprint |
|---|---|---|
| IA integrada, no un chatbot simple | IA en tres momentos: planificar, analizar, responder/reportar | S2–S5 |
| Preguntar y que dé el reporte | `build_report`: datos desde SQLite + resumen de IA con citas; exportable | S5 |
| Con qué capa se trabaja en qué archivos o zonas | Traza de capas (S2), zonas y perfiles (S3), `get_layer_report` y planificador (S5) | S2–S5 |

## Dónde debe aparecer la IA en la documentación (documento 7.8)

- [ ] Requisitos funcionales
- [ ] Arquitectura
- [ ] Diagramas
- [ ] Casos de uso
- [ ] Modelo de componentes
- [ ] Sprints
- [ ] Pruebas
- [ ] Criterios de aceptación
- [ ] Documentación técnica
- [ ] Manual de usuario
- [ ] Demostración final

## Si falta tiempo, recortar en este orden

1. Protección en tiempo real
2. Adaptador YARA
3. Segundo proveedor de IA
4. Aho-Corasick
5. Vista en árbol por carpetas
6. Pool de procesos Python
7. Escaneo incremental
8. Instalador (demo en modo desarrollo)
9. Persistencia de conversaciones del Copilot
10. `compare_results`

**Nunca recortar:** escaneo con cola, motor mínimo, veredicto con traza, mínimos de IA, pedidos del profesor (traza de capas, zonas y perfiles, reportes por conversación, planificador), cuarentena, SQLite y pruebas.

## Cómo usar esta carpeta

- **Al iniciar un sprint.** Lean su `plan.md` y completen la sección "Antes de empezar". Luego creen las tarjetas en `tareas/` con `ia/plantilla-tarea.md` y actualicen `00-ESTADO.md`.
- **Durante el sprint.** Una tarjeta = una rama = un agente escritor. Otro agente revisa.
- **Al cerrar.** Copien `sprints/plantilla-cierre.md` como `cierre.md` dentro de la carpeta del sprint, complétenlo, creen el tag y actualicen `00-ESTADO.md`.
