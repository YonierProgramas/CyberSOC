"""Compara 100 000 consultas idénticas; no lee muestras ni mide su hashing."""

import hashlib
import random
import sys
from statistics import median
from time import perf_counter


def benchmark(*, size: int = 1000, queries: int = 100000, repeats: int = 3) -> str:
    # Invariante: ambas estructuras contienen los mismos hashes sintéticos únicos.
    # Construcción O(n), memoria O(n); no se incluye esta fase en los tiempos.
    entries = [
        (hashlib.sha256(f"firma sintetica {i}".encode()).hexdigest(), i) for i in range(size)
    ]
    table = dict(entries)
    rng = random.Random(2026)
    samples = [
        entries[rng.randrange(size)][0]
        if i % 2 == 0
        else hashlib.sha256(f"ausente {i}".encode()).hexdigest()
        for i in range(queries)
    ]
    dict_times = []
    list_times = []
    for _ in range(repeats):
        started = perf_counter()
        # get: O(1) promedio por búsqueda; q consultas cuestan O(q) promedio.
        dict_hits = sum(table.get(key) is not None for key in samples)
        dict_times.append(perf_counter() - started)
        started = perf_counter()
        list_hits = 0
        # Lista: O(n) en el peor caso por búsqueda; q consultas cuestan O(q*n).
        for key in samples:
            for stored, _value in entries:
                if stored == key:
                    list_hits += 1
                    break
        list_times.append(perf_counter() - started)
        if list_hits != dict_hits:
            raise AssertionError("Las estructuras no devolvieron los mismos resultados")
    dict_seconds = median(dict_times)
    list_seconds = median(list_times)
    return (
        f"Firmas sinteticas: {size}\nConsultas: {queries}\nAciertos: {dict_hits}\n"
        f"Repeticiones: {repeats} (mediana)\nDict: {dict_seconds:.6f} s\n"
        f"Lista: {list_seconds:.6f} s\nRelacion lista/dict: {list_seconds / dict_seconds:.2f}x\n"
    )


if __name__ == "__main__":
    # Este script es una herramienta independiente: stdout del motor no se usa.
    sys.stdout.write(benchmark())
