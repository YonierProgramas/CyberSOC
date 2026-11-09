import { ESLint } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

describe('src/core boundary', () => {
  const eslint = new ESLint();

  beforeAll(async () => {
    await eslint.calculateConfigForFile('src/core/boundary-check.ts');
  }, 60_000);

  it.each([
    ["import { app } from 'electron'; void app;", 'no-restricted-imports'],
    ["export { app } from 'electron';", 'no-restricted-imports'],
    ["import { app } from 'electron/main'; void app;", 'no-restricted-imports'],
    ["void import('electron');", 'no-restricted-syntax'],
    ["require('electron');", 'no-restricted-syntax'],
  ])('rejects %s', async (code, rule) => {
    const [result] = await eslint.lintText(code, {
      filePath: 'src/core/boundary-check.ts',
    });
    expect(result.messages.some((message) => message.ruleId === rule)).toBe(
      true,
    );
  });

  it('allows Electron in main', async () => {
    const [result] = await eslint.lintText(
      "import { app } from 'electron'; void app;",
      {
        filePath: 'src/main/boundary-check.ts',
      },
    );
    expect(result.errorCount).toBe(0);
  });
});
