# ADR-008 — Zonas y perfiles de capas

**Estado: Aprobado** · 1 oct 2026 · D15 · Autorización: tarea T3.1 del equipo.

## Contexto

Aplicar las mismas capas a Descargas y Sistema ignora diferencias de riesgo y puede aumentar falsos positivos. Una extensión puede estar disfrazada y las carpetas pueden anidarse: TEMPORALES debe prevalecer sobre DATOS_APPS cuando Temp está dentro de LOCALAPPDATA. Debe quedar visible qué se analizó y qué se desactivó.

## Decisión

El Core resolverá las rutas reales del usuario al iniciar y clasificará cada archivo con un Trie por segmentos de ruta Windows normalizados (mayúsculas/minúsculas, separadores y unidad). Gana el **prefijo más largo**; `C:\Win` no coincide con `C:\Windows`. La búsqueda recuerda la última zona encontrada, en O(d) pasos promedio para d segmentos, más el costo de normalización. Las unidades extraíbles se identificarán mediante `fs.driveInfo`; sin coincidencia corresponde OTRA.

Un Map zona → perfil seleccionará las capas según el [plan S3](../sprints/sprint-03-motor-hibrido-ia-v2/plan.md): todas en zonas de usuario/extraíbles; HASH, SIGNATURES, FILETYPE y RULES en PROGRAMAS; HASH, SIGNATURES y FILETYPE en SISTEMA. Descargas, temporales y extraíbles incluyen ocultos y admiten 512 MB; las demás zonas, sin ocultos y 256 MB. Se permite un perfil personalizado por escaneo, validado por el Core y guardado en `scan_jobs.profile_json`. **HASH y SIGNATURES siempre estarán activas y no podrán desactivarse.**

## Alternativas

- **Capas fijas para todo:** simples, pero no ajustan costo y falsos positivos según ubicación.
- **Perfiles por extensión:** económicos, pero una extensión manipulable no representa la zona ni el tipo real.
- **Perfiles por zona con Trie (elegida):** resuelven anidamiento por prefijo más largo, sin recorrer todos los prefijos en cada clasificación; requieren normalización y configuración inicial.

## Consecuencias

Se aprueba ampliar `scan.file` con `options.zone` y `options.layers`, coordinando ejemplos, zod, pydantic y pruebas en T3.2. Cada capa implementada conservará una entrada de traza: `DISABLED` cuando el perfil la desactive, con motivo y sin aciertos ni puntos; `SKIPPED` cuando esté habilitada pero no aplique. DISABLED ya está admitido desde S2; S3 incorpora su uso por perfiles.

La calibración deberá justificar las restricciones de SISTEMA/PROGRAMAS; ubicación no significa confianza automática. Python seguirá sin red, SQLite ni escrituras del usuario. La IA solo podrá proponer perfiles futuros: el Core los validará y el usuario confirmará. Este ADR aprueba la decisión; no implementa el contrato.

