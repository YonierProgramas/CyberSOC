import { z } from 'zod';
import { boundResult, type ToolResult } from './limits';

export interface ToolDefinition<T> {
  name: string;
  description: string;
  arguments: z.ZodType<T>;
  execute(args: T): unknown | Promise<unknown>;
}
export interface ToolSpec {
  name: string;
  description: string;
  strict: true;
  input_schema: Record<string, unknown>;
}

export class ToolRegistry {
  // Tabla de despacho: cada nombre identifica exactamente un esquema y ejecutor.
  // Map registra/busca en O(1) promedio, frente a recorrer n if/else (O(n)).
  // La validación y el trabajo del ejecutor tienen su propio costo; listar es O(n).
  private readonly entries = new Map<
    string,
    {
      spec: ToolSpec;
      arguments: z.ZodType;
      run: (args: unknown) => Promise<unknown>;
    }
  >();

  register<T>(tool: ToolDefinition<T>): this {
    if (
      !/^[a-z][a-z0-9_]{0,63}$/.test(tool.name) ||
      this.entries.has(tool.name)
    )
      throw new Error('Nombre de herramienta inválido o duplicado.');
    const json = z.toJSONSchema(tool.arguments, {
      target: 'draft-7',
      io: 'input',
    });
    delete json.$schema;
    if (json.type !== 'object' || json.additionalProperties !== false)
      throw new Error('Los argumentos deben ser un objeto estricto.');
    const spec: ToolSpec = {
      name: tool.name,
      description: tool.description,
      strict: true,
      input_schema: strictSchema(json),
    };
    this.entries.set(tool.name, {
      spec,
      arguments: tool.arguments,
      run: async (args) => {
        const parsed = tool.arguments.safeParse(args);
        if (!parsed.success) throw new InvalidToolArguments();
        return tool.execute(parsed.data);
      },
    });
    return this;
  }
  definitions(): ToolSpec[] {
    return [...this.entries.values()].map(({ spec }) => structuredClone(spec));
  }
  async execute(name: string, args: unknown): Promise<ToolResult> {
    const entry = this.entries.get(name);
    if (!entry) return errorResult('UNKNOWN_TOOL');
    try {
      return boundResult(await entry.run(args));
    } catch (error) {
      return errorResult(
        error instanceof InvalidToolArguments
          ? 'INVALID_ARGUMENTS'
          : error instanceof Error && error.message === 'NOT_FOUND'
            ? 'NOT_FOUND'
            : 'EXECUTION_ERROR',
      );
    }
  }
}

class InvalidToolArguments extends Error {}

/** En modo estricto todos los campos figuran en required; los opcionales aceptan null. */
function strictSchema(input: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(input);
  const properties = copy.properties as
    Record<string, Record<string, unknown>> | undefined;
  if (properties) {
    const required = (copy.required ?? []) as string[];
    for (const [key, value] of Object.entries(properties)) {
      const schema = strictSchema(value);
      properties[key] = required.includes(key)
        ? schema
        : { anyOf: [schema, { type: 'null' }] };
    }
    copy.required = Object.keys(properties);
    copy.additionalProperties = false;
  }
  if (copy.items && typeof copy.items === 'object')
    copy.items = strictSchema(copy.items as Record<string, unknown>);
  return copy;
}
function errorResult(
  code: 'UNKNOWN_TOOL' | 'INVALID_ARGUMENTS' | 'NOT_FOUND' | 'EXECUTION_ERROR',
): ToolResult {
  const messages = {
    UNKNOWN_TOOL: 'Herramienta desconocida.',
    INVALID_ARGUMENTS: 'Argumentos inválidos.',
    NOT_FOUND: 'No existe el registro solicitado.',
    EXECUTION_ERROR: 'No se pudo consultar la información.',
  };
  return {
    ok: false,
    truncated: false,
    error: { code, message: messages[code] },
  };
}
