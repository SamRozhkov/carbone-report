// Тестовый поток пула: mode «oom» занимает память до исчерпания кучи (resourceLimits), «echo» — отвечает.
import { parentPort } from 'node:worker_threads';

const hoard = [];
parentPort.on('message', (m) => {
  const { mode } = JSON.parse(m.data);
  if (mode === 'oom') {
    for (;;) hoard.push(new Array(1024 * 1024).fill({ x: hoard.length }));
  }
  const out = new Uint8Array(m.template.byteLength + 1);
  out.set(m.template);
  out[out.length - 1] = 0x21;
  parentPort.postMessage({ id: m.id, ok: true, out }, [out.buffer]);
});

parentPort.postMessage({ ready: true });
