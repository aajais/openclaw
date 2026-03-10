import { en } from "../locales/en.ts";
import type { Locale, TranslationMap } from "./types.ts";

type Subscriber = (locale: Locale) => void;

export const SUPPORTED_LOCALES: ReadonlyArray<Locale> = ["en", "zh-CN", "zh-TW", "pt-BR"];

export function isSupportedLocale(value: string | null | undefined): value is Locale {
  return value !== null && value !== undefined && SUPPORTED_LOCALES.includes(value as Locale);
}

function resolveStartupLocale(): Locale {
  try {
    const saved = globalThis.localStorage?.getItem?.("openclaw.i18n.locale") ?? null;
    if (isSupportedLocale(saved)) {
      return saved;
    }
  } catch {
    // ignore storage access failures
  }

  const navLang = globalThis.navigator?.language ?? "en";
  if (navLang.startsWith("zh")) {
    return navLang === "zh-TW" || navLang === "zh-HK" ? "zh-TW" : "zh-CN";
  }
  if (navLang.startsWith("pt")) {
    return "pt-BR";
  }
  return "en";
}

class I18nManager {
  private locale: Locale;
  private translations: Record<Locale, TranslationMap> = { en } as Record<Locale, TranslationMap>;
  private subscribers: Set<Subscriber> = new Set();

  constructor(initialLocale: Locale) {
    this.locale = initialLocale;
    if (initialLocale !== "en") {
      // Fire and forget; locale is already set synchronously.
      void this.setLocale(initialLocale);
    }
  }

  public getLocale(): Locale {
    // In some environments (notably tests), module resets can be imperfect.
    // Treat localStorage as source-of-truth when a supported value is present.
    try {
      const saved = globalThis.localStorage?.getItem?.("openclaw.i18n.locale") ?? null;
      if (isSupportedLocale(saved) && saved !== this.locale) {
        this.locale = saved;
        if (!this.translations[saved]) {
          void this.setLocale(saved);
        }
      }
    } catch {
      // ignore
    }
    return this.locale;
  }

  public async setLocale(locale: Locale) {
    const needsTranslationLoad = !this.translations[locale];
    if (this.locale === locale && !needsTranslationLoad) {
      return;
    }

    // Lazy load translations if needed
    if (needsTranslationLoad) {
      try {
        let module: Record<string, TranslationMap>;
        if (locale === "zh-CN") {
          module = await import("../locales/zh-CN.ts");
        } else if (locale === "zh-TW") {
          module = await import("../locales/zh-TW.ts");
        } else if (locale === "pt-BR") {
          module = await import("../locales/pt-BR.ts");
        } else {
          return;
        }
        this.translations[locale] = module[locale.replace("-", "_")];
      } catch (e) {
        console.error(`Failed to load locale: ${locale}`, e);
        return;
      }
    }

    this.locale = locale;
    localStorage.setItem("openclaw.i18n.locale", locale);
    this.notify();
  }

  public registerTranslation(locale: Locale, map: TranslationMap) {
    this.translations[locale] = map;
  }

  public subscribe(sub: Subscriber) {
    this.subscribers.add(sub);
    return () => this.subscribers.delete(sub);
  }

  private notify() {
    this.subscribers.forEach((sub) => sub(this.locale));
  }

  public t(key: string, params?: Record<string, string>): string {
    const keys = key.split(".");
    let value: unknown = this.translations[this.locale] || this.translations["en"];

    for (const k of keys) {
      if (value && typeof value === "object") {
        value = (value as Record<string, unknown>)[k];
      } else {
        value = undefined;
        break;
      }
    }

    // Fallback to English
    if (value === undefined && this.locale !== "en") {
      value = this.translations["en"];
      for (const k of keys) {
        if (value && typeof value === "object") {
          value = (value as Record<string, unknown>)[k];
        } else {
          value = undefined;
          break;
        }
      }
    }

    if (typeof value !== "string") {
      return key;
    }

    if (params) {
      return value.replace(/\{(\w+)\}/g, (_, k) => params[k] || `{${k}}`);
    }

    return value;
  }
}

export const i18n = new I18nManager(resolveStartupLocale());
export const t = (key: string, params?: Record<string, string>) => i18n.t(key, params);
