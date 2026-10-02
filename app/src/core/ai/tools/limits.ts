export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };
export type ToolResult =
  | { ok: true; data: Json; truncated: boolean }
  | { ok: false; error: { code: string; message: string }; truncated: false };
export const MAX_TOOL_ROWS = 20;
export const MAX_TOOL_CHARS = 8_000;

/** Presupuesto compartido de filas (objetos en listas), incluso en listas anidadas. */
export function boundResult(value: unknown): ToolResult {
  const result = {
    ok: true as const,
    data: JSON.parse(JSON.stringify(value)) as Json,
    truncated:
      value !== null &&
      typeof value === 'object' &&
      'truncated' in value &&
      value.truncated === true,
  };
  let rows = 0;
  function cap(node: Json): Json {
    if (Array.isArray(node)) {
      const output: Json[] = [];
      for (const item of node) {
        if (
          output.length >= MAX_TOOL_ROWS ||
          (typeof item === 'object' && item !== null && rows >= MAX_TOOL_ROWS)
        ) {
          result.truncated = true;
          continue;
        }
        if (typeof item === 'object' && item !== null) rows++;
        output.push(cap(item));
      }
      return output;
    }
    if (node !== null && typeof node === 'object')
      return Object.fromEntries(
        Object.entries(node).map(([key, item]) => [key, cap(item)]),
      );
    return node;
  }
  result.data = cap(result.data);
  // Se mide el JSON COMPLETO, incluida la envoltura. Nunca cortar JSON por bytes:
  // se acortan textos largos o se retiran filas; los números conservados no cambian.
  while (JSON.stringify(result).length > MAX_TOOL_CHARS) {
    result.truncated = true;
    let longest = 256;
    let shrink: (() => void) | undefined;
    let largest: Json[] | undefined;
    function visit(node: Json, set: (replacement: Json) => void): void {
      if (typeof node === 'string' && node.length > longest) {
        longest = node.length;
        shrink = () => set(node.slice(0, Math.floor(node.length / 2)) + '…');
      } else if (Array.isArray(node)) {
        if (node.length && (!largest || node.length > largest.length))
          largest = node;
        node.forEach((item, i) =>
          visit(item, (v) => {
            node[i] = v;
          }),
        );
      } else if (node !== null && typeof node === 'object') {
        for (const [key, item] of Object.entries(node))
          visit(item, (v) => {
            node[key] = v;
          });
      }
    }
    visit(result.data, (replacement) => {
      result.data = replacement;
    });
    if (shrink) shrink();
    else if (largest) largest.pop();
    else {
      result.data = null;
      break;
    }
  }
  return result;
}
