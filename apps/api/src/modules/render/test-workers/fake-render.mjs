// Тестовый поток пула: вместо Carbone ведёт себя по data.mode.
import process from 'node:process';
import { setTimeout, setInterval } from 'node:timers';
import { TextEncoder } from 'node:util';
import { parentPort } from 'node:worker_threads';

parentPort.on('message', (m) => {
  const { mode, ms } = JSON.parse(m.data);
  const reply = (warnings = []) => {
    const out = new Uint8Array(m.template.byteLength + 1);
    out.set(m.template);
    out[out.length - 1] = 0x21; // «!» — признак, что поток обработал шаблон
    parentPort.postMessage({ id: m.id, ok: true, out, warnings }, [out.buffer]);
  };
  if (mode === 'echo') reply();
  else if (mode === 'warn')
    reply(['изображение не загружено: http://cdn.example.org/a.png — код ответа 404']);
  else if (mode === 'options') {
    const out = new TextEncoder().encode(JSON.stringify(m.options));
    parentPort.postMessage({ id: m.id, ok: true, out, warnings: [] }, [out.buffer]);
  } else if (mode === 'slow') setTimeout(reply, ms);
  else if (mode === 'hang') setInterval(() => {}, 1000);
  else if (mode === 'fail')
    parentPort.postMessage({ id: m.id, ok: false, message: 'Formatter "x" does not exist' });
  else if (mode === 'crash') process.exit(3);
});

parentPort.postMessage({ ready: true });
