# Ficha: Stack

| Campo | Contenido |
|---|---|
| Problema | Recorrer carpetas: al entrar en un directorio se apilan las rutas pendientes y se atiende la última, como un recorrido en profundidad. |
| Estructura elegida | Pila propia sobre un arreglo, con un índice al tope. |
| Por qué | El último en entrar es el primero en salir, y `push`/`pop` al final de un arreglo no mueven al resto. No hace falta una lista enlazada. |
| Complejidad | `push`, `pop` y `peek` son O(1) amortizado (`push` a veces agranda el arreglo). `size`, `isEmpty` y `peakSize` son O(1). Memoria O(n). |
| Implementación | `CyberSOC/app/src/core/structures/Stack.ts` |
| Evidencia | `CyberSOC/app/tests/stack.test.ts` |
| Sprint | S0 |

## Diagrama o ejemplo de funcionamiento

Entran 1, 2 y 3. El tope es 3.

```
tope →  3
        2
        1
```

`pop` devuelve 3, luego 2, luego 1. `peek` mira el tope y no lo saca. `pop` en vacía devuelve `undefined`.

Si se llegó a 3 elementos y luego se sacan todos, `size` vuelve a 0 y `peakSize` se queda en 3.

## Preguntas probables en la sustentación

- ¿Por qué la pila sí puede usar el final del arreglo y la cola no? Porque la pila entra y sale por el mismo extremo. La cola sale por el extremo contrario, y quitar el primero de un arreglo obliga a desplazar todo.
- ¿Qué mide `peakSize`? El máximo de elementos que llegó a tener a la vez, no el tamaño actual.
- ¿`pop` en vacía lanza error? No. Devuelve `undefined`, igual que `peek`.
