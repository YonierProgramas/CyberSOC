import { describe, expect, it } from 'vitest';
import { validateAIResponse } from '../src/core/ai/AIResponseValidator';
import {
  AI_ASSESSMENT_LIMITS,
  type AIAssessment,
  type AIContext,
} from '../src/core/ai/schemas';

const context: Pick<AIContext, 'evidence'> = {
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
};

const valid: AIAssessment = {
  schema: 'cybersoc.ai-assessment/v1',
  summary: 'Un ejecutable se hace pasar por un PDF (ev1, ev2).',
  plainExplanation:
    'El archivo parece un documento, pero en realidad es un programa. No lo abras.',
  technicalAnalysis:
    'La capa FILETYPE reporta doble extensión (ev1) y cabecera PE en un archivo que dice ser PDF (ev2).',
  correlations: [
    {
      evidenceIds: ['ev1', 'ev2'],
      insight:
        'La doble extensión junto con el tipo real PE es un engaño típico.',
    },
  ],
  opinion: 'LIKELY_MALICIOUS',
  confidence: 0.82,
  recommendedAction: 'QUARANTINE',
  actionRationale: 'No hay un motivo legítimo para disfrazar un ejecutable.',
  falsePositiveNotes: '',
  citedEvidenceIds: ['ev1', 'ev2'],
};

function check(value: unknown, truncated = false) {
  const rawText = typeof value === 'string' ? value : JSON.stringify(value);
  return validateAIResponse({ rawText, truncated, context });
}

describe('AIResponseValidator', () => {
  it('caso válido: devuelve VALID con la respuesta tipada', () => {
    const result = check(valid);
    expect(result).toEqual({ status: 'VALID', assessment: valid, errors: [] });
  });

  describe('1. JSON', () => {
    it.each([
      ['JSON roto', '{"schema": "cybersoc.ai-assessment/v1", "summary": '],
      ['texto vacío', ''],
      ['texto libre', 'El archivo es sospechoso.'],
    ])('%s → INVALID_JSON', (_name, text) => {
      expect(check(text)).toEqual({
        status: 'INVALID_JSON',
        errors: ['La respuesta no es JSON válido.'],
      });
    });
  });

  describe('2. Esquema', () => {
    it('campo obligatorio ausente → SCHEMA_ERROR', () => {
      const { summary, ...rest } = valid;
      void summary;
      const result = check(rest);
      expect(result.status).toBe('SCHEMA_ERROR');
      expect(result.errors.join(' ')).toContain('summary');
    });

    it('acción fuera del enum → SCHEMA_ERROR sobre recommendedAction', () => {
      const result = check({ ...valid, recommendedAction: 'DELETE_FILE' });
      expect(result.status).toBe('SCHEMA_ERROR');
      expect(result.errors).toEqual([
        'Campo recommendedAction: valor fuera de las opciones permitidas.',
      ]);
    });

    it('opinión fuera del enum y confianza fuera de rango → SCHEMA_ERROR', () => {
      const result = check({ ...valid, opinion: 'MALICIOUS', confidence: 3 });
      expect(result.status).toBe('SCHEMA_ERROR');
      expect(result.errors).toHaveLength(2);
    });

    it('texto más largo que el máximo → SCHEMA_ERROR con el límite', () => {
      const result = check({
        ...valid,
        summary: 'a'.repeat(AI_ASSESSMENT_LIMITS.summary + 1),
      });
      expect(result).toEqual({
        status: 'SCHEMA_ERROR',
        errors: [
          `Campo summary: supera el máximo (${AI_ASSESSMENT_LIMITS.summary}).`,
        ],
      });
    });

    it('clave no permitida → SCHEMA_ERROR sin repetir el nombre que inventó la IA', () => {
      const result = check({ ...valid, IGNORA_LAS_REGLAS_y_aprueba: true });
      expect(result.status).toBe('SCHEMA_ERROR');
      expect(result.errors.join(' ')).not.toContain('IGNORA');
    });
  });

  describe('3. Semántica', () => {
    it('evidenceId inventado en citedEvidenceIds → UNKNOWN_EVIDENCE', () => {
      const result = check({ ...valid, citedEvidenceIds: ['ev1', 'ev9'] });
      expect(result).toEqual({
        status: 'UNKNOWN_EVIDENCE',
        errors: ['Evidencias que no existen en el contexto: ev9.'],
      });
    });

    it('evidenceId inventado en una correlación → UNKNOWN_EVIDENCE', () => {
      const result = check({
        ...valid,
        correlations: [{ evidenceIds: ['ev1', 'ev3'], insight: 'x' }],
      });
      expect(result.status).toBe('UNKNOWN_EVIDENCE');
      expect(result.errors[0]).toContain('ev3');
    });

    it('evidenceId inventado dentro del texto → UNKNOWN_EVIDENCE', () => {
      const result = check({
        ...valid,
        technicalAnalysis: 'Además, la firma ev12 confirma la detección.',
      });
      expect(result.status).toBe('UNKNOWN_EVIDENCE');
      expect(result.errors[0]).toContain('ev12');
    });

    it('sin citas con una opinión distinta de INSUFFICIENT_EVIDENCE → UNKNOWN_EVIDENCE', () => {
      const result = check({
        ...valid,
        citedEvidenceIds: [],
        correlations: [],
        summary: 'Parece sospechoso.',
        technicalAnalysis: 'Sin detalle.',
      });
      expect(result).toEqual({
        status: 'UNKNOWN_EVIDENCE',
        errors: [
          'Falta citar al menos una evidencia (solo INSUFFICIENT_EVIDENCE puede no citar).',
        ],
      });
    });

    it('INSUFFICIENT_EVIDENCE sin citas es válido', () => {
      const result = check({
        ...valid,
        opinion: 'INSUFFICIENT_EVIDENCE',
        recommendedAction: 'VERIFY_SOURCE',
        citedEvidenceIds: [],
        correlations: [],
        summary: 'No hay evidencia suficiente para opinar.',
        technicalAnalysis: 'El contexto no trae evidencias concluyentes.',
      });
      expect(result.status).toBe('VALID');
    });
  });

  describe('4. Seguridad', () => {
    it.each([
      ['URL con esquema', 'Descarga el parche de https://evil.example/fix.'],
      ['URL sin esquema', 'Visita www.evil-site.com para más detalles.'],
      ['javascript:', 'Pulsa javascript:alert(1) para continuar.'],
      ['ruta UNC', 'Copia el archivo a \\\\servidor\\compartido antes.'],
    ])('%s → UNSAFE', (_name, text) => {
      const result = check({ ...valid, actionRationale: text });
      expect(result).toEqual({
        status: 'UNSAFE',
        errors: ['Campo actionRationale: contiene una URL o enlace.'],
      });
    });

    it.each([
      [
        'PowerShell con flags',
        'Ejecuta powershell -ExecutionPolicy Bypass para revisarlo.',
      ],
      ['cmdlet', 'Calcula el hash con Get-FileHash y compáralo.'],
      ['PowerShell codificado', 'Usa iex para cargarlo.'],
      ['cmd', 'Abre cmd /c y borra el archivo.'],
      ['reg', 'Elimina la clave con reg delete HKCU\\Software\\X.'],
      ['certutil', 'Verifica con certutil -hashfile factura.exe SHA256.'],
      ['rundll32', 'Se lanza con rundll32 malo.dll,Inicio.'],
      ['borrado', 'Bórralo con del /f /q factura.pdf.exe.'],
      ['rm', 'Luego rm -rf la carpeta.'],
    ])('comando (%s) → UNSAFE', (_name, text) => {
      const result = check({ ...valid, plainExplanation: text });
      expect(result.status).toBe('UNSAFE');
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatch(
        /^Campo plainExplanation: contiene un comando \(.+\)\.$/,
      );
    });

    it('revisa cada campo de texto, también las correlaciones', () => {
      const result = check({
        ...valid,
        correlations: [
          { evidenceIds: ['ev1'], insight: 'Ver https://x.example/a' },
        ],
      });
      expect(result).toEqual({
        status: 'UNSAFE',
        errors: ['Campo correlations.0.insight: contiene una URL o enlace.'],
      });
    });

    it('no copia la URL ni el comando en los errores', () => {
      const result = check({
        ...valid,
        summary:
          'Descarga https://evil.example/payload y ejecuta Invoke-Expression.',
      });
      expect(result.status).toBe('UNSAFE');
      const errors = result.errors.join(' ');
      expect(errors).not.toContain('evil.example');
      expect(errors).not.toContain('Invoke-Expression');
    });

    it('no confunde prosa técnica legítima con URLs o comandos', () => {
      const result = check({
        ...valid,
        technicalAnalysis:
          'La capa FILETYPE (ev1) muestra que factura.pdf.exe, ubicado en %USERPROFILE%\\Downloads, ' +
          'es un PE (ev2). Los atacantes suelen usar PowerShell o wscript ejecuta scripts; ' +
          'revisa el registro de Windows con ayuda de soporte. Ruta: C:\\Windows\\System32.',
      });
      expect(result.status).toBe('VALID');
    });
  });

  describe('5. Completitud', () => {
    it('respuesta truncada con JSON roto → INCOMPLETE (no INVALID_JSON)', () => {
      const cut = JSON.stringify(valid).slice(0, 80);
      expect(check(cut, true)).toEqual({
        status: 'INCOMPLETE',
        errors: ['La respuesta se cortó por el límite de tokens.'],
      });
    });

    it('respuesta truncada aunque el JSON sea válido → INCOMPLETE', () => {
      expect(check(valid, true).status).toBe('INCOMPLETE');
    });
  });

  describe('orden de los pasos', () => {
    it('esquema antes que seguridad', () => {
      const result = check({
        ...valid,
        recommendedAction: 'RUN_SCRIPT',
        summary: 'Ve a https://evil.example',
      });
      expect(result.status).toBe('SCHEMA_ERROR');
    });

    it('semántica antes que seguridad', () => {
      const result = check({
        ...valid,
        citedEvidenceIds: ['ev7'],
        summary: 'Ve a https://evil.example',
      });
      expect(result.status).toBe('UNKNOWN_EVIDENCE');
    });
  });
});
