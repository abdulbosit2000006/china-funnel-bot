// Client-facing texts are Uzbek (Latin); admin texts are Russian.
// Phase 2 moves client templates into the `settings` table so they can be edited without a deploy.
export const clientTexts = {
  welcome:
    "Assalomu alaykum! 👋\n\n" +
    "Bu bot Xitoydagi sanoat ko'rgazmalari, ishlab chiqarish liniyalari, uskunalar va xomashyo " +
    "bo'yicha foydali materiallarni yuboradi.\n\n" +
    "Kanalimizdagi postlar ostidagi tugmani bosing — tegishli material shu yerga keladi.",
  unknownCampaign:
    "Assalomu alaykum! 👋\n\nBu material hozircha mavjud emas yoki yangilanmoqda. " +
    "Kanalimizdagi yangi postlarni kuzatib boring.",
  fallback:
    "Rahmat! Materiallarni olish uchun kanalimizdagi post ostidagi tugmani bosing.",
};

export const adminTexts = {
  menuTitle: "🛠 <b>Админ-панель</b>\nВыберите раздел:",
  comingSoon: (section: string) => `<b>${section}</b>\n\nРаздел появится в следующих фазах.`,
  back: "⬅️ Назад",
};
