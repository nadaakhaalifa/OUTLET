-- migration: 0050_addresses
-- phase: expand
--
-- Structured Egyptian address book, courier coverage reference data, immutable delivery snapshots
-- and gift hidden-address tokens (spec 7, docs/specs/addresses.md). Expand only: new tables.
--
--   * Coverage tables are public reference data (SELECT for app_user, writes by system only). They
--     are seeded from packages/domain/src/addresses/coverage-data.ts; a test asserts they match.
--   * saved_addresses: P3 fields (recipient, phone, street, building, floor, apartment, landmark,
--     map pin) are field-encrypted bytea (AAD = address:<id>:<field>). governorate/city are P2 plain
--     (needed for coverage). dedupe_blind / phone_blind are HMAC blind indexes. Exactly one default
--     per user (partial unique index). Deleting an address never touches delivery_snapshots.
--   * delivery_snapshots: immutable copy taken at checkout (UPDATE and DELETE revoked and blocked by
--     trigger). No FK to users or addresses so account deletion cannot rewrite delivery history;
--     erasure is crypto-shredding of the per-user data key after the legal retention period.
--   * gift_address_tokens: 128-bit token stored as SHA-256 hash. The buyer holds the token, never
--     the address; resolution is server-side and yields a courier-only snapshot.

CREATE TABLE couriers (
  code          text PRIMARY KEY CHECK (code ~ '^[a-z0-9-]{2,40}$'),
  cod_supported boolean NOT NULL,
  active        boolean NOT NULL DEFAULT true
);

CREATE TABLE coverage_governorates (
  code     text PRIMARY KEY CHECK (code ~ '^EG-[A-Z]{1,3}$'),
  name_ar  text NOT NULL CHECK (char_length(name_ar) BETWEEN 1 AND 80),
  name_en  text NOT NULL CHECK (char_length(name_en) BETWEEN 1 AND 80),
  position smallint NOT NULL
);

CREATE TABLE coverage_cities (
  governorate_code text NOT NULL REFERENCES coverage_governorates (code) ON DELETE CASCADE,
  code             text NOT NULL CHECK (code ~ '^[a-z0-9-]{2,60}$'),
  name_ar          text NOT NULL CHECK (char_length(name_ar) BETWEEN 1 AND 80),
  name_en          text NOT NULL CHECK (char_length(name_en) BETWEEN 1 AND 80),
  position         smallint NOT NULL,
  PRIMARY KEY (governorate_code, code)
);

CREATE TABLE courier_coverage (
  courier          text NOT NULL REFERENCES couriers (code) ON DELETE CASCADE,
  governorate_code text NOT NULL REFERENCES coverage_governorates (code) ON DELETE CASCADE,
  city_code        text,
  covered          boolean NOT NULL,
  FOREIGN KEY (governorate_code, city_code) REFERENCES coverage_cities (governorate_code, code) ON DELETE CASCADE
);
CREATE UNIQUE INDEX courier_coverage_uq ON courier_coverage (courier, governorate_code, COALESCE(city_code, ''));

GRANT SELECT ON couriers, coverage_governorates, coverage_cities, courier_coverage TO app_user;

CREATE TABLE saved_addresses (
  id                 uuid PRIMARY KEY,
  user_id            uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  label              text CHECK (label IS NULL OR char_length(label) BETWEEN 1 AND 40),
  recipient_name_enc bytea NOT NULL,
  phone_enc          bytea NOT NULL,
  phone_blind        bytea NOT NULL,
  governorate_code   text NOT NULL REFERENCES coverage_governorates (code),
  city_code          text NOT NULL,
  street_enc         bytea NOT NULL,
  building_enc       bytea NOT NULL,
  floor_enc          bytea,
  apartment_enc      bytea,
  landmark_enc       bytea,
  map_pin_enc        bytea,
  dedupe_blind       bytea NOT NULL,
  courier_coverage   text NOT NULL CHECK (courier_coverage IN ('covered', 'not_covered', 'unknown')),
  cod_eligible       boolean NOT NULL,
  quality_score      smallint NOT NULL CHECK (quality_score BETWEEN 0 AND 100),
  is_default         boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (governorate_code, city_code) REFERENCES coverage_cities (governorate_code, code)
);
CREATE INDEX saved_addresses_user_idx ON saved_addresses (user_id, created_at DESC, id DESC);
CREATE UNIQUE INDEX saved_addresses_one_default ON saved_addresses (user_id) WHERE is_default;
CREATE UNIQUE INDEX saved_addresses_dedupe ON saved_addresses (user_id, dedupe_blind);

ALTER TABLE saved_addresses ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON saved_addresses TO app_user;
CREATE POLICY saved_addresses_owner ON saved_addresses FOR ALL
  USING (user_id = app_user_id() OR app_role() = 'system')
  WITH CHECK (user_id = app_user_id() OR app_role() = 'system');

CREATE TABLE delivery_snapshots (
  id                 uuid PRIMARY KEY,
  user_id            uuid NOT NULL,
  order_ref          text NOT NULL CHECK (char_length(order_ref) BETWEEN 1 AND 80),
  source_address_id  uuid,
  gift               boolean NOT NULL DEFAULT false,
  recipient_name_enc bytea NOT NULL,
  phone_enc          bytea NOT NULL,
  governorate_code   text NOT NULL,
  city_code          text NOT NULL,
  street_enc         bytea NOT NULL,
  building_enc       bytea NOT NULL,
  floor_enc          bytea,
  apartment_enc      bytea,
  landmark_enc       bytea,
  map_pin_enc        bytea,
  courier_coverage   text NOT NULL CHECK (courier_coverage IN ('covered', 'not_covered', 'unknown')),
  cod_eligible       boolean NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, order_ref)
);

CREATE FUNCTION delivery_snapshots_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'delivery_snapshots rows are immutable' USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
CREATE TRIGGER delivery_snapshots_no_update BEFORE UPDATE OR DELETE ON delivery_snapshots
  FOR EACH ROW EXECUTE FUNCTION delivery_snapshots_immutable();

ALTER TABLE delivery_snapshots ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON delivery_snapshots TO app_user;
CREATE POLICY delivery_snapshots_select ON delivery_snapshots FOR SELECT
  USING (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY delivery_snapshots_insert ON delivery_snapshots FOR INSERT
  WITH CHECK (user_id = app_user_id() OR app_role() = 'system');

CREATE TABLE gift_address_tokens (
  token_hash    bytea PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  address_id    uuid NOT NULL REFERENCES saved_addresses (id) ON DELETE CASCADE,
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX gift_address_tokens_owner_idx ON gift_address_tokens (owner_user_id);

ALTER TABLE gift_address_tokens ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON gift_address_tokens TO app_user;
CREATE POLICY gift_address_tokens_owner ON gift_address_tokens FOR ALL
  USING (owner_user_id = app_user_id() OR app_role() = 'system')
  WITH CHECK (owner_user_id = app_user_id() OR app_role() = 'system');

-- Seed: generated from packages/domain/src/addresses/coverage-data.ts
INSERT INTO coverage_governorates (code, name_ar, name_en, position) VALUES
  ('EG-C', 'القاهرة', 'Cairo', 1),
  ('EG-GZ', 'الجيزة', 'Giza', 2),
  ('EG-ALX', 'الإسكندرية', 'Alexandria', 3),
  ('EG-QH', 'القليوبية', 'Qalyubia', 4),
  ('EG-SHR', 'الشرقية', 'Sharqia', 5),
  ('EG-DK', 'الدقهلية', 'Dakahlia', 6),
  ('EG-BH', 'البحيرة', 'Beheira', 7),
  ('EG-FYM', 'الفيوم', 'Faiyum', 8),
  ('EG-GH', 'الغربية', 'Gharbia', 9),
  ('EG-IS', 'الإسماعيلية', 'Ismailia', 10),
  ('EG-MNF', 'المنوفية', 'Monufia', 11),
  ('EG-MN', 'المنيا', 'Minya', 12),
  ('EG-WAD', 'الوادي الجديد', 'New Valley', 13),
  ('EG-SUZ', 'السويس', 'Suez', 14),
  ('EG-ASN', 'أسوان', 'Aswan', 15),
  ('EG-AST', 'أسيوط', 'Asyut', 16),
  ('EG-BNS', 'بني سويف', 'Beni Suef', 17),
  ('EG-PTS', 'بورسعيد', 'Port Said', 18),
  ('EG-DT', 'دمياط', 'Damietta', 19),
  ('EG-JS', 'جنوب سيناء', 'South Sinai', 20),
  ('EG-KFS', 'كفر الشيخ', 'Kafr El Sheikh', 21),
  ('EG-MT', 'مطروح', 'Matrouh', 22),
  ('EG-KN', 'قنا', 'Qena', 23),
  ('EG-SIN', 'شمال سيناء', 'North Sinai', 24),
  ('EG-SHG', 'سوهاج', 'Sohag', 25),
  ('EG-BA', 'البحر الأحمر', 'Red Sea', 26),
  ('EG-LX', 'الأقصر', 'Luxor', 27);

INSERT INTO coverage_cities (governorate_code, code, name_ar, name_en, position) VALUES
  ('EG-C', 'nasr-city', 'مدينة نصر', 'Nasr City', 1),
  ('EG-C', 'heliopolis', 'مصر الجديدة', 'Heliopolis', 2),
  ('EG-C', 'maadi', 'المعادي', 'Maadi', 3),
  ('EG-C', 'new-cairo', 'القاهرة الجديدة', 'New Cairo', 4),
  ('EG-C', 'shorouk', 'الشروق', 'El Shorouk', 5),
  ('EG-C', 'downtown', 'وسط البلد', 'Downtown', 6),
  ('EG-GZ', 'dokki', 'الدقي', 'Dokki', 1),
  ('EG-GZ', 'mohandessin', 'المهندسين', 'Mohandessin', 2),
  ('EG-GZ', 'haram', 'الهرم', 'Haram', 3),
  ('EG-GZ', 'sheikh-zayed', 'الشيخ زايد', 'Sheikh Zayed', 4),
  ('EG-GZ', '6th-october', 'السادس من أكتوبر', '6th of October', 5),
  ('EG-ALX', 'smouha', 'سموحة', 'Smouha', 1),
  ('EG-ALX', 'montaza', 'المنتزه', 'Montaza', 2),
  ('EG-ALX', 'agami', 'العجمي', 'Agami', 3),
  ('EG-ALX', 'borg-el-arab', 'برج العرب', 'Borg El Arab', 4),
  ('EG-QH', 'banha', 'بنها', 'Banha', 1),
  ('EG-QH', 'shubra-el-kheima', 'شبرا الخيمة', 'Shubra El Kheima', 2),
  ('EG-QH', 'qalyub', 'قليوب', 'Qalyub', 3),
  ('EG-QH', 'obour', 'العبور', 'El Obour', 4),
  ('EG-SHR', 'zagazig', 'الزقازيق', 'Zagazig', 1),
  ('EG-SHR', '10th-ramadan', 'العاشر من رمضان', '10th of Ramadan', 2),
  ('EG-SHR', 'belbeis', 'بلبيس', 'Belbeis', 3),
  ('EG-DK', 'mansoura', 'المنصورة', 'Mansoura', 1),
  ('EG-DK', 'mit-ghamr', 'ميت غمر', 'Mit Ghamr', 2),
  ('EG-DK', 'talkha', 'طلخا', 'Talkha', 3),
  ('EG-BH', 'damanhur', 'دمنهور', 'Damanhur', 1),
  ('EG-BH', 'kafr-el-dawwar', 'كفر الدوار', 'Kafr El Dawwar', 2),
  ('EG-BH', 'rashid', 'رشيد', 'Rashid', 3),
  ('EG-FYM', 'fayoum-city', 'مدينة الفيوم', 'Faiyum City', 1),
  ('EG-FYM', 'sinnuris', 'سنورس', 'Sinnuris', 2),
  ('EG-GH', 'tanta', 'طنطا', 'Tanta', 1),
  ('EG-GH', 'mahalla', 'المحلة الكبرى', 'El Mahalla El Kubra', 2),
  ('EG-GH', 'kafr-el-zayat', 'كفر الزيات', 'Kafr El Zayat', 3),
  ('EG-IS', 'ismailia-city', 'مدينة الإسماعيلية', 'Ismailia City', 1),
  ('EG-IS', 'fayed', 'فايد', 'Fayed', 2),
  ('EG-MNF', 'shebin-el-kom', 'شبين الكوم', 'Shebin El Kom', 1),
  ('EG-MNF', 'sadat-city', 'مدينة السادات', 'Sadat City', 2),
  ('EG-MNF', 'menouf', 'منوف', 'Menouf', 3),
  ('EG-MN', 'minya-city', 'مدينة المنيا', 'Minya City', 1),
  ('EG-MN', 'mallawi', 'ملوي', 'Mallawi', 2),
  ('EG-MN', 'samalut', 'سمالوط', 'Samalut', 3),
  ('EG-WAD', 'kharga', 'الخارجة', 'Kharga', 1),
  ('EG-WAD', 'dakhla', 'الداخلة', 'Dakhla', 2),
  ('EG-SUZ', 'suez-city', 'مدينة السويس', 'Suez City', 1),
  ('EG-SUZ', 'ain-sokhna', 'العين السخنة', 'Ain Sokhna', 2),
  ('EG-ASN', 'aswan-city', 'مدينة أسوان', 'Aswan City', 1),
  ('EG-ASN', 'edfu', 'إدفو', 'Edfu', 2),
  ('EG-ASN', 'kom-ombo', 'كوم أمبو', 'Kom Ombo', 3),
  ('EG-AST', 'asyut-city', 'مدينة أسيوط', 'Asyut City', 1),
  ('EG-AST', 'abnub', 'أبنوب', 'Abnub', 2),
  ('EG-AST', 'manfalut', 'منفلوط', 'Manfalut', 3),
  ('EG-BNS', 'beni-suef-city', 'مدينة بني سويف', 'Beni Suef City', 1),
  ('EG-BNS', 'wasta', 'الواسطى', 'El Wasta', 2),
  ('EG-PTS', 'port-said-city', 'مدينة بورسعيد', 'Port Said City', 1),
  ('EG-PTS', 'port-fouad', 'بورفؤاد', 'Port Fouad', 2),
  ('EG-DT', 'damietta-city', 'مدينة دمياط', 'Damietta City', 1),
  ('EG-DT', 'new-damietta', 'دمياط الجديدة', 'New Damietta', 2),
  ('EG-DT', 'ras-el-bar', 'رأس البر', 'Ras El Bar', 3),
  ('EG-JS', 'sharm-el-sheikh', 'شرم الشيخ', 'Sharm El Sheikh', 1),
  ('EG-JS', 'dahab', 'دهب', 'Dahab', 2),
  ('EG-JS', 'tor', 'الطور', 'El Tor', 3),
  ('EG-KFS', 'kafr-el-sheikh-city', 'مدينة كفر الشيخ', 'Kafr El Sheikh City', 1),
  ('EG-KFS', 'desouk', 'دسوق', 'Desouk', 2),
  ('EG-KFS', 'baltim', 'بلطيم', 'Baltim', 3),
  ('EG-MT', 'marsa-matrouh', 'مرسى مطروح', 'Marsa Matrouh', 1),
  ('EG-MT', 'el-alamein', 'العلمين', 'El Alamein', 2),
  ('EG-MT', 'siwa', 'سيوة', 'Siwa', 3),
  ('EG-KN', 'qena-city', 'مدينة قنا', 'Qena City', 1),
  ('EG-KN', 'nag-hammadi', 'نجع حمادي', 'Nag Hammadi', 2),
  ('EG-SIN', 'arish', 'العريش', 'El Arish', 1),
  ('EG-SIN', 'sheikh-zuweid', 'الشيخ زويد', 'Sheikh Zuweid', 2),
  ('EG-SHG', 'sohag-city', 'مدينة سوهاج', 'Sohag City', 1),
  ('EG-SHG', 'akhmim', 'أخميم', 'Akhmim', 2),
  ('EG-SHG', 'girga', 'جرجا', 'Girga', 3),
  ('EG-BA', 'hurghada', 'الغردقة', 'Hurghada', 1),
  ('EG-BA', 'el-gouna', 'الجونة', 'El Gouna', 2),
  ('EG-BA', 'marsa-alam', 'مرسى علم', 'Marsa Alam', 3),
  ('EG-BA', 'safaga', 'سفاجا', 'Safaga', 4),
  ('EG-LX', 'luxor-city', 'مدينة الأقصر', 'Luxor City', 1),
  ('EG-LX', 'esna', 'إسنا', 'Esna', 2);

INSERT INTO couriers (code, cod_supported) VALUES
  ('bosta', true),
  ('aramex', false);

INSERT INTO courier_coverage (courier, governorate_code, city_code, covered) VALUES
  ('bosta', 'EG-C', NULL, true),
  ('bosta', 'EG-GZ', NULL, true),
  ('bosta', 'EG-ALX', NULL, true),
  ('bosta', 'EG-QH', NULL, true),
  ('bosta', 'EG-SHR', NULL, true),
  ('bosta', 'EG-DK', NULL, true),
  ('bosta', 'EG-BH', NULL, true),
  ('bosta', 'EG-FYM', NULL, true),
  ('bosta', 'EG-GH', NULL, true),
  ('bosta', 'EG-IS', NULL, true),
  ('bosta', 'EG-MNF', NULL, true),
  ('bosta', 'EG-MN', NULL, true),
  ('bosta', 'EG-WAD', NULL, false),
  ('bosta', 'EG-SUZ', NULL, true),
  ('bosta', 'EG-ASN', NULL, true),
  ('bosta', 'EG-AST', NULL, true),
  ('bosta', 'EG-BNS', NULL, true),
  ('bosta', 'EG-PTS', NULL, true),
  ('bosta', 'EG-DT', NULL, true),
  ('bosta', 'EG-JS', NULL, true),
  ('bosta', 'EG-KFS', NULL, true),
  ('bosta', 'EG-MT', NULL, true),
  ('bosta', 'EG-KN', NULL, true),
  ('bosta', 'EG-SIN', NULL, false),
  ('bosta', 'EG-SHG', NULL, true),
  ('bosta', 'EG-BA', NULL, true),
  ('bosta', 'EG-LX', NULL, true),
  ('aramex', 'EG-C', NULL, true),
  ('aramex', 'EG-GZ', NULL, true),
  ('aramex', 'EG-ALX', NULL, true),
  ('aramex', 'EG-QH', NULL, true),
  ('aramex', 'EG-SHR', NULL, true),
  ('aramex', 'EG-DK', NULL, true),
  ('aramex', 'EG-BH', NULL, false),
  ('aramex', 'EG-FYM', NULL, false),
  ('aramex', 'EG-GH', NULL, true),
  ('aramex', 'EG-IS', NULL, true),
  ('aramex', 'EG-MNF', NULL, true),
  ('aramex', 'EG-MN', NULL, false),
  ('aramex', 'EG-WAD', NULL, false),
  ('aramex', 'EG-SUZ', NULL, false),
  ('aramex', 'EG-ASN', NULL, true),
  ('aramex', 'EG-AST', NULL, true),
  ('aramex', 'EG-BNS', NULL, false),
  ('aramex', 'EG-PTS', NULL, true),
  ('aramex', 'EG-DT', NULL, false),
  ('aramex', 'EG-JS', NULL, true),
  ('aramex', 'EG-KFS', NULL, false),
  ('aramex', 'EG-MT', NULL, false),
  ('aramex', 'EG-KN', NULL, false),
  ('aramex', 'EG-SIN', NULL, false),
  ('aramex', 'EG-SHG', NULL, false),
  ('aramex', 'EG-BA', NULL, true),
  ('aramex', 'EG-LX', NULL, true),
  ('bosta', 'EG-BA', 'marsa-alam', false),
  ('bosta', 'EG-MT', 'siwa', false),
  ('aramex', 'EG-JS', 'tor', false);
