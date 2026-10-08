# Asignación de agentes según presupuesto

**Regla del proyecto:** el equipo no programa ni redacta documentos técnicos. Todo lo hacen los agentes. El equipo dirige (pega prompts), controla (aprueba y fusiona PR) y estudia (lee resúmenes y fichas para la sustentación).

**Criterio de asignación (desde el Sprint 3), pensado para repartir los tokens entre los tres planes:**

| Agente | Recibe | Ejemplos |
|---|---|---|
| **Codex** (100 USD) | Lo crítico y pesado: tareas con más código o más riesgo técnico | Motor, contratos, integración, calibración, cierre de sprint; revisión crítica de lo que hace Claude Code |
| **Claude Code** (20 USD) | Alto nivel y robustez: decisiones y piezas cortas pero delicadas | ADR, Risk Policy, prompts y validación de IA, revisión de seguridad [CRÍTICO] |
| **Cursor** (20 USD) | Validaciones y tareas acotadas | Validación del sprint anterior, revisiones no críticas, UI, capturas de evidencias |

El prompt de cada tarea ya indica qué agente usar.

## Rol de cada herramienta

| Herramienta | Plan | Capacidad | Rol en el proyecto | Parte aprox. de las tareas |
|---|---|---|---|---|
| **Codex** | 100 USD | La mayor | Crítico y pesado: motor Python, core, contratos, estructuras de datos (modo didáctico), integración, calibración, cierre de sprints, E2E, empaquetado; revisión crítica de Claude Code y revisión de Cursor | ~60 % |
| **Claude Code + Claude Chat** | 20 USD (Pro) | Limitada y **compartida** entre el chat y Claude Code | Alto nivel y robustez: ADR, Risk Policy, validador y prompts de IA, orquestador del Copilot, pruebas adversariales, revisión de seguridad [CRÍTICO], auditoría final | ~15 % |
| **Cursor** | 20 USD | Media | Validaciones: validación del sprint anterior, revisiones no críticas, verificación de informes; además UI y capturas de evidencias | ~25 % |
| **ChatGPT** | Si viene con el plan de Codex | — | Explicaciones de estudio y borradores de documentos largos, para no gastar el límite de Claude | Apoyo |
| **Equipo** | — | — | Pegar prompts, aprobar y fusionar PR, configurar la API key, leer el "Resumen para el equipo" de cada PR, estudiar las fichas | Dirección y control |

## Lo que hace el equipo en cada tarea (nada más)

1. Abrir el agente indicado en la raíz del repositorio y pegar el prompt de la tarea.
2. Cuando el agente termine, pegar su reporte al agente revisor, con la plantilla de revisión.
3. Si el revisor marca puntos [BLOQUEANTE] o [IMPORTANTE], pegarlos al agente autor con la plantilla de corrección.
4. Leer el **"Resumen para el equipo"** del reporte (5 líneas).
5. Fusionar la PR en GitHub (botón "Squash and merge") cuando el CI esté en verde.

Si algo no se entiende, usen la plantilla **"Explícame esto"** (abajo) con ChatGPT o Claude Chat.

## Estructuras de datos: modo didáctico

Las estructuras (Queue, Stack, Set, Map, PriorityQueue, Trie, top-k) las implementan los agentes en **modo didáctico** (definido en `AGENTS.md`):

- código comentado con el invariante y la complejidad de cada operación;
- "Explicación para estudiantes" en el reporte;
- ficha completa en `sprints/<sprint>/entrega/fichas/`, con una sección "Guía de estudio".

El profesor evalúa estructuras de datos: las fichas y las explicaciones son su material de estudio para la sustentación.

## Revisión cruzada (autor ≠ revisor)

| Autor | Revisor | Cuándo |
|---|---|---|
| Codex | **Claude Code** | Tareas marcadas **[CRÍTICO]** (seguridad, parser de archivos, cuarentena, calibración) |
| Codex | Cursor | Resto de tareas |
| Claude Code | Codex | Siempre (es crítica cuando toca decisiones o IA) |
| Cursor | Codex | Siempre |

- En tareas de estructuras de datos, el revisor verifica además la complejidad y los comentarios didácticos.
- Cuando haya dos PR críticos en el mismo sprint, revísenlos con Claude Code en **una sola sesión**.

## Cómo rendir el límite de Claude (Pro, 20 USD)

- El límite del plan Pro se comparte entre Claude Chat y Claude Code, y se reinicia por ventanas de 5 horas.
- **Una tarea por sesión.** Usen `/clear` entre tareas.
- Den rutas exactas; no pidan que explore todo el repositorio.
- Para revisiones, pasen solo el diff (`git diff main...<rama>`).
- Usen Sonnet en Claude Code: los modelos más potentes consumen el límite más rápido.
- No peguen logs completos; solo el error.
- Si se agota el límite, Codex sigue con otra tarea mientras se reinicia la ventana.

### ⚠️ Variable de entorno de la API

**No definan `ANTHROPIC_API_KEY` en el sistema.** Si existe, Claude Code la usa y cobra a la API en lugar del plan Pro.

La app usa **`CYBERSOC_ANTHROPIC_API_KEY`**. Para las pruebas reales de IA, defínanla solo en la terminal donde trabaja el agente (PowerShell):

```powershell
$env:CYBERSOC_ANTHROPIC_API_KEY = "sk-ant-..."   # solo vale en esta ventana; al cerrarla desaparece
```

## Codex: ¿local o en la nube?

| Modo | Úsenlo para | No lo usen para |
|---|---|---|
| **Local** (CLI o extensión en Windows) | Electron, rutas y atributos de Windows, DPAPI, junctions, USB, capturador de evidencias, cierre de sprint, empaquetado, E2E | — |
| **Nube** | Lógica pura: motor Python sin partes de Windows, core TS, repositorios, pruebas unitarias | Cualquier cosa que dependa de Windows: su entorno no es Windows |

Toda tarea hecha en la nube se verifica localmente en Windows antes del merge. El agente local de cierre lo hace de todas formas.

## Plantillas

### Revisión de seguridad — Claude Code (tareas [CRÍTICO])

```text
Revisión de seguridad, SOLO LECTURA: no modifiques archivos.
Lee AGENTS.md y el prompt de la tarea <T-XX> en construccion/ia/prompts/<sprint>.md.
Revisa únicamente el diff: git diff main...<rama>
Busca: violaciones de AGENTS.md; entradas sin validar (IPC, JSON-RPC, respuestas de IA,
argumentos de herramientas); rutas sin normalizar; fugas de secretos en logs o renderer;
acciones destructivas sin confirmación; carreras en cancelación o cierre; estados
inconsistentes tras un error; texto de IA mostrado como HTML.
Responde con máximo 15 puntos priorizados: [BLOQUEANTE] / [IMPORTANTE] / [MENOR],
cada uno con archivo:línea y la corrección sugerida en 1–2 líneas. No reescribas el código.
Termina con un "Resumen para el equipo" de 3 líneas en lenguaje sencillo.
```

### Revisión general — Cursor o Codex (según la tabla del sprint)

```text
Revisa, SIN modificar archivos, el diff de la rama <rama> contra main.
Verifica contra el prompt de la tarea <T-XX> de construccion/ia/prompts/<sprint>.md:
- ¿cumple cada criterio de "Terminado cuando"?
- ¿hay pruebas suficientes y pasan?
- ¿solo toca los archivos permitidos? ¿nada de documentación dentro de CyberSOC/?
- si es modo didáctico: ¿comentarios de invariante y complejidad, y "Explicación para estudiantes" correcta?
Máximo 15 puntos priorizados con archivo:línea.
Termina con un "Resumen para el equipo" de 3 líneas en lenguaje sencillo.
```

### Corrección tras la revisión — al agente autor

```text
En la misma rama <rama>, aplica SOLO los puntos [BLOQUEANTE] e [IMPORTANTE] de esta revisión:
<pegar lista>
No cambies nada más. Ejecuta las pruebas y actualiza el reporte de la tarea.
```

### Explícame esto — ChatGPT o Claude Chat (para estudiar)

```text
Soy estudiante de cuarto semestre de Estructuras de Datos. Explícame en lenguaje sencillo, con un ejemplo
pequeño paso a paso, qué hace <archivo o concepto> en el proyecto CyberSOC Defender, por qué se usó esa
estructura o técnica, y qué me podría preguntar el profesor (con respuestas cortas). No uses jerga sin explicarla.
```

### Cierre de sprint

Lo hace Codex (local) con el procedimiento de `construccion/ia/prompts/cierre-sprint.md`.
