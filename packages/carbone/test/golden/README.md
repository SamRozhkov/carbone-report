# Эталоны Carbone EE 5.15.3

Записанное поведение `carbone/carbone-ee:full-5.15.3-fonts` без лицензии (режим Community). Код образа не используется: эталоны фиксируют только наблюдаемый результат.

- `help.json` — примеры «Справки по шаблонам» (`apps/web/src/pages/admin/help/content.ts`), id `help/<id примера>`.
- `matrix.json` — пробы матрицы Community (`docs/superpowers/notes/2026-10-13-carbone-community-matrix.md`), id `matrix/…`.
- `known-gaps.json` — случаи, где сборка пока расходится с EE.

## Формат случая

```jsonc
{
  "id": "matrix/s1/table-i-i-1", // уникальный
  "probe": "tests.py :: …", // происхождение (необязательно)
  "template": "строки в нотации справки", // '| a | b |' — строка таблицы, иначе абзац
  "raw": ["<w:p>…</w:p>"], // необязательно: заменяет строки '<<RAW>>' по порядку
  "rels": "<Relationship …/>", // необязательно
  "data": {},
  "options": { "lang": "ru", "timezone": "Europe/Moscow" },
  "expect": { "text": "…" }, // или { "error": "…" }
  "skip": "причина", // не рендерится (pdf/txt/картинки)
  "volatile": "причина", // проверяется только отсутствие ошибки
  "deviation": { "ours": "…", "why": "…" } // осознанное отличие от EE; ours — текст сборки или { "error": "…" }
}
```

Сравнение: текст — `docxText(word/document.xml)`; ошибка — сообщение без `Unable to generate the document. Error: ` и ` Source: …`.

## Правила

- `known-gaps.json` только сокращается. Тест требует, чтобы случаи из списка НЕ совпадали с эталоном; когда случай начинает совпадать, тест просит убрать его id. К концу плана список пуст.
- Осознанное отличие от EE оформляется полем `deviation` с объяснением `why`; для `help/*` такое допустимо только если оно записано в спецификации.
- Новые пробы добавляются через `scripts/carbone-parity.ts` (разработческий скрипт, поднимает образ EE на 3,7 ГБ; в CI не используется):
  `pnpm exec tsx scripts/carbone-parity.ts <файл.json>`.
