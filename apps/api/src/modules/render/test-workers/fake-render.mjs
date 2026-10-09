// Тестовый поток пула: вместо Carbone ведёт себя по data.mode.
import process from 'node:process';
import { setTimeout, setInterval } from 'node:timers';
import { parentPort } from 'node:worker_threads';

parentPort.on('message', (m) => {
  const { mode, ms } = JSON.parse(m.data);
  const reply = () => {
    const out = new Uint8Array(m.template.byteLength + 1);
    out.set(m.template);
    out[out.length - 1] = 0x21; // «!» — признак, что поток обработал шаблон
    parentPort.postMessage({ id: m.id, ok: true, out }, [out.buffer]);
  };
  if (mode === 'echo') reply();
  else if (mode === 'slow') setTimeout(reply, ms);
  else if (mode === 'hang') setInterval(() => {}, 1000);
  else if (mode === 'fail')
    parentPort.postMessage({ id: m.id, ok: false, message: 'Formatter "x" does not exist' });
  else if (mode === 'crash') process.exit(3);
});
