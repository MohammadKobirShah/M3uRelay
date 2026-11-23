/**
 * Bangla presentation layer.
 *
 * The upstream (JioTV-Go) speaks English: "Somoy TV", "Bangla Entertainment".
 * This module adds a Bangla name and a Bangla group label for the panel, plus
 * the search aliases that make typing Bangla work. Everything is additive: an
 * unknown channel or group keeps its original text, so nothing breaks when the
 * playlist changes.
 */

export function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/\+/g, 'plus')
    .replace(/[^a-z0-9]+/g, '');
}

/* -------------------------------------------------------------------------- */
/* groups                                                                     */
/* -------------------------------------------------------------------------- */

const GROUP_EXACT = new Map(
  Object.entries({
    entertainment: 'বিনোদন',
    news: 'সংবাদ',
    movies: 'সিনেমা',
    movie: 'সিনেমা',
    sports: 'খেলাধুলা',
    sport: 'খেলাধুলা',
    kids: 'শিশুতোষ',
    children: 'শিশুতোষ',
    music: 'সংগীত',
    devotional: 'ধর্মীয়',
    religious: 'ধর্মীয়',
    spiritual: 'আধ্যাত্মিক',
    lifestyle: 'লাইফস্টাইল',
    education: 'শিক্ষা',
    educational: 'শিক্ষা',
    food: 'রান্না-বাটি',
    cooking: 'রান্না-বাটি',
    comedy: 'কমেডি',
    drama: 'নাটক',
    business: 'ব্যবসা',
    shopping: 'শপিং',
    travel: 'ভ্রমণ',
    documentary: 'ডকুমেন্টারি',
    regional: 'আঞ্চলিক',
    infotainment: 'তথ্য-বিনোদন',
    foreign: 'বিদেশি',
    international: 'আন্তর্জাতিক',
    other: 'অন্যান্য',
    others: 'অন্যান্য',
    misc: 'বিবিধ',
    devotionalandspiritual: 'ধর্মীয়',
    bangla: 'বাংলা',
    bengali: 'বাংলা',
    hindi: 'হিন্দি',
    english: 'ইংরেজি',
    tamil: 'তামিল',
    telugu: 'তেলুগু',
    kannada: 'কন্নড়',
    malayalam: 'মালায়ালাম',
    marathi: 'মারাঠি',
    punjabi: 'পাঞ্জাবি',
    gujarati: 'গুজরাটি',
    odia: 'ওড়িয়া',
    oriya: 'ওড়িয়া',
    assamese: 'অসমীয়া',
    urdu: 'উর্দু',
    bhojpuri: 'ভোজপুরি',
    nepali: 'নেপালি',
    sanskrit: 'সংস্কৃত',
  }),
);

const GROUP_WORDS = [
  ['bangla', 'বাংলা'],
  ['bengali', 'বাংলা'],
  ['hindi', 'হিন্দি'],
  ['english', 'ইংরেজি'],
  ['tamil', 'তামিল'],
  ['telugu', 'তেলুগু'],
  ['kannada', 'কন্নড়'],
  ['malayalam', 'মালায়ালাম'],
  ['marathi', 'মারাঠি'],
  ['punjabi', 'পাঞ্জাবি'],
  ['gujarati', 'গুজরাটি'],
  ['odia', 'ওড়িয়া'],
  ['oriya', 'ওড়িয়া'],
  ['assamese', 'অসমীয়া'],
  ['urdu', 'উর্দু'],
  ['bhojpuri', 'ভোজপুরি'],
  ['nepali', 'নেপালি'],
  ['sports', 'খেলাধুলা'],
  ['sport', 'খেলাধুলা'],
  ['news', 'সংবাদ'],
  ['entertainment', 'বিনোদন'],
  ['movies', 'সিনেমা'],
  ['movie', 'সিনেমা'],
  ['kids', 'শিশুতোষ'],
  ['children', 'শিশুতোষ'],
  ['music', 'সংগীত'],
  ['devotional', 'ধর্মীয়'],
  ['spiritual', 'আধ্যাত্মিক'],
  ['comedy', 'কমেডি'],
  ['drama', 'নাটক'],
  ['lifestyle', 'লাইফস্টাইল'],
  ['education', 'শিক্ষা'],
  ['business', 'ব্যবসা'],
  ['travel', 'ভ্রমণ'],
  ['documentary', 'ডকুমেন্টারি'],
  ['regional', 'আঞ্চলিক'],
  ['infotainment', 'তথ্য-বিনোদন'],
  ['foreign', 'বিদেশি'],
];

/** Bangla label for a group-title, or null when we have no translation. */
export function banglaGroupName(group) {
  const raw = String(group || '').trim();
  if (!raw) return null;
  const key = normalizeName(raw);
  if (!key) return null;
  if (GROUP_EXACT.has(key)) return GROUP_EXACT.get(key);

  const words = raw.toLowerCase().split(/[^a-z0-9+]+/).filter(Boolean);
  const found = [];
  for (const word of words) {
    const hit = GROUP_WORDS.find(([latin]) => latin === word);
    if (hit && !found.includes(hit[1])) found.push(hit[1]);
  }
  if (!found.length) return null;
  return found.slice(0, 2).join(' ');
}

/* -------------------------------------------------------------------------- */
/* channels                                                                   */
/* -------------------------------------------------------------------------- */

/** [Bangla name, ...English spellings that should resolve to it] */
const CHANNELS = [
  // ---- Bangladesh ----
  ['বিটিভি ন্যাশনাল', ['BTV National', 'BTV', 'Bangladesh Television', 'BTV HD']],
  ['বিটিভি ওয়ার্ল্ড', ['BTV World']],
  ['বিটিভি চট্টগ্রাম', ['BTV Chattogram', 'BTV Chittagong']],
  ['সংসদ টিভি', ['Sangsad TV', 'Sangsad Bangladesh TV', 'Sangsad']],
  ['সময় টিভি', ['Somoy TV', 'Somoy News', 'Somoy']],
  ['চ্যানেল আই', ['Channel i', 'Channel I', 'Channeli']],
  ['এনটিভি', ['NTV', 'NTV Bangladesh']],
  ['আরটিভি', ['RTV', 'RTV Bangladesh']],
  ['এটিএন বাংলা', ['ATN Bangla']],
  ['এটিএন নিউজ', ['ATN News']],
  ['চ্যানেল ২৪', ['Channel 24', 'Channel24']],
  ['নিউজ ২৪', ['News 24', 'News24']],
  ['ডিবিসি নিউজ', ['DBC News']],
  ['ডিবিসি টিভি', ['DBC TV']],
  ['একাত্তর টিভি', ['Ekattor TV', 'Ekattor', 'Ekattor TV HD']],
  ['ইনডিপেনডেন্ট টিভি', ['Independent TV', 'Independent Television']],
  ['মাছরাঙা টিভি', ['Maasranga TV', 'Maasranga', 'Masranga TV']],
  ['বাংলাভিশন', ['Bangla Vision', 'Banglavision', 'BanglaVision']],
  ['বৈশাখী টিভি', ['Boishakhi TV', 'Boishakhi']],
  ['যমুনা টিভি', ['Jamuna TV', 'Jamuna']],
  ['গাজী টিভি', ['Gazi TV', 'Gazi Television']],
  ['জিটিভি', ['GTV', 'G TV']],
  ['নাগরিক টিভি', ['Nagorik TV', 'Nagorik']],
  ['একুশে টিভি', ['Ekushey TV', 'Ekushey', 'ETV']],
  ['এসএ টিভি', ['SA TV', 'SATV']],
  ['দেশ টিভি', ['Desh TV']],
  ['মোহনা টিভি', ['Mohona TV', 'Mohona']],
  ['এশিয়ান টিভি', ['Asian TV']],
  ['চ্যানেল ৯', ['Channel 9']],
  ['চ্যানেল ওয়ান', ['Channel One']],
  ['বিজয় টিভি', ['Bijoy TV', 'Bijoy']],
  ['মাই টিভি', ['My TV', 'MyTV']],
  ['দুরন্ত টিভি', ['Duronto TV', 'Duronto']],
  ['দীপ্ত টিভি', ['Deepto TV', 'Deepto', 'Deepto Entertainment']],
  ['ইসলামিক টিভি', ['Islamic TV']],
  ['পিস টিভি বাংলা', ['Peace TV Bangla', 'Peace TV Bengali']],
  ['স্টার জলসা', ['Star Jalsha']],
  ['জি বাংলা', ['Zee Bangla']],
  ['কালারস বাংলা', ['Colors Bangla', 'Colours Bangla']],
  ['সনি আট', ['Sony Aath', 'Sony Aat']],
  ['সান বাংলা', ['Sun Bangla']],
  ['এন্টার ১০ বাংলা', ['Enterr10 Bangla', 'Enter 10 Bangla', 'Enterr10 Bengali']],
  ['রূপসী বাংলা', ['Ruposhi Bangla']],
  ['আকাশ আট', ['Aakash Aath', 'Akash Aath']],
  ['সংগীত বাংলা', ['Sangeet Bangla']],
  ['খুশবু বাংলা', ['Khushboo Bangla', 'Khushboo TV']],
  ['বাংলা টিভি', ['Bangla TV']],
  // ---- Hindi and national ----
  ['স্টার প্লাস', ['Star Plus']],
  ['স্টার গোল্ড', ['Star Gold']],
  ['স্টার উৎসব', ['Star Utsav']],
  ['স্টার ভারত', ['Star Bharat']],
  ['স্টার মুভিজ', ['Star Movies']],
  ['স্টার স্পোর্টস ১', ['Star Sports 1']],
  ['স্টার স্পোর্টস ১ হিন্দি', ['Star Sports 1 Hindi']],
  ['স্টার স্পোর্টস ২', ['Star Sports 2']],
  ['জি টিভি', ['Zee TV']],
  ['জি সিনেমা', ['Zee Cinema']],
  ['জি নিউজ', ['Zee News']],
  ['জি অ্যাকশন', ['Zee Action']],
  ['সনি টিভি', ['Sony Entertainment Television', 'Sony TV', 'SET']],
  ['সনি সাব', ['Sony SAB', 'SAB TV']],
  ['সনি ম্যাক্স', ['Sony MAX', 'SET MAX', 'Max']],
  ['সনি পিক্স', ['Sony PIX']],
  ['কালারস', ['Colors', 'Colors TV', 'Colours']],
  ['আজ তক', ['Aaj Tak']],
  ['এবিপি নিউজ', ['ABP News']],
  ['এনডিটিভি ইন্ডিয়া', ['NDTV India']],
  ['এনডিটিভি ২৪x৭', ['NDTV 24x7', 'NDTV 24X7']],
  ['ইন্ডিয়া টিভি', ['India TV']],
  ['রিপাবলিক ভারতে', ['Republic Bharat']],
  ['ডিডি নিউজ', ['DD News']],
  ['ডিডি ন্যাশনাল', ['DD National']],
  ['ডিডি স্পোর্টস', ['DD Sports']],
  ['দঙ্গল', ['Dangal', 'Dangal TV']],
  ['বিগ ম্যাজিক', ['Big Magic']],
  ['কার্টুন নেটওয়ার্ক', ['Cartoon Network', 'CN']],
  ['পোগো', ['Pogo', 'Pogo TV']],
  ['নিকেলোডিয়ন', ['Nickelodeon', 'Nick']],
  ['ডিসকভারি', ['Discovery', 'Discovery Channel']],
  ['ন্যাশনাল জিওগ্রাফিক', ['National Geographic', 'Nat Geo', 'NatGeo']],
  ['অ্যানিমেল প্ল্যানেট', ['Animal Planet']],
  ['হিস্টরি টিভি ১৮', ['History TV18', 'History TV 18']],
  ['ট্রাভেল এক্সপি', ['Travelxp', 'Travel XP']],
  ['সনি টেন ১', ['Sony Ten 1', 'Ten 1']],
  ['সনি টেন ২', ['Sony Ten 2', 'Ten 2']],
  ['সনি টেন ৩', ['Sony Ten 3', 'Ten 3']],
  ['ইউরোস্পোর্ট', ['EuroSport', 'Eurosport']],
];

const CHANNEL_INDEX = new Map();
for (const [bn, aliases] of CHANNELS) {
  for (const alias of [bn, ...aliases]) {
    const key = normalizeName(alias);
    if (key && !CHANNEL_INDEX.has(key)) CHANNEL_INDEX.set(key, bn);
  }
}

/** Bangla name for a channel, or null when we do not know it. */
export function banglaChannelName(name) {
  const key = normalizeName(name);
  if (!key) return null;
  const hit = CHANNEL_INDEX.get(key);
  if (hit) return hit;
  // "Star Jalsha HD", "Sony SAB 4K" …
  const stripped = key.replace(/(hd|uhd|4k|8k|sd|hevc|plus)$/, '');
  if (stripped && stripped !== key) return CHANNEL_INDEX.get(stripped) || null;
  return null;
}

/** Everything the panel should match when the user types in the search box. */
export function searchTerms(channel) {
  const terms = [channel.name, channel.id, channel.group, channel.language];
  const bn = banglaChannelName(channel.name);
  if (bn) terms.push(bn);
  const groupBn = banglaGroupName(channel.group);
  if (groupBn) terms.push(groupBn);
  return terms.filter(Boolean).map((term) => String(term));
}
