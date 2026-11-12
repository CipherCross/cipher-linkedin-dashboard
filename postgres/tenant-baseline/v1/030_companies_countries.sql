-- Step 030: companies from Airtable, the lead <-> company link, and countries.
--
-- The team could not answer "which countries and which companies are we
-- writing to, and how do they respond" (spec specs/2026-11-12-companies-and-countries.md):
--
-- * countries / country_aliases: ISO 3166 reference data and the lower-case
--   spellings LinkedIn and Airtable use for them (country names, US states,
--   Canadian provinces, UK nations, "Bay Area", major metros, UAE/KSA ...).
--   geo_country_code(text) resolves a free-text location to an ISO code: the
--   whole string, then each comma segment right to left, each also with
--   "Greater ..." / "... Area" / "... Metropolitan Area" / "... Region"
--   stripped. NULL when nothing matches; a later step adds aliases.
--   linkedin_slug(text) is the profile-URL normalization the lead <-> contact
--   match uses on both sides.
-- * leads.location (LH2's location, delivered by the agent for every lead)
--   and leads.country_code, kept in step with location by a trigger.
-- * airtable_companies / airtable_contacts: a mirror of the Airtable Companies
--   and Contacts tables of every base, typed columns for what the dashboard
--   filters on plus `fields`, every Airtable field by name. Written by the
--   server's Airtable sync: a member's "Sync from Airtable" (app_runtime) or
--   the daily cron (app_system under the system actor).
-- * lead_company_links: which Airtable company a lead (instance, profile) is
--   written to for. 'contact_slug' links are derived from the Contacts table
--   by LinkedIn slug and refreshed by the sync; 'manual' links are set by a
--   member and never overwritten by the sync. A member may delete only a
--   manual link (to hand the lead back to the slug match).
-- * airtable_sync_state: the incremental cursor and the resumable page offset
--   per (base, table).
--
-- No funnel semantics change. No DELETE anywhere else; the AI sandbox reads
-- every new relation.

SET ROLE app_owner;

CREATE TABLE public.countries (
    iso2 character(2) NOT NULL,
    name text NOT NULL,
    region text NOT NULL,
    CONSTRAINT countries_pkey PRIMARY KEY (iso2),
    CONSTRAINT countries_iso2_check CHECK (iso2 ~ '^[A-Z]{2}$'),
    CONSTRAINT countries_lengths CHECK (char_length(name) <= 100 AND char_length(region) <= 50)
);

CREATE TABLE public.country_aliases (
    alias text NOT NULL,
    iso2 character(2) NOT NULL,
    CONSTRAINT country_aliases_pkey PRIMARY KEY (alias),
    CONSTRAINT country_aliases_iso2_fkey FOREIGN KEY (iso2) REFERENCES public.countries(iso2),
    CONSTRAINT country_aliases_alias_check CHECK (alias = lower(btrim(alias)) AND char_length(alias) BETWEEN 1 AND 100)
);

INSERT INTO public.countries (iso2, name, region) VALUES
    ('AD', 'Andorra', 'Europe'),
    ('AE', 'United Arab Emirates', 'Middle East'),
    ('AF', 'Afghanistan', 'Asia'),
    ('AG', 'Antigua & Barbuda', 'Latin America'),
    ('AI', 'Anguilla', 'Latin America'),
    ('AL', 'Albania', 'Europe'),
    ('AM', 'Armenia', 'Asia'),
    ('AO', 'Angola', 'Africa'),
    ('AQ', 'Antarctica', 'Oceania'),
    ('AR', 'Argentina', 'Latin America'),
    ('AS', 'American Samoa', 'Oceania'),
    ('AT', 'Austria', 'Europe'),
    ('AU', 'Australia', 'Oceania'),
    ('AW', 'Aruba', 'Latin America'),
    ('AX', 'Åland Islands', 'Europe'),
    ('AZ', 'Azerbaijan', 'Asia'),
    ('BA', 'Bosnia & Herzegovina', 'Europe'),
    ('BB', 'Barbados', 'Latin America'),
    ('BD', 'Bangladesh', 'Asia'),
    ('BE', 'Belgium', 'Europe'),
    ('BF', 'Burkina Faso', 'Africa'),
    ('BG', 'Bulgaria', 'Europe'),
    ('BH', 'Bahrain', 'Middle East'),
    ('BI', 'Burundi', 'Africa'),
    ('BJ', 'Benin', 'Africa'),
    ('BL', 'Saint Barthélemy', 'Latin America'),
    ('BM', 'Bermuda', 'North America'),
    ('BN', 'Brunei', 'Asia'),
    ('BO', 'Bolivia', 'Latin America'),
    ('BQ', 'Caribbean Netherlands', 'Latin America'),
    ('BR', 'Brazil', 'Latin America'),
    ('BS', 'Bahamas', 'Latin America'),
    ('BT', 'Bhutan', 'Asia'),
    ('BV', 'Bouvet Island', 'Oceania'),
    ('BW', 'Botswana', 'Africa'),
    ('BY', 'Belarus', 'Europe'),
    ('BZ', 'Belize', 'Latin America'),
    ('CA', 'Canada', 'North America'),
    ('CC', 'Cocos (Keeling) Islands', 'Oceania'),
    ('CD', 'Congo (DRC)', 'Africa'),
    ('CF', 'Central African Republic', 'Africa'),
    ('CG', 'Congo', 'Africa'),
    ('CH', 'Switzerland', 'Europe'),
    ('CI', 'Côte d''Ivoire', 'Africa'),
    ('CK', 'Cook Islands', 'Oceania'),
    ('CL', 'Chile', 'Latin America'),
    ('CM', 'Cameroon', 'Africa'),
    ('CN', 'China', 'Asia'),
    ('CO', 'Colombia', 'Latin America'),
    ('CR', 'Costa Rica', 'Latin America'),
    ('CU', 'Cuba', 'Latin America'),
    ('CV', 'Cape Verde', 'Africa'),
    ('CW', 'Curaçao', 'Latin America'),
    ('CX', 'Christmas Island', 'Oceania'),
    ('CY', 'Cyprus', 'Europe'),
    ('CZ', 'Czechia', 'Europe'),
    ('DE', 'Germany', 'Europe'),
    ('DJ', 'Djibouti', 'Africa'),
    ('DK', 'Denmark', 'Europe'),
    ('DM', 'Dominica', 'Latin America'),
    ('DO', 'Dominican Republic', 'Latin America'),
    ('DZ', 'Algeria', 'Africa'),
    ('EC', 'Ecuador', 'Latin America'),
    ('EE', 'Estonia', 'Europe'),
    ('EG', 'Egypt', 'Africa'),
    ('EH', 'Western Sahara', 'Africa'),
    ('ER', 'Eritrea', 'Africa'),
    ('ES', 'Spain', 'Europe'),
    ('ET', 'Ethiopia', 'Africa'),
    ('FI', 'Finland', 'Europe'),
    ('FJ', 'Fiji', 'Oceania'),
    ('FK', 'Falkland Islands', 'Latin America'),
    ('FM', 'Micronesia', 'Oceania'),
    ('FO', 'Faroe Islands', 'Europe'),
    ('FR', 'France', 'Europe'),
    ('GA', 'Gabon', 'Africa'),
    ('GB', 'United Kingdom', 'Europe'),
    ('GD', 'Grenada', 'Latin America'),
    ('GE', 'Georgia', 'Asia'),
    ('GF', 'French Guiana', 'Latin America'),
    ('GG', 'Guernsey', 'Europe'),
    ('GH', 'Ghana', 'Africa'),
    ('GI', 'Gibraltar', 'Europe'),
    ('GL', 'Greenland', 'North America'),
    ('GM', 'Gambia', 'Africa'),
    ('GN', 'Guinea', 'Africa'),
    ('GP', 'Guadeloupe', 'Latin America'),
    ('GQ', 'Equatorial Guinea', 'Africa'),
    ('GR', 'Greece', 'Europe'),
    ('GS', 'South Georgia & South Sandwich Islands', 'Latin America'),
    ('GT', 'Guatemala', 'Latin America'),
    ('GU', 'Guam', 'Oceania'),
    ('GW', 'Guinea-Bissau', 'Africa'),
    ('GY', 'Guyana', 'Latin America'),
    ('HK', 'Hong Kong', 'Asia'),
    ('HM', 'Heard & McDonald Islands', 'Oceania'),
    ('HN', 'Honduras', 'Latin America'),
    ('HR', 'Croatia', 'Europe'),
    ('HT', 'Haiti', 'Latin America'),
    ('HU', 'Hungary', 'Europe'),
    ('ID', 'Indonesia', 'Asia'),
    ('IE', 'Ireland', 'Europe'),
    ('IL', 'Israel', 'Middle East'),
    ('IM', 'Isle of Man', 'Europe'),
    ('IN', 'India', 'Asia'),
    ('IO', 'British Indian Ocean Territory', 'Africa'),
    ('IQ', 'Iraq', 'Middle East'),
    ('IR', 'Iran', 'Middle East'),
    ('IS', 'Iceland', 'Europe'),
    ('IT', 'Italy', 'Europe'),
    ('JE', 'Jersey', 'Europe'),
    ('JM', 'Jamaica', 'Latin America'),
    ('JO', 'Jordan', 'Middle East'),
    ('JP', 'Japan', 'Asia'),
    ('KE', 'Kenya', 'Africa'),
    ('KG', 'Kyrgyzstan', 'Asia'),
    ('KH', 'Cambodia', 'Asia'),
    ('KI', 'Kiribati', 'Oceania'),
    ('KM', 'Comoros', 'Africa'),
    ('KN', 'Saint Kitts and Nevis', 'Latin America'),
    ('KP', 'North Korea', 'Asia'),
    ('KR', 'South Korea', 'Asia'),
    ('KW', 'Kuwait', 'Middle East'),
    ('KY', 'Cayman Islands', 'Latin America'),
    ('KZ', 'Kazakhstan', 'Asia'),
    ('LA', 'Laos', 'Asia'),
    ('LB', 'Lebanon', 'Middle East'),
    ('LC', 'Saint Lucia', 'Latin America'),
    ('LI', 'Liechtenstein', 'Europe'),
    ('LK', 'Sri Lanka', 'Asia'),
    ('LR', 'Liberia', 'Africa'),
    ('LS', 'Lesotho', 'Africa'),
    ('LT', 'Lithuania', 'Europe'),
    ('LU', 'Luxembourg', 'Europe'),
    ('LV', 'Latvia', 'Europe'),
    ('LY', 'Libya', 'Africa'),
    ('MA', 'Morocco', 'Africa'),
    ('MC', 'Monaco', 'Europe'),
    ('MD', 'Moldova', 'Europe'),
    ('ME', 'Montenegro', 'Europe'),
    ('MF', 'Saint Martin', 'Latin America'),
    ('MG', 'Madagascar', 'Africa'),
    ('MH', 'Marshall Islands', 'Oceania'),
    ('MK', 'North Macedonia', 'Europe'),
    ('ML', 'Mali', 'Africa'),
    ('MM', 'Myanmar', 'Asia'),
    ('MN', 'Mongolia', 'Asia'),
    ('MO', 'Macao', 'Asia'),
    ('MP', 'Northern Mariana Islands', 'Oceania'),
    ('MQ', 'Martinique', 'Latin America'),
    ('MR', 'Mauritania', 'Africa'),
    ('MS', 'Montserrat', 'Latin America'),
    ('MT', 'Malta', 'Europe'),
    ('MU', 'Mauritius', 'Africa'),
    ('MV', 'Maldives', 'Asia'),
    ('MW', 'Malawi', 'Africa'),
    ('MX', 'Mexico', 'Latin America'),
    ('MY', 'Malaysia', 'Asia'),
    ('MZ', 'Mozambique', 'Africa'),
    ('NA', 'Namibia', 'Africa'),
    ('NC', 'New Caledonia', 'Oceania'),
    ('NE', 'Niger', 'Africa'),
    ('NF', 'Norfolk Island', 'Oceania'),
    ('NG', 'Nigeria', 'Africa'),
    ('NI', 'Nicaragua', 'Latin America'),
    ('NL', 'Netherlands', 'Europe'),
    ('NO', 'Norway', 'Europe'),
    ('NP', 'Nepal', 'Asia'),
    ('NR', 'Nauru', 'Oceania'),
    ('NU', 'Niue', 'Oceania'),
    ('NZ', 'New Zealand', 'Oceania'),
    ('OM', 'Oman', 'Middle East'),
    ('PA', 'Panama', 'Latin America'),
    ('PE', 'Peru', 'Latin America'),
    ('PF', 'French Polynesia', 'Oceania'),
    ('PG', 'Papua New Guinea', 'Oceania'),
    ('PH', 'Philippines', 'Asia'),
    ('PK', 'Pakistan', 'Asia'),
    ('PL', 'Poland', 'Europe'),
    ('PM', 'Saint Pierre and Miquelon', 'North America'),
    ('PN', 'Pitcairn Islands', 'Oceania'),
    ('PR', 'Puerto Rico', 'Latin America'),
    ('PS', 'Palestine', 'Middle East'),
    ('PT', 'Portugal', 'Europe'),
    ('PW', 'Palau', 'Oceania'),
    ('PY', 'Paraguay', 'Latin America'),
    ('QA', 'Qatar', 'Middle East'),
    ('RE', 'Réunion', 'Africa'),
    ('RO', 'Romania', 'Europe'),
    ('RS', 'Serbia', 'Europe'),
    ('RU', 'Russia', 'Europe'),
    ('RW', 'Rwanda', 'Africa'),
    ('SA', 'Saudi Arabia', 'Middle East'),
    ('SB', 'Solomon Islands', 'Oceania'),
    ('SC', 'Seychelles', 'Africa'),
    ('SD', 'Sudan', 'Africa'),
    ('SE', 'Sweden', 'Europe'),
    ('SG', 'Singapore', 'Asia'),
    ('SH', 'Saint Helena', 'Africa'),
    ('SI', 'Slovenia', 'Europe'),
    ('SJ', 'Svalbard & Jan Mayen', 'Europe'),
    ('SK', 'Slovakia', 'Europe'),
    ('SL', 'Sierra Leone', 'Africa'),
    ('SM', 'San Marino', 'Europe'),
    ('SN', 'Senegal', 'Africa'),
    ('SO', 'Somalia', 'Africa'),
    ('SR', 'Suriname', 'Latin America'),
    ('SS', 'South Sudan', 'Africa'),
    ('ST', 'São Tomé & Príncipe', 'Africa'),
    ('SV', 'El Salvador', 'Latin America'),
    ('SX', 'Sint Maarten', 'Latin America'),
    ('SY', 'Syria', 'Middle East'),
    ('SZ', 'Eswatini', 'Africa'),
    ('TC', 'Turks & Caicos Islands', 'Latin America'),
    ('TD', 'Chad', 'Africa'),
    ('TF', 'French Southern Territories', 'Africa'),
    ('TG', 'Togo', 'Africa'),
    ('TH', 'Thailand', 'Asia'),
    ('TJ', 'Tajikistan', 'Asia'),
    ('TK', 'Tokelau', 'Oceania'),
    ('TL', 'Timor-Leste', 'Asia'),
    ('TM', 'Turkmenistan', 'Asia'),
    ('TN', 'Tunisia', 'Africa'),
    ('TO', 'Tonga', 'Oceania'),
    ('TR', 'Türkiye', 'Europe'),
    ('TT', 'Trinidad & Tobago', 'Latin America'),
    ('TV', 'Tuvalu', 'Oceania'),
    ('TW', 'Taiwan', 'Asia'),
    ('TZ', 'Tanzania', 'Africa'),
    ('UA', 'Ukraine', 'Europe'),
    ('UG', 'Uganda', 'Africa'),
    ('UM', 'U.S. Outlying Islands', 'Oceania'),
    ('US', 'United States', 'North America'),
    ('UY', 'Uruguay', 'Latin America'),
    ('UZ', 'Uzbekistan', 'Asia'),
    ('VA', 'Vatican City', 'Europe'),
    ('VC', 'Saint Vincent and the Grenadines', 'Latin America'),
    ('VE', 'Venezuela', 'Latin America'),
    ('VG', 'British Virgin Islands', 'Latin America'),
    ('VI', 'U.S. Virgin Islands', 'Latin America'),
    ('VN', 'Vietnam', 'Asia'),
    ('VU', 'Vanuatu', 'Oceania'),
    ('WF', 'Wallis & Futuna', 'Oceania'),
    ('WS', 'Samoa', 'Oceania'),
    ('XK', 'Kosovo', 'Europe'),
    ('YE', 'Yemen', 'Middle East'),
    ('YT', 'Mayotte', 'Africa'),
    ('ZA', 'South Africa', 'Africa'),
    ('ZM', 'Zambia', 'Africa'),
    ('ZW', 'Zimbabwe', 'Africa');

INSERT INTO public.country_aliases (alias, iso2) VALUES
    ('abu dhabi', 'AE'),
    ('abu dhabi emirate', 'AE'),
    ('abuja', 'NG'),
    ('accra', 'GH'),
    ('adelaide', 'AU'),
    ('afghanistan', 'AF'),
    ('ahmedabad', 'IN'),
    ('ajman', 'AE'),
    ('al khobar', 'SA'),
    ('alabama', 'US'),
    ('aland islands', 'AX'),
    ('åland islands', 'AX'),
    ('alaska', 'US'),
    ('albania', 'AL'),
    ('alberta', 'CA'),
    ('alexandria', 'EG'),
    ('algeria', 'DZ'),
    ('america', 'US'),
    ('american samoa', 'AS'),
    ('amman', 'JO'),
    ('amsterdam', 'NL'),
    ('andorra', 'AD'),
    ('angola', 'AO'),
    ('anguilla', 'AI'),
    ('ankara', 'TR'),
    ('antarctica', 'AQ'),
    ('antigua & barbuda', 'AG'),
    ('antwerp', 'BE'),
    ('argentina', 'AR'),
    ('arizona', 'US'),
    ('arkansas', 'US'),
    ('armenia', 'AM'),
    ('aruba', 'AW'),
    ('athens', 'GR'),
    ('atlanta', 'US'),
    ('auckland', 'NZ'),
    ('austin', 'US'),
    ('australia', 'AU'),
    ('austria', 'AT'),
    ('azerbaijan', 'AZ'),
    ('bahamas', 'BS'),
    ('bahrain', 'BH'),
    ('baltimore', 'US'),
    ('bangalore', 'IN'),
    ('bangkok', 'TH'),
    ('bangladesh', 'BD'),
    ('barbados', 'BB'),
    ('barcelona', 'ES'),
    ('basel', 'CH'),
    ('bavaria', 'DE'),
    ('bay', 'US'),
    ('bayern', 'DE'),
    ('beijing', 'CN'),
    ('beirut', 'LB'),
    ('belarus', 'BY'),
    ('belfast', 'GB'),
    ('belgium', 'BE'),
    ('belgrade', 'RS'),
    ('belize', 'BZ'),
    ('bengaluru', 'IN'),
    ('benin', 'BJ'),
    ('berlin', 'DE'),
    ('berlin metropolitan', 'DE'),
    ('bermuda', 'BM'),
    ('bern', 'CH'),
    ('bhutan', 'BT'),
    ('birmingham', 'GB'),
    ('bogota', 'CO'),
    ('bogotá', 'CO'),
    ('bolivia', 'BO'),
    ('bosnia', 'BA'),
    ('bosnia & herzegovina', 'BA'),
    ('boston', 'US'),
    ('botswana', 'BW'),
    ('boulder', 'US'),
    ('bouvet island', 'BV'),
    ('brasil', 'BR'),
    ('brazil', 'BR'),
    ('brisbane', 'AU'),
    ('bristol', 'GB'),
    ('britain', 'GB'),
    ('british columbia', 'CA'),
    ('british indian ocean territory', 'IO'),
    ('british virgin islands', 'VG'),
    ('brunei', 'BN'),
    ('brussels', 'BE'),
    ('bucharest', 'RO'),
    ('budapest', 'HU'),
    ('buenos aires', 'AR'),
    ('bulgaria', 'BG'),
    ('burkina faso', 'BF'),
    ('burundi', 'BI'),
    ('cairo', 'EG'),
    ('calgary', 'CA'),
    ('california', 'US'),
    ('cambodia', 'KH'),
    ('cambridge', 'GB'),
    ('cameroon', 'CM'),
    ('canada', 'CA'),
    ('canberra', 'AU'),
    ('cape town', 'ZA'),
    ('cape verde', 'CV'),
    ('cardiff', 'GB'),
    ('caribbean netherlands', 'BQ'),
    ('casablanca', 'MA'),
    ('catalonia', 'ES'),
    ('cayman islands', 'KY'),
    ('cdmx', 'MX'),
    ('central african republic', 'CF'),
    ('chad', 'TD'),
    ('charlotte', 'US'),
    ('chennai', 'IN'),
    ('chicago', 'US'),
    ('chile', 'CL'),
    ('china', 'CN'),
    ('christmas island', 'CX'),
    ('cincinnati', 'US'),
    ('city of london', 'GB'),
    ('ciudad de méxico', 'MX'),
    ('cleveland', 'US'),
    ('cocos (keeling) islands', 'CC'),
    ('cologne', 'DE'),
    ('colombia', 'CO'),
    ('colorado', 'US'),
    ('columbus', 'US'),
    ('comoros', 'KM'),
    ('congo', 'CG'),
    ('congo - brazzaville', 'CG'),
    ('congo - kinshasa', 'CD'),
    ('congo (drc)', 'CD'),
    ('connecticut', 'US'),
    ('cook islands', 'CK'),
    ('copenhagen', 'DK'),
    ('cork', 'IE'),
    ('costa rica', 'CR'),
    ('cote d''ivoire', 'CI'),
    ('côte d''ivoire', 'CI'),
    ('côte d’ivoire', 'CI'),
    ('croatia', 'HR'),
    ('cuba', 'CU'),
    ('curacao', 'CW'),
    ('curaçao', 'CW'),
    ('cyprus', 'CY'),
    ('czech republic', 'CZ'),
    ('czechia', 'CZ'),
    ('dallas', 'US'),
    ('dallas-fort worth', 'US'),
    ('dammam', 'SA'),
    ('dc-baltimore', 'US'),
    ('delaware', 'US'),
    ('delhi', 'IN'),
    ('democratic republic of the congo', 'CD'),
    ('denmark', 'DK'),
    ('denver', 'US'),
    ('detroit', 'US'),
    ('dfw', 'US'),
    ('district of columbia', 'US'),
    ('djibouti', 'DJ'),
    ('dnipro', 'UA'),
    ('doha', 'QA'),
    ('dominica', 'DM'),
    ('dominican republic', 'DO'),
    ('drc', 'CD'),
    ('dubai', 'AE'),
    ('dubai emirate', 'AE'),
    ('dublin', 'IE'),
    ('durban', 'ZA'),
    ('düsseldorf', 'DE'),
    ('eastern province', 'SA'),
    ('ecuador', 'EC'),
    ('edinburgh', 'GB'),
    ('edmonton', 'CA'),
    ('egypt', 'EG'),
    ('eindhoven', 'NL'),
    ('el salvador', 'SV'),
    ('emirate of dubai', 'AE'),
    ('emirates', 'AE'),
    ('england', 'GB'),
    ('equatorial guinea', 'GQ'),
    ('eritrea', 'ER'),
    ('estonia', 'EE'),
    ('eswatini', 'SZ'),
    ('ethiopia', 'ET'),
    ('falkland islands', 'FK'),
    ('faroe islands', 'FO'),
    ('fiji', 'FJ'),
    ('finland', 'FI'),
    ('florida', 'US'),
    ('france', 'FR'),
    ('frankfurt', 'DE'),
    ('frankfurt rhine-main metropolitan', 'DE'),
    ('french guiana', 'GF'),
    ('french polynesia', 'PF'),
    ('french southern territories', 'TF'),
    ('fujairah', 'AE'),
    ('gabon', 'GA'),
    ('gambia', 'GM'),
    ('gauteng', 'ZA'),
    ('geneva', 'CH'),
    ('georgia', 'GE'),
    ('germany', 'DE'),
    ('ghana', 'GH'),
    ('ghent', 'BE'),
    ('gibraltar', 'GI'),
    ('giza', 'EG'),
    ('glasgow', 'GB'),
    ('gothenburg', 'SE'),
    ('great britain', 'GB'),
    ('greater manchester', 'GB'),
    ('greater paris', 'FR'),
    ('greater toronto', 'CA'),
    ('greece', 'GR'),
    ('greenland', 'GL'),
    ('grenada', 'GD'),
    ('guadalajara', 'MX'),
    ('guadeloupe', 'GP'),
    ('guam', 'GU'),
    ('guangzhou', 'CN'),
    ('guatemala', 'GT'),
    ('guernsey', 'GG'),
    ('guinea', 'GN'),
    ('guinea-bissau', 'GW'),
    ('gurgaon', 'IN'),
    ('gurugram', 'IN'),
    ('guyana', 'GY'),
    ('haifa', 'IL'),
    ('haiti', 'HT'),
    ('hamburg', 'DE'),
    ('hanoi', 'VN'),
    ('hawaii', 'US'),
    ('heard & mcdonald islands', 'HM'),
    ('helsinki', 'FI'),
    ('hksar', 'HK'),
    ('ho chi minh city', 'VN'),
    ('holland', 'NL'),
    ('honduras', 'HN'),
    ('hong kong', 'HK'),
    ('hong kong sar', 'HK'),
    ('hong kong sar china', 'HK'),
    ('houston', 'US'),
    ('hungary', 'HU'),
    ('hyderabad', 'IN'),
    ('iceland', 'IS'),
    ('idaho', 'US'),
    ('ile-de-france', 'FR'),
    ('île-de-france', 'FR'),
    ('illinois', 'US'),
    ('india', 'IN'),
    ('indiana', 'US'),
    ('indianapolis', 'US'),
    ('indonesia', 'ID'),
    ('iowa', 'US'),
    ('iran', 'IR'),
    ('iraq', 'IQ'),
    ('ireland', 'IE'),
    ('islamabad', 'PK'),
    ('isle of man', 'IM'),
    ('israel', 'IL'),
    ('istanbul', 'TR'),
    ('italia', 'IT'),
    ('italy', 'IT'),
    ('ivory coast', 'CI'),
    ('izmir', 'TR'),
    ('jakarta', 'ID'),
    ('jamaica', 'JM'),
    ('japan', 'JP'),
    ('jeddah', 'SA'),
    ('jersey', 'JE'),
    ('jerusalem', 'IL'),
    ('jiddah', 'SA'),
    ('johannesburg', 'ZA'),
    ('jordan', 'JO'),
    ('k.s.a.', 'SA'),
    ('kansas', 'US'),
    ('kansas city', 'US'),
    ('karachi', 'PK'),
    ('kazakhstan', 'KZ'),
    ('kentucky', 'US'),
    ('kenya', 'KE'),
    ('kharkiv', 'UA'),
    ('khobar', 'SA'),
    ('kiev', 'UA'),
    ('kingdom of saudi arabia', 'SA'),
    ('kiribati', 'KI'),
    ('kolkata', 'IN'),
    ('köln', 'DE'),
    ('korea', 'KR'),
    ('kosovo', 'XK'),
    ('krakow', 'PL'),
    ('kraków', 'PL'),
    ('ksa', 'SA'),
    ('kuala lumpur', 'MY'),
    ('kuwait', 'KW'),
    ('kuwait city', 'KW'),
    ('kyiv', 'UA'),
    ('kyrgyzstan', 'KG'),
    ('lagos', 'NG'),
    ('lahore', 'PK'),
    ('laos', 'LA'),
    ('las vegas', 'US'),
    ('latvia', 'LV'),
    ('lausanne', 'CH'),
    ('lebanon', 'LB'),
    ('leeds', 'GB'),
    ('lesotho', 'LS'),
    ('liberia', 'LR'),
    ('libya', 'LY'),
    ('liechtenstein', 'LI'),
    ('lima', 'PE'),
    ('limassol', 'CY'),
    ('lisbon', 'PT'),
    ('lithuania', 'LT'),
    ('liverpool', 'GB'),
    ('london', 'GB'),
    ('los angeles', 'US'),
    ('louisiana', 'US'),
    ('luxembourg', 'LU'),
    ('luxembourg city', 'LU'),
    ('lviv', 'UA'),
    ('lyon', 'FR'),
    ('macao', 'MO'),
    ('macao sar china', 'MO'),
    ('macau', 'MO'),
    ('macedonia', 'MK'),
    ('madagascar', 'MG'),
    ('madinah', 'SA'),
    ('madrid', 'ES'),
    ('maine', 'US'),
    ('makkah', 'SA'),
    ('malawi', 'MW'),
    ('malaysia', 'MY'),
    ('maldives', 'MV'),
    ('mali', 'ML'),
    ('malta', 'MT'),
    ('manama', 'BH'),
    ('manchester', 'GB'),
    ('manila', 'PH'),
    ('manitoba', 'CA'),
    ('marseille', 'FR'),
    ('marshall islands', 'MH'),
    ('martinique', 'MQ'),
    ('maryland', 'US'),
    ('massachusetts', 'US'),
    ('mauritania', 'MR'),
    ('mauritius', 'MU'),
    ('mayotte', 'YT'),
    ('mecca', 'SA'),
    ('medellin', 'CO'),
    ('medellín', 'CO'),
    ('medina', 'SA'),
    ('melbourne', 'AU'),
    ('metro manila', 'PH'),
    ('mexico', 'MX'),
    ('mexico city', 'MX'),
    ('miami', 'US'),
    ('miami-fort lauderdale', 'US'),
    ('michigan', 'US'),
    ('micronesia', 'FM'),
    ('milan', 'IT'),
    ('minneapolis', 'US'),
    ('minneapolis-st. paul', 'US'),
    ('minnesota', 'US'),
    ('minsk', 'BY'),
    ('mississippi', 'US'),
    ('missouri', 'US'),
    ('moldova', 'MD'),
    ('monaco', 'MC'),
    ('mongolia', 'MN'),
    ('montana', 'US'),
    ('montenegro', 'ME'),
    ('monterrey', 'MX'),
    ('montreal', 'CA'),
    ('montréal', 'CA'),
    ('montserrat', 'MS'),
    ('morocco', 'MA'),
    ('moscow', 'RU'),
    ('mozambique', 'MZ'),
    ('mumbai', 'IN'),
    ('münchen', 'DE'),
    ('munich', 'DE'),
    ('munich metropolitan', 'DE'),
    ('muscat', 'OM'),
    ('myanmar', 'MM'),
    ('myanmar (burma)', 'MM'),
    ('nairobi', 'KE'),
    ('namibia', 'NA'),
    ('nashville', 'US'),
    ('nauru', 'NR'),
    ('nebraska', 'US'),
    ('nepal', 'NP'),
    ('netherlands', 'NL'),
    ('nevada', 'US'),
    ('new brunswick', 'CA'),
    ('new caledonia', 'NC'),
    ('new delhi', 'IN'),
    ('new hampshire', 'US'),
    ('new jersey', 'US'),
    ('new mexico', 'US'),
    ('new south wales', 'AU'),
    ('new york', 'US'),
    ('new york city', 'US'),
    ('new zealand', 'NZ'),
    ('newfoundland and labrador', 'CA'),
    ('nicaragua', 'NI'),
    ('nice', 'FR'),
    ('nicosia', 'CY'),
    ('niger', 'NE'),
    ('nigeria', 'NG'),
    ('niue', 'NU'),
    ('noida', 'IN'),
    ('norfolk island', 'NF'),
    ('north carolina', 'US'),
    ('north dakota', 'US'),
    ('north korea', 'KP'),
    ('north macedonia', 'MK'),
    ('northern ireland', 'GB'),
    ('northern mariana islands', 'MP'),
    ('norway', 'NO'),
    ('nova scotia', 'CA'),
    ('nyc', 'US'),
    ('odesa', 'UA'),
    ('odessa', 'UA'),
    ('ohio', 'US'),
    ('oklahoma', 'US'),
    ('oman', 'OM'),
    ('ontario', 'CA'),
    ('oregon', 'US'),
    ('orlando', 'US'),
    ('osaka', 'JP'),
    ('oslo', 'NO'),
    ('ottawa', 'CA'),
    ('oxford', 'GB'),
    ('pakistan', 'PK'),
    ('palau', 'PW'),
    ('palestine', 'PS'),
    ('palestinian territories', 'PS'),
    ('panama', 'PA'),
    ('papua new guinea', 'PG'),
    ('paraguay', 'PY'),
    ('paris', 'FR'),
    ('pennsylvania', 'US'),
    ('people''s republic of china', 'CN'),
    ('perth', 'AU'),
    ('peru', 'PE'),
    ('philadelphia', 'US'),
    ('philippines', 'PH'),
    ('phoenix', 'US'),
    ('pitcairn islands', 'PN'),
    ('pittsburgh', 'US'),
    ('poland', 'PL'),
    ('portland', 'US'),
    ('porto', 'PT'),
    ('portugal', 'PT'),
    ('prague', 'CZ'),
    ('prc', 'CN'),
    ('pretoria', 'ZA'),
    ('prince edward island', 'CA'),
    ('puerto rico', 'PR'),
    ('pune', 'IN'),
    ('qatar', 'QA'),
    ('quebec', 'CA'),
    ('québec', 'CA'),
    ('queensland', 'AU'),
    ('rabat', 'MA'),
    ('raleigh-durham', 'US'),
    ('ras al khaimah', 'AE'),
    ('ras al-khaimah', 'AE'),
    ('republic of ireland', 'IE'),
    ('republic of korea', 'KR'),
    ('republic of singapore', 'SG'),
    ('reunion', 'RE'),
    ('réunion', 'RE'),
    ('reykjavik', 'IS'),
    ('rhode island', 'US'),
    ('riga', 'LV'),
    ('rio de janeiro', 'BR'),
    ('riyadh', 'SA'),
    ('riyadh province', 'SA'),
    ('romania', 'RO'),
    ('rome', 'IT'),
    ('rotterdam', 'NL'),
    ('russia', 'RU'),
    ('russian federation', 'RU'),
    ('rwanda', 'RW'),
    ('sacramento', 'US'),
    ('saint barthelemy', 'BL'),
    ('saint barthélemy', 'BL'),
    ('saint helena', 'SH'),
    ('saint kitts and nevis', 'KN'),
    ('saint lucia', 'LC'),
    ('saint martin', 'MF'),
    ('saint petersburg', 'RU'),
    ('saint pierre and miquelon', 'PM'),
    ('saint vincent and the grenadines', 'VC'),
    ('salt lake city', 'US'),
    ('samoa', 'WS'),
    ('san antonio', 'US'),
    ('san diego', 'US'),
    ('san francisco', 'US'),
    ('san francisco bay', 'US'),
    ('san marino', 'SM'),
    ('santiago', 'CL'),
    ('sao paulo', 'BR'),
    ('são paulo', 'BR'),
    ('sao tome & principe', 'ST'),
    ('são tomé & príncipe', 'ST'),
    ('saskatchewan', 'CA'),
    ('saudi', 'SA'),
    ('saudi arabia', 'SA'),
    ('scotland', 'GB'),
    ('seattle', 'US'),
    ('senegal', 'SN'),
    ('seoul', 'KR'),
    ('serbia', 'RS'),
    ('seychelles', 'SC'),
    ('shanghai', 'CN'),
    ('sharjah', 'AE'),
    ('shenzhen', 'CN'),
    ('sierra leone', 'SL'),
    ('silicon valley', 'US'),
    ('singapore', 'SG'),
    ('sint maarten', 'SX'),
    ('slovakia', 'SK'),
    ('slovenia', 'SI'),
    ('sofia', 'BG'),
    ('solomon islands', 'SB'),
    ('somalia', 'SO'),
    ('south africa', 'ZA'),
    ('south carolina', 'US'),
    ('south dakota', 'US'),
    ('south georgia & south sandwich islands', 'GS'),
    ('south korea', 'KR'),
    ('south sudan', 'SS'),
    ('spain', 'ES'),
    ('sri lanka', 'LK'),
    ('st. barthélemy', 'BL'),
    ('st. helena', 'SH'),
    ('st. kitts & nevis', 'KN'),
    ('st. kitts and nevis', 'KN'),
    ('st. louis', 'US'),
    ('st. lucia', 'LC'),
    ('st. martin', 'MF'),
    ('st. pierre & miquelon', 'PM'),
    ('st. pierre and miquelon', 'PM'),
    ('st. vincent & grenadines', 'VC'),
    ('st. vincent and the grenadines', 'VC'),
    ('stockholm', 'SE'),
    ('stuttgart', 'DE'),
    ('sudan', 'SD'),
    ('suriname', 'SR'),
    ('svalbard & jan mayen', 'SJ'),
    ('swaziland', 'SZ'),
    ('sweden', 'SE'),
    ('switzerland', 'CH'),
    ('sydney', 'AU'),
    ('syria', 'SY'),
    ('taipei', 'TW'),
    ('taiwan', 'TW'),
    ('tajikistan', 'TJ'),
    ('tallinn', 'EE'),
    ('tampa bay', 'US'),
    ('tanzania', 'TZ'),
    ('tbilisi', 'GE'),
    ('tel aviv', 'IL'),
    ('tel aviv-yafo', 'IL'),
    ('tennessee', 'US'),
    ('texas', 'US'),
    ('thailand', 'TH'),
    ('the emirates', 'AE'),
    ('the hague', 'NL'),
    ('the netherlands', 'NL'),
    ('timor-leste', 'TL'),
    ('togo', 'TG'),
    ('tokelau', 'TK'),
    ('tokyo', 'JP'),
    ('tonga', 'TO'),
    ('toronto', 'CA'),
    ('toulouse', 'FR'),
    ('trinidad & tobago', 'TT'),
    ('tunisia', 'TN'),
    ('turin', 'IT'),
    ('turkey', 'TR'),
    ('turkiye', 'TR'),
    ('türkiye', 'TR'),
    ('turkmenistan', 'TM'),
    ('turks & caicos islands', 'TC'),
    ('tuvalu', 'TV'),
    ('u.a.e.', 'AE'),
    ('u.k.', 'GB'),
    ('u.s.', 'US'),
    ('u.s. outlying islands', 'UM'),
    ('u.s. virgin islands', 'VI'),
    ('u.s.a.', 'US'),
    ('uae', 'AE'),
    ('uganda', 'UG'),
    ('uk', 'GB'),
    ('ukraine', 'UA'),
    ('umm al quwain', 'AE'),
    ('united arab emirates', 'AE'),
    ('united kingdom', 'GB'),
    ('united states', 'US'),
    ('united states of america', 'US'),
    ('uruguay', 'UY'),
    ('us', 'US'),
    ('usa', 'US'),
    ('utah', 'US'),
    ('utrecht', 'NL'),
    ('uzbekistan', 'UZ'),
    ('valencia', 'ES'),
    ('valletta', 'MT'),
    ('vancouver', 'CA'),
    ('vanuatu', 'VU'),
    ('vatican city', 'VA'),
    ('venezuela', 'VE'),
    ('vermont', 'US'),
    ('victoria', 'AU'),
    ('vienna', 'AT'),
    ('viet nam', 'VN'),
    ('vietnam', 'VN'),
    ('vilnius', 'LT'),
    ('virginia', 'US'),
    ('wales', 'GB'),
    ('wallis & futuna', 'WF'),
    ('warsaw', 'PL'),
    ('washington', 'US'),
    ('washington d.c.', 'US'),
    ('washington dc', 'US'),
    ('washington dc-baltimore', 'US'),
    ('waterloo', 'CA'),
    ('wellington', 'NZ'),
    ('west virginia', 'US'),
    ('western sahara', 'EH'),
    ('wien', 'AT'),
    ('winnipeg', 'CA'),
    ('wisconsin', 'US'),
    ('wroclaw', 'PL'),
    ('wrocław', 'PL'),
    ('wyoming', 'US'),
    ('yemen', 'YE'),
    ('yerevan', 'AM'),
    ('zagreb', 'HR'),
    ('zambia', 'ZM'),
    ('zimbabwe', 'ZW'),
    ('zurich', 'CH'),
    ('zürich', 'CH');

-- A free-text location to an ISO country code, or NULL. Candidates in order:
-- the whole string, then each comma segment from the right ("Berlin, Germany"
-- -> "germany"); each candidate is tried as is, then with the LinkedIn area
-- wrappers stripped ("Greater London" -> "london", "San Francisco Bay Area"
-- -> "san francisco bay").
CREATE FUNCTION public.geo_country_code(p_location text) RETURNS character(2)
    LANGUAGE plpgsql STABLE
    SET search_path TO ''
    AS $$
declare
  normalized text;
  segments text[];
  candidate text;
  stripped text;
  resolved character(2);
  i int;
begin
  if p_location is null then
    return null;
  end if;
  normalized := lower(btrim(regexp_replace(p_location, '[[:space:]]+', ' ', 'g')));
  if normalized = '' or char_length(normalized) > 300 then
    return null;
  end if;

  segments := array_prepend(normalized, regexp_split_to_array(normalized, '\s*,\s*'));
  for i in 1 .. coalesce(array_length(segments, 1), 0) loop
    -- Index 1 is the whole string; then segments right to left.
    candidate := btrim(segments[case when i = 1 then 1 else array_length(segments, 1) - i + 2 end], ' .');
    continue when candidate = '';
    select a.iso2 into resolved from public.country_aliases a where a.alias = candidate;
    if resolved is not null then
      return resolved;
    end if;
    stripped := btrim(regexp_replace(regexp_replace(candidate,
                  '^(the )?greater ', ''),
                  ' (metropolitan area|metropolitan region|metro area|metroplex|area|region|metro)$', ''));
    if stripped <> candidate and stripped <> '' then
      select a.iso2 into resolved from public.country_aliases a where a.alias = stripped;
      if resolved is not null then
        return resolved;
      end if;
    end if;
  end loop;
  return null;
end;
$$;

-- A LinkedIn profile URL to its lower-case, percent-decoded public slug
-- ("https://www.linkedin.com/in/J%C3%B6rg-X/" -> "jörg-x"), or NULL. The one
-- normalization both sides of the lead <-> Airtable contact match use; same
-- rule as analysis/outreach-insights/enrich.py slug().
CREATE FUNCTION public.linkedin_slug(p_url text) RETURNS text
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO ''
    AS $$
declare
  raw text;
  bytes bytea := ''::bytea;
  token text;
  decoded text;
  matched text[];
begin
  if p_url is null then
    return null;
  end if;
  raw := btrim(p_url);
  if raw = '' or char_length(raw) > 1000 then
    return null;
  end if;
  decoded := raw;
  if raw ~ '%[0-9A-Fa-f]{2}' then
    begin
      for token in select m[1] from regexp_matches(raw, '(%[0-9A-Fa-f]{2}|[^%]+|%)', 'g') as m loop
        if token ~ '^%[0-9A-Fa-f]{2}$' then
          bytes := bytes || decode(substr(token, 2), 'hex');
        else
          bytes := bytes || convert_to(token, 'UTF8');
        end if;
      end loop;
      decoded := convert_from(bytes, 'UTF8');
    exception when others then
      decoded := raw;
    end;
  end if;
  matched := regexp_match(lower(decoded), 'linkedin\.com/(?:in|pub)/([^/?#[:space:]]+)');
  if matched is null then
    return null;
  end if;
  return nullif(btrim(matched[1], '/'), '');
end;
$$;

CREATE FUNCTION public.refresh_lead_country_code() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  new.country_code := public.geo_country_code(new.location);
  return new;
end;
$$;

CREATE FUNCTION public.refresh_airtable_company_country_code() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  new.country_code := public.geo_country_code(new.hq_country);
  return new;
end;
$$;

ALTER TABLE public.leads
    ADD COLUMN location text,
    ADD COLUMN country_code character(2),
    ADD CONSTRAINT leads_location_length CHECK (location IS NULL OR char_length(location) <= 300);

CREATE INDEX leads_country_code_idx ON public.leads USING btree (country_code) WHERE (country_code IS NOT NULL);

CREATE TRIGGER refresh_lead_country_code BEFORE INSERT OR UPDATE OF location ON public.leads
    FOR EACH ROW EXECUTE FUNCTION public.refresh_lead_country_code();

CREATE TABLE public.airtable_companies (
    base_key text NOT NULL,
    record_id text NOT NULL,
    name text,
    website text,
    domain text,
    linkedin_url text,
    hq_country text,
    country_code character(2),
    industry text,
    employees integer,
    founded_year integer,
    ai_niche text,
    approve_status text,
    description text,
    summary text,
    keywords text,
    web_app_link text,
    airtable_created timestamp with time zone,
    airtable_modified timestamp with time zone,
    fields jsonb DEFAULT '{}'::jsonb NOT NULL,
    synced_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT airtable_companies_pkey PRIMARY KEY (base_key, record_id),
    CONSTRAINT airtable_companies_base_key_check CHECK (base_key ~ '^[a-z0-9_]{1,40}$'),
    CONSTRAINT airtable_companies_record_id_check CHECK (record_id ~ '^rec[A-Za-z0-9]{14}$'),
    CONSTRAINT airtable_companies_fields_check CHECK (jsonb_typeof(fields) = 'object'),
    CONSTRAINT airtable_companies_lengths CHECK (
        coalesce(char_length(name), 0) <= 500 AND coalesce(char_length(website), 0) <= 1000
        AND coalesce(char_length(domain), 0) <= 253 AND coalesce(char_length(linkedin_url), 0) <= 1000
        AND coalesce(char_length(hq_country), 0) <= 200 AND coalesce(char_length(industry), 0) <= 500
        AND coalesce(char_length(ai_niche), 0) <= 500 AND coalesce(char_length(approve_status), 0) <= 100
        AND coalesce(char_length(description), 0) <= 20000 AND coalesce(char_length(summary), 0) <= 20000
        AND coalesce(char_length(keywords), 0) <= 20000 AND coalesce(char_length(web_app_link), 0) <= 1000)
);

CREATE INDEX airtable_companies_country_code_idx ON public.airtable_companies USING btree (country_code);

CREATE TRIGGER refresh_airtable_company_country_code BEFORE INSERT OR UPDATE OF hq_country ON public.airtable_companies
    FOR EACH ROW EXECUTE FUNCTION public.refresh_airtable_company_country_code();

CREATE TABLE public.airtable_contacts (
    base_key text NOT NULL,
    record_id text NOT NULL,
    persona_slug text,
    persona_url text,
    full_name text,
    title text,
    company_record_id text,
    approve_status text,
    readiness text,
    technicality text,
    airtable_created timestamp with time zone,
    airtable_modified timestamp with time zone,
    fields jsonb DEFAULT '{}'::jsonb NOT NULL,
    synced_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT airtable_contacts_pkey PRIMARY KEY (base_key, record_id),
    CONSTRAINT airtable_contacts_base_key_check CHECK (base_key ~ '^[a-z0-9_]{1,40}$'),
    CONSTRAINT airtable_contacts_record_id_check CHECK (record_id ~ '^rec[A-Za-z0-9]{14}$'),
    CONSTRAINT airtable_contacts_company_record_id_check CHECK (company_record_id IS NULL OR company_record_id ~ '^rec[A-Za-z0-9]{14}$'),
    CONSTRAINT airtable_contacts_fields_check CHECK (jsonb_typeof(fields) = 'object'),
    CONSTRAINT airtable_contacts_lengths CHECK (
        coalesce(char_length(persona_slug), 0) <= 300 AND coalesce(char_length(persona_url), 0) <= 1000
        AND coalesce(char_length(full_name), 0) <= 500 AND coalesce(char_length(title), 0) <= 1000
        AND coalesce(char_length(approve_status), 0) <= 100 AND coalesce(char_length(readiness), 0) <= 200
        AND coalesce(char_length(technicality), 0) <= 200)
);

CREATE INDEX airtable_contacts_persona_slug_idx ON public.airtable_contacts USING btree (persona_slug) WHERE (persona_slug IS NOT NULL);
CREATE INDEX airtable_contacts_company_idx ON public.airtable_contacts USING btree (base_key, company_record_id) WHERE (company_record_id IS NOT NULL);

CREATE TABLE public.lead_company_links (
    instance_id text NOT NULL,
    profile_url text NOT NULL,
    base_key text NOT NULL,
    company_record_id text NOT NULL,
    contact_record_id text,
    method text NOT NULL,
    linked_by bigint,
    linked_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT lead_company_links_pkey PRIMARY KEY (instance_id, profile_url),
    CONSTRAINT lead_company_links_instance_id_fkey FOREIGN KEY (instance_id)
        REFERENCES public.instances(id) ON DELETE CASCADE,
    CONSTRAINT lead_company_links_company_fkey FOREIGN KEY (base_key, company_record_id)
        REFERENCES public.airtable_companies(base_key, record_id),
    CONSTRAINT lead_company_links_linked_by_fkey FOREIGN KEY (linked_by)
        REFERENCES public.team_members(id) ON DELETE SET NULL,
    CONSTRAINT lead_company_links_method_check CHECK (method = ANY (ARRAY['contact_slug'::text, 'manual'::text])),
    CONSTRAINT lead_company_links_contact_check CHECK (
        (method = 'contact_slug' AND contact_record_id IS NOT NULL) OR method = 'manual'),
    CONSTRAINT lead_company_links_profile_url_length CHECK (char_length(profile_url) <= 1000)
);

CREATE INDEX lead_company_links_company_idx ON public.lead_company_links USING btree (base_key, company_record_id);

CREATE TABLE public.airtable_sync_state (
    base_key text NOT NULL,
    table_key text NOT NULL,
    cursor timestamp with time zone,
    run_started_at timestamp with time zone,
    pending_offset text,
    last_run_at timestamp with time zone,
    last_error text,
    rows_upserted integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT airtable_sync_state_pkey PRIMARY KEY (base_key, table_key),
    CONSTRAINT airtable_sync_state_base_key_check CHECK (base_key ~ '^[a-z0-9_]{1,40}$'),
    CONSTRAINT airtable_sync_state_table_key_check CHECK (table_key = ANY (ARRAY['companies'::text, 'contacts'::text])),
    CONSTRAINT airtable_sync_state_lengths CHECK (
        coalesce(char_length(pending_offset), 0) <= 500 AND coalesce(char_length(last_error), 0) <= 1000)
);

CREATE TRIGGER touch_airtable_sync_state_updated_at BEFORE UPDATE ON public.airtable_sync_state
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.countries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.country_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.airtable_companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.airtable_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_company_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.airtable_sync_state ENABLE ROW LEVEL SECURITY;

-- Reference data: every role that writes a lead or a company resolves a
-- country through the triggers above, so every one of them reads it.
CREATE POLICY countries_read ON public.countries
    FOR SELECT TO app_runtime, app_readonly, app_machine, app_system, app_ai_runner
    USING (true);
CREATE POLICY country_aliases_read ON public.country_aliases
    FOR SELECT TO app_runtime, app_readonly, app_machine, app_system, app_ai_runner
    USING (true);

CREATE POLICY airtable_companies_active_member ON public.airtable_companies
    FOR ALL TO app_runtime, app_readonly
    USING (public.is_active_team_member())
    WITH CHECK (public.is_active_team_member());
CREATE POLICY airtable_contacts_active_member ON public.airtable_contacts
    FOR ALL TO app_runtime, app_readonly
    USING (public.is_active_team_member())
    WITH CHECK (public.is_active_team_member());
CREATE POLICY lead_company_links_active_member ON public.lead_company_links
    FOR ALL TO app_runtime, app_readonly
    USING (public.is_active_team_member())
    WITH CHECK (public.is_active_team_member());
-- DELETE is granted to members only to drop a manual link.
CREATE POLICY lead_company_links_manual_delete ON public.lead_company_links
    AS RESTRICTIVE FOR DELETE TO app_runtime
    USING (method = 'manual');
CREATE POLICY airtable_sync_state_active_member ON public.airtable_sync_state
    FOR ALL TO app_runtime, app_readonly
    USING (public.is_active_team_member())
    WITH CHECK (public.is_active_team_member());

CREATE POLICY airtable_companies_system_actor ON public.airtable_companies
    FOR ALL TO app_system
    USING (current_setting('app.actor_id', true) = '00000000-0000-0000-0000-000000000000')
    WITH CHECK (current_setting('app.actor_id', true) = '00000000-0000-0000-0000-000000000000');
CREATE POLICY airtable_contacts_system_actor ON public.airtable_contacts
    FOR ALL TO app_system
    USING (current_setting('app.actor_id', true) = '00000000-0000-0000-0000-000000000000')
    WITH CHECK (current_setting('app.actor_id', true) = '00000000-0000-0000-0000-000000000000');
CREATE POLICY lead_company_links_system_actor ON public.lead_company_links
    FOR ALL TO app_system
    USING (current_setting('app.actor_id', true) = '00000000-0000-0000-0000-000000000000')
    WITH CHECK (current_setting('app.actor_id', true) = '00000000-0000-0000-0000-000000000000');
CREATE POLICY airtable_sync_state_system_actor ON public.airtable_sync_state
    FOR ALL TO app_system
    USING (current_setting('app.actor_id', true) = '00000000-0000-0000-0000-000000000000')
    WITH CHECK (current_setting('app.actor_id', true) = '00000000-0000-0000-0000-000000000000');

CREATE POLICY airtable_companies_ai_read ON public.airtable_companies FOR SELECT TO app_ai_runner USING (true);
CREATE POLICY airtable_contacts_ai_read ON public.airtable_contacts FOR SELECT TO app_ai_runner USING (true);
CREATE POLICY lead_company_links_ai_read ON public.lead_company_links FOR SELECT TO app_ai_runner USING (true);
CREATE POLICY airtable_sync_state_ai_read ON public.airtable_sync_state FOR SELECT TO app_ai_runner USING (true);

REVOKE ALL ON TABLE
    public.countries,
    public.country_aliases,
    public.airtable_companies,
    public.airtable_contacts,
    public.lead_company_links,
    public.airtable_sync_state
    FROM PUBLIC;

GRANT SELECT ON TABLE
    public.countries,
    public.country_aliases
    TO app_runtime, app_readonly, app_machine, app_system, app_ai_runner;
GRANT SELECT ON TABLE
    public.airtable_companies,
    public.airtable_contacts,
    public.lead_company_links,
    public.airtable_sync_state
    TO app_runtime, app_readonly, app_ai_runner;
GRANT SELECT, INSERT, UPDATE ON TABLE
    public.airtable_companies,
    public.airtable_contacts,
    public.lead_company_links,
    public.airtable_sync_state
    TO app_runtime, app_system;
GRANT DELETE ON TABLE public.lead_company_links TO app_runtime;

REVOKE ALL ON FUNCTION public.geo_country_code(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.linkedin_slug(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.refresh_lead_country_code() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.refresh_airtable_company_country_code() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.geo_country_code(text)
    TO app_runtime, app_readonly, app_machine, app_system, app_ai_runner;
GRANT EXECUTE ON FUNCTION public.linkedin_slug(text)
    TO app_runtime, app_readonly, app_system, app_ai_runner;

RESET ROLE;
