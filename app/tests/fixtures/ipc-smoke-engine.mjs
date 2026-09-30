// Test-only JSON-RPC peer used by the real Electron IPC smoke test.
import { createInterface } from 'node:readline';
import { basename } from 'node:path';

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  const request = JSON.parse(line);
  const reply = (result) =>
    process.stdout.write(
      JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n',
    );
  switch (request.method) {
    case 'engine.hello':
      reply({
        protocol: '1',
        engineVersion: 'ipc-smoke-fake',
        python: 'not-used',
        capabilities: ['scan.file'],
      });
      break;
    case 'engine.ping':
      reply({ ts: new Date().toISOString() });
      break;
    case 'scan.file':
      setTimeout(
        () =>
          reply({
            taskId: request.params.taskId,
            status: 'SCANNED',
            evidence: [],
            layers: [],
            durationMs: 1_500,
            engineVersion: 'ipc-smoke-fake',
            file: {
              name: basename(request.params.path),
              extension: '.txt',
              sizeBytes: 3,
              modifiedAt: '2026-09-30T00:00:00Z',
            },
            hashes: {
              sha256:
                'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
            },
          }),
        1_500,
      );
      break;
    case 'engine.shutdown':
      reply({ ok: true });
      input.close();
      process.stdin.destroy();
      break;
    default:
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32601, message: 'Method not found' },
        }) + '\n',
      );
  }
});
