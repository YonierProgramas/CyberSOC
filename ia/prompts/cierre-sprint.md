# Cierre de sprint — lo hace la IA

## Qué es el cierre y para qué sirve

El cierre es la **prueba ante el profesor** de que el sprint cumplió lo prometido. Cada criterio de aceptación del plan (CA-N.x) necesita una **evidencia**: un archivo que demuestre que se cumple.

Hay dos tipos de evidencia:

| Tipo | Ejemplos | Quién la produce |
|---|---|---|
| **De texto** | Salidas de pruebas, consultas SQL, rendimiento, comparación de hash con `certutil`, historial de git | El agente de cierre |
| **Visual** | Capturas de pantalla y videos de la app | El capturador automático (desde S2, T2.11) |

Con las evidencias, el agente completa el **informe de entrega** (`entrega/informe-sprint-NN.md`) y las **fichas** de estructuras de datos, y actualiza `00-ESTADO.md`. El equipo no escribe nada: pega tres prompts y fusiona una PR.

## Pasos

| Paso | Quién | Qué |
|---|---|---|
| 1 | Equipo | Actualizar `main` y abrir **Codex en local** (necesita Windows para ejecutar la app y las pruebas) en la raíz del repositorio |
| 2 | Codex | Prompt **Parte 1**: verifica, genera evidencias de texto, completa el informe y las fichas, actualiza el estado y abre la PR |
| 3 | Equipo | Leer el "Resumen para el equipo" y la lista de lo que **no se cumple** (si hay algo) |
| 4 | Codex | Solo si ya existe el capturador: prompt **Parte 2** (capturas y videos, y actualización del informe) |
| 5 | Equipo | Fusionar la PR (Squash and merge) |
| 6 | Codex | Prompt **Parte 3**: crea el tag del sprint |

Si en el paso 3 aparece un criterio **no cumplido**, no se esconde. Se crea una tarea de corrección (Codex, rama `sN/fix-<tema>`) antes de fusionar el cierre, o se deja registrado como pendiente para el siguiente sprint, según su gravedad.

Nombres del sprint para los prompts:

| N | Carpeta | Tag |
|---|---|---|
| 1 | `sprint-01-escaneo-real` | `v0.1.0-s1` |
| 2 | `sprint-02-evidencia-ia-v1` | `v0.2.0-s2` |
| 3 | `sprint-03-motor-hibrido-ia-v2` | `v0.3.0-s3` |
| 4 | `sprint-04-cuarentena-copilot-v1` | `v0.4.0-s4` |
| 5 | `sprint-05-copilot-herramientas-reportes` | `v0.5.0-s5` |
| 6 | `sprint-06-robustez-entrega` | `v1.0.0` |

---

## Parte 1 — Verificación, evidencias de texto, informe y estado · Codex (local)

Reemplacen `<N>`, `<NN>` (con dos dígitos), `<CARPETA>` y `<TAG>` con los valores de la tabla.

```text
Cierre del Sprint <N>. Rama: s<N>/docs-entrega (créala desde main actualizado).
Lee AGENTS.md, construccion/00-ESTADO.md, construccion/sprints/<CARPETA>/plan.md,
construccion/sprints/<CARPETA>/entrega/informe-sprint-<NN>.md, construccion/sprints/<CARPETA>/entrega/fichas/*.md
y los reportes de construccion/sprints/<CARPETA>/tareas/.

1. VERIFICACIÓN
   - En CyberSOC/app: npm run typecheck, npm run lint, npm test (y las pruebas de integración del sprint).
   - En CyberSOC/engine: uv run ruff check y uv run pytest.
   - Los scripts de rendimiento del sprint, si existen.
   - Para CADA criterio de aceptación del plan, determina si se cumple con evidencia real (prueba, consulta o comando).
     Si alguno NO se cumple, no lo ocultes: márcalo como "NO CUMPLE", explica por qué y qué habría que corregir.
     No corrijas código en esta rama.

2. EVIDENCIAS DE TEXTO
   En construccion/sprints/<CARPETA>/evidencias/, genera todas las evidencias de la sección 8 del informe que se
   puedan producir por comando, con EXACTAMENTE los nombres del informe:
   - salidas de pruebas;
   - consultas SQL sobre una BD de demostración creada escaneando los fixtures;
   - rendimiento;
   - comparación del hash de la app con certutil -hashfile <archivo> SHA256;
   - historial de git.
   Guarda los reportes de pruebas en la subcarpeta indicada en el informe.

3. INFORME
   Completa entrega/informe-sprint-<NN>.md reemplazando cada "____" con datos reales:
   - fechas y commits (git log), números de PR (gh pr list --state merged);
   - autor real de cada tarea según tareas/ y git (si una IA hizo algo que el plan asignaba al equipo, indícalo);
   - resultados y cobertura de pruebas; cifras de rendimiento;
   - estado de cada CA con su archivo de evidencia.
   Donde falte algo (por ejemplo, una captura visual todavía no generada), escribe "PENDIENTE: <qué falta>".
   NO inventes datos. La casilla "Explicación de vuelta" se interpreta como "el equipo leyó el Resumen para el equipo".

4. FICHAS
   Completa los "____" de entrega/fichas/*.md (commit, nombres de pruebas, métricas observadas, comparaciones).
   Si una ficha no tiene la sección "Guía de estudio", agrégala al final: 5–8 líneas sencillas y 3 preguntas
   con su respuesta.

5. ESTADO
   En construccion/00-ESTADO.md:
   - Sprint actual = Sprint <N+1>, con nombre y fechas del roadmap, estado "En curso";
   - Último tag estable = <TAG>;
   - Roadmap: Sprint <N> "Cerrado", Sprint <N+1> "En curso";
   - Bitácora: una fila con la fecha de hoy: "Cierre Sprint <N> (<TAG>)".

6. REPORTE
   Guarda tu reporte en construccion/sprints/<CARPETA>/tareas/cierre-reporte.md, con:
   - tabla de CA (CUMPLE / NO CUMPLE / PENDIENTE);
   - lista de evidencias VISUALES pendientes, con su nombre exacto de archivo y qué debe verse en cada una;
   - "Resumen para el equipo".

Archivos permitidos: construccion/** (nada dentro de CyberSOC/).
Haz commit, push y abre la PR (gh pr create) con el título "Cierre Sprint <N>". No hagas merge.
```

### Extra solo para el cierre del Sprint 1

Péguenlo **debajo** del prompt de la Parte 1 cuando `<N>` = 1:

```text
Además, solo en este cierre, actualiza las reglas a la nueva forma de trabajo (el equipo no programa):
a) construccion/00-ESTADO.md:
   - D9 → "Queue, Stack, PriorityQueue, Trie de rutas y heap top-k implementadas en el proyecto (no librerías),
     escritas por agentes de IA en modo didáctico y documentadas en fichas; Map/Set/dict nativos, explicados".
   - D19 → cambia "las estructuras de datos las escribe el equipo" por "el equipo no programa: dirige, aprueba y
     estudia; todo el código lo escriben los agentes (estructuras en modo didáctico)".
   - Bitácora: "Nueva forma de trabajo: todo el código y los documentos los escriben agentes".
b) construccion/01-resumen-general.md, sección Definition of Done: reemplaza
   "La persona que no fue autora explicó cada cambio antes del merge." por
   "El equipo leyó el "Resumen para el equipo" de cada PR."
c) construccion/ia/reglas-agentes.md, sección "Flujo de una tarea", paso 7: reemplázalo por
   "7. El equipo lee el "Resumen para el equipo" del reporte y del revisor."
d) Las capturas visuales de S1 quedan "PENDIENTE": se generarán con el capturador del Sprint 2 (T2.11).
   Márcalo así en el informe, sin dejar CA como "NO CUMPLE" solo por falta de captura, si la prueba de texto lo demuestra.
e) Genera como TEXTO dos evidencias que el informe de S1 nombra como imagen, y ajusta la extensión en el informe:
   - 02-certutil-hash.txt: hash mostrado por la app (desde la BD) junto a la salida de certutil del mismo archivo;
   - 13-ci-verde.txt: salida de gh run list y gh run view del último workflow en verde de main.
```

---

## Parte 2 — Capturas y videos (cuando exista el capturador) · Codex (local)

```text
En la rama s<N>/docs-entrega (o en una nueva rama s<N>/docs-evidencias si la PR del cierre ya se fusionó):
1. Ejecuta npm run evidence:capture -- --sprint <NN> en CyberSOC/app.
2. Verifica que existan en construccion/sprints/<CARPETA>/evidencias/ todas las evidencias visuales del informe.
3. Actualiza el informe: reemplaza los "PENDIENTE" que ya tienen evidencia y el estado de los CA correspondientes.
4. Actualiza tareas/cierre-reporte.md.
Archivos permitidos: construccion/**. Commit y push. No hagas merge.
```

## Parte 3 — Tag del sprint · Codex (local), después de fusionar la PR del cierre

```text
Actualiza main (git checkout main && git pull). Ejecuta npm test en CyberSOC/app y uv run pytest en CyberSOC/engine.
Si pasan, crea y sube el tag anotado <TAG> con el mensaje "Cierre Sprint <N>"
(git tag -a <TAG> -m "Cierre Sprint <N>" && git push origin <TAG>). No cambies archivos.
Si alguna prueba falla, NO crees el tag y reporta el error.
```

El tag marca el estado del **código**. Si después se agregan capturas del mismo sprint (Parte 2), son solo documentos y no hace falta mover el tag.

## Único caso manual: video de la demo sin red (Sprint 2)

El capturador no puede apagar el Wi-Fi sin permisos de administrador, así que este video se graba a mano. El guion paso a paso está en el informe del Sprint 2, sección 8. Para grabar:

1. `Win + Alt + R` inicia y detiene la grabación de la ventana activa (Xbox Game Bar).
2. El video queda en `Videos\Capturas`.
3. Muévanlo a `evidencias/` con el nombre indicado.
