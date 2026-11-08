import type { BrandContent } from "./template";

// MERIDIAN 美瑞达 (logobook 2026). The logo itself is an SVG in brand.generated.ts.
export const BRAND_NAME = "MERIDIAN";
export const BRAND_MARK = "M";

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

// Exhibition trip guide: why go to the fair with us. Abdul, 2026-10-26: accompaniment, successful
// negotiations with suppliers, ongoing contact with the factory, help with purchases. Still no prices.
export const TRIP_CONTENT: BrandContent = {
  services: {
    title: "Nega ko'rgazmaga biz bilan borish kerak",
    intro:
      "Ko'rgazmaga borish oson. Undan natija bilan qaytish qiyin: minglab stend orasidan ishonchli zavodni topish, to'g'ri narxga kelishish va safardan keyin ham ishni davom ettirish kerak. MERIDIAN shu yo'lni siz bilan birga bosib o'tadi.",
    main: [
      {
        title: "Ko'rgazma va zavodlarda hamrohlik",
        text: "Stendlarda yoningizda yuramiz, ishlab chiqaruvchilar bilan gaplashamiz va zavodlarga tashrifni kelishamiz. Vaqtingiz faqat sizga kerakli zavodlarga sarflanadi.",
      },
      {
        title: "Yetkazib beruvchilar bilan muvaffaqiyatli muzokaralar",
        text: "Xitoy zavodlari bilan muzokaralarda amaliy tajribamiz bor: narx, minimal partiya, to'lov va yetkazish shartlarini siz uchun foydali kelishamiz.",
      },
      {
        title: "Zavod bilan doimiy aloqa",
        text: "Safardan keyin ham zavod bilan aloqani biz ushlab turamiz: savollar, namunalar, chizmalar va ishlab chiqarish holati.",
      },
      {
        title: "Xarid va yetkazib berishda yordam",
        text: "Buyurtma berish, sifat nazorati, logistika va O'zbekistongacha yetkazib berishda yoningizdamiz.",
      },
    ],
    after_title: "Natijada siz olasiz",
    after: [
      "Ko'rgazmada vaqt behuda ketmaydi: faqat kerakli ishlab chiqaruvchilar",
      "Ishonchli zavod va yaxshi shartlar",
      "Zavod bilan to'g'ridan-to'g'ri, uzoq muddatli aloqa",
      "Bitta jamoa: zavod tanlashdan yukni olib kelishgacha",
    ],
  },
  cta: {
    title: "Ko'rgazmaga biz bilan boring",
    text: "Qaysi uskuna yoki mahsulot kerakligini yozing. Safarni birga rejalashtiramiz: ko'rgazma, zavodlar va keyingi xaridlar.",
    button: "Ko'rgazmaga birga bormoqchiman",
  },
};

// Business-model PDF: the reader is about to buy equipment, not to travel. Same rules: no prices, no packages.
export const BUSINESS_CONTENT: BrandContent = {
  services: {
    title: "Biz qanday yordam beramiz",
    intro:
      "Hisob-kitob qog'ozda chiqadi. Pul esa uskunani to'g'ri zavoddan, to'g'ri shartlarda olib, ishga tushirganda qaytadi. Shu yo'lda yoningizdamiz.",
    main: [
      {
        title: "Ishlab chiqaruvchini topish va tekshirish",
        text: "Uskunani savdo vositachisidan emas, ishlab chiqaruvchidan topamiz va kompaniyani ochiq ma'lumotlar bo'yicha tekshiramiz.",
      },
      {
        title: "Narx va shartlar bo'yicha muzokara",
        text: "Xitoy zavodlari bilan muzokaralarda amaliy tajribamiz bor: narx, to'plam, kafolat, to'lov va yetkazib berish shartlari.",
      },
      {
        title: "Zavodga tashrif yoki video-inspeksiya",
        text: "Uskunani yuborishdan oldin ishlashini ko'ramiz: sizning xomashyongizda sinov, to'plam va hujjatlarni tekshirish.",
      },
    ],
    after_title: "Xariddan keyin ham yoningizdamiz",
    after: [
      "Logistika va O'zbekistongacha yetkazib berish",
      "Ehtiyot qismlar va qo'shimcha uskunani topish",
      "Xomashyo va qadoq yetkazib beruvchilarini topish",
      "Xitoy bilan ishlashdagi boshqa masalalar",
    ],
  },
  cta: {
    title: "Shu biznesni boshlamoqchimisiz?",
    text: "Bot orqali yozing: qaysi variant sizga yaqin va qancha mablag' bilan boshlamoqchisiz. Uskuna va zavodni tanlashda qanday yordam bera olishimizni aytib beramiz.",
    button: "Biznesni muhokama qilmoqchiman",
  },
};
