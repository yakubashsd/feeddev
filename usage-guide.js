(() => {
  const dialog = document.querySelector("#usageGuideDialog");
  const hint = document.querySelector("#usageHint");
  if (!dialog || !hint) return;

  const pages = {
    projects: {
      step: "СТАРТ", title: "Начните с отдельного проекта", text: "Создайте проект для одной целевой площадки. Внутри него будут источник, квартиры, настройки и ссылка публикации.", action: "Создать проект", target: "#newProjectBtn"
    },
    source: {
      step: "01 / 04", index: "active", title: "Подключите исходный фид", text: "Вставьте постоянную XML-ссылку и нажмите «Добавить источник» или загрузите файл. Выберите площадку и частоту обновления.", action: "К форме источника", target: "#sourceName"
    },
    apartments: {
      step: "03 / 05", index: "active", title: "Проверьте объявления", text: "Отфильтруйте квартиры с ошибками. Откройте объявление для точечной правки или отметьте несколько строк для массового изменения.", action: "К объявлениям", target: ".table-wrap"
    },
    complexes: {
      step: "02 / 05", index: "active", title: "Сверьте ЖК и дома", text: "После загрузки источника проверьте, что дома сгруппированы по жилым комплексам и в каждом отображается ожидаемое число квартир.", action: "Открыть список ЖК", target: ".complexes-panel"
    },
    branding: {
      step: "04 / 05", index: "active", title: "Оформление планировок — по желанию", text: "Загрузите подложку, настройте макет на примере квартиры и сформируйте готовые изображения. Без этого шага фид тоже можно опубликовать.", action: "Загрузить подложку", target: "#pickBrandBadgeBtn", click: true
    },
    results: {
      step: "05 / 05", index: "active", title: "Проверьте и опубликуйте фид", text: "Убедитесь, что нет блокирующих ошибок, сохраните XML по постоянной ссылке или скачайте файл для проверки.", action: "К публикации", target: ".publish-panel"
    },
    feeds: {
      step: "СЕРВИС", title: "Следите за качеством фида", text: "Проверяйте текущий XML, новые ошибки и время синхронизации. При необходимости запустите проверку вручную и настройте уведомления.", action: "К мониторингу", target: "#checkFeedsBtn"
    },
    billing: {
      step: "АККАУНТ", title: "Управляйте подпиской проекта", text: "Здесь можно выбрать число проектов, проверить статус тарифа и посмотреть историю платежей.", action: "К оплате", target: "#checkoutButton"
    },
    support: {
      step: "ПОМОЩЬ", title: "Свяжитесь с техподдержкой", text: "Опишите проблему, выберите проект и оставьте email для ответа. Номер и статус обращения сохранятся в кабинете.", action: "Создать обращение", target: "#supportTitle"
    }
  };
    const titleToPage = {
    "Все проекты": "projects", "Проекты фидов": "projects", "Источники видов": "source",
    "ЖК и дома": "complexes", "Объявления и квартиры": "apartments", "Квартиры": "apartments",
    "Оформление планировок": "branding", "Шаблоны планировок": "branding",
    "Проверка и публикация": "results", "Результаты и ссылки": "results",
    "Мониторинг и ошибки": "feeds", "Мониторинг": "feeds", "Тариф и оплата": "billing", "Техническая поддержка": "support"
  };
  let dismissedFor = "";

  function activePage() {
    return titleToPage[document.querySelector(".topbar h1")?.textContent.trim()] || "projects";
  }

  function renderHint() {
    const page = activePage();
    const data = pages[page] || pages.projects;
    document.querySelector("#usageHintStep").textContent = data.step;
    document.querySelector("#usageHintStep").dataset.index = data.index || "";
    document.querySelector("#usageHintTitle").textContent = data.title;
    document.querySelector("#usageHintText").textContent = data.text;
    const action = document.querySelector("#usageHintAction");
    action.textContent = data.action;
    action.dataset.target = data.target;
    action.dataset.clickTarget = String(Boolean(data.click));
    hint.hidden = dismissedFor === page;
  }

  function go(page) {
    const nav = document.querySelector(`[data-nav="${page}"]`);
    if (nav && !nav.hidden) {
      nav.click();
      dialog.close();
      window.setTimeout(() => {
        const target = pages[page]?.target;
        if (target) document.querySelector(target)?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 80);
      return;
    }
    if (page === "projects") {
      dialog.close();
      document.querySelector('.sidebar a.nav-item[href="/"]')?.click();
      return;
    }
    if (nav?.hidden && page !== "billing") {
      dialog.close();
      document.querySelector("#newProjectBtn")?.click();
    }
  }

  document.querySelector("#usageGuideOpen").addEventListener("click", () => dialog.showModal());
  document.querySelector("#usageGuideClose").addEventListener("click", () => dialog.close());
  document.querySelector("#usageGuideStart").addEventListener("click", () => go("source"));
  document.querySelector("#usageGuideDialog").addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
    const button = event.target.closest("[data-guide-go]");
    if (button) go(button.dataset.guideGo);
  });
  document.querySelector("#usageHintDismiss").addEventListener("click", () => {
    dismissedFor = activePage();
    hint.hidden = true;
  });
  document.querySelector("#usageHintAction").addEventListener("click", (event) => {
    const button = event.currentTarget;
    const target = document.querySelector(button.dataset.target);
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    if (button.dataset.clickTarget === "true") target.click();
    else if (target.matches("input,select,textarea")) target.focus({ preventScroll: true });
  });
  document.querySelectorAll("[data-nav]").forEach((nav) => nav.addEventListener("click", () => {
    dismissedFor = "";
    window.setTimeout(renderHint, 0);
  }));
  const heading = document.querySelector(".topbar h1");
  if (heading) new MutationObserver(() => renderHint()).observe(heading, { childList: true, characterData: true, subtree: true });
  renderHint();
})();
