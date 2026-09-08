const pageCopy = {
  workspace: ["Рабочая область", "Создание, настройка и публикация фидов для агрегаторов недвижимости."],
  feeds: ["Фиды", "Сохранённые выгрузки, версии и постоянные ссылки."],
  monitoring: ["Мониторинг", "Проверки доступности, ошибки источников и уведомления."],
  layouts: ["Планировки", "Библиотека макетов и брендирование изображений для фидов."],
  billing: ["Подписки", "Тарифы, лимиты, платежи и коммерческие ограничения."],
  admin: ["Админка", "Управление клиентами, подписками, лимитами и системными событиями."]
};

const navButtons = document.querySelectorAll("[data-page]");
const views = document.querySelectorAll(".view");
const title = document.querySelector("#pageTitle");
const subtitle = document.querySelector("#pageSubtitle");

function showPage(page) {
  if (!pageCopy[page]) return;
  navButtons.forEach(button => button.classList.toggle("active", button.dataset.page === page));
  views.forEach(view => view.classList.toggle("active", view.id === page));
  title.textContent = pageCopy[page][0];
  subtitle.textContent = pageCopy[page][1];
}

navButtons.forEach(button => {
  button.addEventListener("click", () => showPage(button.dataset.page));
});

document.querySelectorAll("button").forEach(button => {
  button.addEventListener("pointerdown", () => button.style.transform = "translateY(1px)");
  button.addEventListener("pointerup", () => button.style.transform = "");
  button.addEventListener("pointerleave", () => button.style.transform = "");
});
