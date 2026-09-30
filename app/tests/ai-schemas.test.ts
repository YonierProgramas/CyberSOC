import { describe, expect, it } from 'vitest';
import {
  AI_ASSESSMENT_LIMITS,
  AI_CONTEXT_LIMITS,
  aiAssessmentJsonSchema,
  aiAssessmentSchema,
  aiContextSchema,
  type AIAssessment,
  type AIContext,
} from '../src/core/ai/schemas';

// Ejemplo de ai-context/v1 del plan de S2, con los campos de S2 y S3 incluidos.
const fullContext: AIContext = {
  schema: 'cybersoc.ai-context/v1',
  task: 'ANALYZE_FILE_RESULT',
  locale: 'es-CO',
  file: {
    resultId: 'r_91',
    name: 'factura_octubre.pdf.exe',
    extension: '.exe',
    detectedType: 'PE ejecutable',
    typeMatchesExtension: false,
    sizeBytes: 245_760,
    location: '%USERPROFILE%\\Downloads',
    sha256: 'a'.repeat(64),
    zone: 'DESCARGAS',
  },
  engine: {
    engineVersion: '0.2.0',
    signaturesVersion: '2026.10.17',
    verdict: 'SUSPICIOUS',
    score: 40,
    riskLevel: 'MEDIO',
    scoreBreakdown: [
      { evidenceId: 'ev1', points: 25 },
      { evidenceId: 'ev2', points: 15 },
    ],
  },
  evidence: [
    {
      id: 'ev1',
      source: 'FILETYPE',
      code: 'DOUBLE_EXTENSION',
      severity: 'HIGH',
      summary: 'La extensión visible (.pdf) no es la real (.exe)',
    },
    {
      id: 'ev2',
      source: 'FILETYPE',
      code: 'TYPE_MISMATCH',
      severity: 'MEDIUM',
      summary: 'El contenido es un PE',
    },
  ],
  layers: [
    { layer: 'HASH', status: 'RAN', hits: 0 },
    { layer: 'SIGNATURES', status: 'RAN', hits: 0 },
    { layer: 'FILETYPE', status: 'RAN', hits: 2 },
    { layer: 'PE', status: 'SKIPPED', hits: 0, reason: 'NOT_PE' },
  ],
  profile: { name: 'DESCARGAS', layers: ['HASH', 'SIGNATURES', 'FILETYPE'] },
  history: { timesSeenBefore: 0 },
  constraints: {
    evidenceTruncated: false,
    fieldsTruncated: false,
    fileNamePseudonymized: false,
    contentIncluded: false,
  },
};

const assessment: AIAssessment = {
  schema: 'cybersoc.ai-assessment/v1',
  summary: 'Ejecutable disfrazado de PDF.',
  plainExplanation: 'El archivo parece un PDF pero es un programa.',
  technicalAnalysis: 'Doble extensión y cabecera MZ.',
  correlations: [{ evidenceIds: ['ev1', 'ev2'], insight: 'Engaño clásico.' }],
  opinion: 'LIKELY_MALICIOUS',
  confidence: 0.78,
  recommendedAction: 'QUARANTINE',
  actionRationale: 'No hay motivo legítimo para el disfraz.',
  falsePositiveNotes: '',
  citedEvidenceIds: ['ev1', 'ev2'],
};

function evidence(n: number): AIContext['evidence'][number] {
  return {
    id: `ev${n}`,
    source: 'SIGNATURES',
    code: 'SIGNATURE_MATCH',
    severity: 'LOW',
    summary: 'x',
  };
}

describe('aiContextSchema', () => {
  it('acepta el contexto completo con los campos de S2 y S3', () => {
    expect(aiContextSchema.parse(fullContext)).toEqual(fullContext);
  });

  it('acepta el contexto sin los campos opcionales (layers, zone, profile, history)', () => {
    const { layers, profile, history, ...rest } = fullContext;
    const { zone, ...file } = fullContext.file;
    void [layers, profile, history, zone];
    expect(aiContextSchema.safeParse({ ...rest, file }).success).toBe(true);
  });

  it.each([
    ['campo desconocido', { ...fullContext, extra: 1 }],
    [
      'contenido incluido',
      {
        ...fullContext,
        constraints: { ...fullContext.constraints, contentIncluded: true },
      },
    ],
    [
      'campo de contenido en file',
      { ...fullContext, file: { ...fullContext.file, content: 'TVqQ' } },
    ],
    [
      'severidad fuera del enum',
      { ...fullContext, evidence: [{ ...evidence(1), severity: 'SEVERE' }] },
    ],
    [
      'capa fuera del enum',
      { ...fullContext, layers: [{ layer: 'AV', status: 'RAN', hits: 0 }] },
    ],
    [
      'estado de capa fuera del enum',
      { ...fullContext, layers: [{ layer: 'HASH', status: 'DONE', hits: 0 }] },
    ],
    [
      'zona fuera del enum',
      { ...fullContext, file: { ...fullContext.file, zone: 'NUBE' } },
    ],
    [
      'SHA-256 mal formado',
      { ...fullContext, file: { ...fullContext.file, sha256: 'ABC' } },
    ],
    [
      'ID de evidencia mal formado',
      {
        ...fullContext,
        evidence: [{ ...evidence(1), id: 'e1' }],
        engine: { ...fullContext.engine, scoreBreakdown: [] },
      },
    ],
    [
      'nombre demasiado largo',
      {
        ...fullContext,
        file: {
          ...fullContext.file,
          name: 'a'.repeat(AI_CONTEXT_LIMITS.fileName + 1),
        },
      },
    ],
    [
      'resumen demasiado largo',
      {
        ...fullContext,
        evidence: [
          {
            ...evidence(1),
            summary: 'a'.repeat(AI_CONTEXT_LIMITS.evidenceSummary + 1),
          },
        ],
        engine: { ...fullContext.engine, scoreBreakdown: [] },
      },
    ],
    [
      'más de 20 evidencias',
      {
        ...fullContext,
        evidence: Array.from({ length: 21 }, (_, i) => evidence(i + 1)),
      },
    ],
    [
      'evidencias repetidas',
      {
        ...fullContext,
        evidence: [evidence(1), evidence(1)],
        engine: { ...fullContext.engine, scoreBreakdown: [] },
      },
    ],
    [
      'puntuación que cita una evidencia ausente',
      { ...fullContext, evidence: [evidence(1)] },
    ],
    [
      'capa repetida en la traza',
      {
        ...fullContext,
        layers: [
          { layer: 'HASH', status: 'RAN', hits: 0 },
          { layer: 'HASH', status: 'RAN', hits: 0 },
        ],
      },
    ],
    [
      'puntuación mayor que 100',
      { ...fullContext, engine: { ...fullContext.engine, score: 101 } },
    ],
  ])('rechaza: %s', (_label, input) => {
    expect(aiContextSchema.safeParse(input).success).toBe(false);
  });
});

describe('aiAssessmentSchema', () => {
  it('acepta la respuesta del ejemplo del plan', () => {
    expect(aiAssessmentSchema.parse(assessment)).toEqual(assessment);
  });

  it.each([
    ['opinión fuera del enum', { opinion: 'MALICIOUS' }],
    ['acción fuera del enum', { recommendedAction: 'DELETE_FILE' }],
    ['confianza mayor que 1', { confidence: 1.2 }],
    ['confianza negativa', { confidence: -0.1 }],
    ['resumen vacío', { summary: '' }],
    [
      'resumen demasiado largo',
      { summary: 'a'.repeat(AI_ASSESSMENT_LIMITS.summary + 1) },
    ],
    [
      'análisis técnico demasiado largo',
      {
        technicalAnalysis: 'a'.repeat(
          AI_ASSESSMENT_LIMITS.technicalAnalysis + 1,
        ),
      },
    ],
    [
      'demasiadas correlaciones',
      {
        correlations: Array.from(
          { length: 6 },
          () => assessment.correlations[0],
        ),
      },
    ],
    ['ID citado mal formado', { citedEvidenceIds: ['ev1', 'r_91'] }],
    ['esquema de otra versión', { schema: 'cybersoc.ai-assessment/v2' }],
    ['campo desconocido', { verdict: 'DETECTED' }],
  ])('rechaza: %s', (_label, patch) => {
    expect(
      aiAssessmentSchema.safeParse({ ...assessment, ...patch }).success,
    ).toBe(false);
  });
});

describe('aiAssessmentJsonSchema', () => {
  const json = aiAssessmentJsonSchema();

  it('exige todas las claves y prohíbe claves adicionales', () => {
    expect(json).toMatchObject({ type: 'object', additionalProperties: false });
    expect(new Set(json.required as string[])).toEqual(
      new Set(Object.keys(aiAssessmentSchema.shape)),
    );
  });

  it('conserva los enums y la constante del esquema', () => {
    const properties = json.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(properties.schema).toMatchObject({
      const: 'cybersoc.ai-assessment/v1',
    });
    expect(properties.opinion!.enum).toEqual(
      aiAssessmentSchema.shape.opinion.options,
    );
    expect(properties.recommendedAction!.enum).toEqual(
      aiAssessmentSchema.shape.recommendedAction.options,
    );
  });

  it('quita lo que las salidas estructuradas no admiten y deja los límites en la descripción', () => {
    const serialized = JSON.stringify(json);
    for (const keyword of [
      'maxLength',
      'minLength',
      'pattern',
      'minimum',
      'maximum',
      'maxItems',
      '$schema',
    ]) {
      expect(serialized).not.toContain(`"${keyword}"`);
    }
    const properties = json.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(properties.summary!.description).toContain(
      `${AI_ASSESSMENT_LIMITS.summary}`,
    );
    const correlation = properties.correlations!.items as Record<
      string,
      unknown
    >;
    expect(correlation.additionalProperties).toBe(false);
  });

  it('es determinista', () => {
    expect(aiAssessmentJsonSchema()).toEqual(json);
  });
});
