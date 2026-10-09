// runs inside api container: reads JSON array of cases from stdin, prints JSON results
const base = 'http://carbone:4000';
const H = { 'carbone-version': '5' };
let buf = '';
process.stdin.on('data', d => buf += d);
process.stdin.on('end', async () => {
  const cases = JSON.parse(buf);
  const out = [];
  for (const c of cases) {
    const r = { name: c.name };
    try {
      const form = new FormData();
      form.append('template', new Blob([Buffer.from(c.tpl, 'base64')]), 'template.docx');
      const up = await fetch(base + '/template', { method: 'POST', headers: H, body: form });
      const ub = await up.json().catch(() => null);
      const id = ub?.data?.templateId;
      if (!id) { r.error = 'upload: ' + JSON.stringify(ub); out.push(r); continue; }
      const body = Object.assign({ data: c.data, convertTo: c.convertTo, lang: 'ru-ru', timezone: 'Europe/Moscow' }, c.opts || {});
      const res = await fetch(base + '/render/' + encodeURIComponent(id) + '?download=true', {
        method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const ct = res.headers.get('content-type') || '';
      if (res.ok && !ct.includes('application/json')) r.out = Buffer.from(await res.arrayBuffer()).toString('base64');
      else r.error = 'HTTP ' + res.status + ' ' + (await res.text()).slice(0, 500);
    } catch (e) { r.error = 'EXC ' + e.message; }
    out.push(r);
  }
  process.stdout.write(JSON.stringify(out));
});
