// Place → IANA time zone, resolved on device.
//
// The point of this table is that Qwen never has to remember a UTC offset. An
// offset is a fact that changes twice a year, differs by country, and is
// exactly the kind of thing a 4B model states confidently and wrongly. What the
// device HAS is the IANA tz database — the same one java.time reads, kept
// current by the OS — reachable through Intl with a zone id. So the only thing
// that needs to be known here is which zone id a spoken place means, and that
// is a lookup, not a calculation.
//
// Two kinds of entry:
//
//   single   the place has one zone anyone would mean by it. Norway is
//            Europe/Oslo. Japan is Asia/Tokyo. Some of these are simplifying —
//            Spain also has Atlantic/Canary, Portugal the Azores, Chile Easter
//            Island — but "what time is it in Spain" means Madrid to everyone
//            who has ever asked it, and answering Madrid is right.
//
//   ambiguous  the place genuinely spans zones people mean differently. "What
//            time is it in the United States" has no answer; asking which city
//            is the only honest response, and the alternative — picking New
//            York because it is the biggest — is wrong three hours out of four.
//
// Pure data and pure lookup. No clock, no platform.

export type ZoneLookup =
  | { status: "resolved"; zone: string; label: string }
  | { status: "ambiguous"; place: string; examples: string[] }
  | { status: "unknown" };

/** Cities, and the regions that name one unambiguously. */
const CITIES: Record<string, string> = {
  // Europe
  oslo: "Europe/Oslo", bergen: "Europe/Oslo", trondheim: "Europe/Oslo",
  stockholm: "Europe/Stockholm", copenhagen: "Europe/Copenhagen",
  "københavn": "Europe/Copenhagen", helsinki: "Europe/Helsinki",
  reykjavik: "Atlantic/Reykjavik", "reykjavík": "Atlantic/Reykjavik",
  london: "Europe/London", manchester: "Europe/London", edinburgh: "Europe/London",
  glasgow: "Europe/London", belfast: "Europe/London", cardiff: "Europe/London",
  dublin: "Europe/Dublin", paris: "Europe/Paris", lyon: "Europe/Paris",
  marseille: "Europe/Paris", brussels: "Europe/Brussels", bruxelles: "Europe/Brussels",
  amsterdam: "Europe/Amsterdam", rotterdam: "Europe/Amsterdam",
  berlin: "Europe/Berlin", munich: "Europe/Berlin", "münchen": "Europe/Berlin",
  hamburg: "Europe/Berlin", frankfurt: "Europe/Berlin", cologne: "Europe/Berlin",
  vienna: "Europe/Vienna", wien: "Europe/Vienna",
  zurich: "Europe/Zurich", "zürich": "Europe/Zurich", geneva: "Europe/Zurich",
  bern: "Europe/Zurich", basel: "Europe/Zurich",
  rome: "Europe/Rome", roma: "Europe/Rome", milan: "Europe/Rome",
  milano: "Europe/Rome", naples: "Europe/Rome", napoli: "Europe/Rome",
  turin: "Europe/Rome", torino: "Europe/Rome", venice: "Europe/Rome",
  venezia: "Europe/Rome", florence: "Europe/Rome", firenze: "Europe/Rome",
  palermo: "Europe/Rome", bologna: "Europe/Rome",
  madrid: "Europe/Madrid", barcelona: "Europe/Madrid", valencia: "Europe/Madrid",
  seville: "Europe/Madrid", lisbon: "Europe/Lisbon", lisboa: "Europe/Lisbon",
  porto: "Europe/Lisbon", athens: "Europe/Athens", atene: "Europe/Athens",
  warsaw: "Europe/Warsaw", krakow: "Europe/Warsaw", prague: "Europe/Prague",
  praha: "Europe/Prague", budapest: "Europe/Budapest",
  bucharest: "Europe/Bucharest", sofia: "Europe/Sofia", belgrade: "Europe/Belgrade",
  zagreb: "Europe/Zagreb", ljubljana: "Europe/Ljubljana", bratislava: "Europe/Bratislava",
  tallinn: "Europe/Tallinn", riga: "Europe/Riga", vilnius: "Europe/Vilnius",
  kyiv: "Europe/Kyiv", kiev: "Europe/Kyiv",
  moscow: "Europe/Moscow", "mosca": "Europe/Moscow",
  "saint petersburg": "Europe/Moscow", "st petersburg": "Europe/Moscow",
  istanbul: "Europe/Istanbul", ankara: "Europe/Istanbul",
  malta: "Europe/Malta", luxembourg: "Europe/Luxembourg", monaco: "Europe/Monaco",
  // Africa & Middle East
  cairo: "Africa/Cairo", "il cairo": "Africa/Cairo",
  "cape town": "Africa/Johannesburg", johannesburg: "Africa/Johannesburg",
  pretoria: "Africa/Johannesburg", durban: "Africa/Johannesburg",
  lagos: "Africa/Lagos", abuja: "Africa/Lagos", accra: "Africa/Accra",
  nairobi: "Africa/Nairobi", "addis ababa": "Africa/Addis_Ababa",
  casablanca: "Africa/Casablanca", tunis: "Africa/Tunis", algiers: "Africa/Algiers",
  "tel aviv": "Asia/Jerusalem", jerusalem: "Asia/Jerusalem",
  dubai: "Asia/Dubai", "abu dhabi": "Asia/Dubai", doha: "Asia/Qatar",
  riyadh: "Asia/Riyadh", jeddah: "Asia/Riyadh", kuwait: "Asia/Kuwait",
  tehran: "Asia/Tehran", baghdad: "Asia/Baghdad", beirut: "Asia/Beirut",
  amman: "Asia/Amman", muscat: "Asia/Muscat",
  // Asia
  tokyo: "Asia/Tokyo", osaka: "Asia/Tokyo", kyoto: "Asia/Tokyo",
  yokohama: "Asia/Tokyo", sapporo: "Asia/Tokyo",
  seoul: "Asia/Seoul", busan: "Asia/Seoul", pyongyang: "Asia/Pyongyang",
  beijing: "Asia/Shanghai", "pechino": "Asia/Shanghai", shanghai: "Asia/Shanghai",
  shenzhen: "Asia/Shanghai", guangzhou: "Asia/Shanghai", chengdu: "Asia/Shanghai",
  "hong kong": "Asia/Hong_Kong", macau: "Asia/Macau", taipei: "Asia/Taipei",
  singapore: "Asia/Singapore", "kuala lumpur": "Asia/Kuala_Lumpur",
  bangkok: "Asia/Bangkok", hanoi: "Asia/Ho_Chi_Minh",
  "ho chi minh city": "Asia/Ho_Chi_Minh", saigon: "Asia/Ho_Chi_Minh",
  manila: "Asia/Manila", jakarta: "Asia/Jakarta", bali: "Asia/Makassar",
  denpasar: "Asia/Makassar",
  delhi: "Asia/Kolkata", "new delhi": "Asia/Kolkata", mumbai: "Asia/Kolkata",
  bombay: "Asia/Kolkata", bangalore: "Asia/Kolkata", bengaluru: "Asia/Kolkata",
  kolkata: "Asia/Kolkata", calcutta: "Asia/Kolkata", chennai: "Asia/Kolkata",
  hyderabad: "Asia/Kolkata", karachi: "Asia/Karachi", lahore: "Asia/Karachi",
  islamabad: "Asia/Karachi", dhaka: "Asia/Dhaka", colombo: "Asia/Colombo",
  kathmandu: "Asia/Kathmandu", "ulaanbaatar": "Asia/Ulaanbaatar",
  tashkent: "Asia/Tashkent", "almaty": "Asia/Almaty", baku: "Asia/Baku",
  tbilisi: "Asia/Tbilisi", yerevan: "Asia/Yerevan", kabul: "Asia/Kabul",
  // Oceania
  sydney: "Australia/Sydney", melbourne: "Australia/Melbourne",
  canberra: "Australia/Sydney", brisbane: "Australia/Brisbane",
  perth: "Australia/Perth", adelaide: "Australia/Adelaide",
  darwin: "Australia/Darwin", hobart: "Australia/Hobart",
  auckland: "Pacific/Auckland", wellington: "Pacific/Auckland",
  christchurch: "Pacific/Auckland", fiji: "Pacific/Fiji", suva: "Pacific/Fiji",
  // Americas
  "new york": "America/New_York", nyc: "America/New_York",
  "new york city": "America/New_York", boston: "America/New_York",
  philadelphia: "America/New_York", washington: "America/New_York",
  "washington dc": "America/New_York", atlanta: "America/New_York",
  miami: "America/New_York", orlando: "America/New_York",
  detroit: "America/Detroit", toronto: "America/Toronto",
  montreal: "America/Toronto", ottawa: "America/Toronto",
  chicago: "America/Chicago", houston: "America/Chicago",
  dallas: "America/Chicago", austin: "America/Chicago",
  "new orleans": "America/Chicago", minneapolis: "America/Chicago",
  "mexico city": "America/Mexico_City", winnipeg: "America/Winnipeg",
  denver: "America/Denver", "salt lake city": "America/Denver",
  phoenix: "America/Phoenix", calgary: "America/Edmonton",
  edmonton: "America/Edmonton",
  "los angeles": "America/Los_Angeles", la: "America/Los_Angeles",
  "san francisco": "America/Los_Angeles", "san diego": "America/Los_Angeles",
  seattle: "America/Los_Angeles", portland: "America/Los_Angeles",
  "las vegas": "America/Los_Angeles", vancouver: "America/Vancouver",
  anchorage: "America/Anchorage", honolulu: "Pacific/Honolulu",
  hawaii: "Pacific/Honolulu",
  "sao paulo": "America/Sao_Paulo", "são paulo": "America/Sao_Paulo",
  "rio de janeiro": "America/Sao_Paulo", rio: "America/Sao_Paulo",
  brasilia: "America/Sao_Paulo", "buenos aires": "America/Argentina/Buenos_Aires",
  santiago: "America/Santiago", lima: "America/Lima", bogota: "America/Bogota",
  "bogotá": "America/Bogota", caracas: "America/Caracas", quito: "America/Guayaquil",
  "la paz": "America/La_Paz", montevideo: "America/Montevideo",
  asuncion: "America/Asuncion", havana: "America/Havana",
  kingston: "America/Jamaica", "san juan": "America/Puerto_Rico",
  "panama city": "America/Panama", "san jose": "America/Costa_Rica",
};

/** Countries and regions with one zone anyone asking would mean. */
const COUNTRIES: Record<string, string> = {
  norway: "Europe/Oslo", norvegia: "Europe/Oslo",
  sweden: "Europe/Stockholm", svezia: "Europe/Stockholm",
  denmark: "Europe/Copenhagen", danimarca: "Europe/Copenhagen",
  finland: "Europe/Helsinki", finlandia: "Europe/Helsinki",
  iceland: "Atlantic/Reykjavik", islanda: "Atlantic/Reykjavik",
  ireland: "Europe/Dublin", irlanda: "Europe/Dublin",
  "united kingdom": "Europe/London", uk: "Europe/London",
  britain: "Europe/London", "great britain": "Europe/London",
  england: "Europe/London", scotland: "Europe/London", wales: "Europe/London",
  "northern ireland": "Europe/London", "regno unito": "Europe/London",
  inghilterra: "Europe/London", scozia: "Europe/London",
  france: "Europe/Paris", francia: "Europe/Paris",
  belgium: "Europe/Brussels", belgio: "Europe/Brussels",
  netherlands: "Europe/Amsterdam", holland: "Europe/Amsterdam",
  "paesi bassi": "Europe/Amsterdam", olanda: "Europe/Amsterdam",
  germany: "Europe/Berlin", germania: "Europe/Berlin",
  austria: "Europe/Vienna", switzerland: "Europe/Zurich",
  svizzera: "Europe/Zurich", italy: "Europe/Rome", italia: "Europe/Rome",
  spain: "Europe/Madrid", spagna: "Europe/Madrid",
  portugal: "Europe/Lisbon", portogallo: "Europe/Lisbon",
  greece: "Europe/Athens", grecia: "Europe/Athens",
  poland: "Europe/Warsaw", polonia: "Europe/Warsaw",
  "czech republic": "Europe/Prague", czechia: "Europe/Prague",
  "repubblica ceca": "Europe/Prague",
  hungary: "Europe/Budapest", ungheria: "Europe/Budapest",
  romania: "Europe/Bucharest", bulgaria: "Europe/Sofia",
  serbia: "Europe/Belgrade", croatia: "Europe/Zagreb", croazia: "Europe/Zagreb",
  slovenia: "Europe/Ljubljana", slovakia: "Europe/Bratislava",
  estonia: "Europe/Tallinn", latvia: "Europe/Riga", lithuania: "Europe/Vilnius",
  ukraine: "Europe/Kyiv", ucraina: "Europe/Kyiv",
  turkey: "Europe/Istanbul", turchia: "Europe/Istanbul",
  israel: "Asia/Jerusalem", israele: "Asia/Jerusalem",
  egypt: "Africa/Cairo", egitto: "Africa/Cairo",
  "south africa": "Africa/Johannesburg", sudafrica: "Africa/Johannesburg",
  kenya: "Africa/Nairobi", nigeria: "Africa/Lagos", ghana: "Africa/Accra",
  morocco: "Africa/Casablanca", marocco: "Africa/Casablanca",
  tunisia: "Africa/Tunis", algeria: "Africa/Algiers", ethiopia: "Africa/Addis_Ababa",
  japan: "Asia/Tokyo", giappone: "Asia/Tokyo",
  "south korea": "Asia/Seoul", korea: "Asia/Seoul", "corea del sud": "Asia/Seoul",
  "north korea": "Asia/Pyongyang",
  china: "Asia/Shanghai", cina: "Asia/Shanghai",
  taiwan: "Asia/Taipei", "hong kong": "Asia/Hong_Kong",
  singapore: "Asia/Singapore", malaysia: "Asia/Kuala_Lumpur",
  thailand: "Asia/Bangkok", thailandia: "Asia/Bangkok",
  vietnam: "Asia/Ho_Chi_Minh", philippines: "Asia/Manila",
  filippine: "Asia/Manila",
  india: "Asia/Kolkata", pakistan: "Asia/Karachi", bangladesh: "Asia/Dhaka",
  "sri lanka": "Asia/Colombo", nepal: "Asia/Kathmandu", mongolia: "Asia/Ulaanbaatar",
  uzbekistan: "Asia/Tashkent", azerbaijan: "Asia/Baku", georgia: "Asia/Tbilisi",
  armenia: "Asia/Yerevan", afghanistan: "Asia/Kabul", iran: "Asia/Tehran",
  iraq: "Asia/Baghdad", lebanon: "Asia/Beirut", jordan: "Asia/Amman",
  "saudi arabia": "Asia/Riyadh", "arabia saudita": "Asia/Riyadh",
  qatar: "Asia/Qatar", kuwait: "Asia/Kuwait", oman: "Asia/Muscat",
  uae: "Asia/Dubai", "united arab emirates": "Asia/Dubai",
  "new zealand": "Pacific/Auckland", "nuova zelanda": "Pacific/Auckland",
  argentina: "America/Argentina/Buenos_Aires", chile: "America/Santiago",
  cile: "America/Santiago", peru: "America/Lima", "perù": "America/Lima",
  colombia: "America/Bogota", venezuela: "America/Caracas",
  ecuador: "America/Guayaquil", bolivia: "America/La_Paz",
  uruguay: "America/Montevideo", paraguay: "America/Asuncion",
  cuba: "America/Havana", jamaica: "America/Jamaica",
  "puerto rico": "America/Puerto_Rico", panama: "America/Panama",
  "costa rica": "America/Costa_Rica", guatemala: "America/Guatemala",
};

/**
 * Places that genuinely span zones, with the cities worth offering back.
 *
 * Asking is the right answer here, not a default. The whole reason this module
 * exists is that Vesta should stop producing confident times nobody can check.
 */
const AMBIGUOUS: Record<string, { label: string; examples: string[] }> = {
  "united states": { label: "the United States", examples: ["New York", "Chicago", "Denver", "Los Angeles"] },
  usa: { label: "the United States", examples: ["New York", "Chicago", "Denver", "Los Angeles"] },
  us: { label: "the United States", examples: ["New York", "Chicago", "Denver", "Los Angeles"] },
  "the us": { label: "the United States", examples: ["New York", "Chicago", "Denver", "Los Angeles"] },
  america: { label: "the United States", examples: ["New York", "Chicago", "Denver", "Los Angeles"] },
  "stati uniti": { label: "gli Stati Uniti", examples: ["New York", "Chicago", "Denver", "Los Angeles"] },
  canada: { label: "Canada", examples: ["Toronto", "Winnipeg", "Calgary", "Vancouver"] },
  australia: { label: "Australia", examples: ["Sydney", "Adelaide", "Brisbane", "Perth"] },
  russia: { label: "Russia", examples: ["Moscow", "Yekaterinburg", "Novosibirsk", "Vladivostok"] },
  brazil: { label: "Brazil", examples: ["São Paulo", "Manaus", "Rio Branco"] },
  brasile: { label: "il Brasile", examples: ["São Paulo", "Manaus", "Rio Branco"] },
  mexico: { label: "Mexico", examples: ["Mexico City", "Chihuahua", "Tijuana"] },
  messico: { label: "il Messico", examples: ["Città del Messico", "Chihuahua", "Tijuana"] },
  indonesia: { label: "Indonesia", examples: ["Jakarta", "Bali", "Jayapura"] },
  kazakhstan: { label: "Kazakhstan", examples: ["Almaty", "Aqtobe"] },
  greenland: { label: "Greenland", examples: ["Nuuk", "Ittoqqortoormiit"] },
  "dr congo": { label: "the DR Congo", examples: ["Kinshasa", "Lubumbashi"] },
  "democratic republic of the congo": { label: "the DR Congo", examples: ["Kinshasa", "Lubumbashi"] },
  antarctica: { label: "Antarctica", examples: ["McMurdo", "Rothera"] },
};

/** Normalised lookup key: lowercase, no accents-stripping, no punctuation. */
function key(place: string): string {
  return place
    .toLowerCase()
    .replace(/^(?:the|in|a|at|il|lo|la|gli|le|nel|nella|negli)\s+/u, "")
    .replace(/[?!.,;:'"]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

/** A readable name for a zone id, for when we have to say which we used. */
export function zoneLabel(zone: string): string {
  const tail = zone.split("/").pop() ?? zone;
  return tail.replace(/_/g, " ");
}

/**
 * The zone a spoken place means.
 *
 * Cities win over countries: "Georgia" is a US state and a country, but
 * nobody types it as a city here, whereas "Kansas City" must not be read as
 * a country. The order also makes the ambiguous list a backstop rather than a
 * trap — "New York" resolves before "United States" is ever consulted.
 */
export function resolveZone(place: string): ZoneLookup {
  const k = key(place);
  if (!k) return { status: "unknown" };

  // An IANA id said outright ("Europe/Oslo").
  if (/^[a-z_]+\/[a-z_+\-/0-9]+$/i.test(place.trim())) {
    return { status: "resolved", zone: place.trim(), label: zoneLabel(place.trim()) };
  }

  const city = CITIES[k];
  if (city) return { status: "resolved", zone: city, label: titleCase(k) };

  const country = COUNTRIES[k];
  if (country) return { status: "resolved", zone: country, label: titleCase(k) };

  const ambiguous = AMBIGUOUS[k];
  if (ambiguous) {
    return { status: "ambiguous", place: ambiguous.label, examples: ambiguous.examples };
  }

  return { status: "unknown" };
}

function titleCase(s: string): string {
  return s.replace(/\b[a-zà-ÿ]/gu, (c) => c.toUpperCase());
}

/** Test seam: the places this table knows, for coverage checks. */
export function knownPlaceCount(): number {
  return Object.keys(CITIES).length + Object.keys(COUNTRIES).length;
}
