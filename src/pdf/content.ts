import type { BrandContent } from "./template";

export const BRAND_NAME = "abdulbosit_source";
export const BRAND_MARK = "AS";

// Approved by Abdul on 2026-10-03: no prices or packages in the PDF.
export const DEFAULT_CONTENT: BrandContent = {
  services: {
    title: "Biz qanday yordam beramiz",
    intro:
      "Ko'rgazmaga borish oson. Undan foyda bilan qaytish uchun to'g'ri zavodni topish, yaxshi shartlarga kelishish va mahsulotni xavfsiz olib kelish kerak. Shu ishda yoningizdamiz.",
    main: [
      {
        title: "Muzokaralar tajribasi",
        text: "Xitoy zavodlari va yetkazib beruvchilar bilan muzokaralarda amaliy tajriba: narx, minimal buyurtma, to'lov va yetkazib berish shartlari.",
      },
      { title: "Ko'rgazmada hamrohlik", text: "Stendlarda birga yuramiz, muzokara qilamiz va har bir taklifni yozib boramiz." },
      { title: "Zavodlarga tashrif", text: "Tashrifni kelishamiz, ishlab chiqarishni va hujjatlarni birga ko'ramiz." },
    ],
    after_title: "Safardan keyin ham yoningizdamiz",
    after: [
      "Yetkazib beruvchilarni topish va ular bilan muloqot",
      "Sifat nazorati",
      "Logistika va O'zbekistongacha yetkazib berish",
      "Xitoy bilan ishlashdagi boshqa masalalar",
    ],
  },
  cta: {
    title: "Safaringizni natijali qilamiz",
    text: "Qaysi mahsulot kerakligini yozing: uskuna, xomashyo, metall prokat yoki boshqa narsa. Ko'rgazmada va undan keyin qanday yordam bera olishimizni aytib beramiz.",
  },
};
