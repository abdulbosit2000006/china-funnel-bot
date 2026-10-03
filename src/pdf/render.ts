import puppeteer from "@cloudflare/puppeteer";

/** HTML -> PDF bytes. Injected so tests run without a browser. */
export type PdfRenderer = (html: string, footerHtml: string) => Promise<Uint8Array>;

export function createBrowserRenderer(binding: Fetcher): PdfRenderer {
  return async (html, footerHtml) => {
    const browser = await puppeteer.launch(binding);
    try {
      const page = await browser.newPage();
      // Fonts are inlined (fonts.generated.ts), so "load" is enough: no network requests.
      await page.setContent(html, { waitUntil: "load", timeout: 30_000 });
      const pdf = await page.pdf({
        format: "A4",
        printBackground: true,
        preferCSSPageSize: true,
        displayHeaderFooter: true,
        headerTemplate: "<span></span>",
        footerTemplate: footerHtml,
      });
      return new Uint8Array(pdf);
    } finally {
      await browser.close();
    }
  };
}

/** HTML -> PNG of the given viewport size (post cover). */
export type ImageRenderer = (html: string, width: number, height: number) => Promise<Uint8Array>;

export function createBrowserImageRenderer(binding: Fetcher): ImageRenderer {
  return async (html, width, height) => {
    const browser = await puppeteer.launch(binding);
    try {
      const page = await browser.newPage();
      await page.setViewport({ width, height, deviceScaleFactor: 1 });
      await page.setContent(html, { waitUntil: "load", timeout: 30_000 });
      return new Uint8Array((await page.screenshot({ type: "png" })) as Uint8Array);
    } finally {
      await browser.close();
    }
  };
}
