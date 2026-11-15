/**
 * Every language a video can be written in. `code` goes to the script writer and is stored on the video; `locale`
 * is what speech recognition listens for in the teleprompter; `flag` is a representative flag, not a claim that a
 * language belongs to one country.
 */
export interface VideoLanguage {
  code: string;
  name: string;
  native: string;
  flag: string;
  locale: string;
}

export const LANGUAGES: VideoLanguage[] = [
  { code: "en", name: "English", native: "English", flag: "🇬🇧", locale: "en-GB" },
  { code: "en-US", name: "English (US)", native: "English (US)", flag: "🇺🇸", locale: "en-US" },
  { code: "el", name: "Greek", native: "Ελληνικά", flag: "🇬🇷", locale: "el-GR" },
  { code: "es", name: "Spanish", native: "Español", flag: "🇪🇸", locale: "es-ES" },
  { code: "es-MX", name: "Spanish (Latin America)", native: "Español (Latinoamérica)", flag: "🇲🇽", locale: "es-MX" },
  { code: "fr", name: "French", native: "Français", flag: "🇫🇷", locale: "fr-FR" },
  { code: "de", name: "German", native: "Deutsch", flag: "🇩🇪", locale: "de-DE" },
  { code: "it", name: "Italian", native: "Italiano", flag: "🇮🇹", locale: "it-IT" },
  { code: "pt", name: "Portuguese", native: "Português", flag: "🇵🇹", locale: "pt-PT" },
  { code: "pt-BR", name: "Portuguese (Brazil)", native: "Português (Brasil)", flag: "🇧🇷", locale: "pt-BR" },
  { code: "nl", name: "Dutch", native: "Nederlands", flag: "🇳🇱", locale: "nl-NL" },
  { code: "sv", name: "Swedish", native: "Svenska", flag: "🇸🇪", locale: "sv-SE" },
  { code: "no", name: "Norwegian", native: "Norsk", flag: "🇳🇴", locale: "nb-NO" },
  { code: "da", name: "Danish", native: "Dansk", flag: "🇩🇰", locale: "da-DK" },
  { code: "fi", name: "Finnish", native: "Suomi", flag: "🇫🇮", locale: "fi-FI" },
  { code: "is", name: "Icelandic", native: "Íslenska", flag: "🇮🇸", locale: "is-IS" },
  { code: "ga", name: "Irish", native: "Gaeilge", flag: "🇮🇪", locale: "ga-IE" },
  { code: "pl", name: "Polish", native: "Polski", flag: "🇵🇱", locale: "pl-PL" },
  { code: "cs", name: "Czech", native: "Čeština", flag: "🇨🇿", locale: "cs-CZ" },
  { code: "sk", name: "Slovak", native: "Slovenčina", flag: "🇸🇰", locale: "sk-SK" },
  { code: "hu", name: "Hungarian", native: "Magyar", flag: "🇭🇺", locale: "hu-HU" },
  { code: "ro", name: "Romanian", native: "Română", flag: "🇷🇴", locale: "ro-RO" },
  { code: "bg", name: "Bulgarian", native: "Български", flag: "🇧🇬", locale: "bg-BG" },
  { code: "hr", name: "Croatian", native: "Hrvatski", flag: "🇭🇷", locale: "hr-HR" },
  { code: "sr", name: "Serbian", native: "Српски", flag: "🇷🇸", locale: "sr-RS" },
  { code: "sl", name: "Slovenian", native: "Slovenščina", flag: "🇸🇮", locale: "sl-SI" },
  { code: "sq", name: "Albanian", native: "Shqip", flag: "🇦🇱", locale: "sq-AL" },
  { code: "mk", name: "Macedonian", native: "Македонски", flag: "🇲🇰", locale: "mk-MK" },
  { code: "uk", name: "Ukrainian", native: "Українська", flag: "🇺🇦", locale: "uk-UA" },
  { code: "ru", name: "Russian", native: "Русский", flag: "🇷🇺", locale: "ru-RU" },
  { code: "lt", name: "Lithuanian", native: "Lietuvių", flag: "🇱🇹", locale: "lt-LT" },
  { code: "lv", name: "Latvian", native: "Latviešu", flag: "🇱🇻", locale: "lv-LV" },
  { code: "et", name: "Estonian", native: "Eesti", flag: "🇪🇪", locale: "et-EE" },
  { code: "mt", name: "Maltese", native: "Malti", flag: "🇲🇹", locale: "mt-MT" },
  { code: "tr", name: "Turkish", native: "Türkçe", flag: "🇹🇷", locale: "tr-TR" },
  { code: "ka", name: "Georgian", native: "ქართული", flag: "🇬🇪", locale: "ka-GE" },
  { code: "hy", name: "Armenian", native: "Հայերեն", flag: "🇦🇲", locale: "hy-AM" },
  { code: "az", name: "Azerbaijani", native: "Azərbaycanca", flag: "🇦🇿", locale: "az-AZ" },
  { code: "kk", name: "Kazakh", native: "Қазақ тілі", flag: "🇰🇿", locale: "kk-KZ" },
  { code: "ar", name: "Arabic", native: "العربية", flag: "🇸🇦", locale: "ar-SA" },
  { code: "he", name: "Hebrew", native: "עברית", flag: "🇮🇱", locale: "he-IL" },
  { code: "fa", name: "Persian", native: "فارسی", flag: "🇮🇷", locale: "fa-IR" },
  { code: "ur", name: "Urdu", native: "اردو", flag: "🇵🇰", locale: "ur-PK" },
  { code: "hi", name: "Hindi", native: "हिन्दी", flag: "🇮🇳", locale: "hi-IN" },
  { code: "bn", name: "Bengali", native: "বাংলা", flag: "🇧🇩", locale: "bn-BD" },
  { code: "ta", name: "Tamil", native: "தமிழ்", flag: "🇮🇳", locale: "ta-IN" },
  { code: "zh", name: "Chinese (Simplified)", native: "简体中文", flag: "🇨🇳", locale: "zh-CN" },
  { code: "zh-TW", name: "Chinese (Traditional)", native: "繁體中文", flag: "🇹🇼", locale: "zh-TW" },
  { code: "ja", name: "Japanese", native: "日本語", flag: "🇯🇵", locale: "ja-JP" },
  { code: "ko", name: "Korean", native: "한국어", flag: "🇰🇷", locale: "ko-KR" },
  { code: "vi", name: "Vietnamese", native: "Tiếng Việt", flag: "🇻🇳", locale: "vi-VN" },
  { code: "th", name: "Thai", native: "ไทย", flag: "🇹🇭", locale: "th-TH" },
  { code: "id", name: "Indonesian", native: "Bahasa Indonesia", flag: "🇮🇩", locale: "id-ID" },
  { code: "ms", name: "Malay", native: "Bahasa Melayu", flag: "🇲🇾", locale: "ms-MY" },
  { code: "fil", name: "Filipino", native: "Filipino", flag: "🇵🇭", locale: "fil-PH" },
  { code: "sw", name: "Swahili", native: "Kiswahili", flag: "🇰🇪", locale: "sw-KE" },
  { code: "af", name: "Afrikaans", native: "Afrikaans", flag: "🇿🇦", locale: "af-ZA" },
];

const byCode = new Map(LANGUAGES.map((language) => [language.code.toLowerCase(), language]));
/** The language for a code, falling back to its base language (pt-PT → pt), then to a plain entry for the code. */
export function languageOf(code: string): VideoLanguage {
  const exact = byCode.get(code.toLowerCase());
  if (exact) return exact;
  const base = byCode.get(code.split("-")[0].toLowerCase());
  return base ?? { code, name: code, native: code, flag: "🏳️", locale: code };
}
/** The browser's own language when it is in the list, else English. */
export function defaultLanguage(): string {
  const preferred = typeof navigator === "undefined" ? [] : [...(navigator.languages ?? []), navigator.language];
  for (const tag of preferred) {
    if (!tag) continue;
    const exact = byCode.get(tag.toLowerCase());
    if (exact) return exact.code;
    const base = byCode.get(tag.split("-")[0].toLowerCase());
    if (base) return base.code;
  }
  return "en";
}
/** Matches a search against the English name, the native name and the code. */
export function matchesLanguage(language: VideoLanguage, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const fold = (value: string) => value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  return [language.name, language.native, language.code].some((value) => fold(value).includes(fold(q)));
}
