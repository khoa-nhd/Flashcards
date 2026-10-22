/**
 * The interface language. The owner's rule: follow the browser by default,
 * fall back to Vietnamese, and never change the language of a word's meaning.
 *
 * Only the interface is translated. Vocabulary, definitions and examples are
 * kept exactly as the learner wrote them.
 */
export type UiLanguage = 'vi' | 'en';
export type UiLanguagePreference = 'auto' | UiLanguage;

/** Vietnamese unless the browser is clearly English. */
export function resolveUiLanguage(
  preference: UiLanguagePreference | null | undefined,
  browserLanguage: string | null | undefined,
): UiLanguage {
  if (preference === 'vi' || preference === 'en') return preference;
  const base = (browserLanguage ?? '').trim().toLowerCase().split(/[-_]/)[0];
  return base === 'en' ? 'en' : 'vi';
}

/** Chooses the text for the current language. */
export function pick(language: UiLanguage, english: string, vietnamese: string): string {
  return language === 'vi' ? vietnamese : english;
}
