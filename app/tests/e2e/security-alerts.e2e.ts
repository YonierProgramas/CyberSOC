import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'playwright/test';
import { launchEvidence, pointDialog, prepareEvidenceRoot } from './harness';

test('security alert offers quarantine and reports cancellation, isolation, restoration and failure', async () => {
  const testInfo = test.info();
  const root = prepareEvidenceRoot();
  const folder = join(root, 'security-demo');
  mkdirSync(folder);
  const file = join(folder, 'CSD-TEST-001.txt');
  writeFileSync(
    file,
    'CyberSOC Defender | CSD-TEST-001 | texto inofensivo de prueba.\n',
  );
  writeFileSync(join(folder, 'control.txt'), 'Documento limpio.\n');
  const session = await launchEvidence(root);
  const { app, page } = session;
  try {
    await app.evaluate(({ dialog }) => {
      const answers = [0, 1, 1, 1, 1];
      dialog.showMessageBox = (async () => {
        const response = answers.shift();
        if (response === undefined)
          throw new Error('Unexpected native confirmation');
        return { response, checkboxChecked: false };
      }) as typeof dialog.showMessageBox;
    });
    await page.getByTestId('nav-scan').click();
    await pointDialog(app, folder);
    await page.getByTestId('scan-folder').click();
    const alert = page.getByTestId('security-alerts');
    await expect(alert).toContainText('Archivo detectado: CSD-TEST-001.txt');
    await expect(alert).toContainText('Sin cuarentena');
    await expect(page.getByTestId('job-status')).toContainText('Completado');
    await expect(alert.getByTestId('security-alert-file')).toHaveCount(1);
    await page.getByTestId('nav-home').click();
    await expect(alert).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('alert-detected.png') });

    await alert.getByTestId('security-quarantine-file').click();
    await page
      .getByTestId('quarantine-dialog')
      .getByRole('button', { name: 'Cancelar', exact: true })
      .click();
    expect(existsSync(file)).toBe(true);
    await expect(alert).toContainText('Sin cuarentena');

    // Rechazo nativo: no debe anunciar un aislamiento inexistente.
    await alert.getByTestId('security-quarantine-file').click();
    await page.getByTestId('quarantine-confirm').click();
    await expect(page.getByTestId('quarantine-dialog')).toHaveCount(0);
    await expect(alert).toContainText('Sin cuarentena');
    expect(existsSync(file)).toBe(true);

    await alert.getByTestId('security-quarantine-file').click();
    await page.getByTestId('quarantine-confirm').click();
    await expect(alert.getByTestId('security-quarantine-status')).toContainText(
      'En cuarentena:',
    );
    expect(existsSync(file)).toBe(false);
    await page.screenshot({
      path: testInfo.outputPath('alert-quarantined.png'),
    });
    await expect(alert.getByTestId('security-quarantine-file')).toHaveCount(0);

    await alert.getByRole('button', { name: 'Abrir cuarentena' }).click();
    const row = page
      .getByTestId('quarantine-row')
      .filter({ hasText: 'CSD-TEST-001.txt' });
    await row.getByTestId('quarantine-restore').click();
    await page.getByTestId('quarantine-restore-confirm').click();
    await page.getByTestId('quarantine-restore-detected-confirm').click();
    await expect(alert).toContainText('Restaurado por el usuario');
    expect(existsSync(file)).toBe(true);

    // El análisis nuevo no hereda el aislamiento del resultado anterior.
    await page.getByTestId('nav-scan').click();
    await pointDialog(app, file);
    await page.getByTestId('scan-file').click();
    await expect(
      alert.getByTestId('security-quarantine-status').first(),
    ).toContainText('Sin cuarentena');
    await expect(page.getByTestId('job-status')).toContainText('Completado');

    writeFileSync(
      file,
      'Contenido cambiado para comprobar que no se anuncia un aislamiento falso.\n',
    );
    await alert.getByTestId('security-quarantine-file').click();
    await page.getByTestId('quarantine-confirm').click();
    await expect(page.getByTestId('quarantine-dialog')).toHaveCount(0);
    await expect(alert).toContainText('(FILE_CHANGED)');
    await expect(
      alert.getByTestId('security-quarantine-status').first(),
    ).not.toContainText('En cuarentena:');
    expect(existsSync(file)).toBe(true);
  } finally {
    await app.close();
  }
});
