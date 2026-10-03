// Client-facing texts are Uzbek (Latin); admin texts are Russian.
// Client templates can be overridden without a deploy via the `settings` table (key = "tpl.<name>").
export const clientTexts = {
  welcome:
    "Assalomu alaykum! 👋\n\n" +
    "Bu bot Xitoydagi sanoat ko'rgazmalari, ishlab chiqarish liniyalari, uskunalar va xomashyo " +
    "bo'yicha foydali materiallarni yuboradi.\n\n" +
    "Kanalimizdagi postlar ostidagi tugmani bosing — tegishli material shu yerga keladi.",
  unknownCampaign:
    "Assalomu alaykum! 👋\n\nBu material hozircha mavjud emas yoki yangilanmoqda. " +
    "Kanalimizdagi yangi postlarni kuzatib boring.",
  fallback: "Rahmat! Materiallarni olish uchun kanalimizdagi post ostidagi tugmani bosing.",
  intro: "Assalomu alaykum! 👋\n\nMana siz so'ragan material:",
  serviceCta:
    "Agar siz bu loyihani jiddiy ko'rib chiqayotgan bo'lsangiz, biz yordam bera olamiz: " +
    "Xitoyga safarni tashkil qilish, uskunani topish va tekshirish, zavod bilan muzokaralar " +
    "va Xitoyda hamrohlik.",
  ctaButton: "🤝 Muhokama qilmoqchiman",
  ctaThanks: "Rahmat! So'rovingiz mutaxassisga yuborildi. Tez orada siz bilan bog'lanamiz.",
  ctaAlready: "So'rovingiz allaqachon qabul qilingan. Tez orada bog'lanamiz.",
};

export type ClientTemplate = keyof typeof clientTexts;

export const adminTexts = {
  menuTitle: "🛠 <b>Админ-панель</b>\nВыберите раздел:",
  comingSoon: (section: string) => `<b>${section}</b>\n\nРаздел появится в следующих фазах.`,
  back: "⬅️ Назад",
  uploadHelp:
    "📄 <b>Как загрузить PDF</b>\n\nОтправьте боту PDF-файл с подписью:\n" +
    "<code>slug | Название</code>\n\nНапример:\n<code>canton-fair-2027 | Canton Fair 2027: hisob-kitob</code>\n\n" +
    "slug: латиница, цифры и дефис (2–40 символов). Новый файл с тем же slug становится новой версией.\n\n" +
    "🤖 <b>Автоматический PDF</b>: отправьте research-пакет (.json) — бот сам посчитает бюджет, соберёт PDF по шаблону и пришлёт на одобрение.",
  badCaption:
    "Не понял подпись. Нужно так:\n<code>slug | Название</code>\nНапример: <code>paper-cup | Qog'oz stakan ishlab chiqarish</code>",
  notPdf: "Это не PDF. Отправьте файл в формате PDF.",
  tooLarge: "Файл больше 20 МБ: Telegram не даст боту его скачать. Сожмите PDF и отправьте снова.",
};
