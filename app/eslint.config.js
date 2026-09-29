import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'out/**',
      'coverage/**',
      '.npm-cache/**',
      '.electron-cache/**',
      '.smoke-profile/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {
    files: ['src/core/**/*.{ts,tsx,mts,cts,js,mjs,cjs}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'electron',
              message: 'El core debe ser independiente de Electron.',
            },
          ],
          patterns: ['electron/*'],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportExpression[source.value=/^electron(\\/|$)/]',
          message: 'El core no puede cargar Electron de forma dinamica.',
        },
        {
          selector:
            "CallExpression[callee.name='require'][arguments.0.value=/^electron(\\/|$)/]",
          message: 'El core no puede cargar Electron con require.',
        },
      ],
    },
  },
);
