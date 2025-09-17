(function () {
  const languages = {
    pt: { label: 'Português', documentLang: 'pt-BR' },
    en: { label: 'English', documentLang: 'en' },
  };
  const defaultLanguage = 'pt';
  let currentLanguage = defaultLanguage;

  function isSupported(lang) {
    return Object.prototype.hasOwnProperty.call(languages, lang);
  }

  function getPreferredLanguage() {
    const stored = localStorage.getItem('preferredLanguage');
    if (stored && isSupported(stored)) {
      return stored;
    }

    const cookieMatch = document.cookie.match(/(?:^|;\s*)googtrans=([^;]+)/i);
    if (cookieMatch) {
      const parts = decodeURIComponent(cookieMatch[1]).split('/');
      const candidate = parts[parts.length - 1];
      if (candidate && isSupported(candidate)) {
        return candidate;
      }
    }

    return defaultLanguage;
  }

  function setCookie(name, value) {
    const expires = new Date();
    expires.setFullYear(expires.getFullYear() + 1);
    const encodedValue = encodeURIComponent(value);
    document.cookie = `${name}=${encodedValue};expires=${expires.toUTCString()};path=/`;

    const host = window.location.hostname;
    const isIp = /^\d+(?:\.\d+){3}$/.test(host);
    if (host && host.includes('.') && !isIp) {
      const domain = host.replace(/^www\./i, '');
      document.cookie = `${name}=${encodedValue};expires=${expires.toUTCString()};path=/;domain=.${domain}`;
    }
  }

  function updateUi(lang) {
    const entry = languages[lang] || languages[defaultLanguage];
    document.querySelectorAll('[data-language-label]').forEach((el) => {
      el.textContent = entry.label;
    });

    document.documentElement.setAttribute('lang', entry.documentLang || lang);

    document.querySelectorAll('[data-language-option]').forEach((button) => {
      const isActive = button.dataset.languageOption === lang;
      button.classList.toggle('is-active', isActive);
      button.setAttribute('aria-checked', String(isActive));
    });
  }

  function triggerTranslate(lang) {
    const apply = () => {
      const combo = document.querySelector('.goog-te-combo');
      if (!combo) {
        return false;
      }
      if (combo.value !== lang) {
        combo.value = lang;
      }
      combo.dispatchEvent(new Event('change'));
      return true;
    };

    if (apply()) {
      return;
    }

    const observer = new MutationObserver(() => {
      if (apply()) {
        observer.disconnect();
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 10_000);
  }

  function persistLanguage(lang) {
    const normalized = isSupported(lang) ? lang : defaultLanguage;
    const cookieValue = `/pt/${normalized}`;
    setCookie('googtrans', cookieValue);
    localStorage.setItem('preferredLanguage', normalized);
  }

  function setLanguage(lang, { persist = true } = {}) {
    const normalized = isSupported(lang) ? lang : defaultLanguage;
    currentLanguage = normalized;
    if (persist) {
      persistLanguage(normalized);
    }
    updateUi(normalized);
    triggerTranslate(normalized);
  }

  function ensureHiddenContainer() {
    const container = document.getElementById('google_translate_container');
    if (container) {
      container.style.position = 'absolute';
      container.style.width = '1px';
      container.style.height = '1px';
      container.style.overflow = 'hidden';
      container.style.clip = 'rect(0 0 0 0)';
      container.style.clipPath = 'inset(50%)';
      container.style.whiteSpace = 'nowrap';
    }
  }

  function loadGoogleTranslate() {
    if (window.googleTranslateElementInit) {
      return;
    }

    ensureHiddenContainer();

    window.googleTranslateElementInit = function () {
      if (!window.google || !window.google.translate) {
        return;
      }

      new window.google.translate.TranslateElement(
        {
          pageLanguage: 'pt',
          includedLanguages: Object.keys(languages).join(','),
          layout: window.google.translate.TranslateElement.InlineLayout.SIMPLE,
          autoDisplay: false,
        },
        'google_translate_container',
      );

      triggerTranslate(currentLanguage);
    };

    const script = document.createElement('script');
    script.src = 'https://translate.google.com/translate_a/element.js?cb=googleTranslateElementInit';
    script.async = true;
    script.defer = true;
    document.head.appendChild(script);
  }

  function closeDropdown(dropdown, toggle) {
    dropdown.hidden = true;
    if (toggle) {
      toggle.setAttribute('aria-expanded', 'false');
    }
  }

  function setupDropdown() {
    const toggle = document.querySelector('[data-language-toggle]');
    const dropdown = document.querySelector('[data-language-dropdown]');
    if (!toggle || !dropdown) {
      return;
    }

    toggle.addEventListener('click', (event) => {
      event.preventDefault();
      const willOpen = dropdown.hidden;
      dropdown.hidden = !willOpen;
      toggle.setAttribute('aria-expanded', String(willOpen));
      if (willOpen) {
        const active = dropdown.querySelector('.language-option.is-active');
        if (active) {
          active.focus();
        }
      }
    });

    document.addEventListener('click', (event) => {
      if (!dropdown.contains(event.target) && !toggle.contains(event.target)) {
        closeDropdown(dropdown, toggle);
      }
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        closeDropdown(dropdown, toggle);
      }
    });

    dropdown.addEventListener('click', (event) => {
      const option = event.target.closest('[data-language-option]');
      if (!option) {
        return;
      }
      const { languageOption } = option.dataset;
      if (!languageOption || !isSupported(languageOption)) {
        return;
      }

      setLanguage(languageOption);
      closeDropdown(dropdown, toggle);
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    setupDropdown();
    const preferred = getPreferredLanguage();
    currentLanguage = preferred;
    updateUi(preferred);
    persistLanguage(preferred);
    loadGoogleTranslate();
  });
})();
