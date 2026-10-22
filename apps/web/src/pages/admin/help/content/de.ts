import type { HelpSection } from './types';

const j = (v: unknown) => JSON.stringify(v, null, 2);
const L = (...lines: string[]) => lines.join('\n');
/** API-Meldung für einen deaktivierten Formatierer (apps/api/src/modules/carbone/community.ts, errors-Katalog). */
const community = (name: string) =>
  `die Vorlage verwendet ${name} — in der kostenlosen Version von Carbone nicht verfügbar, siehe „Hilfe zu Vorlagen“`;

const CARS = [
  { brand: 'Opel', qty: 3, ok: true },
  { brand: 'Tesla', qty: 1, ok: false },
  { brand: 'Opel', qty: 2, ok: true },
  { brand: 'BMW', qty: 5, ok: true },
];
/** PNG 1×1 — ein echtes Bild für die Beispiele (`pnpm help:check` dekodiert es). */
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const GROUPS = [
  { name: 'G1', items: [{ x: 'a' }, { x: 'b' }] },
  { name: 'G2', items: [{ x: 'c' }] },
  { name: 'G3', items: [] },
];

export const HELP_INTRO: string[] = [
  'Hier steht nur, was auf unserem Carbone geprüft ist — der kostenlosen Version (Community Edition). Alles, was ihr fehlt, ist im letzten Abschnitt zusammen mit Alternativen gesammelt. Fehlermeldungen der Carbone-Engine selbst (Bilder, Barcodes, Farben, Diagramme, HTML) werden nach „Vorlagenfehler:“ auf Russisch angezeigt; diese Hilfe beschreibt, was sie bedeuten.',
  'Die Berichtsdaten sind das Objekt `d`. Das Ergebnis jeder SQL-Abfrage der Vorlage liegt unter ihrem Schlüssel: im Modus „Liste von Zeilen“ ein Array, im Modus „Eine Zeile“ ein Objekt (oder leer). Die Berichtsparameter stehen in `d.params`.',
  'Tags und „Konstrukte“ aus dem Bereich rechts auf dem Tab „Dokument“ können Sie mit der Maus direkt in das Dokument ziehen — das Tag landet dort, wo Sie die Maustaste loslassen. Ersetzen Sie in „Konstrukte“ `feld` und `array` durch Ihre eigenen Namen.',
  'In den Beispielen ist eine Zeile, die mit „|“ beginnt, eine Zeile einer Word-Tabelle; die Zellen sind durch „|“ getrennt. Die übrigen Zeilen sind einzelne Absätze.',
];

export const HELP_SECTIONS: HelpSection[] = [
  {
    id: 'basics',
    title: 'Grundlagen',
    intro: [
      'Das Tag `{d.feld}` fügt einen Wert aus den Daten ein. Ein Pfad mit Punkten führt in verschachtelte Objekte, `[Nummer]` zu einem Array-Element (ab null gezählt), `[feld=wert]` zu einem Element nach Bedingung.',
    ],
    examples: [
      {
        id: 'basics-field',
        title: 'Feldwert',
        template: 'Kunde: {d.name}',
        data: j({ name: 'Max' }),
        result: 'Kunde: Max',
        note: 'Fehlt das Feld in den Daten, wird eine leere Zeichenkette eingefügt; einen Fehler gibt es nicht.',
      },
      {
        id: 'basics-nested',
        title: 'Verschachteltes Objekt',
        template: '{d.client.address.city}',
        data: j({ client: { address: { city: 'Berlin' } } }),
        result: 'Berlin',
      },
      {
        id: 'basics-search',
        title: 'Array-Element nach Bedingung',
        template: '{d.items[id=2].name}',
        data: j({
          items: [
            { id: 1, name: 'a' },
            { id: 2, name: 'b' },
          ],
        }),
        result: 'b',
        note: "Ein Zeichenkettenwert steht in Anführungszeichen: `{d.items[code='X'].name}`. Ein Element nach Nummer: `{d.items[0].name}` (ab null gezählt).",
      },
      {
        id: 'basics-params',
        title: 'Berichtsparameter',
        template: "Zeitraum ab {d.params.from:formatD('DD.MM.YYYY')}",
        data: j({ params: { from: '2026-03-01' } }),
        result: 'Zeitraum ab 01.03.2026',
        note: "Die Berichtsparameter stehen in `d.params` unter ihren Namen. Tags `{c.…}` füllt das System nicht selbst, außer `{c.now}` — dem Zeitpunkt der Erstellung: `{c.now:formatD('DD.MM.YYYY')}`. Eigene Werte können Sie in `c` nur mit `:set` ablegen (siehe Abschnitt „Summen und Gruppierung“).",
      },
      {
        id: 'basics-ifempty',
        title: 'Standardwert',
        template: "Bezahlt am: {d.paid_on:formatD('DD.MM.YYYY'):ifEmpty('—')}",
        data: j({ paid_on: null }),
        result: 'Bezahlt am: —',
        note: "`ifEmpty` steht als letztes in der Kette: `{d.paid_on:ifEmpty('—'):formatD('DD.MM.YYYY')}` gibt „Invalid Date“ aus. Als leer gelten null, eine leere Zeichenkette, ein leeres Array und ein fehlendes Feld; 0 bleibt 0.",
      },
      {
        id: 'basics-alias',
        title: 'Alias',
        template: '{#cl = d.client}{$cl.name}',
        data: j({ client: { name: 'Peter' } }),
        result: 'Peter',
        note: 'Ein Alias wird mit dem Tag `{#name = pfad}` deklariert; dieses Tag selbst gibt nichts aus. Danach schreiben Sie `{$name…}` statt des Pfads.',
      },
    ],
  },
  {
    id: 'tables',
    title: 'Tabellen',
    intro: [
      'Eine Tabellenzeile wird für jedes Array-Element wiederholt: Sie enthält Tags mit `[i]`, und die nächste Zeile enthält mindestens ein Tag mit `[i+1]`. Die Zeile mit `[i+1]` erscheint nicht im Ergebnis. Ohne `[i+1]` meldet Carbone den Fehler „has no corresponding [i+1]“. Setzen Sie in die `[i+1]`-Zeile nur `[i+1]`-Tags und lassen Sie die übrigen Zellen leer: Ein `[i]`-Tag dort führt zum Fehler „is in the [i+1] row“.',
      'Absätze werden genauso wiederholt: ein Absatz mit `[i]`, danach ein Absatz mit `[i+1]`.',
    ],
    examples: [
      {
        id: 'tables-rows',
        title: 'Tabellenzeilen aus einem Array',
        template: L(
          '| Marke | Menge |',
          '| {d.cars[i].brand} | {d.cars[i].qty} |',
          '| {d.cars[i+1].brand} | |',
        ),
        data: j({ cars: CARS }),
        result: L(
          '| Marke | Menge |',
          '| Opel | 3 |',
          '| Tesla | 1 |',
          '| Opel | 2 |',
          '| BMW | 5 |',
        ),
      },
      {
        id: 'tables-nested',
        title: 'Verschachtelte Schleife',
        template: L(
          '{d.groups[i].name}:',
          '- {d.groups[i].items[i].x}',
          '- {d.groups[i].items[i+1].x}',
          '{d.groups[i+1].name}',
        ),
        data: j({ groups: GROUPS }),
        result: L('G1:', '- a', '- b', 'G2:', '- c', 'G3:'),
        note: 'Ein leeres verschachteltes Array erzeugt keine Zeilen — „G3“ hat keine, und einen Fehler gibt es auch nicht.',
      },
      {
        id: 'tables-nested-rows',
        title: 'Verschachtelte Schleife in Tabellenzeilen',
        template: L(
          '| {d.groups[i].name} | |',
          '| | {d.groups[i].items[i].x} |',
          '| | {d.groups[i].items[i+1].x} |',
          '| {d.groups[i+1].name} | |',
        ),
        data: j({ groups: GROUPS }),
        result: L('| G1 | |', '| | a |', '| | b |', '| G2 | |', '| | c |', '| G3 | |'),
      },
      {
        id: 'tables-empty',
        title: 'Leeres Array',
        template: L(
          'vorher',
          '| Marke |',
          '| {d.cars[i].brand} |',
          '| {d.cars[i+1].brand} |',
          'nachher',
          "{d.cars:ifEM():show('Keine Daten'):elseShow('')}",
        ),
        data: j({ cars: [] }),
        result: L('vorher', '| Marke |', 'nachher', 'Keine Daten'),
        note: "Die Schleifenzeilen verschwinden, die Kopfzeile bleibt; der Schlüssel darf ganz fehlen — das Ergebnis ist dasselbe. Ohne `elseShow('')` gibt `ifEM` bei nicht leerem Array den Wert selbst aus.",
      },
      {
        id: 'tables-numbering',
        title: 'Zeilennummer',
        template: L(
          '| Nr. | Marke |',
          '| {d.cars[i].brand:count()} | {d.cars[i].brand} |',
          '| {d.cars[i+1].brand} | |',
        ),
        data: j({ cars: CARS }),
        result: L(
          '| Nr. | Marke |',
          '| 1 | Opel |',
          '| 2 | Tesla |',
          '| 3 | Opel |',
          '| 4 | BMW |',
        ),
        note: 'Die Nummern laufen 1, 2, 3… über die ausgegebenen Zeilen, auch in einer gefilterten Schleife — ohne Lücken. Das Tag `{d.cars[i].i}` gibt nichts aus. Der alte Weg `{d.cars[i].brand:print(.i):add(1)}` funktioniert ebenfalls, aber `.i` ist die Position im Quell-Array, sodass die Nummern bei einem Schleifenfilter Lücken haben. Eine Zahl in den Klammern wie in der alten Carbone-Version (`count(0)`) wird ignoriert: Die Nummerierung beginnt immer bei 1. Wiederholen Sie Filter und Sortierung der Schleife im `count()`-Tag selbst (`{d.cars[i, ok=true].brand:count()}`), sonst nummeriert die Zeile ihre eigene Menge. Zeilen, die `drop(row)` entfernt, erhalten trotzdem eine Nummer, sodass die Nummerierung Lücken hat; wählen Sie Zeilen stattdessen mit einem Schleifenfilter aus. Nummerierung, Summen und Zwischensummen: Abschnitt „Summen und Nummerierung“.',
      },
      {
        id: 'tables-filter',
        title: 'Zeilen filtern',
        template: L('| {d.cars[i, ok=true].brand} |', '| {d.cars[i+1, ok=true].brand} |'),
        data: j({ cars: CARS }),
        result: L('| Opel |', '| Opel |', '| BMW |'),
        note: "Vergleiche `[i, qty > 1]`, Zeichenketten `[i, brand='Opel']` und mehrere Bedingungen durch Kommas getrennt funktionieren genauso — sie werden mit UND verknüpft; ODER gibt es nicht, legen Sie dafür ein Flag in SQL an. Eine Tabellenzeile können Sie so oder mit einem `drop(row)`-Tag ausblenden; `hideBegin`/`hideEnd` in einer Tabelle hinterlassen eine leere Zeile (Abschnitt „Bedingungen“).",
      },
      {
        id: 'tables-sort',
        title: 'Sortierung',
        template: L('{d.cars[qty, i].brand}', '{d.cars[qty+1, i+1].brand}'),
        data: j({ cars: CARS }),
        result: L('Tesla', 'Opel', 'Opel', 'BMW'),
        note: 'Nur aufsteigend. `[-qty, i]` behält stillschweigend die ursprüngliche Reihenfolge bei — sortieren Sie absteigend in SQL (`order by … desc`).',
      },
    ],
  },
  {
    id: 'formatting',
    title: 'Formatierung',
    intro: [
      "Ein Formatierer steht nach einem Doppelpunkt: `{d.feld:formatD('DD.MM.YYYY')}`. Formatierer lassen sich zu einer Kette verbinden und werden von links nach rechts angewendet.",
    ],
    examples: [
      {
        id: 'fmt-date-long',
        title: 'Datum mit Monatsnamen',
        template: "{d.date:formatD('D. MMMM YYYY')}",
        data: j({ date: '2026-03-08' }),
        result: '8. März 2026',
        note: "`formatD('dddd, D. MMMM YYYY')` ergibt „Sonntag, 8. März 2026“, `formatD('MMMM YYYY')` ergibt „März 2026“.",
      },
      {
        id: 'fmt-date-short',
        title: 'Datum in Ziffern',
        template: "{d.date:formatD('DD.MM.YYYY')}",
        data: j({ date: '2026-03-08' }),
        result: '08.03.2026',
      },
      {
        id: 'fmt-date-time',
        title: 'Datum und Uhrzeit',
        template: "{d.at:formatD('DD.MM.YYYY HH:mm')}",
        data: j({ at: '2026-03-08T23:30:00+03:00' }),
        result: '08.03.2026 23:30',
        note: 'Die Uhrzeit wird in der Zeitzone des Servers angezeigt (`TZ`, standardmäßig Europe/Moscow). Übergeben Sie Zeiten mit Versatz (`+03:00`) oder in UTC (`Z`).',
      },
      {
        id: 'fmt-date-naive',
        title: 'Uhrzeit ohne Versatz',
        template: "{d.at:formatD('DD.MM.YYYY HH:mm')}",
        data: j({ at: '2026-03-08 23:30:00' }),
        result: '09.03.2026 02:30',
        note: 'Eine Uhrzeit ohne Versatz gilt als UTC und wird um 3 Stunden verschoben. Übergeben Sie Zeiten mit Versatz oder ein Datum ohne Uhrzeit.',
      },
      {
        id: 'fmt-number',
        title: 'Zahl',
        template: '{d.n:formatN(2)}',
        data: j({ n: 1234567.891 }),
        result: '1.234.567,89',
        note: 'Tausendertrennzeichen und Dezimalzeichen richten sich nach der Berichtssprache: im Deutschen Punkt und Komma. `formatN(0)` rundet auf eine ganze Zahl: 1234567.5 → „1.234.568“.',
      },
      {
        id: 'fmt-money',
        title: 'Betrag in Euro',
        template: '{d.sum:formatC()}',
        data: j({ sum: 1234567.891 }),
        result: '1.234.567,89 €',
        note: "`formatC()` gibt die Währung der Berichtssprache aus — Euro für Deutsch; ändert sich die Berichtssprache der Vorlage, ändert sich auch die Währung. `formatC(0)` lässt die Cent weg: 1234.5 → „1.235 €“. Verwenden Sie `formatC('M')` und `formatC('LL')` nicht: Der Name der Währung wird auf Englisch ausgegeben („1.234.567,89 euros“).",
      },
      {
        id: 'fmt-convcurr',
        title: 'Umrechnung in eine andere Währung',
        template: "{d.sum:convCurr('USD')}",
        data: j({ sum: 1000 }),
        result: '1140.3000000000002',
        note: "Carbone rechnet aus der Währung der Berichtssprache (Euro für Deutsch) zu eingebauten Kursen um: Sie werden nicht aktualisiert, und unser System übergibt keine eigenen Kurse. `formatC(2, 'USD')` rechnet genauso stillschweigend um: 1000 → „1.140,30 $“. Berechnen Sie Beträge in anderen Währungen in SQL.",
      },
      {
        id: 'fmt-case',
        title: 'Groß- und Kleinschreibung',
        template: '{d.name:ucWords()}',
        data: j({ name: 'max müller' }),
        result: 'Max Müller',
        note: 'Außerdem `ucFirst()` → „Max müller“, `upperCase()`, `lowerCase()`. Umlaute und Buchstaben anderer Alphabete, etwa Kyrillisch, werden korrekt verarbeitet.',
      },
      {
        id: 'fmt-ellipsis',
        title: 'Zeichenkette kürzen',
        template: '{d.title:ellipsis(7)}',
        data: j({ title: 'Kontoauszug' }),
        result: 'Kontoau...',
        note: "Außerdem `substr(0, 5)` → „Konto“, `padl(6, '0')` für „42“ → „000042“, `prepend('Nr. ')`, `append(' EUR')`, `replace('-', '/')`.",
      },
      {
        id: 'fmt-math',
        title: 'Arithmetik',
        template: '{d.v:add(.b * 2 - 1)}',
        data: j({ v: 10, b: 3 }),
        result: '15',
        note: '`add`, `sub`, `mul`, `div` nehmen eine Zahl oder ein benachbartes Feld (`.b`); Ausdrücke haben keine Klammern. Das Ergebnis wird unformatiert ausgegeben — fügen Sie für die Anzeige `formatN` hinzu. Division durch null gibt stillschweigend die ursprüngliche Zahl zurück.',
      },
      {
        id: 'fmt-array-join',
        title: 'Kommagetrennte Liste',
        template: '{d.tags:arrayJoin()}',
        data: j({ tags: ['a', 'b', 'c'] }),
        result: 'a, b, c',
        note: "Für ein Array von Objekten: `{d.items:arrayMap(', ', ':', 'name')}` — die Werte des Feldes name, durch Kommas getrennt.",
      },
      {
        id: 'fmt-multiline',
        title: 'Mehrzeiliger Text',
        template: '{d.text:convCRLF}',
        data: j({ text: 'Zeile1\nZeile2' }),
        result: L('Zeile1', 'Zeile2'),
        note: 'Ohne `convCRLF` ist ein Zeilenumbruch aus den Daten in Word nicht sichtbar.',
      },
    ],
  },
  {
    id: 'conditions',
    title: 'Bedingungen',
    intro: [
      'Eine Bedingung prüft einen Wert (`ifEQ`, `ifNE`, `ifGT`, `ifGTE`, `ifLT`, `ifLTE`, `ifIN`, `ifNIN`, `ifEM`, `ifNEM`) und gibt `show(…)` oder `elseShow(…)` aus. Bedingungen werden mit `and(.feld)` und `or(.feld)` verknüpft.',
      'Absätze und Textteile blenden `showBegin`/`showEnd` und `hideBegin`/`hideEnd` aus. Eine Tabellenzeile blenden Sie mit einem Schleifenfilter (Abschnitt „Tabellen“) oder `drop(row)` aus; einen ganzen Absatz, eine Tabelle oder ein Bild entfernen `drop`/`keep`.',
    ],
    examples: [
      {
        id: 'cond-if',
        title: 'Text je nach Bedingung',
        template: "{d.status:ifEQ('paid'):show('Bezahlt'):elseShow('Nicht bezahlt')}",
        data: j({ status: 'new' }),
        result: 'Nicht bezahlt',
        note: "Ohne `elseShow` gibt eine falsche Bedingung den Wert selbst aus: `{d.v:ifEQ(1):show('eins')}` ergibt für 2 „2“. Fügen Sie `elseShow('')` hinzu.",
      },
      {
        id: 'cond-and',
        title: 'Zwei Bedingungen',
        template:
          "{d.qty:ifGT(0):and(.paid):ifEQ(true):show('versandbereit'):elseShow('ausstehend')}",
        data: j({ qty: 2, paid: true }),
        result: 'versandbereit',
        note: 'Statt `and` können Sie `or` verwenden: `…:or(.paid):ifEQ(true)…`.',
      },
      {
        id: 'cond-inline',
        title: 'Textteil je nach Bedingung',
        template: 'Gesamt{d.vat:ifEQ(true):showBegin}, einschließlich MwSt{d.vat:showEnd}.',
        data: j({ vat: false }),
        result: 'Gesamt.',
      },
      {
        id: 'cond-paragraphs',
        title: 'Absätze ausblenden',
        template: L(
          'Rechnung',
          '{d.paid:ifEQ(true):hideBegin}',
          'Bitte zahlen Sie innerhalb von 5 Tagen.',
          '{d.paid:hideEnd}',
          'Vielen Dank!',
        ),
        data: j({ paid: true }),
        result: L('Rechnung', 'Vielen Dank!'),
        note: 'Die Absätze mit den Tags `hideBegin`/`hideEnd` verschwinden ebenfalls.',
      },
      {
        id: 'cond-drop-p',
        title: 'Absatz entfernen (drop)',
        template: L('vorher', '{d.f:ifEQ(true):drop(p)}zu entfernender Absatz', 'nachher'),
        data: j({ f: true }),
        result: L('vorher', 'nachher'),
        note: 'Setzen Sie das Tag in den Absatz selbst und als letztes in die Formatiererkette. Die Bedingung ist das Ergebnis von `ifEQ`, `ifGT` und ähnlichen. Ohne Bedingung entscheidet der Wert selbst: `true`, eine Zahl ungleich null, nicht leerer Text außer `"0"` und `"false"` sowie eine nicht leere Liste entfernen den Absatz; `false`, `0`, leerer Text, `"0"`, `"false"` sowie ein leerer oder fehlender Wert nicht — 0/1-Flags aus der Datenbank funktionieren unverändert. Funktioniert in DOCX, ODT, PPTX, ODP; XLSX und ODS haben keine Absätze.',
      },
      {
        id: 'cond-keep-p',
        title: 'Absatz nur bei erfüllter Bedingung behalten (keep)',
        template: L('vorher', '{d.f:ifEQ(true):keep(p)}zu behaltender Absatz', 'nachher'),
        data: j({ f: false }),
        result: L('vorher', 'nachher'),
        note: '`keep` ist das Gegenteil von `drop`: Der Absatz bleibt nur, wenn die Bedingung wahr ist. `drop(table)`, `drop(img)`, `drop(shape)`, `drop(chart)` funktionieren genauso; in ODS außerdem `drop(sheet)`, in ODP `drop(slide)`.',
      },
      {
        id: 'cond-drop-row',
        title: 'Tabellenzeile entfernen (drop(row))',
        template: L(
          '| Marke | Menge |',
          '| {d.cars[i].ok:ifEQ(false):drop(row)}{d.cars[i].brand} | {d.cars[i].qty} |',
          '| {d.cars[i+1].brand} | |',
        ),
        data: j({ cars: CARS }),
        result: L('| Marke | Menge |', '| Opel | 3 |', '| Opel | 2 |', '| BMW | 5 |'),
        note: 'Die Zeile „Tesla“ wird vollständig entfernt, die Tabellenformatierung bleibt erhalten. Anders als `hideBegin` funktioniert `drop(row)` in einer Schleife. Werden alle Zeilen einer Tabelle entfernt, verschwindet auch die Tabelle. `drop(col)` entfernt eine Spalte; in XLSX werden verbundene Zellen und der AutoFilter dabei nicht neu berechnet, und auf einem Blatt mit formatierter Tabelle („Als Tabelle formatieren“) ist `drop(col)` nicht verfügbar. Ein Flag ohne Bedingung funktioniert ebenfalls: `{d.cars[i].archived:drop(row)}` entfernt die Zeilen mit `archived` = 1 und behält die mit 0. Laufende Summen, `:count()` und `aggSum`-Summen über `[]` zählen auch entfernte Zeilen mit — damit eine Zeile weder in der Tabelle noch in der Summe erscheint, wählen Sie die Zeilen mit einem Schleifenfilter und demselben Filter in der Summe aus (`[ok=true]`).',
      },
      {
        id: 'cond-table-row',
        antiPattern: true,
        title: 'hideBegin in einer Tabellenzeile (so nicht)',
        template: L(
          '| Marke | Menge |',
          '| {d.cars[i].ok:ifEQ(false):hideBegin}{d.cars[i].brand} | {d.cars[i].qty}{d.cars[i].ok:hideEnd} |',
          '| {d.cars[i+1].brand} | |',
        ),
        data: j({ cars: CARS }),
        result: L('| Marke | Menge |', '| Opel | 3 |', '| |', '| Opel | 2 |', '| BMW | 5 |'),
        note: 'Statt der Zeile „Tesla“ bleibt eine leere Zeile mit einer Zelle zurück, und die Tabellenformatierung geht kaputt. Blenden Sie Zeilen mit einem Schleifenfilter (`{d.cars[i, ok=true].brand}`) oder `drop(row)` aus.',
      },
    ],
  },
  {
    id: 'aggregates',
    title: 'Summen und Nummerierung',
    intro: [
      'Aggregatoren rechnen über die gesamte Menge: `aggSum` — Summe, `aggAvg` — Durchschnitt, `aggMin`/`aggMax` — kleinster und größter Wert, `aggCount` — Anzahl der Elemente, `aggCountD` — Anzahl verschiedener Werte, `aggStr`/`aggStrD` — Werte durch Kommas getrennt (`D` — ohne Wiederholungen). Die `cum…`-Varianten (`cumSum`, `cumCount`, `cumCountD`) liefern eine laufende Summe über die Schleifenzeilen, `:count()` die Zeilennummer.',
      'Die Klammern im Pfad wählen den Modus. `[]` ist eine Summe über das ganze Array (an beliebiger Stelle im Dokument, auch nach der Tabelle), `[sort>1]` oder `[ok=true]` eine Summe nur über die ausgewählten Elemente. `[i]` in einer Schleife ist ein Wert für jede Zeile; genau `[i]` brauchen laufende Summen, `:count()` und die Gruppierung mit `aggSum(.brand)`.',
      'Das Ergebnis ist eine ungerundete Zahl: Formatieren Sie sie mit einem Formatierer nach dem Aggregator, zum Beispiel `:aggAvg:formatN(2)`. Nichtnumerische Werte (Text, leer, `null`) werden in Summen übersprungen; eine Zahl in einer Zeichenkette (`"2"`) zählt als Zahl. Ein leeres Array oder ein fehlender Schlüssel ergibt keinen Fehler: `aggSum`, `aggCount`, `aggCountD`, `cumSum` ergeben 0; `aggAvg`, `aggMin`, `aggMax`, `aggStr`, `aggStrD` ergeben einen leeren Wert.',
    ],
    examples: [
      {
        id: 'agg-sum',
        title: 'Summe außerhalb einer Schleife',
        template: 'Gesamt: {d.cars[].qty:aggSum}',
        data: j({ cars: CARS }),
        result: 'Gesamt: 11',
        note: 'Die Summe hängt nicht davon ab, wo das Tag im Dokument steht oder ob dasselbe Array von einer Schleife ausgegeben wird.',
      },
      {
        id: 'agg-filter',
        title: 'Summe mit Filter',
        template: 'Bezahlt: {d.cars[ok=true].qty:aggSum}',
        data: j({ cars: CARS }),
        result: 'Bezahlt: 10',
        note: "Die Bedingungen in den Klammern sind dieselben wie in einer Schleife: `[qty>1]`, `[brand='Opel']`, mehrere durch Kommas getrennt. Ein Schleifenfilter im Dokument wirkt sich nicht auf die Summe aus, ein Filter im Tag selbst dagegen schon.",
      },
      {
        id: 'agg-others',
        title: 'Durchschnitt, Maximum, Anzahl',
        template: L(
          'Positionen: {d.cars[].qty:aggCount}, Durchschnitt {d.cars[].qty:aggAvg:formatN(2)}',
          'Größter Wert {d.cars[].qty:aggMax}, kleinster {d.cars[].qty:aggMin}',
          'Verschiedene Marken: {d.cars[].brand:aggCountD}',
        ),
        data: j({ cars: CARS }),
        result: L(
          'Positionen: 4, Durchschnitt 2,75',
          'Größter Wert 5, kleinster 1',
          'Verschiedene Marken: 3',
        ),
        note: '`aggCount` zählt alle Elemente, `aggCountD` die verschiedenen Werte. Ein Formatierer kann auch vor dem Aggregator stehen: `{d.cars[].qty:mul(2):aggSum}` summiert die verdoppelten Werte.',
      },
      {
        id: 'agg-str',
        title: 'Werte in einer Zeile',
        template: L(
          "Marken: {d.cars[].brand:aggStrD(', ')}",
          "Alle: {d.cars[].brand:aggStr(' | ')}",
        ),
        data: j({ cars: CARS }),
        result: L('Marken: Tesla, Opel, BMW', 'Alle: Opel | Tesla | Opel | BMW'),
        note: 'Ohne Argument ist das Trennzeichen ein Komma mit Leerzeichen. `aggStrD` ordnet die Werte nach ihrem letzten Vorkommen.',
      },
      {
        id: 'agg-total-row',
        title: 'Zeile „Gesamt“ unter einer Tabelle',
        template: L(
          '| Marke | Menge |',
          '| {d.cars[i].brand} | {d.cars[i].qty} |',
          '| {d.cars[i+1].brand} | |',
          '| Gesamt | {d.cars[].qty:aggSum} |',
        ),
        data: j({ cars: CARS }),
        result: L(
          '| Marke | Menge |',
          '| Opel | 3 |',
          '| Tesla | 1 |',
          '| Opel | 2 |',
          '| BMW | 5 |',
          '| Gesamt | 11 |',
        ),
        note: 'Legen Sie die Zeile „Gesamt“ in Word als gewöhnliche Zeile unter der `[i+1]`-Zeile an. Wenn Sie `{d.cars[i].qty:aggSum}` in die Schleifenzeile schreiben, zeigt jede Zeile dieselbe Gesamtsumme: `[i]` umfasst die ganze Menge, nicht die Zeilen darüber.',
      },
      {
        id: 'agg-cum',
        title: 'Laufende Summe',
        template: L(
          '| Marke | Menge | Kumuliert |',
          '| {d.cars[i].brand} | {d.cars[i].qty} | {d.cars[i].qty:cumSum} |',
          '| {d.cars[i+1].brand} | | |',
        ),
        data: j({ cars: CARS }),
        result: L(
          '| Marke | Menge | Kumuliert |',
          '| Opel | 3 | 3 |',
          '| Tesla | 1 | 4 |',
          '| Opel | 2 | 6 |',
          '| BMW | 5 | 11 |',
        ),
        note: 'Die laufende Summe folgt der Reihenfolge und der Zeilenmenge, die die Klammern des `cumSum`-Tags selbst vorgeben. Ist die Schleife gefiltert oder sortiert (`[i, ok=true]`, `[qty, i]`), wiederholen Sie dieselben Bedingungen, einschließlich der Sortierung, in den Klammern des Tags der laufenden Summe: Die Sortierung der Schleife wirkt sich darauf nicht aus. Mit `[]` statt `[i]` ist es ein Vorlagenfehler.',
      },
      {
        id: 'agg-partition',
        title: 'Gruppensumme in einer Zeile',
        template: L(
          '| Marke | Menge | Je Marke | Nr. in Marke |',
          '| {d.cars[i].brand} | {d.cars[i].qty} | {d.cars[i].qty:aggSum(.brand)} | {d.cars[i].qty:cumCount(.brand)} |',
          '| {d.cars[i+1].brand} | | | |',
        ),
        data: j({ cars: CARS }),
        result: L(
          '| Marke | Menge | Je Marke | Nr. in Marke |',
          '| Opel | 3 | 5 | 1 |',
          '| Tesla | 1 | 1 | 1 |',
          '| Opel | 2 | 5 | 2 |',
          '| BMW | 5 | 5 | 1 |',
        ),
        note: 'Das Argument `(.brand)` ist ein Pfad vom Schleifenelement aus: Der Aggregator rechnet für jeden Wert getrennt. Es funktioniert nur in einer `[i]`-Schleife; die Werte werden streng verglichen: Die Zahl 1 und die Zeichenkette "1" sind verschiedene Gruppen. Das Argument muss ein Pfad mit Punkt sein; `aggSum(brand)` ist ein Fehler.',
      },
      {
        id: 'agg-nested',
        title: 'Zwischensumme über ein verschachteltes Array',
        template: L(
          '{d.groups[i].name}: {d.groups[i].items[].qty:aggSum}',
          '- {d.groups[i].items[i].x} {d.groups[i].items[i].qty}',
          '- {d.groups[i].items[i+1].x}',
          '{d.groups[i+1].name}',
          'Gesamt: {d.groups[].items[].qty:aggSum}',
        ),
        data: j({
          groups: [
            {
              name: 'G1',
              items: [
                { x: 'a', qty: 2 },
                { x: 'b', qty: 3 },
              ],
            },
            { name: 'G2', items: [{ x: 'c', qty: 4 }] },
            { name: 'G3', items: [] },
          ],
        }),
        result: L('G1: 5', '- a 2', '- b 3', 'G2: 4', '- c 4', 'G3: 0', 'Gesamt: 9'),
        note: '`[i]` am äußeren Array und `[]` am verschachtelten ergeben eine Zwischensumme innerhalb jeder Gruppe; eine leere Gruppe ergibt 0. Zwei `[]` hintereinander ergeben die Gesamtsumme über alle Gruppen. Für Zwischensummen können Sie nicht mit einer äußeren Schleife über ein Feld wie `[brand]` gruppieren — gruppieren Sie mit `:set` und berechnen Sie `aggSum` je Gruppe (Beispiel „Gruppenzwischensummen (:set)“ im Abschnitt „Summen und Gruppierung“) oder in SQL. Führt der verschachtelte Pfad durch ein Objekt (`{d.items[].sub.qty:aggSum}`), gibt es unter `[]` einen Fehler: Holen Sie das Feld mit `print(.sub.qty)` nach oben oder verwenden Sie `[i]`.',
      },
    ],
  },
  {
    id: 'totals',
    title: 'Summen und Gruppierung',
    intro: [
      'Summen, Zwischensummen und Nummerierung lassen sich auch in der Vorlage bilden — siehe Abschnitt „Summen und Nummerierung“. Gruppen mit Zwischensummen werden ebenfalls in der Vorlage gebildet (`:set` + `aggSum`). SQL ist dort nötig, wo die Vorlage nicht weiterkommt: Filtern mit einer ODER-Bedingung und absteigendes Sortieren; bei sehr großen Mengen (Zehntausende Zeilen) sind Summen mit Filter in Klammern in SQL schneller berechnet.',
      'Zahlen aus PostgreSQL (`numeric`, `bigint`) kommen als Zahlen in den Daten an, `date` als Zeichenkette JJJJ-MM-TT, `json` als Objekte und Arrays.',
    ],
    examples: [
      {
        id: 'totals-sum',
        title: 'Summe als eigene Abfrage',
        sql: {
          key: 'totals',
          mode: 'single',
          text: L(
            'select count(*) as positions, sum(qty * price) as amount',
            'from invoice_items',
            'where invoice_id = :invoiceId',
          ),
        },
        template: 'Positionen: {d.totals.positions}, Gesamtbetrag {d.totals.amount:formatC()}',
        data: j({ totals: { positions: 3, amount: 13775 } }),
        result: 'Positionen: 3, Gesamtbetrag 13.775,00 €',
        note: 'Die Anzahl der Array-Elemente lässt sich auch in der Vorlage ermitteln: `{d.items:len()}`.',
      },
      {
        id: 'totals-rownum',
        title: 'Zeilennummer aus SQL',
        sql: {
          key: 'items',
          mode: 'list',
          text: L(
            'select row_number() over (order by id) as n, name, qty',
            'from invoice_items',
            'where invoice_id = :invoiceId',
            'order by id',
          ),
        },
        template: L(
          '| Nr. | Artikel | Menge |',
          '| {d.items[i].n} | {d.items[i].name} | {d.items[i].qty} |',
          '| {d.items[i+1].n} | | |',
        ),
        data: j({
          items: [
            { n: 1, name: 'Kopierpapier A4', qty: 10 },
            { n: 2, name: 'Tonerkartusche', qty: 2 },
            { n: 3, name: 'Kugelschreiber', qty: 50 },
          ],
        }),
        result: L(
          '| Nr. | Artikel | Menge |',
          '| 1 | Kopierpapier A4 | 10 |',
          '| 2 | Tonerkartusche | 2 |',
          '| 3 | Kugelschreiber | 50 |',
        ),
        note: 'Wählen Sie die Zeilen in `where` aus statt mit einem Vorlagenfilter — dann haben die Nummern keine Lücken.',
      },
      {
        id: 'totals-groups',
        title: 'Gruppen mit Zwischensummen (json_agg)',
        sql: {
          key: 'groups',
          mode: 'list',
          text: L(
            'select c.name as company,',
            '       sum(it.qty * it.price) as subtotal,',
            "       json_agg(json_build_object('name', it.name, 'qty', it.qty) order by it.id) as items",
            'from invoice_items it',
            'join invoices i on i.id = it.invoice_id',
            'join company c on c.id = i.company_id',
            'group by c.id, c.name',
            'order by c.id',
          ),
        },
        template: L(
          '{d.groups[i].company} — {d.groups[i].subtotal:formatC()}',
          '- {d.groups[i].items[i].name}: {d.groups[i].items[i].qty}',
          '- {d.groups[i].items[i+1].name}',
          '{d.groups[i+1].company}',
        ),
        data: j({
          groups: [
            {
              company: 'Muster GmbH',
              subtotal: 13775,
              items: [
                { name: 'Kopierpapier A4', qty: 10 },
                { name: 'Tonerkartusche', qty: 2 },
                { name: 'Kugelschreiber', qty: 50 },
              ],
            },
            {
              company: 'Beispiel AG',
              subtotal: 34300,
              items: [
                { name: 'Bürotisch', qty: 1 },
                { name: 'Bürostuhl', qty: 2 },
                { name: 'Schreibtischlampe', qty: 3 },
              ],
            },
          ],
        }),
        result: L(
          'Muster GmbH — 13.775,00 €',
          '- Kopierpapier A4: 10',
          '- Tonerkartusche: 2',
          '- Kugelschreiber: 50',
          'Beispiel AG — 34.300,00 €',
          '- Bürotisch: 1',
          '- Bürostuhl: 2',
          '- Schreibtischlampe: 3',
        ),
        note: 'Die Zwischensumme der Gruppe berechnet `sum(…)`, den Inhalt der Gruppe sammelt `json_agg`. Die Gesamtsumme ist eine eigene Abfrage im Modus „Eine Zeile“.',
      },
      {
        id: 'totals-set-group',
        title: 'Gruppierung in der Vorlage (:set)',
        template: L(
          '{d.cars[]:set(c.g[id=.brand].rows[])}',
          '{c.g[i].id}',
          '- {c.g[i].rows[i].brand} {c.g[i].rows[i].qty}',
          '- {c.g[i].rows[i+1].qty}',
          '{c.g[i+1].id}',
        ),
        data: j({ cars: CARS }),
        result: L('Opel', '- Opel 3', '- Opel 2', 'Tesla', '- Tesla 1', 'BMW', '- BMW 5'),
        note: 'Die Gruppen folgen der Reihenfolge des ersten Auftretens; das `:set`-Tag gibt nichts aus. Speichern Sie das ganze Objekt (`d.cars[]:set(…rows[])`), nicht einzelne Felder. Die Zwischensumme der Gruppe ist `aggSum` über ihre Zeilen — siehe nächstes Beispiel.',
      },
      {
        id: 'totals-set-subtotal',
        title: 'Gruppenzwischensummen (:set)',
        template: L(
          '{d.cars[]:set(c.g[id=.brand].rows[])}',
          '{c.g[i].id}: {c.g[i].rows[].qty:aggSum} Stk.',
          '{c.g[i+1].id}',
          'Gesamt: {d.cars[].qty:aggSum} Stk.',
        ),
        data: j({ cars: CARS }),
        result: L('Opel: 5 Stk.', 'Tesla: 1 Stk.', 'BMW: 5 Stk.', 'Gesamt: 11 Stk.'),
        note: '`:set` sammelt die Zeilen nach Marke, und `{c.g[i].rows[].qty:aggSum}` ist die Zwischensumme innerhalb jeder Gruppe. `aggCount`, `aggAvg` und die anderen Aggregatoren funktionieren genauso, und die Zeilen der Gruppe lassen sich mit einer verschachtelten Schleife ausgeben, wie im Beispiel oben.',
      },
      {
        id: 'totals-set-sum',
        antiPattern: true,
        title: 'Summe über :set (falsch)',
        template: '{d.zero:set(c.total)}{d.cars[].qty:add(c.total):set(c.total)}Gesamt: {c.total}',
        data: j({ zero: 0, cars: CARS }),
        result: 'Gesamt: 14',
        note: 'Die richtige Summe ist 11: Das erste Element wird doppelt gezählt. Berechnen Sie Summen mit dem Aggregator `aggSum` (Abschnitt „Summen und Nummerierung“) oder in SQL.',
      },
    ],
  },
  {
    id: 'media',
    title: 'Bilder, Barcodes, Farben, Links',
    intro: [
      'Ein Bild oder ein Barcode aus den Daten ersetzt ein Platzhalterbild. Fügen Sie ein beliebiges Bild in passender Größe in die Vorlage ein und schreiben Sie das Tag in seinen Alternativtext: in Word — „Grafik formatieren“ → „Alternativtext“ (oder Rechtsklick → „Alternativtext bearbeiten“), in LibreOffice — „Eigenschaften“ → Tab „Optionen“ → „Textalternative“ oder „Beschreibung“, im Vorlageneditor — „Erweiterte Einstellungen des Bildes“ → „Alternativer Text“ → „Beschreibung“. Das Tag muss den gesamten Alternativtext einnehmen: gemischter Text („Foto {d.name}“) wird unverändert ausgegeben, und das Bild bleibt. Dasselbe Tag in einem gewöhnlichen Absatz gibt einfach den Wert aus.',
      'Ein Bild in den Daten ist ein Data-URI (`data:image/png;base64,…`; PNG, JPEG oder GIF) oder eine `https://…`-Adresse. Adressen werden nur von Hosts aus der Einstellung `IMAGE_URL_ALLOWLIST` geladen; sie ist standardmäßig leer, und eine Adresse ergibt einen Vorlagenfehler. SVG wird nicht unterstützt. Ein leerer Wert entfernt das Platzhalterbild. Grenzen: 10 MB pro Bild und 50 MB pro Bericht. Funktioniert in DOCX, XLSX, PPTX, ODT, ODS, ODP; mehrere Bilder in einer Schleife funktionieren in DOCX (Bild „Mit Text in Zeile“) und ODT (verankert „Als Zeichen“).',
      'Ein reiner Textwert (nicht `data:` und nicht `http(s)://`) wird im Alternativtext ausgegeben, und das Bild bleibt; ein leerer Wert entfernt das Bild. Ein ungültiges Bild (ein beschädigter Data-URI, ein Host nicht auf der Liste, ein falsches Tag) ist ein Vorlagenfehler mit dem Tag im Text, und der Bericht wird nicht erstellt. Konnte ein Bild unter einer Adresse nicht geladen werden (Zeitüberschreitung, Antwort nicht 2xx), wird es entfernt, und der Bericht wird erstellt.',
    ],
    examples: [
      {
        id: 'media-image',
        title: 'Bild aus den Daten',
        picture: true,
        template: '{d.photo}',
        data: j({ photo: PNG }),
        result:
          'Das Platzhalterbild wird durch das Bild ersetzt: die Breite wie beim Platzhalter, die Höhe nach den Proportionen des Bildes.',
        note: 'Das Tag steht im Alternativtext des Bildes, nicht in einem Absatz. Statt eines Data-URI können Sie eine `https://…`-Adresse übergeben, wenn ihr Host in `IMAGE_URL_ALLOWLIST` aufgeführt ist.',
      },
      {
        id: 'media-image-fit',
        title: 'Bild in den Rahmen einpassen (imageFit)',
        picture: true,
        template: '{d.logo:imageFit(contain)}',
        data: j({ logo: PNG }),
        result:
          'Das ganze Bild wird in den Rahmen des Platzhalters eingepasst, die Proportionen bleiben erhalten.',
        note: '`fillWidth` (Standard) — die Breite des Rahmens, die Höhe nach den Proportionen; `contain` — das ganze Bild einpassen; `fill` — auf den ganzen Rahmen strecken.',
      },
      {
        id: 'media-qrcode',
        title: 'QR-Code',
        picture: true,
        template: '{d.invoice:barcode(qrcode)}',
        data: j({ invoice: 'INV-2026-0042' }),
        result: 'Das Platzhalterbild wird durch einen QR-Code mit dem Wert INV-2026-0042 ersetzt.',
        note: 'Weitere Typen: `ean13`, `code128`, `datamatrix`, `pdf417` und die übrigen aus der Carbone-Dokumentation. Optionen werden durch Kommas getrennt: `{d.v:barcode(ean13, includetext:true, scale:2)}`; `width` und `height` in mm, `scale` von 1 bis 10 (standardmäßig 3), die Farben `barcolor`, `textcolor`, `backgroundcolor` als `#RRGGBB`, `eclevel:H` für QR. Ein Wert, der sich nicht kodieren lässt (Buchstaben in `ean13`), ist ein Vorlagenfehler. `barcode` in gewöhnlichem Text ist ein Vorlagenfehler, der besagt, dass ein Barcode in den Alternativtext eines Bildes gehört; Barcode-Schriftarten werden nicht unterstützt.',
      },
      {
        id: 'media-color-cell',
        title: 'Zellenfarbe aus den Daten (:color)',
        template: L(
          '| Aufgabe | Status |',
          '| {d.tasks[i].name} | {d.tasks[i].color:color(cell, background)}{d.tasks[i].status} |',
          '| {d.tasks[i+1].name} | |',
        ),
        data: j({
          tasks: [
            { name: 'Bericht', status: 'erledigt', color: '#C6EFCE' },
            { name: 'Abgleich', status: 'überfällig', color: 'FFC7CE' },
          ],
        }),
        result: L('| Aufgabe | Status |', '| Bericht | erledigt |', '| Abgleich | überfällig |'),
        note: 'Das Tag gibt nichts aus; es färbt das, worin es steht: `color(p)` — den Absatz (Standard), `cell` — die Zelle, `row` — die Tabellenzeile, `shape` — die Form (PPTX, ODP, ODT), `part` — ein Textstück (nur ODT). Das zweite Argument gibt an, was gefärbt wird: `text` (Standard), `background`, `highlight` (nicht in DOCX), `border` — die Kontur der Form (PPTX). In DOCX nur `text` und `background`, und `shape` wird nicht unterstützt; in PPTX wird `p` mit `background` nicht unterstützt. Die Farbe besteht aus 6 Hex-Ziffern mit oder ohne `#`; jeder andere Wert ergibt Grau `#888888`. In XLSX und ODS ist es ein Vorlagenfehler.',
      },
      {
        id: 'media-default-url',
        title: 'Ersatzlink (:defaultURL)',
        template: "{d.site:defaultURL('https://example.com')}",
        data: j({ site: 'not a url' }),
        result: 'https://example.com',
        note: "Meist wird das Tag als Adresse eines Hyperlinks verwendet: in Word — „Einfügen“ → „Link“, im Feld „Adresse“ — `{d.site:defaultURL('https://example.com')}`. Eine Linkadresse aus den Daten wird geprüft: Ohne Schema wird `https://` ergänzt; erlaubt sind `http`, `https`, `mailto`, `tel`. Eine ungültige Adresse — `javascript:`, `localhost`, eine IP-Adresse oder ein Name ohne Top-Level-Domain (`http://server:8080`) — wird durch den Wert von `:defaultURL` ersetzt (das kann ein Feld sein: `:defaultURL(.fallback)`), ohne `:defaultURL` durch `#`. Relative Adressen und Anker (`#abschnitt`, `../datei.pdf`) werden ebenfalls zu `#`. In einer Adresse mit statischem Teil (`https://site.de/?id={d.id}`) wird der Tag-Wert kodiert und die ganze Adresse geprüft; ein Tag ganz am Anfang der Adresse (`{d.base}/items/{d.id}`) wird unverändert eingefügt.",
      },
    ],
  },
  {
    id: 'charts',
    title: 'Diagramme in Word und Excel',
    intro: [
      'Diagramme in Word und Excel werden mit Berichtsdaten gefüllt. Erstellen Sie das Diagramm wie gewohnt und schreiben Sie die Tags als Schleifenzeilen in seine Daten, wie in einer Tabelle: eine Zeile mit `[i]` und darunter eine Zeile mit `[i+1]`. In Word stehen die Tags im Datenblatt des Diagramms: Rechtsklick auf das Diagramm → „Daten bearbeiten“. In Excel stehen sie in den Zellen des Blatts, auf die sich das Diagramm bezieht.',
      'Nach dem Erstellen des Berichts umfassen die Datenreihen des Diagramms alle Datenzeilen, und die im Diagramm gespeicherten Werte werden neu berechnet: Das Diagramm stimmt sowohl im PDF als auch beim Öffnen in Word oder Excel. In Word zeigt „Daten bearbeiten“ die Berichtsdaten. Zeilen unterhalb der Schleife verschieben sich zusammen mit den Bezügen auf sie. Ein leeres Array ergibt ein Diagramm ohne Punkte. Alle gängigen Typen funktionieren: Säulen und Balken, Linien, Flächen, Kreis und Ring, Punkt und Blase, Kombination, 2D und 3D.',
      'Zahlen: Eine Zelle einer Wertereihe wird zur Zahl, wenn der Wert wie eine Zahl aussieht. Leerzeichen und geschützte Leerzeichen werden entfernt, und ein Komma oder ein Punkt ist das Dezimaltrennzeichen: `1234,5`, `1 234,5`, `-3`, `1e3`. Jeder andere Wert (`10%`, `abc`, leer) bleibt Text, und für ihn gibt es keinen Punkt im Diagramm. Kategoriebeschriftungen ändern sich nicht. In Excel funktioniert `:formatN` wie gewohnt.',
      'Nicht unterstützt: die neuen Typen von Office 2016 (Treemap, Sunburst, Histogramm, Kastengrafik und weitere), Schleifen über Spalten und eine Anzahl von Reihen aus den Daten — die Reihen legt die Vorlage fest, mehrstufige Kategoriebeschriftungen, Excel-Tabellen („Als Tabelle formatieren“) und benannte Bereiche (sie werden nicht erweitert), mit einer externen Datei verknüpfte Diagramme, Diagramme in PPTX, ODT, ODS, ODP. ECharts-Diagramme (`:chart`) behandelt der Abschnitt „ECharts-Diagramme“.',
    ],
    examples: [
      {
        id: 'chart-word',
        title: 'Diagramm in Word',
        template: L(
          '| | Betrag |',
          '| {d.sales[i].month} | {d.sales[i].sum} |',
          '| {d.sales[i+1].month} | {d.sales[i+1].sum} |',
        ),
        data: j({
          sales: [
            { month: 'Jan', sum: 10 },
            { month: 'Feb', sum: 25 },
            { month: 'Mär', sum: 7 },
          ],
        }),
        result: L('| | Betrag |', '| Jan | 10 |', '| Feb | 25 |', '| Mär | 7 |'),
        note: 'Die Tabelle ist das Blatt „Daten bearbeiten“ eines Word-Diagramms, wie es nach dem Erstellen des Berichts aussieht. Das Diagramm zeigt die Reihe „Betrag“ mit drei Säulen: Jan, Feb, Mär. Die Zelle über den Beschriftungen kann leer bleiben; der Reihenname steht in der ersten Zeile.',
      },
      {
        id: 'chart-excel',
        title: 'Diagramm in Excel: zwei Reihen, Zahlen aus Text',
        template: L(
          '| Monat | Plan | Ist |',
          '| {d.sales[i].month} | {d.sales[i].plan} | {d.sales[i].fact} |',
          '| {d.sales[i+1].month} | {d.sales[i+1].plan} | {d.sales[i+1].fact} |',
        ),
        data: j({
          sales: [
            { month: 'Jan', plan: 100, fact: '98,5' },
            { month: 'Feb', plan: 120, fact: '1 250' },
            { month: 'Mär', plan: 150, fact: null },
          ],
        }),
        result: L(
          '| Monat | Plan | Ist |',
          '| Jan | 100 | 98,5 |',
          '| Feb | 120 | 1 250 |',
          '| Mär | 150 | |',
        ),
        note: 'Die Tabelle sind die Zellen des Excel-Blatts, auf die sich das Diagramm bezieht. Die Reihen „Plan“ und „Ist“ umfassen drei Zeilen. Der Text `98,5` und `1 250` aus den Daten wird zu den Zahlen 98,5 und 1250, und „Ist“ hat für März keinen Punkt. Ein Punkt gilt ebenfalls als Dezimaltrennzeichen: `1.250` wird zu 1,25, und `1.234,5` bleibt Text — übergeben Sie Zahlen ohne Tausenderpunkte.',
      },
    ],
  },
  {
    id: 'echarts',
    title: 'ECharts-Diagramme',
    intro: [
      'Ein ECharts-Diagramm wird anstelle eines Platzhalterbildes gezeichnet — in DOCX, XLSX, PPTX, ODT, ODS, ODP. Fügen Sie ein beliebiges Bild in passender Größe in das Dokument ein und schreiben Sie das Tag `{d.charts.sales:chart}` in seinen Alternativtext, genau wie bei Bildern: in Word — „Grafik formatieren“ → „Alternativtext“, in Excel — „Grafik formatieren“ → „Alternativtext“, in LibreOffice — „Eigenschaften“ → „Optionen“ → „Textalternative“ (in Calc und Impress — „Titel“). Ohne `width`/`height` in der Definition übernimmt das Diagramm die Größe des Bildes; mit ihnen behält das Bild die Breite des Platzhalters, und die Höhe folgt den Proportionen des Diagramms. `:imageFit(contain)` und `:imageFit(fill)` funktionieren wie bei Bildern.',
      'Am einfachsten geht es mit dem Diagramm-Editor: dem Tab „Diagramme“ des Vorlageneditors. Wählen Sie eine Abfrage im Modus „Liste von Zeilen“, die Beschriftungsspalte und die Spalten der Reihen (oder „Reihen aus Daten“ — die Spalte, nach der die Zeilen auf Reihen aufgeteilt werden), den Typ, den Titel, die Legende, die Farbpalette und das Zahlenformat; die Vorschau wird mit Testdaten erstellt. Die Diagrammdefinition gelangt unter dem Schlüssel `d.charts.<schlüssel>` in die Berichtsdaten; das Tag wird mit der Schaltfläche „Kopieren“ kopiert und ist auf dem Tab „Dokument“ sichtbar.',
      'Sie können eine fertige ECharts-5-Definition aus SQL übergeben: Der Tag-Wert ist `{ "type": "echarts@v5", "option": { … } }` oder die Definition selbst mit `series`; eine Zeichenkette mit JSON funktioniert ebenfalls. `width` und `height` (100–4000) legen die logische Größe der Zeichenfläche fest: ECharts-Schriftgrößen werden in diesen Pixeln gemessen, eine größere Fläche bedeutet also kleineren Text; ohne sie wird die Größe des Bildes verwendet. `theme` ist `"dark"` oder ein Theme-Objekt. Der Hintergrund ist standardmäßig weiß.',
      'Grenzen: Die Definition ist bis zu 1 MB groß, hat bis zu 20 Reihen und 10.000 Punkte und wird in höchstens 5 s gezeichnet; Funktionen in der Definition funktionieren nicht (nur JSON); die Schriftart ist immer Noto Sans, andere Schriftarten in der Definition werden durch sie ersetzt. Bilder in der Definition (`graphic`, `symbol: "image://…"`, Muster, `image`-Schlüssel) dürfen nur `data:image/png|jpeg|gif;base64,…` sein; eine Adresse, ein Dateipfad oder SVG ist ein Vorlagenfehler. In Diagrammen aus dem Diagramm-Editor werden Datumsbeschriftungen als TT.MM.JJJJ aus dem Datum in den Daten angezeigt, ohne Umrechnung der Zeitzone — um nach Tagen zu gruppieren, wandeln Sie die Zeit in SQL in ein Datum um (`created::date`). Ein leerer Wert entfernt das Platzhalterbild. Eine ungültige Definition ist ein Vorlagenfehler mit dem Tag; ein `:chart`-Tag in gewöhnlichem Text ist ein Vorlagenfehler, der besagt, dass ein Diagramm in den Alternativtext eines Bildes gehört.',
    ],
    examples: [
      {
        id: 'echarts-builder',
        title: 'Diagramm aus dem Diagramm-Editor',
        picture: true,
        template: '{d.charts.sales:chart}',
        data: j({
          charts: {
            sales: {
              type: 'echarts@v5',
              option: {
                xAxis: { type: 'category', data: ['Jan', 'Feb', 'Mär'] },
                yAxis: { type: 'value' },
                series: [{ type: 'bar', name: 'Betrag', data: [10, 25, 7] }],
              },
            },
          },
        }),
        result:
          'Das Platzhalterbild wird durch ein Säulendiagramm „Betrag“ für die Monate Jan, Feb, Mär ersetzt; die Größe ist die des Platzhalters.',
        note: 'So sehen die Daten aus, die der Diagramm-Editor (Tab „Diagramme“) vorbereitet: `d.charts.<schlüssel>` wird bei jeder Erstellung des Berichts und in der Vorschau aus den Zeilen der Abfrage gebildet.',
      },
      {
        id: 'echarts-sql',
        title: 'Fertige Definition aus SQL',
        picture: true,
        template: '{d.report.chart:chart}',
        data: j({
          report: {
            chart: {
              series: [
                {
                  type: 'pie',
                  radius: '70%',
                  data: [
                    { name: 'Nord', value: 120 },
                    { name: 'Süd', value: 80 },
                  ],
                },
              ],
            },
          },
        }),
        sql: {
          key: 'report',
          mode: 'single',
          text: L(
            'select json_build_object(',
            "  'series', json_build_array(json_build_object(",
            "    'type', 'pie',",
            "    'radius', '70%',",
            "    'data', (select json_agg(json_build_object('name', region, 'value', total)) from sales)",
            '  ))',
            ') as chart',
          ),
        },
        result: 'Das Platzhalterbild wird durch ein Kreisdiagramm ersetzt: Nord — 120, Süd — 80.',
        note: 'Eine Definition ohne `type` und `option`, aber mit `series` gilt als ECharts-Definition. In einer Abfrage im Modus „Eine Zeile“ wird die Spalte `chart` zu `d.report.chart`.',
      },
      {
        id: 'echarts-size',
        title: 'Größe der Zeichenfläche und dunkles Theme',
        picture: true,
        template: '{d.c:chart}',
        data: j({
          c: {
            width: 800,
            height: 400,
            theme: 'dark',
            option: {
              xAxis: { type: 'category', data: ['Mo', 'Di', 'Mi'] },
              yAxis: { type: 'value' },
              series: [{ type: 'line', smooth: true, data: [3, 7, 5] }],
            },
          },
        }),
        result:
          'Das Platzhalterbild wird durch ein Liniendiagramm auf dunklem Hintergrund ersetzt; die Breite ist die des Platzhalters, die Höhe folgt den Proportionen 800×400.',
        note: 'Ohne `width`/`height` entspricht die Zeichenfläche dem Platzhalterbild. Der Typ `echarts@v5a` wird ebenfalls mit ECharts 5 gezeichnet.',
      },
    ],
  },
  {
    id: 'html',
    title: 'HTML',
    intro: [
      '`{d.feld:html}` fügt formatiertes HTML aus den Daten ein: Absätze, Überschriften, Listen, Tabellen, Links, Bilder. Funktioniert in DOCX und ODT — im Text, in Tabellenzellen, Kopf- und Fußzeilen — und im daraus erstellten PDF. In einer HTML-Vorlage wird der Wert unverändert eingefügt. In XLSX, PPTX, ODS, ODP ist es ein Vorlagenfehler, der besagt, dass html in diesem Format nicht unterstützt wird.',
      'Das Tag steht im Absatztext: im Alternativtext, in einer Linkadresse oder im Berichtsnamen ist es ein Vorlagenfehler, der besagt, dass html in den Absatztext gehört. `:html` ist der letzte Formatierer im Tag: Danach folgen keine weiteren Formatierer. Ohne Optionen wird das HTML als eigene Absätze an der Stelle des Tags eingefügt; der Absatztext vor und nach dem Tag bleibt in eigenen Absätzen. Nach jedem Absatz, jeder Überschrift, jeder Liste und jeder Tabelle wird ein leerer Absatz eingefügt. Schriftart, Größe, Farbe und Ausrichtung kommen vom Tag: Formatieren Sie das Tag in der Vorlage, und das HTML erhält dieselbe Formatierung. Legt das HTML dieselbe Eigenschaft fest, hat das Tag Vorrang.',
      'Text-Tags: `b`/`strong`, `i`/`em`, `u`, `s`/`del`, `sup`, `sub`, `mark` (gelbe Hervorhebung), `code`/`kbd`/`samp` (Courier New). Blöcke: `p`, `br`, `pre`, `hr`, `blockquote`, Überschriften `h1`–`h6` (die Formatvorlagen „Überschrift 1“–„Überschrift 6“), Listen `ul`/`ol`/`li` mit Verschachtelung, Tabellen `table`/`tr`/`th`/`td` mit `colspan` und `rowspan`, Links `a href`, Bilder `img`, Kontrollkästchen `<input type="checkbox" checked>`. Von CSS nur das Attribut `style` mit den Eigenschaften `color`, `background-color`, `break-before: page` und `break-after: page`. Andere Tags, Klassen und Stile werden verworfen, der Text bleibt; `script` und `style` werden samt Inhalt entfernt.',
      'Optionen, durch Kommas getrennt: `inline` — innerhalb des aktuellen Absatzes; `nospace` — ohne leere Absätze; `headingtheme:<präfix>` — Überschrift-Formatvorlagen `<präfix>1`…`<präfix>6`; `tabletheme:<formatvorlage>` — Tabellenformatvorlage (nur DOCX); `quotetheme:<formatvorlage>` — Formatvorlage für Zitate. Zum Beispiel `{d.h:html(nospace, tabletheme:TableGrid)}`. Eine unbekannte Option ist ein Vorlagenfehler.',
      'Das Bild `img`: `src` ist ein Data-URI (PNG, JPEG, GIF) oder eine Adresse auf einem Host aus `IMAGE_URL_ALLOWLIST`, wie im Abschnitt „Bilder, Barcodes, Farben, Links“. Die Größe sind `width` und `height` in Pixeln; ohne sie ist die Breite 5 cm, die Proportionen bleiben erhalten. Ein ungültiges Bild oder ein Ladefehler überspringt das Bild mit einer Warnung im API-Protokoll, und der Bericht wird erstellt; ein Bild über 10 MB ist ein Vorlagenfehler.',
      'Ein leerer Wert fügt nichts ein. Ein Wert über 1 MB, eine Verschachtelung der Tags tiefer als 32 oder mehr als 4096 nicht geschlossene Tags ist ein Vorlagenfehler. Eine Tabelle hat höchstens 63 Spalten: Der Inhalt überzähliger Zellen landet in der letzten. Mit `inline` innerhalb eines Hyperlinks der Vorlage werden Links aus dem HTML zu reinem Text. In ODT sind Kontrollkästchen die Zeichen ☒ und ☐ (in DOCX sind es Word-Kontrollkästchen), `tabletheme` wirkt nicht, und eine Überschrift innerhalb eines Listenpunkts ist großer fetter Text des Punkts.',
    ],
    examples: [
      {
        id: 'html-text',
        title: 'Absätze und Textformatierung',
        rich: true,
        template: '{d.note:html}',
        data: j({
          note: '<p>Die Rechnung ist <b>bezahlt</b>.</p><p>Frist: <i>5 Tage</i>, <span style="color:#C00000">ohne Vorauszahlung</span>.</p>',
        }),
        result: L(
          'Zwei Absätze, nach jedem ein leerer:',
          'Die Rechnung ist bezahlt.',
          'Frist: 5 Tage, ohne Vorauszahlung.',
          '„bezahlt“ ist fett, „5 Tage“ kursiv, „ohne Vorauszahlung“ rot.',
        ),
        note: 'Das Tag steht in einem eigenen Absatz: Das gesamte HTML erhält seine Formatierung (Schriftart, Größe, Ausrichtung). Die Option `nospace` entfernt die leeren Absätze.',
      },
      {
        id: 'html-list',
        title: 'Listen',
        rich: true,
        template: '{d.steps:html(nospace)}',
        data: j({
          steps:
            '<ul><li>Lieferung</li><li>Montage<ul><li>Etage 1</li><li>Etage 2</li></ul></li></ul><ol><li>Abnahmeprotokoll unterschreiben</li><li>Bezahlen</li></ol>',
        }),
        result: L(
          '• Lieferung',
          '• Montage',
          '    ◦ Etage 1',
          '    ◦ Etage 2',
          '1. Abnahmeprotokoll unterschreiben',
          '2. Bezahlen',
        ),
        note: 'Aufzählungszeichen nach Ebene: •, ◦, ▪; Nummern: 1., a., i. Jede Liste wird neu nummeriert, auch in jeder Schleifenzeile. Der Punkt `<li><input type="checkbox" checked> erledigt</li>` wird als Kontrollkästchen ohne Aufzählungszeichen angezeigt.',
      },
      {
        id: 'html-table',
        title: 'Tabelle',
        rich: true,
        template: '{d.items:html}',
        data: j({
          items:
            '<table><tr><th>Artikel</th><th>Menge</th></tr><tr><td>Kabel</td><td>10</td></tr><tr><td colspan="2">Gesamt: 10</td></tr></table>',
        }),
        result: L('| Artikel | Menge |', '| Kabel | 10 |', '| Gesamt: 10 |'),
        note: 'Die Tabelle nimmt die volle Textbreite mit gleich breiten Spalten ein, `th` ist fett, und „Gesamt“ erstreckt sich über zwei Spalten. In DOCX — die Formatvorlage `tabletheme`, sonst die Standard-Tabellenformatvorlage des Dokuments (außer „Normale Tabelle“ ohne Rahmen), sonst „Tabellenraster“ (durchgehende Rahmen); in ODT — dünne Rahmen. Ein `caption` wird zu einem Absatz über der Tabelle.',
      },
      {
        id: 'html-link',
        title: 'Links und eine Ersatzadresse',
        rich: true,
        template: "{d.text:defaultURL('https://example.com'):html}",
        data: j({
          text: '<p>Der Vertrag steht <a href="site.de/doc">auf der Website</a>, die Anleitung <a href="javascript:alert(1)">hier</a>.</p>',
        }),
        result: L(
          'Der Vertrag steht auf der Website, die Anleitung hier.',
          '„auf der Website“ führt zu https://site.de/doc, „hier“ zu https://example.com.',
        ),
        note: 'Adressen werden genauso geprüft wie Links der Vorlage: Ohne Schema wird `https://` ergänzt; erlaubt sind `http`, `https`, `mailto`, `tel`. Eine ungültige Adresse (`javascript:`, `localhost`, ein Anker `#abschnitt`) wird durch den Wert von `:defaultURL` ersetzt, ohne `:defaultURL` durch `#`.',
      },
      {
        id: 'html-inline',
        title: 'Innerhalb eines Absatzes (inline)',
        rich: true,
        template: 'Status: {d.status:html(inline)}, siehe oben.',
        data: j({ status: '<b>bezahlt</b> <i>teilweise</i>' }),
        result: L(
          'Status: bezahlt teilweise, siehe oben.',
          'Ein Absatz; „bezahlt“ fett, „teilweise“ kursiv.',
        ),
        note: 'Im Modus `inline` funktionieren nur `a`, `b`, `strong`, `em`, `i`, `s`, `del`, `u`. Andere Tags werden verworfen, der Text bleibt; `br` und Absatzgrenzen werden zu Leerzeichen.',
      },
      {
        id: 'html-nospace',
        title: 'Überschriften ohne leere Absätze (nospace)',
        rich: true,
        template: '{d.terms:html(nospace)}',
        data: j({ terms: '<h2>Bedingungen</h2><p>Zahlung innerhalb von 5 Tagen.</p>' }),
        result: L(
          'Bedingungen — Formatvorlage „Überschrift 2“',
          'Zahlung innerhalb von 5 Tagen.',
          'Zwischen und nach ihnen gibt es keinen leeren Absatz.',
        ),
        note: 'Eine in der Vorlage fehlende Überschrift-Formatvorlage wird einfach angelegt: fett, 20/16/14/13/12/11 pt für `h1`–`h6`. Eigene Formatvorlagen verwenden Sie mit der Option `headingtheme:<präfix>`: `{d.terms:html(headingtheme:Report)}` nimmt die Formatvorlagen `Report1`…`Report6`.',
      },
    ],
  },
  {
    id: 'pdf',
    title: 'PDF: PDF/A, Wasserzeichen, Seitenzahlen, Anhänge, Passwort',
    intro: [
      'PDF-Einstellungen werden auf dem Tab „PDF“ des Vorlageneditors festgelegt und gelten für das PDF des Berichts: in der Vorschau, beim Erstellen und beim Herunterladen. „Speichern als“ DOCX/XLSX… liefert eine Datei ohne sie.',
      'PDF/A-2b ist ein Format für die Archivierung und den elektronischen Dokumentenaustausch. Ist PDF/A eingeschaltet, müssen angehängte Dateien ebenfalls PDF/A sein (das wird aus den Metadaten der Datei gelesen).',
      'Das Wasserzeichen und die Metadaten (Titel, Autor, Thema, Stichwörter) können Tags `{d.feld}` und `{d.liste[0].feld}` enthalten — ohne Formatierer und Schleifen. Ein leerer Tag-Wert im Wasserzeichen entfernt das Wasserzeichen: So erscheint „ENTWURF“ nur auf noch nicht freigegebenen Dokumenten. Zeichen, die in der PDF-Schriftart fehlen (zum Beispiel Emoji), werden in den Daten durch „?“ ersetzt.',
      'Die Seitennummerierung läuft durch das ganze Dokument einschließlich der angehängten Dateien: `{page}` ist die Seitenzahl, `{pages}` die Gesamtzahl der Seiten; die erste Seite kann ohne Nummer bleiben. Angehängte PDFs (bis zu 10 Dateien zu je 20 MB, insgesamt bis zu 500 Seiten) werden am Anfang oder am Ende des Berichts eingefügt; passwortgeschützte Dateien werden nicht angenommen.',
      'Schutz: ein Passwort zum Öffnen (eines pro Vorlage, 4–64 Zeichen, beginnt nicht mit „-“) und Einschränkungen für Drucken, Kopieren von Text und Bearbeiten. Einschränkungen ohne Passwort sperren das Dokument nicht — sie werden von PDF-Betrachtern umgesetzt. Der Schutz gilt für erstellte Berichte; die Vorschau wird ohne ihn angezeigt. PDF/A und Schutz sind nicht miteinander vereinbar. Das Passwort wird verschlüsselt gespeichert, im Dialog nicht angezeigt und beim Übertragen der Vorlage in eine andere Umgebung nicht übernommen — legen Sie es dort erneut fest.',
    ],
    examples: [
      {
        id: 'pdf-title',
        title: 'Dokumentnummer im PDF-Titel',
        template: 'Rechnung Nr. {d.number}',
        data: j({ number: '42', status: 'ENTWURF' }),
        result: 'Rechnung Nr. 42',
        note: 'Dasselbe Tag im Feld „Titel“ des Tabs „PDF“ ergibt den Dokumenttitel „Rechnung Nr. 42“, und `{d.status}` im Feld für das Wasserzeichen ergibt das Wasserzeichen „ENTWURF“. Formatierer (`{d.sum:formatC}`) werden in PDF-Feldern nicht unterstützt.',
      },
    ],
  },
  {
    id: 'signature',
    title: 'Elektronische Signatur',
    intro: [
      'Die PDF-Signatur ist PAdES mit dem Zertifikat des Benutzers aus einer `.p12`-Datei (`.pfx`). Nach dem russischen Bundesgesetz Nr. 63-FZ ist dies eine fortgeschrittene, nicht qualifizierte elektronische Signatur: Ihre Rechtswirkung innerhalb der Organisation und gegenüber Geschäftspartnern ergibt sich aus einer Vereinbarung der Parteien.',
      'Signaturverfahren: Auf dem Tab „PDF“ wählt das Feld „Signaturverfahren“ zwischen „.p12-Zertifikat (Signatur im PDF)“ und „GOST, CryptoPro (.sig-Datei)“. Bei GOST bleibt der Schlüssel auf dem Computer des Benutzers: Er benötigt CryptoPro CSP 5.0, CryptoPro CAdES Browser plug-in mit der Browsererweiterung und ein Zertifikat nach GOST R 34.10-2012 im Speicher „Persönlich“; das Ergebnis ist ein PDF mit Stempel und eine abgesetzte Signatur `.sig`. Der Administrator stellt das Skript `cadesplugin_api.js` bereit (wir liefern es nicht mit), Einzelheiten in `docs/operations/gost-signature.md`; ohne es meldet der Signaturdialog, dass das Plug-in nicht gefunden wurde. Der Server prüft die Signatur, aber nicht die Zertifikatskette oder den Widerruf — prüfen Sie diese auf dem russischen Portal für öffentliche Dienste Gosuslugi (gosuslugi.ru/pgu/eds).',
      'So schalten Sie sie ein: Tab „PDF“ des Vorlageneditors → „Elektronische Signatur“ → „Signieren des PDF erlauben“, dann die Position des Stempels (unten links, unten mittig, unten rechts). Das Signieren ist nicht mit dem Passwort und den Einschränkungen im Block „Schutz“ vereinbar; mit PDF/A ist es vereinbar. Die Einstellung gilt für neue Berichte; frühere Ausführungen ändern sich nicht.',
      'So signieren Sie: Der Benutzer lädt sein Zertifikat auf der Seite „Meine Signatur“ hoch, erstellt den Bericht und klickt auf „PDF signieren“ (oder „Signieren…“ im Verlauf). Das Passwort des Schlüssels wird bei jeder Signatur eingegeben und nirgends gespeichert; nach fünf falschen Passwörtern innerhalb von 15 Minuten wird das Signieren für den Rest dieses Zeitfensters gesperrt. Nur wer eine Ausführung erstellt hat, kann sie signieren; eine Ausführung lässt sich nicht zweimal signieren. Die signierte Datei: „Signiertes PDF herunterladen“ oder „Signiertes PDF“ im Verlauf.',
      'Der Stempel ist ein Rahmen von 250 × 80 pt unten auf der letzten Seite (links, mittig oder rechts) über dem Inhalt: Seriennummer, Inhaber, Gültigkeitszeitraum des Zertifikats, Zeitpunkt der Signatur. Der Seitenbereich darunter wird nicht freigeräumt — lassen Sie unten auf der letzten Seite 110 pt frei.',
      'Zeitstempel: Hat der Administrator einen Zeitstempeldienst eingerichtet (`SIGN_TSA_URL`), bestätigt dieser den Zeitpunkt der Signatur; ist der Dienst nicht erreichbar, wird der Bericht nicht signiert — Fehler „der Zeitstempeldienst ist nicht verfügbar“.',
      'Prüfung: Adobe Acrobat Reader zeigt die Signatur im Bereich „Unterschriften“. Sie ist „gültig“, wenn der Empfänger dem Zertifikat der Zertifizierungsstelle vertraut; bei selbstsignierten und internen Zertifikaten fügen Sie das Stammzertifikat zu den vertrauenswürdigen hinzu.',
    ],
    examples: [],
  },
  {
    id: 'unavailable',
    title: 'In der kostenlosen Version nicht verfügbar',
    intro: [
      'Diese Tags sind in der kostenlosen Version von Carbone deaktiviert. Steht ein solches Tag in der Vorlage, werden weder der Bericht noch die Vorschau erstellt, und es wird der Fehler aus dem Beispiel angezeigt.',
    ],
    examples: [
      {
        id: 'na-format-region',
        title: 'Namen von Regionen (formatR)',
        template: '{d.v:formatR()}',
        data: j({ v: 'DE' }),
        result: community('formatR'),
        unavailable: true,
        note: 'Holen Sie den Namen aus einer Nachschlagetabelle in SQL.',
      },
    ],
    limits: [
      {
        id: 'na-autoorient',
        title: 'autoOrient',
        instead:
          'Deaktiviert; eine Vorlage damit wird nicht erstellt. Ein Bild aus den Daten wird unverändert eingefügt — drehen Sie es, bevor Sie es an den Bericht übergeben.',
      },
      {
        id: 'na-bindcolor',
        title: 'bindColor',
        instead:
          'Das alte `bindColor` ergibt keinen Fehler, ändert die Farbe aber auch nicht. Verwenden Sie `:color` (Abschnitt „Bilder, Barcodes, Farben, Links“).',
      },
      {
        id: 'na-svg',
        title: 'SVG und Barcode-Schriftarten',
        instead:
          'Ein SVG-Bild aus den Daten ist ein Vorlagenfehler, der besagt, dass SVG nicht unterstützt wird: Übergeben Sie PNG, JPEG oder GIF. Barcode-Schriftarten werden nicht unterstützt — verwenden Sie `:barcode` in einem Platzhalterbild.',
      },
      {
        id: 'na-sort-desc',
        title: 'Absteigende Sortierung',
        instead:
          '`[-qty, i]` behält stillschweigend die ursprüngliche Reihenfolge bei: Carbone kann das noch nicht. Sortieren Sie in SQL: `order by qty desc`.',
      },
      {
        id: 'na-txt',
        title: 'Ausgabe als TXT',
        instead:
          'Kyrillischer Text wird zu „??????“. Unser System hat kein TXT-Format — verwenden Sie PDF oder DOCX.',
      },
    ],
  },
];
