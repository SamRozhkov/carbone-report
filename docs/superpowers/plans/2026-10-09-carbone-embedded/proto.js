// Prototype renderBuffer on top of unmodified Carbone 3.8.2 (scratch only).
const path = require('path');
const SRC = path.join(__dirname, '../carbone-src/lib/');
const carbone = require(SRC + 'index');
const file = require(SRC + 'file');
const input = require(SRC + 'input');
const preprocessor = require(SRC + 'preprocessor');
const builder = require(SRC + 'builder');

function unzipToTemplate(buf, ext, cb) {
  const t = { isZipped: true, filename: 'template.' + ext, embeddings: [], files: [] };
  if (buf.slice(0, 2).toString() !== 'PK') {
    t.isZipped = false;
    t.files.push({ name: t.filename, data: buf.toString('utf8'), isMarked: true, parent: '' });
    return cb(null, t);
  }
  file.unzip(buf, (err, files) => {
    if (err) return cb(err);
    for (const f of files) {
      const e = path.extname(f.name);
      f.isMarked = false; f.parent = '';
      if (e === '.xml' || e === '.rels') { f.isMarked = true; f.data = f.data.toString(); }
      t.files.push(f); // NOTE: embedded xlsx/ods not handled in proto (file.js unzipFiles does it)
    }
    cb(null, t);
  });
}
function walk(t, data, options, i, cb) {
  if (i >= t.files.length) return cb(null, t);
  const f = t.files[i];
  if (!f.isMarked) return walk(t, data, options, i + 1, cb);
  builder.buildXML(f.data, data, options, (err, xml) => {
    if (err) return cb(err);
    f.data = xml; walk(t, data, options, i + 1, cb);
  });
}
function renderBuffer(buf, ext, data, opts) {
  return new Promise((resolve, reject) => {
    const raw = Object.assign({}, opts);
    input.parseOptions(raw, null, (options) => {
      options.extension = ext;
      const e = input.parseConvertTo(options, undefined);
      if (e) return reject(new Error(e));
      unzipToTemplate(buf, ext, (err, t) => {
        if (err) return reject(err);
        t.extension = ext;
        preprocessor.execute(t, options, (err, t) => {
          if (err) return reject(err);
          walk(t, data, options, 0, (err, r) => {
            if (err) return reject(err);
            file.buildFile(r, (err, out) => (err ? reject(err) : resolve(out)));
          });
        });
      });
    });
  });
}
module.exports = { renderBuffer, carbone, file };
