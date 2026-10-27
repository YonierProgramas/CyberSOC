# Sprint 6 — Robustez y entrega final

| Campo | Valor |
|---|---|
| Fechas | 18 – 24 nov 2026 · colchón del 25 nov a la entrega |
| Depende de | Todos los sprints anteriores |
| Tag al cerrar | `v1.0.0` |
| Carriles | A: E2E, empaquetado, seguridad Electron · B: rendimiento, manuales, guion de la demo · Ambos: ensayo |

## Antes de empezar

- [ ] S5 cerrado con tag `v0.5.0-s5`. La congelación funcional está vigente: solo correcciones.
- [ ] Lista de pendientes de todos los `cierre.md` consolidada y priorizada.
- [ ] Fecha y formato de la sustentación confirmados.

## Objetivo

Dejar CyberSOC Defender estable, probado de extremo a extremo, documentado y listo para una demostración confiable. Además, tener un plan B para cada punto de la demo.

## Entregables

### Calidad

- [ ] Pruebas E2E con Playwright para Electron (escenarios abajo).
- [ ] Pruebas de rendimiento con resultados documentados.
- [ ] Revisión de seguridad con la checklist de abajo.
- [ ] Auditoría de dependencias (`npm audit`, `pip-audit`) sin vulnerabilidades altas.
- [ ] Corrección de los errores encontrados, cada uno con su prueba de regresión.

### Empaquetado

- [ ] Decisión (ADR-007):
  - **Opción A:** Python embebido (distribución embeddable) + `electron-builder` con `extraResources`.
  - **Opción B:** PyInstaller. Riesgo: otros antivirus pueden marcar el ejecutable como falso positivo.
- [ ] Instalador o carpeta portable probada en una cuenta de Windows sin herramientas de desarrollo.
- [ ] **Plan B:** la demo corre en modo desarrollo desde el tag `v1.0.0`.

### Documentación final (en `construccion/`)

- [ ] `manuales/manual-tecnico.md`:
  - instalación y compilación;
  - arquitectura;
  - protocolo;
  - modelo de datos;
  - estructuras de datos;
  - diseño de IA;
  - pruebas;
  - cómo añadir firmas y reglas;
  - zonas y perfiles de capas;
  - cómo cambiar de proveedor de IA.
- [ ] `manuales/manual-usuario.md`:
  - escanear;
  - interpretar veredictos;
  - leer la evidencia y el panel "¿Cómo se decidió?";
  - análisis de IA y "Qué se envió";
  - Copilot: preguntas, reportes por conversación, consulta de capas y planificador;
  - cuarentena;
  - historial y reportes;
  - configurar la API key;
  - qué pasa sin Internet.
- [ ] Arquitectura y diagramas actualizados a la versión final (partir de `arquitectura/diagramas/arquitectura-v2.svg`).
- [ ] Todas las fichas de estructuras de datos completas.
- [ ] Informe de pruebas consolidado: unitarias, integración, E2E, rendimiento, evaluación de IA, calibración.
- [ ] Verificación de que la IA aparece en todos los lugares exigidos (checklist abajo).

### Demo

- [ ] Guion de la demostración (abajo), ensayado al menos 2 veces con tiempo medido.
- [ ] Carpeta de demo preparada solo con fixtures benignos y firmas de prueba.
- [ ] Video de respaldo con toda la demo grabada.
- [ ] Respuestas preparadas para el "guion de sustentación" (abajo).

## Especificaciones clave

### Escenarios E2E

1. Escanear la carpeta de fixtures → los veredictos esperados aparecen en la tabla.
2. Cancelar un escaneo a mitad → estado `CANCELLED` consistente.
3. Abrir una detección → aparecen la evidencia, la traza y el análisis de IA (con `FakeAIProvider`).
4. Poner en cuarentena y restaurar → el hash es idéntico.
5. Preguntar al Copilot (con Fake) → aparecen los chips de referencia.
6. Reiniciar la app → el historial se conserva.

### Rendimiento (registrar los números)

- 10 000 archivos pequeños: archivos por segundo y duración total.
- 1 archivo de 1 GB: MB por segundo, y memoria del motor estable (streaming).
- La UI responde durante todo el escaneo (sin congelamientos perceptibles).
- Pico de la pila y de la cola en un árbol grande.

### Checklist de seguridad (Electron y aplicación)

- [ ] `contextIsolation`, `sandbox` y `nodeIntegration: false` en todas las ventanas.
- [ ] CSP estricta; el renderer no se conecta a ningún sitio externo.
- [ ] Navegación y ventanas nuevas bloqueadas.
- [ ] Preload mínimo; todos los IPC validados con zod.
- [ ] La API key solo en main, cifrada con `safeStorage`; nunca en logs, BD en texto plano ni renderer.
- [ ] Nada de `dangerouslySetInnerHTML`; el texto de la IA siempre como texto plano.
- [ ] El motor Python no hace llamadas de red (revisar imports) y no escribe en disco.
- [ ] La cuarentena respeta las rutas protegidas, verifica hashes y no sobrescribe archivos.
- [ ] No hay EICAR, malware ni secretos en el repositorio (revisar el historial de Git).

### La IA debe aparecer en (documento 7.8)

- [ ] Requisitos funcionales (RF-IA-01 a 09)
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

### Mínimos de IA verificados antes de cerrar (documento 7.8)

- [ ] 1. Integración real con un modelo de IA
- [ ] 2. AI Context Builder
- [ ] 3. Análisis inteligente basado en resultados reales
- [ ] 4. Respuestas estructuradas
- [ ] 5. Asistente conversacional integrado
- [ ] 6. Consultas del asistente sobre datos reales
- [ ] 7. Explicación inteligente de detecciones
- [ ] 8. Manejo seguro de errores de IA
- [ ] 9. Protección de la API key
- [ ] 10. Pruebas que demuestran la integración

### Pedidos adicionales del profesor verificados

- [ ] Reportes por conversación (RF-IA-10)
- [ ] Consulta de capas por archivo, escaneo o zona (RF-IA-11)
- [ ] Planificador de escaneo por zonas y capas, con confirmación (RF-IA-12)
- [ ] Zonas y perfiles de capas (RF-17)

### Guion de la demostración (~14 minutos)

1. Problema y objetivo (30 s).
2. Arquitectura: diagrama de 3 procesos y regla de oro de privilegios (1 min).
3. Escanear la carpeta de demo: progreso en vivo (1 min).
4. Cancelar un segundo escaneo: estado consistente (30 s).
5. Detección por firma de prueba: evidencia + "¿Cómo se decidió?" (1,5 min).
6. Análisis de IA + panel "Qué se envió" (1,5 min).
7. Copilot: "¿Por qué fue marcado?", "¿Qué capa lo detectó?", "¿Qué capas revisaron Descargas?" (1,5 min).
8. Reporte por conversación: "Hazme un reporte de los sospechosos de hoy" → tarjeta → exportar (1 min).
9. Planificador: "Voy a revisar mi USB, ¿cómo la escaneo?" → plan por zona y capas → confirmar → escaneo (1 min).
10. Cuarentena y restauración, con el hash antes y después (1 min).
11. IA sin red: Wi-Fi apagado → degradación controlada (1 min).
12. Estructuras de datos: métricas reales (pila, cola, heap, trie de zonas) + una ficha (1 min).
13. Pruebas y CI: reporte y evaluación de IA (1 min).

### Guion de sustentación (preguntas probables → dónde se ve)

| Pregunta | Dónde se ve |
|---|---|
| ¿Qué encontró el motor? | Panel de evidencias + desglose de puntos |
| ¿Qué recibió la IA? | Panel "Qué se envió" (`context_json`) |
| ¿Qué aportó la IA? | Correlaciones, explicación y notas de falso positivo, todas con citas |
| ¿Qué produjo? | `ai-assessment/v1` validado |
| ¿Cómo se obtuvo el riesgo? | `trace_json` de `RiskPolicy` |
| ¿Qué pasa si la IA falla? | Demo sin red + prueba automatizada |
| ¿Cómo evitan los falsos positivos del modelo? | Política asimétrica + citas obligatorias + métrica en corpus benigno |
| ¿Por qué Stack / Queue / heap / Map? | Fichas de estructuras + métricas en la app |
| ¿Por qué Electron y no MERN? | ADR-001 |
| ¿Cómo es segura la cuarentena? | ADR-006 + pruebas de fallo |
| ¿La IA es solo un chatbot? | No: planifica (propone el plan por zonas), analiza cada detección y responde/reporta con datos reales mediante herramientas |
| ¿Qué capa se usa en cada zona? | Perfiles por zona (Trie + Map) + `get_layer_report` |
| ¿Qué IA usan y por qué? | API de Claude (Anthropic), Haiku 4.5: salidas estructuradas, tool use estricto, bajo coste; `AIProvider` permite cambiarla (ADR-004) |

## Criterios de aceptación

- [ ] **CA-6.1** Los 6 escenarios E2E pasan.
- [ ] **CA-6.2** Los resultados de rendimiento están documentados.
- [ ] **CA-6.3** La checklist de seguridad está completa.
- [ ] **CA-6.4** La app corre en una cuenta de Windows sin herramientas de desarrollo, o está documentado el plan B en modo desarrollo.
- [ ] **CA-6.5** Los manuales técnico y de usuario están completos.
- [ ] **CA-6.6** Los 10 mínimos de IA y los 11 lugares de documentación están verificados.
- [ ] **CA-6.7** La demo se ensayó 2 veces dentro del tiempo y hay un video de respaldo.
- [ ] **CA-6.8** El tag `v1.0.0` está creado y la app arranca desde él.

## Evidencias a guardar

- [ ] Reporte E2E, informe de rendimiento e informe consolidado de pruebas.
- [ ] Checklist de seguridad firmada por ambos.
- [ ] Video de la demo completa.
- [ ] Capturas finales de cada pantalla.
- [ ] Hash del commit de `v1.0.0`.

## Riesgos a vigilar

- Empaquetado que falla a última hora: el plan B (modo desarrollo) debe estar probado desde el primer día del sprint.
- Sin Internet en el lugar de la sustentación: la demo sin red es parte del guion, y el video de respaldo cubre el resto.
- Cambios de última hora que rompen algo: solo correcciones con prueba de regresión.

## Colchón (25 nov → entrega)

Solo correcciones críticas, ensayos de la sustentación y ajustes de la documentación. Nada de funcionalidades nuevas.
