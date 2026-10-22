import type { HelpSection } from './types';

const j = (v: unknown) => JSON.stringify(v, null, 2);
const L = (...lines: string[]) => lines.join('\n');
/** API message for a disabled formatter (apps/api/src/modules/carbone/community.ts, errors catalog); \u00a0 — non-breaking space, as in the catalog. */
const community = (name: string) =>
  `le modèle utilise ${name} — non disponible dans la version gratuite de Carbone, voir «\u00a0Aide sur les modèles\u00a0»`;

const CARS = [
  { brand: 'Renault', qty: 3, ok: true },
  { brand: 'Tesla', qty: 1, ok: false },
  { brand: 'Renault', qty: 2, ok: true },
  { brand: 'Peugeot', qty: 5, ok: true },
];
/** 1×1 PNG — a real image for the examples (`pnpm help:check` decodes it). */
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const GROUPS = [
  { name: 'G1', items: [{ x: 'a' }, { x: 'b' }] },
  { name: 'G2', items: [{ x: 'c' }] },
  { name: 'G3', items: [] },
];

export const HELP_INTRO: string[] = [
  'Cette page ne décrit que ce qui a été vérifié sur notre Carbone — la version gratuite (Community Edition). Tout ce qui lui manque est rassemblé dans la dernière section, avec des solutions de remplacement. Les messages d’erreur du moteur Carbone lui-même (images, codes-barres, couleurs, graphiques, HTML) s’affichent en russe après « erreur de modèle : » ; cette aide explique ce qu’ils signifient.',
  'Les données du rapport sont l’objet `d`. Le résultat de chaque requête SQL du modèle est placé sous sa clé : en mode « Liste de lignes », c’est un tableau, en mode « Une ligne », un objet (ou une valeur vide). Les paramètres du rapport se trouvent dans `d.params`.',
  'Les balises et les « Constructions » du panneau à droite de l’onglet « Document » peuvent être glissées avec la souris directement dans le document — la balise est insérée là où vous relâchez le bouton. Dans les « Constructions », remplacez `champ` et `tableau` par vos propres noms.',
  'Dans les exemples, une ligne qui commence par « | » est une ligne de tableau Word, dont les cellules sont séparées par « | ». Les autres lignes sont des paragraphes distincts.',
];

export const HELP_SECTIONS: HelpSection[] = [
  {
    id: 'basics',
    title: 'Notions de base',
    intro: [
      'La balise `{d.field}` insère une valeur des données. Un chemin avec des points mène aux objets imbriqués, `[nombre]` à un élément de tableau (en comptant à partir de zéro), `[champ=valeur]` à un élément selon une condition.',
    ],
    examples: [
      {
        id: 'basics-field',
        title: 'Valeur d’un champ',
        template: 'Client : {d.name}',
        data: j({ name: 'Jean' }),
        result: 'Client : Jean',
        note: 'Si le champ est absent des données, une chaîne vide est insérée ; il n’y a pas d’erreur.',
      },
      {
        id: 'basics-nested',
        title: 'Objet imbriqué',
        template: '{d.client.address.city}',
        data: j({ client: { address: { city: 'Lyon' } } }),
        result: 'Lyon',
      },
      {
        id: 'basics-search',
        title: 'Élément de tableau selon une condition',
        template: '{d.items[id=2].name}',
        data: j({
          items: [
            { id: 1, name: 'a' },
            { id: 2, name: 'b' },
          ],
        }),
        result: 'b',
        note: "Une valeur de type chaîne se met entre apostrophes : `{d.items[code='X'].name}`. Un élément par son numéro : `{d.items[0].name}` (en comptant à partir de zéro).",
      },
      {
        id: 'basics-params',
        title: 'Paramètre du rapport',
        template: "Période à partir du {d.params.from:formatD('DD/MM/YYYY')}",
        data: j({ params: { from: '2026-03-01' } }),
        result: 'Période à partir du 01/03/2026',
        note: "Les paramètres du rapport se trouvent dans `d.params` sous leur nom. Le système ne remplit pas lui-même les balises `{c.…}`, sauf `{c.now}` — le moment de la génération du rapport : `{c.now:formatD('DD/MM/YYYY')}`. Vous ne pouvez enregistrer vos propres valeurs dans `c` qu’avec `:set` (voir la section « Totaux et regroupement »).",
      },
      {
        id: 'basics-ifempty',
        title: 'Valeur par défaut',
        template: "Payé le : {d.paid_on:formatD('DD/MM/YYYY'):ifEmpty('—')}",
        data: j({ paid_on: null }),
        result: 'Payé le : —',
        note: "`ifEmpty` se place en dernier dans la chaîne : `{d.paid_on:ifEmpty('—'):formatD('DD/MM/YYYY')}` affiche « Invalid Date ». Est vide : null, une chaîne vide, un tableau vide et un champ absent ; 0 reste 0.",
      },
      {
        id: 'basics-alias',
        title: 'Alias',
        template: '{#cl = d.client}{$cl.name}',
        data: j({ client: { name: 'Pierre' } }),
        result: 'Pierre',
        note: 'Un alias se déclare avec la balise `{#nom = chemin}` ; cette balise n’affiche rien elle-même. Ensuite, écrivez `{$nom…}` à la place du chemin.',
      },
    ],
  },
  {
    id: 'tables',
    title: 'Tableaux',
    intro: [
      'Une ligne de tableau est répétée pour chaque élément du tableau de données : elle contient des balises avec `[i]`, et la ligne suivante contient au moins une balise avec `[i+1]`. La ligne `[i+1]` n’apparaît pas dans le résultat. Sans `[i+1]`, Carbone renvoie l’erreur « has no corresponding [i+1] ». Ne placez dans la ligne `[i+1]` que des balises `[i+1]` et laissez les autres cellules vides : une balise `[i]` à cet endroit provoque l’erreur « is in the [i+1] row ».',
      'Les paragraphes se répètent de la même manière : un paragraphe avec `[i]`, suivi d’un paragraphe avec `[i+1]`.',
    ],
    examples: [
      {
        id: 'tables-rows',
        title: 'Lignes de tableau à partir d’un tableau de données',
        template: L(
          '| Marque | Qté |',
          '| {d.cars[i].brand} | {d.cars[i].qty} |',
          '| {d.cars[i+1].brand} | |',
        ),
        data: j({ cars: CARS }),
        result: L(
          '| Marque | Qté |',
          '| Renault | 3 |',
          '| Tesla | 1 |',
          '| Renault | 2 |',
          '| Peugeot | 5 |',
        ),
      },
      {
        id: 'tables-nested',
        title: 'Boucle imbriquée',
        template: L(
          '{d.groups[i].name} :',
          '- {d.groups[i].items[i].x}',
          '- {d.groups[i].items[i+1].x}',
          '{d.groups[i+1].name}',
        ),
        data: j({ groups: GROUPS }),
        result: L('G1 :', '- a', '- b', 'G2 :', '- c', 'G3 :'),
        note: 'Un tableau imbriqué vide ne produit aucune ligne — « G3 » n’en a pas, et il n’y a pas d’erreur non plus.',
      },
      {
        id: 'tables-nested-rows',
        title: 'Boucle imbriquée dans les lignes d’un tableau',
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
        title: 'Tableau de données vide',
        template: L(
          'avant',
          '| Marque |',
          '| {d.cars[i].brand} |',
          '| {d.cars[i+1].brand} |',
          'après',
          "{d.cars:ifEM():show('Aucune donnée'):elseShow('')}",
        ),
        data: j({ cars: [] }),
        result: L('avant', '| Marque |', 'après', 'Aucune donnée'),
        note: "Les lignes de la boucle disparaissent et l’en-tête reste ; la clé peut même être totalement absente — le résultat est le même. Sans `elseShow('')`, `ifEM` affiche la valeur elle-même lorsque le tableau n’est pas vide.",
      },
      {
        id: 'tables-numbering',
        title: 'Numéro de ligne',
        template: L(
          '| N° | Marque |',
          '| {d.cars[i].brand:count()} | {d.cars[i].brand} |',
          '| {d.cars[i+1].brand} | |',
        ),
        data: j({ cars: CARS }),
        result: L(
          '| N° | Marque |',
          '| 1 | Renault |',
          '| 2 | Tesla |',
          '| 3 | Renault |',
          '| 4 | Peugeot |',
        ),
        note: 'Les numéros vont 1, 2, 3… sur les lignes affichées, y compris dans une boucle filtrée — sans trous. La balise `{d.cars[i].i}` n’affiche rien. L’ancienne méthode, `{d.cars[i].brand:print(.i):add(1)}`, fonctionne aussi, mais `.i` est la position dans le tableau source : avec un filtre de boucle, la numérotation a des trous. Un nombre entre parenthèses, comme dans l’ancienne version de Carbone (`count(0)`), est ignoré : la numérotation commence toujours à 1. Répétez le filtre et le tri de la boucle dans la balise `count()` elle-même (`{d.cars[i, ok=true].brand:count()}`), sinon la ligne numérote son propre ensemble. Les lignes supprimées par `drop(row)` reçoivent quand même un numéro, la numérotation aura donc des trous ; sélectionnez plutôt les lignes avec un filtre de boucle. Numérotation, totaux et sous-totaux : la section « Totaux et numérotation ».',
      },
      {
        id: 'tables-filter',
        title: 'Filtrer les lignes',
        template: L('| {d.cars[i, ok=true].brand} |', '| {d.cars[i+1, ok=true].brand} |'),
        data: j({ cars: CARS }),
        result: L('| Renault |', '| Renault |', '| Peugeot |'),
        note: "Les comparaisons `[i, qty > 1]`, les chaînes `[i, brand='Renault']` et plusieurs conditions séparées par des virgules fonctionnent de la même manière — elles sont combinées par ET ; il n’y a pas de OU, ajoutez donc un indicateur en SQL. Vous pouvez masquer une ligne de tableau de cette façon ou avec une balise `drop(row)` ; `hideBegin`/`hideEnd` dans un tableau laissent une ligne vide (la section « Conditions »).",
      },
      {
        id: 'tables-sort',
        title: 'Tri',
        template: L('{d.cars[qty, i].brand}', '{d.cars[qty+1, i+1].brand}'),
        data: j({ cars: CARS }),
        result: L('Tesla', 'Renault', 'Renault', 'Peugeot'),
        note: 'Uniquement par ordre croissant. `[-qty, i]` conserve silencieusement l’ordre d’origine — triez par ordre décroissant en SQL (`order by … desc`).',
      },
    ],
  },
  {
    id: 'formatting',
    title: 'Mise en forme',
    intro: [
      "Un formateur se place après un deux-points : `{d.field:formatD('DD/MM/YYYY')}`. Les formateurs peuvent être enchaînés et s’appliquent de gauche à droite.",
    ],
    examples: [
      {
        id: 'fmt-date-long',
        title: 'Date avec le nom du mois',
        template: "{d.date:formatD('D MMMM YYYY')}",
        data: j({ date: '2026-03-08' }),
        result: '8 mars 2026',
        note: "`formatD('dddd D MMMM YYYY')` donne « dimanche 8 mars 2026 », `formatD('MMMM YYYY')` donne « mars 2026 ».",
      },
      {
        id: 'fmt-date-short',
        title: 'Date en chiffres',
        template: "{d.date:formatD('DD/MM/YYYY')}",
        data: j({ date: '2026-03-08' }),
        result: '08/03/2026',
      },
      {
        id: 'fmt-date-time',
        title: 'Date et heure',
        template: "{d.at:formatD('DD/MM/YYYY HH:mm')}",
        data: j({ at: '2026-03-08T23:30:00+03:00' }),
        result: '08/03/2026 23:30',
        note: 'L’heure est affichée dans le fuseau horaire du serveur (`TZ`, Europe/Moscow par défaut). Transmettez les heures avec un décalage (`+03:00`) ou en UTC (`Z`).',
      },
      {
        id: 'fmt-date-naive',
        title: 'Heure sans décalage',
        template: "{d.at:formatD('DD/MM/YYYY HH:mm')}",
        data: j({ at: '2026-03-08 23:30:00' }),
        result: '09/03/2026 02:30',
        note: 'Une heure sans décalage est considérée comme UTC et décalée de 3 heures. Transmettez les heures avec un décalage, ou une date sans heure.',
      },
      {
        id: 'fmt-number',
        title: 'Nombre',
        template: '{d.n:formatN(2)}',
        data: j({ n: 1234567.891 }),
        result: '1 234 567,89',
        note: 'Le séparateur des milliers est une espace ordinaire : un nombre long peut être coupé en fin de ligne. `formatN(0)` arrondit à l’entier : 1234567.5 → « 1 234 568 ».',
      },
      {
        id: 'fmt-money',
        title: 'Montant en euros',
        template: '{d.sum:formatC()}',
        data: j({ sum: 1234567.891 }),
        result: '1 234 567,89 €',
        note: "`formatC()` affiche la devise de la langue du rapport — l’euro pour le français ; si la langue du rapport du modèle change, la devise change avec elle. `formatC(0)` supprime les centimes : 1234.5 → « 1 235 € ». `formatC('LL')` écrit le nom de la devise en toutes lettres : « 1 234 567,89 euros ». Ce nom est toujours en anglais : pour l’euro, il est proche du français (Carbone écrit « 1,50 euros », alors qu’en français on écrit « 1,50 euro »), mais pas pour d’autres devises (« pounds » pour la livre sterling) — pour celles-ci, n’utilisez pas `formatC('M')` ni `formatC('LL')`.",
      },
      {
        id: 'fmt-convcurr',
        title: 'Conversion dans une autre devise',
        template: "{d.sum:convCurr('USD')}",
        data: j({ sum: 1000 }),
        result: '1140.3000000000002',
        note: "Carbone convertit depuis la devise de la langue du rapport (l’euro pour le français) selon des taux intégrés : ils ne sont pas mis à jour, et notre système ne transmet pas ses propres taux. `formatC(2, 'USD')` convertit silencieusement de la même manière : 1000 → « 1 140,30 $ ». Calculez les montants dans d’autres devises en SQL.",
      },
      {
        id: 'fmt-case',
        title: 'Casse des lettres',
        template: '{d.name:ucWords()}',
        data: j({ name: 'jean dupont' }),
        result: 'Jean Dupont',
        note: 'Aussi `ucFirst()` → « Jean dupont », `upperCase()`, `lowerCase()`. Les lettres accentuées et celles d’autres alphabets, comme le cyrillique, sont traitées correctement.',
      },
      {
        id: 'fmt-ellipsis',
        title: 'Tronquer une chaîne',
        template: '{d.title:ellipsis(7)}',
        data: j({ title: 'Facture mensuelle' }),
        result: 'Facture...',
        note: "Aussi `substr(0, 5)` → « Factu », `padl(6, '0')` pour « 42 » → « 000042 », `prepend('N° ')`, `append(' EUR')`, `replace('-', '/')`.",
      },
      {
        id: 'fmt-math',
        title: 'Arithmétique',
        template: '{d.v:add(.b * 2 - 1)}',
        data: j({ v: 10, b: 3 }),
        result: '15',
        note: '`add`, `sub`, `mul`, `div` acceptent un nombre ou un champ voisin (`.b`) ; les expressions n’ont pas de parenthèses. Le résultat est affiché sans mise en forme — ajoutez `formatN` pour l’affichage. La division par zéro renvoie silencieusement le nombre d’origine.',
      },
      {
        id: 'fmt-array-join',
        title: 'Liste séparée par des virgules',
        template: '{d.tags:arrayJoin()}',
        data: j({ tags: ['a', 'b', 'c'] }),
        result: 'a, b, c',
        note: "Pour un tableau d’objets : `{d.items:arrayMap(', ', ':', 'name')}` — les valeurs du champ name séparées par des virgules.",
      },
      {
        id: 'fmt-multiline',
        title: 'Texte sur plusieurs lignes',
        template: '{d.text:convCRLF}',
        data: j({ text: 'ligne1\nligne2' }),
        result: L('ligne1', 'ligne2'),
        note: 'Sans `convCRLF`, un saut de ligne provenant des données n’est pas visible dans Word.',
      },
    ],
  },
  {
    id: 'conditions',
    title: 'Conditions',
    intro: [
      'Une condition vérifie une valeur (`ifEQ`, `ifNE`, `ifGT`, `ifGTE`, `ifLT`, `ifLTE`, `ifIN`, `ifNIN`, `ifEM`, `ifNEM`) et affiche `show(…)` ou `elseShow(…)`. Les conditions se combinent avec `and(.field)` et `or(.field)`.',
      'Les paragraphes et les parties de texte se masquent avec `showBegin`/`showEnd` et `hideBegin`/`hideEnd`. Une ligne de tableau se masque avec un filtre de boucle (la section « Tableaux ») ou `drop(row)` ; un paragraphe, un tableau ou une image entiers se suppriment avec `drop`/`keep`.',
    ],
    examples: [
      {
        id: 'cond-if',
        title: 'Texte selon une condition',
        template: "{d.status:ifEQ('paid'):show('Payée'):elseShow('Non payée')}",
        data: j({ status: 'new' }),
        result: 'Non payée',
        note: "Sans `elseShow`, une condition fausse affiche la valeur elle-même : `{d.v:ifEQ(1):show('un')}` donne « 2 » pour 2. Ajoutez `elseShow('')`.",
      },
      {
        id: 'cond-and',
        title: 'Deux conditions',
        template:
          "{d.qty:ifGT(0):and(.paid):ifEQ(true):show('prêt à expédier'):elseShow('en attente')}",
        data: j({ qty: 2, paid: true }),
        result: 'prêt à expédier',
        note: 'Vous pouvez utiliser `or` à la place de `and` : `…:or(.paid):ifEQ(true)…`.',
      },
      {
        id: 'cond-inline',
        title: 'Partie du texte selon une condition',
        template: 'Total{d.vat:ifEQ(true):showBegin}, TVA comprise{d.vat:showEnd}.',
        data: j({ vat: false }),
        result: 'Total.',
      },
      {
        id: 'cond-paragraphs',
        title: 'Masquer des paragraphes',
        template: L(
          'Facture',
          '{d.paid:ifEQ(true):hideBegin}',
          'Merci de régler sous 5 jours.',
          '{d.paid:hideEnd}',
          'Merci !',
        ),
        data: j({ paid: true }),
        result: L('Facture', 'Merci !'),
        note: 'Les paragraphes contenant les balises `hideBegin`/`hideEnd` disparaissent aussi.',
      },
      {
        id: 'cond-drop-p',
        title: 'Supprimer un paragraphe (drop)',
        template: L('avant', '{d.f:ifEQ(true):drop(p)}paragraphe à supprimer', 'après'),
        data: j({ f: true }),
        result: L('avant', 'après'),
        note: 'Placez la balise dans le paragraphe lui-même et en dernier dans la chaîne de formateurs. La condition est le résultat de `ifEQ`, `ifGT` et autres. Sans condition, c’est la valeur elle-même qui décide : `true`, un nombre non nul, un texte non vide autre que `"0"` et `"false"`, et une liste non vide suppriment le paragraphe ; `false`, `0`, un texte vide, `"0"`, `"false"`, et une valeur vide ou absente ne le suppriment pas — les indicateurs 0/1 de la base de données fonctionnent tels quels. Fonctionne en DOCX, ODT, PPTX, ODP ; XLSX et ODS n’ont pas de paragraphes.',
      },
      {
        id: 'cond-keep-p',
        title: 'Garder un paragraphe seulement si une condition est vraie (keep)',
        template: L('avant', '{d.f:ifEQ(true):keep(p)}paragraphe à garder', 'après'),
        data: j({ f: false }),
        result: L('avant', 'après'),
        note: '`keep` est l’inverse de `drop` : le paragraphe ne reste que si la condition est vraie. `drop(table)`, `drop(img)`, `drop(shape)`, `drop(chart)` fonctionnent de la même manière ; en ODS aussi `drop(sheet)`, en ODP `drop(slide)`.',
      },
      {
        id: 'cond-drop-row',
        title: 'Supprimer une ligne de tableau (drop(row))',
        template: L(
          '| Marque | Qté |',
          '| {d.cars[i].ok:ifEQ(false):drop(row)}{d.cars[i].brand} | {d.cars[i].qty} |',
          '| {d.cars[i+1].brand} | |',
        ),
        data: j({ cars: CARS }),
        result: L('| Marque | Qté |', '| Renault | 3 |', '| Renault | 2 |', '| Peugeot | 5 |'),
        note: 'La ligne « Tesla » est entièrement supprimée, et la mise en forme du tableau n’est pas cassée. Contrairement à `hideBegin`, `drop(row)` fonctionne dans une boucle. Si toutes les lignes d’un tableau sont supprimées, le tableau disparaît aussi. `drop(col)` supprime une colonne ; en XLSX, les cellules fusionnées et le filtre automatique ne sont pas recalculés, et sur une feuille avec un tableau mis en forme (« Mettre sous forme de tableau »), `drop(col)` n’est pas disponible. Un indicateur sans condition fonctionne aussi : `{d.cars[i].archived:drop(row)}` supprime les lignes où `archived` = 1 et garde celles à 0. Les cumuls, `:count()` et les totaux `aggSum` sur `[]` comptent aussi les lignes supprimées — pour exclure une ligne à la fois du tableau et du total, sélectionnez les lignes avec un filtre de boucle et le même filtre dans le total (`[ok=true]`).',
      },
      {
        id: 'cond-table-row',
        antiPattern: true,
        title: 'hideBegin dans une ligne de tableau (à ne pas faire)',
        template: L(
          '| Marque | Qté |',
          '| {d.cars[i].ok:ifEQ(false):hideBegin}{d.cars[i].brand} | {d.cars[i].qty}{d.cars[i].ok:hideEnd} |',
          '| {d.cars[i+1].brand} | |',
        ),
        data: j({ cars: CARS }),
        result: L(
          '| Marque | Qté |',
          '| Renault | 3 |',
          '| |',
          '| Renault | 2 |',
          '| Peugeot | 5 |',
        ),
        note: 'À la place de la ligne « Tesla », il reste une ligne vide d’une seule cellule, et la mise en forme du tableau est cassée. Masquez les lignes avec un filtre de boucle (`{d.cars[i, ok=true].brand}`) ou `drop(row)`.',
      },
    ],
  },
  {
    id: 'aggregates',
    title: 'Totaux et numérotation',
    intro: [
      'Les agrégateurs portent sur tout l’ensemble : `aggSum` — somme, `aggAvg` — moyenne, `aggMin`/`aggMax` — plus petite et plus grande valeur, `aggCount` — nombre d’éléments, `aggCountD` — nombre de valeurs distinctes, `aggStr`/`aggStrD` — valeurs séparées par des virgules (`D` — sans répétitions). Les versions `cum…` (`cumSum`, `cumCount`, `cumCountD`) donnent un cumul sur les lignes de la boucle, `:count()` donne le numéro de ligne.',
      'Les crochets du chemin choisissent le mode. `[]` est un total unique sur tout le tableau de données (n’importe où dans le document, y compris après le tableau), `[sort>1]` ou `[ok=true]` est un total sur les seuls éléments sélectionnés. `[i]` dans une boucle est une valeur pour chaque ligne ; c’est justement `[i]` qu’il faut pour les cumuls, `:count()` et le regroupement avec `aggSum(.brand)`.',
      'Le résultat est un nombre non arrondi : mettez-le en forme avec un formateur après l’agrégateur, par exemple `:aggAvg:formatN(2)`. Les valeurs non numériques (texte, vide, `null`) sont ignorées dans les sommes ; un nombre dans une chaîne (`"2"`) compte comme un nombre. Un tableau vide ou une clé absente ne provoque pas d’erreur : `aggSum`, `aggCount`, `aggCountD`, `cumSum` donnent 0 ; `aggAvg`, `aggMin`, `aggMax`, `aggStr`, `aggStrD` donnent une valeur vide.',
    ],
    examples: [
      {
        id: 'agg-sum',
        title: 'Total hors d’une boucle',
        template: 'Total : {d.cars[].qty:aggSum}',
        data: j({ cars: CARS }),
        result: 'Total : 11',
        note: 'Le total ne dépend ni de l’emplacement de la balise dans le document, ni du fait que le même tableau de données soit affiché par une boucle.',
      },
      {
        id: 'agg-filter',
        title: 'Total avec un filtre',
        template: 'Payé : {d.cars[ok=true].qty:aggSum}',
        data: j({ cars: CARS }),
        result: 'Payé : 10',
        note: "Les conditions entre crochets sont les mêmes que dans une boucle : `[qty>1]`, `[brand='Renault']`, plusieurs séparées par des virgules. Un filtre de boucle dans le document n’a pas d’effet sur le total, mais un filtre dans la balise elle-même, si.",
      },
      {
        id: 'agg-others',
        title: 'Moyenne, maximum, nombre',
        template: L(
          'Éléments : {d.cars[].qty:aggCount}, moyenne {d.cars[].qty:aggAvg:formatN(2)}',
          'Plus grand {d.cars[].qty:aggMax}, plus petit {d.cars[].qty:aggMin}',
          'Marques distinctes : {d.cars[].brand:aggCountD}',
        ),
        data: j({ cars: CARS }),
        result: L(
          'Éléments : 4, moyenne 2,75',
          'Plus grand 5, plus petit 1',
          'Marques distinctes : 3',
        ),
        note: '`aggCount` compte tous les éléments, et `aggCountD` les valeurs distinctes. Un formateur peut aussi se placer avant l’agrégateur : `{d.cars[].qty:mul(2):aggSum}` additionne les valeurs doublées.',
      },
      {
        id: 'agg-str',
        title: 'Valeurs sur une ligne',
        template: L(
          "Marques : {d.cars[].brand:aggStrD(', ')}",
          "Toutes : {d.cars[].brand:aggStr(' | ')}",
        ),
        data: j({ cars: CARS }),
        result: L(
          'Marques : Tesla, Renault, Peugeot',
          'Toutes : Renault | Tesla | Renault | Peugeot',
        ),
        note: 'Sans argument, le séparateur est une virgule suivie d’une espace. `aggStrD` ordonne les valeurs selon leur dernière occurrence.',
      },
      {
        id: 'agg-total-row',
        title: 'Ligne « Total » sous un tableau',
        template: L(
          '| Marque | Qté |',
          '| {d.cars[i].brand} | {d.cars[i].qty} |',
          '| {d.cars[i+1].brand} | |',
          '| Total | {d.cars[].qty:aggSum} |',
        ),
        data: j({ cars: CARS }),
        result: L(
          '| Marque | Qté |',
          '| Renault | 3 |',
          '| Tesla | 1 |',
          '| Renault | 2 |',
          '| Peugeot | 5 |',
          '| Total | 11 |',
        ),
        note: 'Faites de la ligne « Total » une ligne Word ordinaire sous la ligne `[i+1]`. Si vous écrivez `{d.cars[i].qty:aggSum}` dans la ligne de la boucle, chaque ligne affiche le même total général : `[i]` couvre tout l’ensemble, pas les lignes au-dessus.',
      },
      {
        id: 'agg-cum',
        title: 'Cumul',
        template: L(
          '| Marque | Qté | Cumul |',
          '| {d.cars[i].brand} | {d.cars[i].qty} | {d.cars[i].qty:cumSum} |',
          '| {d.cars[i+1].brand} | | |',
        ),
        data: j({ cars: CARS }),
        result: L(
          '| Marque | Qté | Cumul |',
          '| Renault | 3 | 3 |',
          '| Tesla | 1 | 4 |',
          '| Renault | 2 | 6 |',
          '| Peugeot | 5 | 11 |',
        ),
        note: 'Le cumul suit l’ordre et l’ensemble des lignes donnés par les crochets de la balise `cumSum` elle-même. Si la boucle est filtrée ou triée (`[i, ok=true]`, `[qty, i]`), répétez les mêmes conditions, tri compris, dans les crochets de la balise du cumul : le tri de la boucle ne s’y applique pas. Avec `[]` au lieu de `[i]`, c’est une erreur de modèle.',
      },
      {
        id: 'agg-partition',
        title: 'Total du groupe dans une ligne',
        template: L(
          '| Marque | Qté | Par marque | N° dans la marque |',
          '| {d.cars[i].brand} | {d.cars[i].qty} | {d.cars[i].qty:aggSum(.brand)} | {d.cars[i].qty:cumCount(.brand)} |',
          '| {d.cars[i+1].brand} | | | |',
        ),
        data: j({ cars: CARS }),
        result: L(
          '| Marque | Qté | Par marque | N° dans la marque |',
          '| Renault | 3 | 5 | 1 |',
          '| Tesla | 1 | 1 | 1 |',
          '| Renault | 2 | 5 | 2 |',
          '| Peugeot | 5 | 5 | 1 |',
        ),
        note: 'L’argument `(.brand)` est un chemin depuis l’élément de la boucle : l’agrégateur compte séparément pour chaque valeur. Cela ne fonctionne que dans une boucle `[i]` ; les valeurs sont comparées strictement : le nombre 1 et la chaîne "1" sont des groupes différents. L’argument doit être un chemin avec un point ; `aggSum(brand)` est une erreur.',
      },
      {
        id: 'agg-nested',
        title: 'Sous-total sur un tableau imbriqué',
        template: L(
          '{d.groups[i].name} : {d.groups[i].items[].qty:aggSum}',
          '- {d.groups[i].items[i].x} {d.groups[i].items[i].qty}',
          '- {d.groups[i].items[i+1].x}',
          '{d.groups[i+1].name}',
          'Total : {d.groups[].items[].qty:aggSum}',
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
        result: L('G1 : 5', '- a 2', '- b 3', 'G2 : 4', '- c 4', 'G3 : 0', 'Total : 9'),
        note: '`[i]` sur le tableau externe et `[]` sur le tableau imbriqué donnent un sous-total dans chaque groupe ; un groupe vide donne 0. Deux `[]` à la suite donnent le total général sur tous les groupes. On ne peut pas regrouper pour des sous-totaux avec une boucle externe sur un champ comme `[brand]` — regroupez avec `:set` et calculez `aggSum` par groupe (l’exemple « Sous-totaux par groupe (:set) » de la section « Totaux et regroupement ») ou en SQL. Si le chemin imbriqué passe par un objet (`{d.items[].sub.qty:aggSum}`), il y a une erreur avec `[]` : remontez le champ avec `print(.sub.qty)` ou utilisez `[i]`.',
      },
    ],
  },
  {
    id: 'totals',
    title: 'Totaux et regroupement',
    intro: [
      'Les totaux, sous-totaux et la numérotation peuvent aussi se faire dans le modèle — voir la section « Totaux et numérotation ». Les groupes avec sous-totaux se construisent aussi dans le modèle (`:set` + `aggSum`). SQL est nécessaire là où le modèle ne suffit pas : filtrage avec une condition OU et tri par ordre décroissant ; sur de très grands ensembles (des dizaines de milliers de lignes), les totaux avec un filtre entre crochets sont plus rapides à calculer en SQL.',
      'Les nombres de PostgreSQL (`numeric`, `bigint`) arrivent dans les données sous forme de nombres, `date` sous forme de chaîne YYYY-MM-DD, `json` sous forme d’objets et de tableaux.',
    ],
    examples: [
      {
        id: 'totals-sum',
        title: 'Total dans une requête distincte',
        sql: {
          key: 'totals',
          mode: 'single',
          text: L(
            'select count(*) as positions, sum(qty * price) as amount',
            'from invoice_items',
            'where invoice_id = :invoiceId',
          ),
        },
        template: 'Articles : {d.totals.positions}, montant total {d.totals.amount:formatC()}',
        data: j({ totals: { positions: 3, amount: 13775 } }),
        result: 'Articles : 3, montant total 13 775,00 €',
        note: 'Le nombre d’éléments d’un tableau de données peut aussi être obtenu dans le modèle : `{d.items:len()}`.',
      },
      {
        id: 'totals-rownum',
        title: 'Numéro de ligne depuis SQL',
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
          '| N° | Article | Qté |',
          '| {d.items[i].n} | {d.items[i].name} | {d.items[i].qty} |',
          '| {d.items[i+1].n} | | |',
        ),
        data: j({
          items: [
            { n: 1, name: 'Papier pour photocopieur', qty: 10 },
            { n: 2, name: 'Cartouche de toner', qty: 2 },
            { n: 3, name: 'Stylos à bille', qty: 50 },
          ],
        }),
        result: L(
          '| N° | Article | Qté |',
          '| 1 | Papier pour photocopieur | 10 |',
          '| 2 | Cartouche de toner | 2 |',
          '| 3 | Stylos à bille | 50 |',
        ),
        note: 'Sélectionnez les lignes dans `where` plutôt qu’avec un filtre du modèle — ainsi, la numérotation n’a pas de trous.',
      },
      {
        id: 'totals-groups',
        title: 'Groupes avec sous-totaux (json_agg)',
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
          '- {d.groups[i].items[i].name} : {d.groups[i].items[i].qty}',
          '- {d.groups[i].items[i+1].name}',
          '{d.groups[i+1].company}',
        ),
        data: j({
          groups: [
            {
              company: 'Dupont SARL',
              subtotal: 13775,
              items: [
                { name: 'Papier pour photocopieur', qty: 10 },
                { name: 'Cartouche de toner', qty: 2 },
                { name: 'Stylos à bille', qty: 50 },
              ],
            },
            {
              company: 'Exemple SA',
              subtotal: 34300,
              items: [
                { name: 'Bureau', qty: 1 },
                { name: 'Chaise', qty: 2 },
                { name: 'Lampe de bureau', qty: 3 },
              ],
            },
          ],
        }),
        result: L(
          'Dupont SARL — 13 775,00 €',
          '- Papier pour photocopieur : 10',
          '- Cartouche de toner : 2',
          '- Stylos à bille : 50',
          'Exemple SA — 34 300,00 €',
          '- Bureau : 1',
          '- Chaise : 2',
          '- Lampe de bureau : 3',
        ),
        note: 'Le sous-total du groupe est calculé par `sum(…)`, et le contenu du groupe est rassemblé par `json_agg`. Le total général est une requête distincte en mode « Une ligne ».',
      },
      {
        id: 'totals-set-group',
        title: 'Regroupement dans le modèle (:set)',
        template: L(
          '{d.cars[]:set(c.g[id=.brand].rows[])}',
          '{c.g[i].id}',
          '- {c.g[i].rows[i].brand} {c.g[i].rows[i].qty}',
          '- {c.g[i].rows[i+1].qty}',
          '{c.g[i+1].id}',
        ),
        data: j({ cars: CARS }),
        result: L(
          'Renault',
          '- Renault 3',
          '- Renault 2',
          'Tesla',
          '- Tesla 1',
          'Peugeot',
          '- Peugeot 5',
        ),
        note: 'Les groupes suivent l’ordre de première apparition ; la balise `:set` n’affiche rien. Enregistrez l’objet entier (`d.cars[]:set(…rows[])`), pas des champs isolés. Le sous-total du groupe est `aggSum` sur ses lignes — voir l’exemple suivant.',
      },
      {
        id: 'totals-set-subtotal',
        title: 'Sous-totaux par groupe (:set)',
        template: L(
          '{d.cars[]:set(c.g[id=.brand].rows[])}',
          '{c.g[i].id} — qté {c.g[i].rows[].qty:aggSum}',
          '{c.g[i+1].id}',
          'Quantité totale : {d.cars[].qty:aggSum}',
        ),
        data: j({ cars: CARS }),
        result: L('Renault — qté 5', 'Tesla — qté 1', 'Peugeot — qté 5', 'Quantité totale : 11'),
        note: '`:set` rassemble les lignes par marque, et `{c.g[i].rows[].qty:aggSum}` est le sous-total dans chaque groupe. `aggCount`, `aggAvg` et les autres agrégateurs fonctionnent de la même manière, et les lignes du groupe peuvent être affichées par une boucle imbriquée, comme dans l’exemple ci-dessus.',
      },
      {
        id: 'totals-set-sum',
        antiPattern: true,
        title: 'Somme via :set (incorrect)',
        template: '{d.zero:set(c.total)}{d.cars[].qty:add(c.total):set(c.total)}Total : {c.total}',
        data: j({ zero: 0, cars: CARS }),
        result: 'Total : 14',
        note: 'Le total correct est 11 : le premier élément est compté deux fois. Calculez les sommes avec l’agrégateur `aggSum` (la section « Totaux et numérotation ») ou en SQL.',
      },
    ],
  },
  {
    id: 'media',
    title: 'Images, codes-barres, couleurs, liens',
    intro: [
      'Une image ou un code-barres provenant des données remplace une image de substitution. Insérez dans le modèle n’importe quelle image de la bonne taille et écrivez la balise dans son texte de remplacement : dans Word — « Format de l’image » → « Texte de remplacement » (ou clic droit → « Modifier le texte de remplacement »), dans LibreOffice — « Propriétés » → onglet « Options » → le champ du texte alternatif ou « Description », dans l’éditeur de modèles — « Paramètres avancés de l’image » → « Texte de remplacement » → « Description ». La balise doit occuper tout le texte de remplacement : un texte mixte (« Photo {d.name} ») est affiché tel quel, et l’image reste. La même balise dans un paragraphe ordinaire affiche simplement la valeur.',
      'Une image dans les données est une data URI (`data:image/png;base64,…` ; PNG, JPEG ou GIF) ou une adresse `https://…`. Les adresses ne sont chargées que depuis les hôtes du paramètre `IMAGE_URL_ALLOWLIST` ; il est vide par défaut, et une adresse donne une erreur de modèle. SVG n’est pas pris en charge. Une valeur vide supprime l’image de substitution. Limites : 10 Mo par image et 50 Mo par rapport. Fonctionne en DOCX, XLSX, PPTX, ODT, ODS, ODP ; plusieurs images dans une boucle fonctionnent en DOCX (image « Aligné sur le texte ») et en ODT (ancrée « Comme caractère »).',
      'Une valeur en texte brut (ni `data:` ni `http(s)://`) est écrite dans le texte de remplacement, et l’image reste ; une valeur vide supprime l’image. Une image non valide (data URI endommagée, hôte absent de la liste, balise incorrecte) est une erreur de modèle avec la balise dans son texte, et le rapport n’est pas généré. Si une image à une adresse n’a pas pu être chargée (délai dépassé, réponse autre que 2xx), elle est supprimée et le rapport est généré.',
    ],
    examples: [
      {
        id: 'media-image',
        title: 'Image provenant des données',
        picture: true,
        template: '{d.photo}',
        data: j({ photo: PNG }),
        result:
          'L’image de substitution est remplacée par l’image : la largeur est celle de l’image de substitution, la hauteur suit les proportions de l’image.',
        note: 'La balise se place dans le texte de remplacement de l’image, pas dans un paragraphe. Au lieu d’une data URI, vous pouvez transmettre une adresse `https://…` si son hôte figure dans `IMAGE_URL_ALLOWLIST`.',
      },
      {
        id: 'media-image-fit',
        title: 'Ajuster une image au cadre (imageFit)',
        picture: true,
        template: '{d.logo:imageFit(contain)}',
        data: j({ logo: PNG }),
        result:
          'L’image entière tient dans le cadre de l’image de substitution, proportions conservées.',
        note: '`fillWidth` (par défaut) — la largeur du cadre, la hauteur selon les proportions ; `contain` — faire tenir toute l’image ; `fill` — l’étirer sur tout le cadre.',
      },
      {
        id: 'media-qrcode',
        title: 'Code QR',
        picture: true,
        template: '{d.invoice:barcode(qrcode)}',
        data: j({ invoice: 'FAC-2026-0042' }),
        result: 'L’image de substitution est remplacée par un code QR de valeur FAC-2026-0042.',
        note: 'Autres types : `ean13`, `code128`, `datamatrix`, `pdf417` et les autres de la documentation de Carbone. Les options sont séparées par des virgules : `{d.v:barcode(ean13, includetext:true, scale:2)}` ; `width` et `height` sont en mm, `scale` va de 1 à 10 (3 par défaut), les couleurs `barcolor`, `textcolor`, `backgroundcolor` sont au format `#RRGGBB`, `eclevel:H` est pour le QR. Une valeur impossible à encoder (des lettres dans `ean13`) est une erreur de modèle. `barcode` dans un texte ordinaire est une erreur de modèle indiquant qu’un code-barres se place dans le texte de remplacement d’une image ; les polices de codes-barres ne sont pas prises en charge.',
      },
      {
        id: 'media-color-cell',
        title: 'Couleur de cellule depuis les données (:color)',
        template: L(
          '| Tâche | Statut |',
          '| {d.tasks[i].name} | {d.tasks[i].color:color(cell, background)}{d.tasks[i].status} |',
          '| {d.tasks[i+1].name} | |',
        ),
        data: j({
          tasks: [
            { name: 'Rapport', status: 'terminé', color: '#C6EFCE' },
            { name: 'Rapprochement', status: 'en retard', color: 'FFC7CE' },
          ],
        }),
        result: L('| Tâche | Statut |', '| Rapport | terminé |', '| Rapprochement | en retard |'),
        note: 'La balise n’affiche rien ; elle colore ce dans quoi elle se trouve : `color(p)` — le paragraphe (par défaut), `cell` — la cellule, `row` — la ligne du tableau, `shape` — la forme (PPTX, ODP, ODT), `part` — un fragment de texte (ODT uniquement). Le second argument indique quoi colorer : `text` (par défaut), `background`, `highlight` (pas en DOCX), `border` — le contour de la forme (PPTX). En DOCX, seulement `text` et `background`, et `shape` n’est pas pris en charge ; en PPTX, `p` avec `background` n’est pas pris en charge. La couleur s’écrit avec 6 chiffres hexadécimaux, avec ou sans `#` ; toute autre valeur donne du gris `#888888`. En XLSX et ODS, c’est une erreur de modèle.',
      },
      {
        id: 'media-default-url',
        title: 'Lien de secours (:defaultURL)',
        template: "{d.site:defaultURL('https://example.com')}",
        data: j({ site: 'pas une adresse' }),
        result: 'https://example.com',
        note: "En général, la balise sert d’adresse de lien hypertexte : dans Word — « Insertion » → « Lien », et dans le champ « Adresse » — `{d.site:defaultURL('https://example.com')}`. Une adresse de lien provenant des données est vérifiée : `https://` est ajouté s’il n’y a pas de schéma ; `http`, `https`, `mailto`, `tel` sont autorisés. Une adresse non valide — `javascript:`, `localhost`, une adresse IP ou un nom sans domaine de premier niveau (`http://server:8080`) — est remplacée par la valeur de `:defaultURL` (cela peut être un champ : `:defaultURL(.fallback)`), ou par `#` s’il n’y en a pas. Les adresses relatives et les ancres (`#section`, `../file.pdf`) deviennent aussi `#`. Dans une adresse avec une partie fixe (`https://site.com/?id={d.id}`), la valeur de la balise est encodée et toute l’adresse est vérifiée ; une balise au tout début de l’adresse (`{d.base}/items/{d.id}`) est insérée telle quelle.",
      },
    ],
  },
  {
    id: 'charts',
    title: 'Graphiques Word et Excel',
    intro: [
      'Les graphiques Word et Excel sont remplis avec les données du rapport. Dessinez le graphique comme d’habitude et écrivez des balises dans ses données sous forme de lignes de boucle, comme dans un tableau : une ligne avec `[i]`, et en dessous une ligne avec `[i+1]`. Dans Word, les balises se placent dans la feuille de données du graphique : clic droit sur le graphique → « Modifier les données ». Dans Excel, elles se placent dans les cellules de la feuille auxquelles le graphique fait référence.',
      'Une fois le rapport construit, les séries du graphique couvrent toutes les lignes de données, et les valeurs enregistrées dans le graphique sont recalculées : le graphique est correct aussi bien en PDF qu’à l’ouverture dans Word ou Excel. Dans Word, « Modifier les données » affiche les données du rapport. Les lignes sous la boucle se décalent avec les références qui pointent vers elles. Un tableau de données vide donne un graphique sans points. Tous les types courants fonctionnent : histogrammes et barres, courbes, aires, secteurs et anneaux, nuages de points et bulles, graphiques combinés, 2D et 3D.',
      'Nombres : une cellule d’une série de valeurs devient un nombre si la valeur ressemble à un nombre. Les espaces et les espaces insécables sont supprimés, et une virgule ou un point sert de séparateur décimal : `1234,5`, `1 234,5`, `-3`, `1e3`. Toute autre valeur (`10%`, `abc`, vide) reste du texte, et elle n’a pas de point sur le graphique. Les étiquettes de catégories ne changent pas. Dans Excel, `:formatN` fonctionne comme d’habitude.',
      'Non pris en charge : les nouveaux types d’Office 2016 (Compartimentage, Rayons de soleil, histogramme de distribution, Zone et valeur, etc.), les boucles sur les colonnes et un nombre de séries tiré des données — c’est le modèle qui définit les séries, les étiquettes de catégories à plusieurs niveaux, les tableaux Excel (« Mettre sous forme de tableau ») et les plages nommées (elles ne s’étendent pas), les graphiques liés à un fichier externe, les graphiques en PPTX, ODT, ODS, ODP. Les graphiques ECharts (`:chart`) sont décrits dans la section « Graphiques ECharts ».',
    ],
    examples: [
      {
        id: 'chart-word',
        title: 'Graphique dans Word',
        template: L(
          '| | Montant |',
          '| {d.sales[i].month} | {d.sales[i].sum} |',
          '| {d.sales[i+1].month} | {d.sales[i+1].sum} |',
        ),
        data: j({
          sales: [
            { month: 'Janv', sum: 10 },
            { month: 'Févr', sum: 25 },
            { month: 'Mars', sum: 7 },
          ],
        }),
        result: L('| | Montant |', '| Janv | 10 |', '| Févr | 25 |', '| Mars | 7 |'),
        note: 'Le tableau est la feuille « Modifier les données » d’un graphique Word, telle qu’elle apparaît une fois le rapport construit. Le graphique affiche la série « Montant » avec trois colonnes : Janv, Févr, Mars. La cellule au-dessus des étiquettes peut rester vide ; le nom de la série est dans la première ligne.',
      },
      {
        id: 'chart-excel',
        title: 'Graphique dans Excel : deux séries, nombres à partir de texte',
        template: L(
          '| Mois | Prévu | Réel |',
          '| {d.sales[i].month} | {d.sales[i].plan} | {d.sales[i].fact} |',
          '| {d.sales[i+1].month} | {d.sales[i+1].plan} | {d.sales[i+1].fact} |',
        ),
        data: j({
          sales: [
            { month: 'Janv', plan: 100, fact: '98,5' },
            { month: 'Févr', plan: 120, fact: '1 250' },
            { month: 'Mars', plan: 150, fact: null },
          ],
        }),
        result: L(
          '| Mois | Prévu | Réel |',
          '| Janv | 100 | 98,5 |',
          '| Févr | 120 | 1 250 |',
          '| Mars | 150 | |',
        ),
        note: 'Le tableau représente les cellules de la feuille Excel auxquelles le graphique fait référence. Les séries « Prévu » et « Réel » couvrent trois lignes. Le texte `98,5` et `1 250` des données devient les nombres 98,5 et 1250, et « Réel » n’a pas de point pour mars.',
      },
    ],
  },
  {
    id: 'echarts',
    title: 'Graphiques ECharts',
    intro: [
      'Un graphique ECharts est dessiné à la place d’une image de substitution — en DOCX, XLSX, PPTX, ODT, ODS, ODP. Insérez dans le document n’importe quelle image de la bonne taille et écrivez la balise `{d.charts.sales:chart}` dans son texte de remplacement, comme pour les images : dans Word — « Format de l’image » → « Texte de remplacement », dans Excel — « Format de l’image » → « Texte de remplacement », dans LibreOffice — « Propriétés » → « Options » → le champ du texte alternatif (dans Calc et Impress — « Titre »). Sans `width`/`height` dans la définition, le graphique prend la taille de l’image ; avec eux, l’image garde la largeur de l’image de substitution, et la hauteur suit les proportions du graphique. `:imageFit(contain)` et `:imageFit(fill)` fonctionnent comme pour les images.',
      'Le plus simple est l’éditeur de graphiques : l’onglet « Graphiques » de l’éditeur de modèles. Choisissez une requête en mode « Liste de lignes », la colonne des étiquettes et les colonnes des séries (ou « Séries issues des données » — la colonne qui répartit les lignes en séries), le type, le titre, la légende, la palette et le format des nombres ; l’aperçu est construit sur des données de test. La définition du graphique est placée dans les données du rapport sous la clé `d.charts.<clé>` ; la balise se copie avec le bouton « Copier » et elle est visible dans l’onglet « Document ».',
      'Vous pouvez transmettre une définition ECharts 5 toute prête depuis SQL : la valeur de la balise est `{ "type": "echarts@v5", "option": { … } }` ou la définition elle-même avec `series` ; une chaîne contenant du JSON fonctionne aussi. `width` et `height` (100–4000) fixent la taille logique du canevas : les polices ECharts sont mesurées dans ces pixels, donc une taille plus grande donne un texte plus petit ; sans eux, la taille de l’image est utilisée. `theme` vaut `"dark"` ou un objet de thème. Le fond est blanc par défaut.',
      'Limites : la définition fait au plus 1 Mo, au plus 20 séries et 10 000 points, et est dessinée en 5 s au maximum ; les fonctions dans la définition ne fonctionnent pas (JSON uniquement) ; la police est toujours Noto Sans, et les autres polices de la définition sont remplacées par celle-ci. Les images dans la définition (`graphic`, `symbol: "image://…"`, motifs, clés `image`) ne peuvent être que `data:image/png|jpeg|gif;base64,…` ; une adresse, un chemin de fichier ou SVG est une erreur de modèle. Dans les graphiques de l’éditeur, les étiquettes de date sont affichées au format DD.MM.YYYY à partir de la date des données, sans conversion de fuseau horaire — pour regrouper par jour, convertissez l’heure en date en SQL (`created::date`). Une valeur vide supprime l’image de substitution. Une définition non valide est une erreur de modèle avec la balise ; une balise `:chart` dans un texte ordinaire est une erreur de modèle indiquant qu’un graphique se place dans le texte de remplacement d’une image.',
    ],
    examples: [
      {
        id: 'echarts-builder',
        title: 'Graphique de l’éditeur de graphiques',
        picture: true,
        template: '{d.charts.sales:chart}',
        data: j({
          charts: {
            sales: {
              type: 'echarts@v5',
              option: {
                xAxis: { type: 'category', data: ['Janv', 'Févr', 'Mars'] },
                yAxis: { type: 'value' },
                series: [{ type: 'bar', name: 'Montant', data: [10, 25, 7] }],
              },
            },
          },
        }),
        result:
          'L’image de substitution est remplacée par un histogramme « Montant » pour les mois Janv, Févr, Mars ; la taille est celle de l’image de substitution.',
        note: 'Voici à quoi ressemblent les données préparées par l’éditeur de graphiques (l’onglet « Graphiques ») : `d.charts.<clé>` est construit à partir des lignes de la requête à chaque génération du rapport et dans l’aperçu.',
      },
      {
        id: 'echarts-sql',
        title: 'Définition toute prête depuis SQL',
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
                    { name: 'Sud', value: 80 },
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
        result:
          'L’image de substitution est remplacée par un graphique en secteurs : Nord — 120, Sud — 80.',
        note: 'Une définition sans `type` ni `option` mais avec `series` est traitée comme une définition ECharts. Dans une requête en mode « Une ligne », la colonne `chart` devient `d.report.chart`.',
      },
      {
        id: 'echarts-size',
        title: 'Taille du canevas et thème sombre',
        picture: true,
        template: '{d.c:chart}',
        data: j({
          c: {
            width: 800,
            height: 400,
            theme: 'dark',
            option: {
              xAxis: { type: 'category', data: ['Lun', 'Mar', 'Mer'] },
              yAxis: { type: 'value' },
              series: [{ type: 'line', smooth: true, data: [3, 7, 5] }],
            },
          },
        }),
        result:
          'L’image de substitution est remplacée par un graphique en courbes sur fond sombre ; la largeur est celle de l’image de substitution, la hauteur suit les proportions 800×400.',
        note: 'Sans `width`/`height`, le canevas correspond à l’image de substitution. Le type `echarts@v5a` est aussi dessiné avec ECharts 5.',
      },
    ],
  },
  {
    id: 'html',
    title: 'HTML',
    intro: [
      '`{d.field:html}` insère du HTML mis en forme depuis les données : paragraphes, titres, listes, tableaux, liens, images. Fonctionne en DOCX et ODT — dans le texte, les cellules de tableau, les en-têtes et les pieds de page — et dans le PDF construit à partir de ceux-ci. Dans un modèle HTML, la valeur est insérée telle quelle. En XLSX, PPTX, ODS, ODP, c’est une erreur de modèle indiquant que html n’est pas pris en charge dans ce format.',
      'La balise se place dans le texte d’un paragraphe : dans un texte de remplacement, une adresse de lien ou le nom du rapport, c’est une erreur de modèle indiquant que html se place dans le texte d’un paragraphe. `:html` est le dernier formateur de la balise : aucun autre formateur ne vient après lui. Sans options, le HTML est inséré sous forme de paragraphes distincts à la place de la balise ; le texte du paragraphe avant et après la balise reste dans ses propres paragraphes. Un paragraphe vide est ajouté après chaque paragraphe, titre, liste et tableau. La police, la taille, la couleur et l’alignement viennent de la balise : mettez en forme la balise dans le modèle, et le HTML reçoit la même mise en forme. Si le HTML définit la même propriété, c’est la balise qui l’emporte.',
      'Balises de texte : `b`/`strong`, `i`/`em`, `u`, `s`/`del`, `sup`, `sub`, `mark` (surlignage jaune), `code`/`kbd`/`samp` (Courier New). Blocs : `p`, `br`, `pre`, `hr`, `blockquote`, titres `h1`–`h6` (les styles « Titre 1 »–« Titre 6 »), listes `ul`/`ol`/`li` avec imbrication, tableaux `table`/`tr`/`th`/`td` avec `colspan` et `rowspan`, liens `a href`, images `img`, cases à cocher `<input type="checkbox" checked>`. Du CSS, seul l’attribut `style` avec les propriétés `color`, `background-color`, `break-before: page` et `break-after: page`. Les autres balises, classes et styles sont supprimés, et le texte reste ; `script` et `style` sont supprimés avec leur contenu.',
      'Options, séparées par des virgules : `inline` — à l’intérieur du paragraphe courant ; `nospace` — sans paragraphes vides ; `headingtheme:<préfixe>` — styles de titre `<préfixe>1`…`<préfixe>6` ; `tabletheme:<style>` — style de tableau (DOCX uniquement) ; `quotetheme:<style>` — style de citation. Par exemple, `{d.h:html(nospace, tabletheme:TableGrid)}`. Une option inconnue est une erreur de modèle.',
      'L’image `img` : `src` est une data URI (PNG, JPEG, GIF) ou une adresse sur un hôte de `IMAGE_URL_ALLOWLIST`, comme dans la section « Images, codes-barres, couleurs, liens ». La taille est donnée par `width` et `height` en pixels ; sans eux, la largeur est de 5 cm, proportions conservées. Une image non valide ou un échec de chargement fait ignorer l’image avec un avertissement dans le journal de l’API, et le rapport est généré ; une image de plus de 10 Mo est une erreur de modèle.',
      'Une valeur vide n’insère rien. Une valeur de plus de 1 Mo, une imbrication de balises de plus de 32 niveaux ou plus de 4096 balises non fermées est une erreur de modèle. Un tableau a au plus 63 colonnes : le contenu des cellules en trop va dans la dernière. Avec `inline` à l’intérieur d’un lien hypertexte du modèle, les liens du HTML deviennent du texte simple. En ODT, les cases à cocher sont les caractères ☒ et ☐ (en DOCX, ce sont des cases à cocher Word), `tabletheme` n’a pas d’effet, et un titre dans un élément de liste devient un texte d’élément grand et gras.',
    ],
    examples: [
      {
        id: 'html-text',
        title: 'Paragraphes et mise en forme du texte',
        rich: true,
        template: '{d.note:html}',
        data: j({
          note: '<p>La facture est <b>payée</b>.</p><p>Délai : <i>5 jours</i>, <span style="color:#C00000">sans acompte</span>.</p>',
        }),
        result: L(
          'Deux paragraphes, chacun suivi d’un paragraphe vide :',
          'La facture est payée.',
          'Délai : 5 jours, sans acompte.',
          '« payée » est en gras, « 5 jours » en italique, « sans acompte » en rouge.',
        ),
        note: 'La balise se trouve dans un paragraphe à part : tout le HTML reçoit sa mise en forme (police, taille, alignement). L’option `nospace` supprime les paragraphes vides.',
      },
      {
        id: 'html-list',
        title: 'Listes',
        rich: true,
        template: '{d.steps:html(nospace)}',
        data: j({
          steps:
            '<ul><li>Livraison</li><li>Installation<ul><li>étage 1</li><li>étage 2</li></ul></li></ul><ol><li>Signer le procès-verbal de réception</li><li>Payer</li></ol>',
        }),
        result: L(
          '• Livraison',
          '• Installation',
          '    ◦ étage 1',
          '    ◦ étage 2',
          '1. Signer le procès-verbal de réception',
          '2. Payer',
        ),
        note: 'Puces par niveau : •, ◦, ▪ ; numéros : 1., a., i. Chaque liste est numérotée à nouveau, y compris dans chaque ligne de boucle. L’élément `<li><input type="checkbox" checked> fait</li>` s’affiche comme une case à cocher sans puce.',
      },
      {
        id: 'html-table',
        title: 'Tableau',
        rich: true,
        template: '{d.items:html}',
        data: j({
          items:
            '<table><tr><th>Produit</th><th>Qté</th></tr><tr><td>Câble</td><td>10</td></tr><tr><td colspan="2">Total : 10</td></tr></table>',
        }),
        result: L('| Produit | Qté |', '| Câble | 10 |', '| Total : 10 |'),
        note: 'Le tableau occupe toute la largeur du texte avec des colonnes égales, `th` en gras, et « Total » s’étend sur deux colonnes. En DOCX — le style `tabletheme`, sinon le style de tableau par défaut du document (sauf « Tableau normal » sans bordures), sinon « Grille du tableau » (bordures pleines) ; en ODT — des bordures fines. Un `caption` devient un paragraphe au-dessus du tableau.',
      },
      {
        id: 'html-link',
        title: 'Liens et adresse de secours',
        rich: true,
        template: "{d.text:defaultURL('https://example.com'):html}",
        data: j({
          text: '<p>Le contrat est <a href="site.com/doc">sur le site</a>, le guide est <a href="javascript:alert(1)">ici</a>.</p>',
        }),
        result: L(
          'Le contrat est sur le site, le guide est ici.',
          '« sur le site » mène à https://site.com/doc, « ici » à https://example.com.',
        ),
        note: 'Les adresses sont vérifiées de la même manière que les liens du modèle : `https://` est ajouté s’il n’y a pas de schéma ; `http`, `https`, `mailto`, `tel` sont autorisés. Une adresse non valide (`javascript:`, `localhost`, une ancre `#section`) est remplacée par la valeur de `:defaultURL`, ou par `#` s’il n’y en a pas.',
      },
      {
        id: 'html-inline',
        title: 'À l’intérieur d’un paragraphe (inline)',
        rich: true,
        template: 'Statut : {d.status:html(inline)}, voir ci-dessus.',
        data: j({ status: '<b>payée</b> <i>en partie</i>' }),
        result: L(
          'Statut : payée en partie, voir ci-dessus.',
          'Un seul paragraphe ; « payée » en gras, « en partie » en italique.',
        ),
        note: 'En mode `inline`, seuls `a`, `b`, `strong`, `em`, `i`, `s`, `del`, `u` fonctionnent. Les autres balises sont supprimées et le texte reste ; `br` et les limites de paragraphe deviennent des espaces.',
      },
      {
        id: 'html-nospace',
        title: 'Titres sans paragraphes vides (nospace)',
        rich: true,
        template: '{d.terms:html(nospace)}',
        data: j({ terms: '<h2>Conditions</h2><p>Paiement sous 5 jours.</p>' }),
        result: L(
          'Conditions — style « Titre 2 »',
          'Paiement sous 5 jours.',
          'Il n’y a pas de paragraphe vide entre eux ni après.',
        ),
        note: 'Un style de titre absent du modèle est créé sous une forme simple : gras, 20/16/14/13/12/11 pt pour `h1`–`h6`. Utilisez vos propres styles avec l’option `headingtheme:<préfixe>` : `{d.terms:html(headingtheme:Report)}` prend les styles `Report1`…`Report6`.',
      },
    ],
  },
  {
    id: 'pdf',
    title: 'PDF : PDF/A, filigrane, numéros de page, pièces jointes, mot de passe',
    intro: [
      'Les réglages PDF se définissent dans l’onglet « PDF » de l’éditeur de modèles et s’appliquent au PDF du rapport : dans l’aperçu, à la génération et au téléchargement. « Enregistrer sous » DOCX/XLSX… donne un fichier sans eux.',
      'PDF/A-2b est un format pour l’archivage et l’échange électronique de documents. Lorsque PDF/A est activé, les fichiers joints doivent aussi être au format PDF/A (cela se lit dans les métadonnées du fichier).',
      'Le filigrane et les métadonnées (titre, auteur, sujet, mots-clés) peuvent contenir des balises `{d.field}` et `{d.list[0].field}` — sans formateurs ni boucles. Une valeur de balise vide dans le filigrane supprime le filigrane : ainsi, « BROUILLON » n’apparaît que sur les documents pas encore approuvés. Les caractères absents de la police du PDF (par exemple, les emoji) dans les données sont remplacés par « ? ».',
      'La numérotation des pages couvre tout le document avec les fichiers joints : `{page}` est le numéro de page, `{pages}` le nombre total de pages ; la première page peut rester sans numéro. Les PDF joints (jusqu’à 10 fichiers de 20 Mo chacun, 500 pages au total) sont ajoutés au début ou à la fin du rapport ; les fichiers protégés par mot de passe ne sont pas acceptés.',
      'Protection : un mot de passe d’ouverture (un par modèle, 4 à 64 caractères, ne commençant pas par « - ») et des restrictions d’impression, de copie du texte et de modification. Des restrictions sans mot de passe ne verrouillent pas le document — ce sont les lecteurs PDF qui les appliquent. La protection s’applique aux rapports générés ; l’aperçu s’affiche sans elle. PDF/A et la protection sont incompatibles. Le mot de passe est stocké chiffré, n’est pas affiché dans la boîte de dialogue et n’est pas transféré lorsque le modèle est déplacé vers un autre environnement — définissez-le à nouveau là-bas.',
    ],
    examples: [
      {
        id: 'pdf-title',
        title: 'Numéro du document dans le titre du PDF',
        template: 'Facture N° {d.number}',
        data: j({ number: '42', status: 'BROUILLON' }),
        result: 'Facture N° 42',
        note: 'La même balise dans le champ « Titre » de l’onglet « PDF » donne le titre de document « Facture N° 42 », et `{d.status}` dans le champ du filigrane donne le filigrane « BROUILLON ». Les formateurs (`{d.sum:formatC}`) ne sont pas pris en charge dans les champs PDF.',
      },
    ],
  },
  {
    id: 'signature',
    title: 'Signature électronique',
    intro: [
      'La signature du PDF est au format PAdES avec le certificat de l’utilisateur issu d’un fichier `.p12` (`.pfx`). Selon la loi fédérale russe n° 63-FZ, il s’agit d’une signature électronique avancée non qualifiée : sa valeur juridique au sein de l’organisation et avec les partenaires découle d’un accord entre les parties.',
      'Méthode de signature : dans l’onglet « PDF », le champ « Méthode de signature » propose « Certificat .p12 (signature dans le PDF) » ou « GOST, CryptoPro (fichier .sig) ». Avec GOST, la clé reste sur l’ordinateur de l’utilisateur : il faut CryptoPro CSP 5.0, CryptoPro CAdES Browser plug-in avec l’extension pour le navigateur, et un certificat GOST R 34.10-2012 dans le magasin « Personnel » ; le résultat est un PDF avec un cachet et une signature `.sig` détachée. L’administrateur dépose le script `cadesplugin_api.js` (nous ne le fournissons pas), voir `docs/operations/gost-signature.md` pour les détails ; sans lui, la boîte de dialogue de signature indique que le plug-in est introuvable. Le serveur vérifie la signature, mais pas la chaîne de certificats ni la révocation — vérifiez-les sur le portail russe des services publics Gosuslugi (gosuslugi.ru/pgu/eds).',
      'Activation : l’onglet « PDF » de l’éditeur de modèles → « Signature électronique » → « Autoriser la signature du PDF », puis la position du cachet (en bas à gauche, en bas au centre, en bas à droite). La signature est incompatible avec le mot de passe et les restrictions du bloc « Protection » ; elle est compatible avec PDF/A. Le réglage s’applique aux nouveaux rapports ; les exécutions antérieures ne changent pas.',
      'Signer : l’utilisateur téléverse son certificat sur la page « Ma signature », génère le rapport et clique sur « Signer le PDF » (ou « Signer… » dans l’historique). Le mot de passe de la clé est saisi à chaque signature et n’est jamais conservé ; après cinq mots de passe erronés en 15 minutes, la signature est bloquée jusqu’à la fin de cette période. Seul l’utilisateur qui a généré une exécution peut la signer ; une exécution ne peut pas être signée deux fois. Le fichier signé : « Télécharger le PDF signé », ou « PDF signé » dans l’historique.',
      'Le cachet est un cadre de 250 × 80 pt en bas de la dernière page (à gauche, au centre ou à droite), par-dessus le contenu : numéro de série, propriétaire, période de validité du certificat, heure de signature. La zone de la page en dessous n’est pas effacée — laissez 110 pt libres en bas de la dernière page.',
      'Horodatage : si l’administrateur a configuré un service d’horodatage (`SIGN_TSA_URL`), celui-ci confirme l’heure de signature ; si le service est indisponible, le rapport n’est pas signé — l’erreur « le service d’horodatage est indisponible ».',
      'Vérification : Adobe Acrobat Reader affiche la signature dans le panneau « Signatures ». Elle est « valide » si le destinataire fait confiance au certificat de l’autorité de certification ; pour les certificats auto-signés et internes, ajoutez le certificat racine aux certificats de confiance.',
    ],
    examples: [],
  },
  {
    id: 'unavailable',
    title: 'Non disponible dans la version gratuite',
    intro: [
      'Ces balises sont désactivées dans la version gratuite de Carbone. Si une telle balise figure dans le modèle, le rapport et l’aperçu ne sont pas générés, et l’erreur de l’exemple s’affiche.',
    ],
    examples: [
      {
        id: 'na-format-region',
        title: 'Noms de régions (formatR)',
        template: '{d.v:formatR()}',
        data: j({ v: 'FR' }),
        result: community('formatR'),
        unavailable: true,
        note: 'Prenez le nom dans une table de référence en SQL.',
      },
    ],
    limits: [
      {
        id: 'na-autoorient',
        title: 'autoOrient',
        instead:
          'Désactivé ; un modèle qui l’utilise n’est pas généré. Une image provenant des données est insérée telle quelle — faites-la pivoter avant de la transmettre au rapport.',
      },
      {
        id: 'na-bindcolor',
        title: 'bindColor',
        instead:
          'L’ancien `bindColor` ne provoque pas d’erreur, mais ne change pas non plus la couleur. Utilisez `:color` (la section « Images, codes-barres, couleurs, liens »).',
      },
      {
        id: 'na-svg',
        title: 'SVG et polices de codes-barres',
        instead:
          'Une image SVG provenant des données est une erreur de modèle indiquant que SVG n’est pas pris en charge : transmettez du PNG, JPEG ou GIF. Les polices de codes-barres ne sont pas prises en charge — utilisez `:barcode` dans une image de substitution.',
      },
      {
        id: 'na-sort-desc',
        title: 'Tri décroissant',
        instead:
          '`[-qty, i]` conserve silencieusement l’ordre d’origine : Carbone ne sait pas encore le faire. Triez en SQL : `order by qty desc`.',
      },
      {
        id: 'na-txt',
        title: 'Sortie TXT',
        instead:
          'Le texte cyrillique devient « ?????? ». Notre système n’a pas de format TXT — utilisez PDF ou DOCX.',
      },
    ],
  },
];
