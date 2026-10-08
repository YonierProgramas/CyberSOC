# 00 — Estado del proyecto (fuente de verdad viva)

> Actualizar al iniciar y al cerrar cada sprint, y cada vez que se apruebe una decisión.

| Campo | Valor |
|---|---|
| Sprint actual | S0 — Foundation |
| Fechas | 30 sep – 6 oct 2026 |
| Estado | Por iniciar |
| Último tag estable | — |
| Entrega 1 (propuesta + requisitos + arquitectura) | **Fecha por confirmar** |
| Entrega final | **Fecha por confirmar** (planificado: finales de noviembre) |
| Persona A (`app/`: core, UI, IA) | _____ |
| Persona B (`engine/`: detección, pruebas) | _____ |
| Proveedor de IA | **API de Claude (Anthropic)** — aprobado (D6) |
| Diagrama vigente | `arquitectura/diagramas/arquitectura-v2.png` (+ `.svg`) |

## Orden de la fuente de verdad

1. Código y contratos en `main` (último tag).
2. Este archivo.
3. ADR en `construccion/decisiones/`.
4. `01-resumen-general.md` y planes de sprint.

Una conversación con cualquier IA **no** es fuente de verdad hasta que su resultado se escribe aquí o en un ADR.

## Retroalimentación del profesor (29 sep 2026)

| Pedido | Cómo lo cumplimos | Sprint | Decisión |
|---|---|---|---|
| La IA dentro del antivirus, no un chatbot simple | La IA participa en tres momentos: planifica (propone el plan de escaneo), analiza (cada detección) y responde/reporta (con datos reales vía herramientas) | S2–S5 | D6, D7, D16, D17 |
| "Le preguntas algo y te da el reporte" | Reportes por conversación: el Core arma los datos desde SQLite y la IA redacta el resumen con citas | S5 | D17 |
| "Con qué capa se trabaja para esos archivos o zonas" | Traza de capas por archivo + zonas con perfiles de capas + planificador de escaneo por zona | S2, S3, S5 | D15, D16, D18 |

## Decisiones

Estados: PROPUESTA → APROBADA → SUSTITUIDA (indicar por cuál ADR).

| ID | Decisión | Estado | ADR |
|---|---|---|---|
| D1 | Escritorio: Electron + electron-vite + TypeScript `strict` | PROPUESTA | ADR-001 |
| D2 | Renderer con React + CSS propio (no por MERN; sin librería de componentes al inicio) | PROPUESTA | ADR-001 |
| D3 | SQLite propiedad exclusiva del core TS; librería (`node:sqlite` o `better-sqlite3`) según spike de S0 | PROPUESTA | ADR-002 |
| D4 | Protocolo TS↔Python: JSON-RPC 2.0 por stdin/stdout, NDJSON UTF-8, logs por stderr | PROPUESTA | ADR-003 |
| D5 | Motor Python: solo lectura, sin red, sin BD, sin estado entre archivos | PROPUESTA | ADR-003 |
| D6 | **IA: API de Claude (Anthropic)**, solo desde el proceso main, con el SDK oficial `@anthropic-ai/sdk`. Modelo por defecto `claude-haiku-4-5-20251001` (salidas estructuradas + tool use estricto). La interfaz `AIProvider` se mantiene (`ClaudeProvider` + `FakeAIProvider` para pruebas) | **APROBADA** | ADR-004 |
| D7 | Veredicto determinista (`RiskPolicy`); la IA solo escala CLEAN→SUSPICIOUS con evidencia citada; nunca DETECTED; nunca baja veredictos | PROPUESTA | ADR-004 |
| D8 | Cuarentena en TS con AES-256-GCM, siempre con confirmación del usuario | PROPUESTA | ADR-006 (S4) |
| D9 | Queue, Stack, PriorityQueue y Trie de rutas implementadas por el equipo; Map/Set/dict nativos, explicados | PROPUESTA | — |
| D10 | Repositorio: `construccion/` (documentación) + `CyberSOC/` (solo código) | PROPUESTA | ADR-005 |
| D11 | Python 3.12 + uv (lockfile reproducible) | PROPUESTA | ADR-003 |
| D12 | Sprints de ~1 semana según el roadmap | PROPUESTA | — |
| D13 | Sin EICAR ni malware en disco o en el repo; firmas de prueba propias | PROPUESTA | — |
| D14 | Identificadores de código en inglés; UI y documentación en español | PROPUESTA | — |
| D15 | Zonas y perfiles de capas: el Core clasifica cada ruta en una zona (Trie de rutas, prefijo más largo) y aplica su perfil (Map zona → capas); el motor recibe las capas por archivo | PROPUESTA | ADR-008 (S3) |
| D16 | Planificador de escaneo con IA: la IA propone un `scan-plan/v1` estructurado; el usuario confirma; el Core valida y ejecuta. La IA nunca inicia un escaneo sola | PROPUESTA | ADR-004 |
| D17 | Reportes por conversación: los datos del reporte los calcula el Core desde SQLite; la IA solo redacta resumen y conclusiones citando IDs reales | PROPUESTA | ADR-004 |
| D18 | Traza de capas: cada resultado registra qué capa corrió, se omitió (y por qué), se desactivó por perfil o falló, con aciertos, puntos y duración | PROPUESTA | ADR-003 |

## Preguntas abiertas

- [ ] Fechas exactas de la entrega 1 y de la entrega final.
- [ ] Mensaje cortado "se modi…": ¿qué cambio se quería indicar?
- [x] ~~Proveedor de IA~~ → API de Claude (Anthropic). Pendiente: quién crea la cuenta, carga el crédito y gestiona la API key.
- [ ] ¿El profesor permite React y estructuras nativas (Map/Set) o exige implementaciones propias?
- [ ] ¿Repositorio público o privado? ¿El profesor necesita acceso?
- [ ] ¿Notación de diagramas exigida (UML, C4, otra)?

## Roadmap

| Fechas | Sprint | Hito | Estado |
|---|---|---|---|
| 30 sep – 6 oct | S0 Foundation | Entrega 1 + app con motor conectado + smoke de la API de Claude | Pendiente |
| 7 – 16 oct | S1 Escaneo real | Pipeline real archivo → SQLite | Pendiente |
| 17 – 25 oct | S2 Evidencia mínima + IA v1 | Primera detección explicada por IA + traza de capas | Pendiente |
| 26 oct – 3 nov | S3 Motor híbrido + zonas + IA v2 | Detección completa, perfiles de capas por zona, correlación IA | Pendiente |
| 4 – 10 nov | S4 Cuarentena + Copilot v1 | Ciclo detección → acción; chat con foco | Pendiente |
| 11 – 17 nov | S5 Copilot con herramientas | Reportes por conversación, consulta de capas, planificador (congelación 17 nov) | Pendiente |
| 18 – 24 nov | S6 Robustez y entrega | v1.0.0 + manuales + demo | Pendiente |
| 25 nov → entrega | Colchón | Solo correcciones y ensayo | Pendiente |

## Bitácora

| Fecha | Cambio | Autor |
|---|---|---|
| 2026-09-29 | Creación de la estructura de documentación y de los planes de sprint | — |
| 2026-09-29 | Retroalimentación del profesor incorporada: D15–D18, RF-17, RF-IA-10 a 12; planes S2, S3, S4, S5 y S6 actualizados | — |
| 2026-09-29 | D6 aprobada: API de Claude (Anthropic), modelo `claude-haiku-4-5-20251001` | — |
| 2026-09-29 | Diagrama de arquitectura v2 (corrige flujos de IA, Risk Policy, cuarentena y flujo completo) | — |
