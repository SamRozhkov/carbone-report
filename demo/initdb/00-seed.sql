CREATE TABLE company (
  id integer PRIMARY KEY,
  name text NOT NULL,
  inn text NOT NULL,
  address text NOT NULL
);

CREATE TABLE invoices (
  id integer PRIMARY KEY,
  company_id integer NOT NULL REFERENCES company (id),
  number text NOT NULL,
  issued_on date NOT NULL
);

CREATE TABLE invoice_items (
  id serial PRIMARY KEY,
  invoice_id integer NOT NULL REFERENCES invoices (id),
  name text NOT NULL,
  qty integer NOT NULL,
  price numeric(12, 2) NOT NULL
);

INSERT INTO company VALUES
  (1, 'ООО «Ромашка»', '7701234567', 'г. Москва, ул. Ленина, д. 1'),
  (2, 'АО «Лютик»', '7809876543', 'г. Санкт-Петербург, Невский пр., д. 10');

INSERT INTO invoices VALUES
  (1, 1, 'СЧ-001', '2026-09-30'),
  (2, 2, 'СЧ-002', '2026-10-01');

INSERT INTO invoice_items (invoice_id, name, qty, price) VALUES
  (1, 'Бумага А4', 10, 350.00),
  (1, 'Картридж', 2, 4500.00),
  (1, 'Ручки шариковые', 50, 25.50),
  (2, 'Стол офисный', 1, 12000.00),
  (2, 'Кресло', 2, 8900.00),
  (2, 'Лампа настольная', 3, 1500.00);
