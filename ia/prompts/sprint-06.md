# Prompts — Sprint 6: Robustez y entrega final (18 – 24 nov)

Plan: `construccion/sprints/sprint-06-robustez-entrega/plan.md` · Reglas: `AGENTS.md` y `construccion/ia/asignacion-agentes.md`

**Congelación vigente:** solo correcciones, cada una con su prueba de regresión. Ninguna funcionalidad nueva.

**Agentes de este sprint (reparto por tokens):**
- **Codex:** lo crítico y pesado (empaquetado, correcciones, manuales, informe final, cierre) y revisiones críticas.
- **Claude Code:** alto nivel y robustez (auditoría de seguridad, guion de demo y guía de sustentación) y revisiones de seguridad y coherencia.
- **Cursor:** validaciones (validación de S5, E2E, rendimiento), video y capturas finales, revisiones no críticas.

Los reportes quedan en `construccion/sprints/sprint-06-robustez-entrega/tareas/T6.X-reporte.md`. Todos los documentos finales quedan en `construccion/sprints/sprint-06-robustez-entrega/entrega/`.

## Orden de ejecución (peguen los prompts en este orden)

| Paso | Tarea | Pegar en | Puede ir en paralelo con | Revisión: pegar la plantilla en |
|---|---|---|---|---|
| 1 | T6.0 Validación del Sprint 5 + pendientes de todo el proyecto | **Cursor** | — | — (si reporta bloqueos, resolverlos antes de seguir) |
| 2 | T6.1 Auditoría de seguridad (solo lectura) | **Claude Code** | Paso 3 | — (es la revisión misma) |
| 3 | T6.2 Empaquetado + plan B | **Codex** (local) | Paso 2 | Cursor |
| 4 | T6.3 Correcciones de la auditoría + auditoría de dependencias | **Codex** (local) | Paso 5 | **Claude Code** [CRÍTICO] |
| 5 | T6.4 Pruebas E2E | **Cursor** | Paso 4 | Codex |
| 6 | T6.5 Rendimiento | **Cursor** | Pasos 7 y 8 | Codex |
| 7 | T6.6 Manuales técnico y de usuario | **Codex** (local) | Pasos 6 y 8 | Cursor |
| 8 | T6.7 Guion de demo + guía de sustentación | **Claude Code** | Pasos 6 y 7 | Cursor |
| 9 | T6.8 Video de la demo + capturas finales | **Cursor** | — | Codex |
| 10 | T6.9 Informe final del proyecto + índice de estructuras + verificación 7.8 | **Codex** (local) | — | **Claude Code** (coherencia) |
| 11 | T6.10 Cierre del Sprint 6 + tag `v1.0.0` | **Codex** (local) | — | Cursor (verifica que el informe no tenga datos inventados) |
| 12 | Ensayo de la sustentación (2 veces) | **Equipo** | — | — |

**Dependencias que importan:**
- El paso 4 necesita el 2.
- Los pasos 6, 7 y 8 se hacen con el 4 ya fusionado (código final).
- El paso 9 necesita el 8 (sigue el guion) y el 3 (usa la app empaquetada si funcionó).
- El paso 10 necesita del 6 al 9.

**Después de cada tarea, siempre igual:**
1. Pegar la plantilla de revisión de `asignacion-agentes.md` en el **agente revisor de la tabla**, con la rama y la tarea. Usen la plantilla de seguridad si dice [CRÍTICO] y la general en los demás casos.
2. Si hay puntos [BLOQUEANTE] o [IMPORTANTE], pegarlos al agente autor con la plantilla de corrección.
3. Leer el "Resumen para el equipo" y fusionar la PR cuando el CI esté en verde.
4. Pasar al siguiente paso.

**API key:** el paso 9 puede usar la API de Claude real para que el video muestre respuestas reales. En la terminal del agente:

```powershell
$env:CYBERSOC_ANTHROPIC_API_KEY = "sk-ant-..."
```

---

## Paso 1 · T6.0 — Validación del Sprint 5 + pendientes del proyecto · Cursor (modo agente)

```text
Validación del Sprint 5, SOLO LECTURA salvo el reporte. Rama: s6/chore-validacion-s5 (créala desde main actualizado).
Lee AGENTS.md, construccion/00-ESTADO.md, construccion/ia/prompts/cierre-sprint.md, la carpeta
construccion/sprints/sprint-05-copilot-herramientas-reportes/ y la sección 11 de los informes de S1 a S5.
Verifica y reporta en una tabla (OK / FALTA / NO CUMPLE):
1. Los tags v0.1.0-s1 a v0.5.0-s5 existen.
2. En CyberSOC/app: npm run typecheck, lint y test pasan. En CyberSOC/engine: uv run ruff check y uv run pytest pasan.
3. No quedan pruebas con it.fails en todo CyberSOC/app/tests.
4. npm run evidence:capture -- --sprint 05 funciona (en una carpeta temporal; no sobrescribas evidencias).
5. Informe de S5: no quedan "____" ni "PENDIENTE" sin justificar; secciones 6 (pedidos del profesor) y 8 completas.
6. Cada archivo de evidencia de la sección 8 del informe de S5 existe.
7. Fichas de S5 (heap-top-k, map-registro-herramientas) completas, con "Guía de estudio".
8. 00-ESTADO.md: S5 "Cerrado", S6 "En curso", último tag v0.5.0-s5, congelación funcional declarada.
9. Funcionalidad clave de S5 presente: 14 herramientas de solo lectura, build_report con exportación,
   AssistantOrchestrator v2, ScanPlanValidator, conversaciones guardadas, historial con filtros.
10. PENDIENTES DEL PROYECTO: junta en una tabla todos los riesgos y pendientes de la sección 11 de los informes
    de S1 a S5. Clasifícalos en:
    - "corregir en S6": solo errores, nunca funcionalidades nuevas;
    - "documentar como limitación": irá en el informe final;
    - "ya resuelto": con la evidencia.
Para cada FALTA o NO CUMPLE indica cómo resolverlo:
- si es de documentación: qué parte de cierre-sprint.md ejecutar;
- si es de código: una tarea de corrección (rama s5/fix-<tema>).
Guarda el reporte en construccion/sprints/sprint-06-robustez-entrega/tareas/T6.0-reporte.md, con un
"Resumen para el equipo" que diga claramente: "Se puede continuar" o "Hay que resolver primero: …".
Archivos permitidos: solo ese reporte. Commit, push y PR. No hagas merge.
```

## Paso 2 · T6.1 — Auditoría de seguridad · Claude Code (solo lectura)

```text
Auditoría de seguridad. NO modifiques código; solo escribe el informe.
Lee AGENTS.md y construccion/sprints/sprint-06-robustez-entrega/plan.md (sección "Checklist de seguridad").
Rama: s6/docs-auditoria.
Revisa, en este orden y sin leer todo el repositorio:
- CyberSOC/app/src/main/** (ventanas, IPC, SecretStore);
- src/preload/**;
- src/core/ai/** (validación, herramientas, planificador);
- src/core/quarantine/**;
- src/core/reports/exporters/**;
- CyberSOC/engine/src/** (imports de red y escrituras en disco).
1. Para cada punto de la checklist del plan: CUMPLE / NO CUMPLE / NO VERIFICABLE, con archivo:línea.
2. Hallazgos priorizados [BLOQUEANTE] / [IMPORTANTE] / [MENOR] (máximo 20), cada uno con archivo:línea y la
   corrección sugerida en 1–2 líneas, numerados H1, H2…
3. Historial de git: busca secretos o EICAR (git log -p con "sk-ant", "EICAR", "api_key") y reporta el resultado.
Guarda el informe en construccion/sprints/sprint-06-robustez-entrega/evidencias/03-auditoria-seguridad.md,
con un "Resumen para el equipo" de 5 líneas al final.
Archivos permitidos: ese informe y tareas/T6.1-reporte.md. Commit, push y PR. No hagas merge.
```

## Paso 3 · T6.2 — Empaquetado + plan B · Codex (local)

```text
Lee AGENTS.md y construccion/sprints/sprint-06-robustez-entrega/plan.md (sección "Empaquetado").
Tarea T6.2 — Empaquetado. Rama: s6/build-packaging.
1. PRIMERO, el plan B: escribe y prueba los comandos exactos para ejecutar la demo en modo desarrollo desde un clon
   limpio (git clone, npm ci, uv sync, npm run dev). Inclúyelos en el reporte; T6.6 los pasa al manual técnico.
2. Opción A: distribución embebible de Python 3.12 + dependencias del motor, incluida con electron-builder
   (extraResources). El core debe resolver la ruta del motor en modo empaquetado.
3. Solo si A falla: opción B con PyInstaller. Advierte en el reporte que otros antivirus pueden marcar ese
   ejecutable como falso positivo.
4. Genera la carpeta portable o el instalador. Prueba de humo: ejecuta la app empaquetada SIN el venv del proyecto
   en el PATH; verifica que el motor se conecta y que escanea los fixtures.
   - Guarda el log de build y de la prueba en construccion/sprints/sprint-06-robustez-entrega/evidencias/05-empaquetado.txt;
   - toma una captura de la app empaquetada funcionando (Playwright sobre el ejecutable) en evidencias/06-app-empaquetada.png.
5. Si el empaquetado no queda estable, déjalo documentado y el plan B probado: la demo se hace en modo desarrollo.
Archivos permitidos: CyberSOC/app/electron-builder.*, package.json, scripts de build, src/main/** (solo la resolución de
la ruta del motor), CyberSOC/engine/pyproject.toml (si hace falta), esos archivos de evidencia, tareas/T6.2-reporte.md.
Commit, push y PR. No hagas merge.
```

## Paso 4 · T6.3 — Correcciones de la auditoría + dependencias · Codex (local) · revisa Claude Code [CRÍTICO]

```text
Lee AGENTS.md y construccion/sprints/sprint-06-robustez-entrega/evidencias/03-auditoria-seguridad.md.
Tarea T6.3 — Correcciones de seguridad. Rama: s6/fix-security.
1. Corrige TODOS los hallazgos [BLOQUEANTE] e [IMPORTANTE], con un commit por hallazgo
   (mensaje "fix(security): H<n> <resumen>"). Cada corrección lleva una prueba de regresión que falla antes y pasa después.
2. Los [MENOR] solo se corrigen si son de una línea y sin riesgo; los demás quedan listados como limitación.
3. No agregues funcionalidades (congelación vigente).
4. Ejecuta npm audit (CyberSOC/app) y pip-audit (CyberSOC/engine). Corrige las vulnerabilidades altas si basta con
   actualizar una versión menor; si no, documéntalas.
   Salida en construccion/sprints/sprint-06-robustez-entrega/evidencias/10-dependencias-audit.txt.
5. Escribe evidencias/04-correcciones-seguridad.txt: tabla hallazgo → commit → prueba de regresión → estado
   (corregido / limitación documentada).
Archivos permitidos: los archivos señalados en los hallazgos y sus pruebas, package.json/lockfiles (solo versiones),
esos archivos de evidencia, tareas/T6.3-reporte.md. Commit, push y PR. No hagas merge.
```

Revisión: **Claude Code**, con la plantilla de seguridad aplicada al diff de `s6/fix-security`, en una sola sesión. Foco: que cada hallazgo quedó realmente cerrado.

## Paso 5 · T6.4 — Pruebas E2E · Cursor (modo agente)

```text
Lee AGENTS.md y construccion/sprints/sprint-06-robustez-entrega/plan.md (sección "Escenarios E2E").
Tarea T6.4 — E2E. Rama: s6/test-e2e.
1. Configura Playwright para Electron reutilizando el modo evidencia del capturador (BD temporal, fixtures,
   diálogo simulado, FakeAIProvider).
2. Implementa los 6 escenarios del plan en CyberSOC/app/tests/e2e/. Script npm run test:e2e.
3. Ejecútalos en Windows local. Agrégalos al CI solo si pasan de forma estable 3 veces seguidas.
4. Guarda la salida en construccion/sprints/sprint-06-robustez-entrega/evidencias/01-e2e-reporte.txt
   y el reporte HTML de Playwright en evidencias/01-e2e-reporte/.
Archivos permitidos: CyberSOC/app/tests/e2e/**, playwright.config.ts, package.json (script), .github/workflows/ci.yml
(solo si es estable), esos archivos de evidencia, tareas/T6.4-reporte.md.
Commit, push y PR. No hagas merge.
```

## Paso 6 · T6.5 — Rendimiento · Cursor (modo agente)

```text
Lee AGENTS.md y construccion/sprints/sprint-06-robustez-entrega/plan.md (sección "Rendimiento").
Tarea T6.5 — Rendimiento. Rama: s6/test-performance.
Amplía scripts/perf-scan.ts con:
(a) 10 000 archivos pequeños → archivos/s y duración total;
(b) un archivo de 1 GB generado → MB/s y memoria máxima del proceso Python;
(c) pico de la pila y de la cola en un árbol profundo y ancho;
(d) la UI responde durante el escaneo (tiempo de respuesta de un clic, medido con Playwright).
Ejecuta todo y escribe construccion/sprints/sprint-06-robustez-entrega/evidencias/02-rendimiento.md con una tabla de
resultados, la máquina usada (CPU, RAM, disco) y una conclusión de 3 líneas.
Archivos permitidos: CyberSOC/app/scripts/perf-scan.ts, ese archivo de evidencia, tareas/T6.5-reporte.md.
Commit, push y PR. No hagas merge.
```

## Paso 7 · T6.6 — Manuales · Codex (local)

```text
Lee AGENTS.md, construccion/01-resumen-general.md, los ADR, los planes e informes de S1 a S5, el reporte de T6.2
(plan B) y el código final.
Tarea T6.6 — Manuales. Rama: s6/docs-manuales.
Escribe en español claro, SOLO con base en el código y los documentos (no inventes funciones):
1. construccion/sprints/sprint-06-robustez-entrega/entrega/manual-tecnico.md:
   - requisitos e instalación (incluido el plan B en modo desarrollo, paso a paso);
   - compilación y empaquetado;
   - arquitectura de 3 procesos;
   - protocolo JSON-RPC;
   - modelo de datos (tablas y migraciones);
   - capas del motor;
   - estructuras de datos, con enlaces a las fichas;
   - diseño de IA (API de Claude, AIProvider, Risk Policy, validación, degradación, privacidad);
   - pruebas y cómo ejecutarlas;
   - cómo añadir firmas y reglas;
   - zonas y perfiles de capas;
   - cómo cambiar de proveedor de IA.
2. .../entrega/manual-usuario.md:
   - escanear;
   - interpretar veredictos;
   - evidencia, capas aplicadas y "¿Cómo se decidió?";
   - análisis de IA y "Qué se envió";
   - Copilot: preguntas, reportes, consulta de capas y planificador;
   - cuarentena;
   - historial y reportes;
   - configurar la API key;
   - qué pasa sin Internet.
   Donde vaya una imagen, usa la referencia exacta ../evidencias/11-capturas-finales/<nombre>.png con los nombres
   de la lista del paso 9 de construccion/ia/prompts/sprint-06.md.
3. Compara construccion/arquitectura/diagramas/arquitectura-v2.svg con el código final. Si algo cambió, crea
   arquitectura-v3.svg (y su PNG, por ejemplo con una captura de Playwright) y anota los cambios en el reporte.
   Si no cambió nada, dilo.
Archivos permitidos: esos dos manuales, construccion/arquitectura/diagramas/arquitectura-v3.*, tareas/T6.6-reporte.md.
Commit, push y PR. No hagas merge.
```

## Paso 8 · T6.7 — Guion de demo + guía de sustentación · Claude Code

```text
Lee AGENTS.md, construccion/sprints/sprint-06-robustez-entrega/plan.md (secciones "Guion de la demostración" y
"Guion de sustentación"), construccion/01-resumen-general.md, los informes de S1 a S5 y todas las fichas de estructuras.
Tarea T6.7 — Guion y guía. Rama: s6/docs-sustentacion.
1. .../entrega/guion-demo.md (~14 minutos), paso a paso. En cada paso:
   - qué se hace en la app;
   - qué se dice (2–3 frases simples);
   - qué debe verse en pantalla;
   - quién habla (Persona A o B, repartido por igual);
   - plan B si falla: mostrar ese tramo del video de respaldo (evidencias/08-video-demo.mp4, minuto aproximado).
   Incluye antes de empezar la checklist del día: app abierta, carpeta de demo, API key, Wi-Fi, video listo.
2. .../entrega/guia-sustentacion.md: preguntas probables con respuestas cortas en lenguaje sencillo y "dónde se ve",
   agrupadas por tema:
   - arquitectura;
   - motor y capas;
   - estructuras de datos (TODAS las fichas, 2–3 preguntas cada una);
   - IA (las 7 preguntas del documento 7.1 y los pedidos del profesor);
   - seguridad;
   - pruebas y evidencias.
3. En la misma guía, una sección honesta "Metodología con agentes de IA":
   - qué hizo cada agente;
   - qué controló el equipo (prompts, revisión cruzada, pruebas, evidencias, cierre por sprint);
   - cómo responder con sinceridad si preguntan quién escribió el código y cómo verificaron que es correcto.
4. Termina la guía con las 10 preguntas más difíciles y su mejor respuesta.
Archivos permitidos: esos dos documentos y tareas/T6.7-reporte.md. Commit, push y PR. No hagas merge.
```

## Paso 9 · T6.8 — Video de la demo + capturas finales · Cursor (modo agente)

```text
Lee AGENTS.md y construccion/sprints/sprint-06-robustez-entrega/entrega/guion-demo.md.
Tarea T6.8 — Video y capturas finales. Rama: s6/feat-evidence-final.
1. scripts/evidence/sprint-06.json para npm run evidence:capture -- --sprint 06 [--live]:
   - recorre la demo completa en el orden del guion;
   - graba el video con recordVideo en
     construccion/sprints/sprint-06-robustez-entrega/evidencias/08-video-demo.mp4;
   - usa la app empaquetada si T6.2 funcionó; si no, el modo desarrollo;
   - el tramo "IA sin red" usa FakeAIProvider en modo OFFLINE y lo indica en pantalla.
2. Capturas finales en evidencias/11-capturas-finales/, con EXACTAMENTE estos nombres:
   01-inicio.png, 02-escaneo-progreso.png, 03-resultados.png, 04-detalle-evidencia.png, 05-como-se-decidio.png,
   06-capas-aplicadas.png, 07-analisis-ia.png, 08-que-se-envio.png, 09-copilot.png, 10-reporte.png,
   11-plan-escaneo.png, 12-cuarentena.png, 13-historial.png, 14-configuracion.png.
3. Verifica que el video dure como máximo el tiempo del guion y que existan todas las capturas.
   Reporta la duración real.
Archivos permitidos: CyberSOC/app/scripts/evidence/**, scripts/capture-evidence.ts, src/main/composition-root.ts
(solo el modo evidencia), src/renderer/** (solo data-testid), construccion/sprints/sprint-06-robustez-entrega/evidencias/**,
tareas/T6.8-reporte.md. Commit, push y PR. No hagas merge.
```

## Paso 10 · T6.9 — Informe final + índice de estructuras + verificación 7.8 · Codex (local) · revisa Claude Code

```text
Lee AGENTS.md, construccion/00-ESTADO.md, construccion/01-resumen-general.md, todos los informes y fichas de S1 a S6,
los ADR, el reporte de T6.0 y construccion/pruebas/calibracion.md.
Tarea T6.9 — Informe final. Rama: s6/docs-informe-final.
1. Completa construccion/sprints/sprint-06-robustez-entrega/entrega/informe-final-proyecto.md siguiendo su plantilla.
   Reemplaza cada "____" con datos reales de los informes y del repositorio. NO inventes cifras: si un dato no
   existe, escribe "no medido".
2. Crea construccion/estructuras-de-datos/indice.md: tabla con TODAS las fichas de todos los sprints (estructura,
   problema que resuelve, sprint, archivo de código, enlace a la ficha). Busca también las fichas de S0, donde estén.
3. Crea construccion/sprints/sprint-06-robustez-entrega/evidencias/07-verificacion-ia-7.8.md:
   - los 10 mínimos de IA;
   - los 11 lugares donde debe aparecer la IA;
   - los pedidos del profesor;
   cada uno con CUMPLE / NO CUMPLE y su evidencia (ruta del archivo).
Archivos permitidos: esos tres documentos y tareas/T6.9-reporte.md. Commit, push y PR. No hagas merge.
```

Revisión: **Claude Code**, con la plantilla general y este foco adicional: *"Verifica la coherencia del informe final con los informes de cada sprint y que no haya cifras inventadas."*

## Paso 11 · T6.10 — Cierre del Sprint 6 + `v1.0.0` · Codex (local)

Ejecuten `construccion/ia/prompts/cierre-sprint.md` con N = 6 (carpeta `sprint-06-robustez-entrega`, tag `v1.0.0`):

| Parte | Qué hace |
|---|---|
| Parte 1 | Verificación, evidencias de texto, informe del sprint y estado |
| Parte 2 | No hace falta: T6.8 ya generó el video y las capturas finales |
| Fusionar la PR y Parte 3 | Tag `v1.0.0` |
| Parte 4 (solo S6) | Verificar que la app arranca desde `v1.0.0` (prompt al final de este paso) |

En la **Parte 1**, peguen además este extra debajo del prompt:

```text
Además, solo en este cierre (entrega final):
a) En construccion/00-ESTADO.md:
   - Sprint actual = "Proyecto entregado", estado "Entregado";
   - Último tag estable = v1.0.0;
   - Roadmap: S6 "Cerrado";
   - Bitácora: "Entrega final (v1.0.0)".
b) En el informe, CA-6.8 queda "PENDIENTE: verificación desde el tag (Parte 4)".
c) Pregunta al equipo en el chat si ya hicieron los 2 ensayos de la sustentación. Marca las casillas de ensayo del
   informe SOLO si lo confirman; si no, déjalas como PENDIENTE.
d) Verifica que en entrega/ existan los 6 documentos finales (informe del sprint, informe final, dos manuales,
   guion y guía) y repórtalo.
```

Antes de fusionar, Cursor verifica la PR del cierre con la plantilla de revisión general.

**Parte 4 — después de crear el tag** (Codex local):

```text
Rama: s6/docs-tag-v1 (desde main). Clona el repositorio en una carpeta temporal y haz git checkout v1.0.0.
Instala (npm ci, uv sync) y verifica que la app arranca (o la app empaquetada de ese tag) y que el motor se conecta.
Guarda los comandos y su resultado en construccion/sprints/sprint-06-robustez-entrega/evidencias/09-tag-v1.txt.
Actualiza en entrega/informe-sprint-06.md el estado de CA-6.8 con esa evidencia.
Archivos permitidos: esos dos archivos. Commit, push y PR con el título "Verificación v1.0.0". No hagas merge.
```

Esta PR solo agrega documentación; el tag `v1.0.0` no se mueve.

## Paso 12 · Ensayo de la sustentación · Equipo

Es la única tarea del equipo en todo el sprint:

1. Lean `entrega/guion-demo.md` y `entrega/guia-sustentacion.md`.
2. Hagan **2 ensayos** completos, con cronómetro, siguiendo el guion y repartiendo los pasos entre Persona A y B.
3. Díganle al agente del paso 11 (o en cualquier chat con Codex) *"ya hicimos los 2 ensayos"*, para que marque las casillas del informe.

**Simulacro opcional** (ChatGPT o Claude Chat), adjuntando `guia-sustentacion.md`:

```text
Actúa como el profesor de Estructuras de Datos que evalúa el proyecto CyberSOC Defender. Usando la guía adjunta,
hazme 10 preguntas, una por una, mezclando estructuras de datos, IA, seguridad y metodología. Espera mi respuesta
a cada una y corrígeme en lenguaje sencillo antes de pasar a la siguiente.
```
