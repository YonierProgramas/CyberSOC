# Ficha: Queue (buffer circular)

| Campo | Contenido |
|---|---|
| Problema | El escaneo va a encolar archivos y atenderlos en el orden en que llegaron, sin perder tiempo moviendo toda la lista en cada salida. |
| Estructura elegida | Cola propia sobre un arreglo circular que duplica su capacidad al llenarse. |
| Por qué | `Array.shift()` saca el primero, pero corre todos los demás una casilla. Una cola circular solo mueve dos índices. |
| Complejidad | `enqueue` y `dequeue` son O(1) amortizado. `peek`, `size`, `isEmpty`, `clear` y `peakSize` son O(1). Memoria O(n), con capacidad entre n y 2n. |
| Implementación | `CyberSOC/app/src/core/structures/Queue.ts` |
| Evidencia | `CyberSOC/app/tests/queue.test.ts` y `npm run bench:queue` |
| Sprint | S0 |

## Diagrama o ejemplo de funcionamiento

Capacidad 4. Entran A, B, C y sale A. Luego entran D y E: el índice de entrada da la vuelta.

```
índice:  0  1  2  3
inicio:  A  B  C  —
tras salir A y entrar D, E:
         E  B  C  D
         ^salida sigue en B
```

El orden de salida es B, C, D, E. Si en ese momento hay que crecer, se copian en ese orden a un arreglo nuevo que empieza en el índice 0. No se copia el arreglo físico tal cual, porque el primero ya no está en la posición 0.

`peakSize` guarda el máximo de `size`. Sacar elementos o llamar a `clear()` deja el pico igual.

## Preguntas probables en la sustentación

- ¿Por qué `Array.shift()` es O(n)? Porque el elemento 0 se va y cada uno de los n − 1 restantes se mueve una posición a la izquierda.
- ¿Por qué la cola circular es O(1) amortizado? Entrar y salir solo avanzan un índice. Al llenarse se copian n elementos a un arreglo del doble de tamaño. Si se duplica, la suma de todas esas copias hasta n inserciones es menor que 2n, así que el promedio por `enqueue` es constante. La operación que crece es cara; las demás, baratas.
- ¿Qué pasa si `dequeue` se llama en vacía? Devuelve `undefined` y no cambia el tamaño.
- ¿Cómo se distingue vacía de llena si los índices coinciden? Con un contador `size`. Llena es `size === capacidad`.
- ¿Qué se rompe al redimensionar si la cola ya dio la vuelta? Copiar el arreglo de izquierda a derecha desordena los datos. Hay que copiar desde `head`, siguiendo el círculo.
