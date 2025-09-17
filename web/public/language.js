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

  function getCookieDomains() {
    const host = window.location.hostname;
    const isIp = /^\d+(?:\.\d+){3}$/.test(host);
    const domains = [''];

    if (host && host.includes('.') && !isIp) {
      domains.push(`.${host.replace(/^www\./i, '')}`);
    }

    return domains;
  }

  function setCookie(name, value) {
    const expires = new Date();
    expires.setFullYear(expires.getFullYear() + 1);
    const encodedValue = encodeURIComponent(value);
    const cookie = `${name}=${encodedValue};expires=${expires.toUTCString()};path=/`;

    getCookieDomains().forEach((domain) => {
      const domainSuffix = domain ? `;domain=${domain}` : '';
      document.cookie = `${cookie}${domainSuffix}`;
    });
  }

  function deleteCookie(name) {
    const expires = new Date(0).toUTCString();
    getCookieDomains().forEach((domain) => {
      const domainSuffix = domain ? `;domain=${domain}` : '';
      document.cookie = `${name}=;expires=${expires};path=/${domainSuffix}`;
    });
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

  function cleanGoogleArtifacts() {
    document.querySelectorAll('.goog-te-banner-frame, .goog-te-banner-frame.skiptranslate').forEach((frame) => {
      frame.style.display = 'none';
      if (frame.parentNode) {
        frame.parentNode.removeChild(frame);
      }
    });

    const tooltip = document.getElementById('goog-gt-tt');
    if (tooltip && tooltip.parentNode) {
      tooltip.parentNode.removeChild(tooltip);
    }

    document.querySelectorAll('.goog-te-balloon-frame').forEach((frame) => {
      frame.style.display = 'none';
      if (frame.parentNode) {
        frame.parentNode.removeChild(frame);
      }
    });

    const skipElements = document.querySelectorAll('html.skiptranslate, body.skiptranslate');
    skipElements.forEach((element) => {
      element.classList.remove('skiptranslate');
      element.style.top = '0px';
    });

    const gadgetWrappers = document.querySelectorAll('.goog-te-gadget, .goog-te-combo');
    gadgetWrappers.forEach((element) => {
      element.style.position = 'absolute';
      element.style.left = '-9999px';
      element.style.top = 'auto';
      element.style.opacity = '0';
      element.style.pointerEvents = 'none';
    });

    document.querySelectorAll('.goog-tooltip, .goog-tooltip div').forEach((element) => {
      element.style.display = 'none';
    });

    document.querySelectorAll('.goog-text-highlight').forEach((element) => {
      element.style.background = 'transparent';
      element.style.boxShadow = 'none';
    });
  }

  const artifactCleanupDelays = [0, 120, 400, 1200, 2400];
  function scheduleArtifactCleanup() {
    artifactCleanupDelays.forEach((delay) => {
      window.setTimeout(cleanGoogleArtifacts, delay);
    });
  }

  function triggerTranslate(lang) {
    const apply = () => {
      const combo = document.querySelector('.goog-te-combo');
      if (!combo) {
        return false;
      }
      const targetValue = lang === defaultLanguage ? '' : lang;
      if (combo.value !== targetValue) {
        combo.value = targetValue;
      }
      combo.dispatchEvent(new Event('change'));
      scheduleArtifactCleanup();
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
    if (normalized === defaultLanguage) {
      deleteCookie('googtrans');
    } else {
      const cookieValue = `/pt/${normalized}`;
      setCookie('googtrans', cookieValue);
    }
    localStorage.setItem('preferredLanguage', normalized);
  }

  function setLanguage(lang, { persist = true } = {}) {
    const normalized = isSupported(lang) ? lang : defaultLanguage;
    const previous = currentLanguage;
    currentLanguage = normalized;
    if (persist) {
      persistLanguage(normalized);
    }
    updateUi(normalized);

    if (normalized === defaultLanguage) {
      triggerTranslate(normalized);
      cleanGoogleArtifacts();
      if (previous !== defaultLanguage) {
        scheduleArtifactCleanup();
        window.setTimeout(() => {
          cleanGoogleArtifacts();
          window.location.reload();
        }, 200);
      }
      return;
    }

    triggerTranslate(normalized);
  }

  function ensureHiddenContainer() {
    let container = document.getElementById('google_translate_container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'google_translate_container';
      container.className = 'language-switch__container';
      container.setAttribute('aria-hidden', 'true');
      document.body.appendChild(container);
    }

    container.style.position = 'absolute';
    container.style.width = '1px';
    container.style.height = '1px';
    container.style.overflow = 'hidden';
    container.style.clip = 'rect(0 0 0 0)';
    container.style.clipPath = 'inset(50%)';
    container.style.whiteSpace = 'nowrap';
    container.style.left = '-9999px';
    container.style.top = 'auto';
    container.style.right = 'auto';
    container.style.bottom = 'auto';
    container.style.opacity = '0';
    container.style.pointerEvents = 'none';
    container.style.zIndex = '-1';
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
      scheduleArtifactCleanup();
    };

    const script = document.createElement('script');
    script.src = 'https://translate.google.com/translate_a/element.js?cb=googleTranslateElementInit';
    script.async = true;
    script.defer = true;
    document.head.appendChild(script);
    scheduleArtifactCleanup();
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

  window.addEventListener('load', cleanGoogleArtifacts);

  document.addEventListener('DOMContentLoaded', () => {
    setupDropdown();
    const preferred = getPreferredLanguage();
    currentLanguage = preferred;
    updateUi(preferred);
    persistLanguage(preferred);
    cleanGoogleArtifacts();
    loadGoogleTranslate();
  });
})();
