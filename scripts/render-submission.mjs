import { chromium } from "@playwright/test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { writeFile } from "node:fs/promises";
const root = resolve("../_ai_context/submission");
const browser = await chromium.launch();
const observations = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(pathToFileURL(resolve(root, "report.html")).href);
  await page.pdf({ path: resolve(root, "PulseGrid-Report.pdf"), format: "A4", printBackground: true, margin: { top: "18mm", bottom: "19mm", left: "18mm", right: "18mm" }, displayHeaderFooter: true, headerTemplate: "<span></span>", footerTemplate: '<div style="width:100%;text-align:center;font:8px Arial;color:#536675">Teaching model, not clinical software. | Local evidence candidate | <span class="pageNumber"></span></div>' });
  await page.screenshot({ path: resolve("../_ai_context/artifacts/stage-15-report-preview.png"), fullPage: false });
  await page.goto(pathToFileURL(resolve(root, "slides.html")).href);
  const slides = page.locator(".slide");
  for (let i = 0; i < await slides.count(); i++) {
    const slide = slides.nth(i);
    const bounds = await slide.evaluate(node => { const children = [...node.querySelectorAll("h1,li,img,footer")]; const box = node.getBoundingClientRect(); return { overflow: node.scrollHeight > node.clientHeight || node.scrollWidth > node.clientWidth, contained: children.every(el => { const r = el.getBoundingClientRect(); return r.right <= box.right && r.bottom <= box.bottom; }) }; });
    if (bounds.overflow || !bounds.contained) throw new Error(`Slide ${i + 1} overflows`);
    await slide.screenshot({ path: resolve(`../_ai_context/artifacts/stage-15-slide-${String(i + 1).padStart(2, "0")}.png`) });
    observations.push({ slide: i + 1, ...bounds });
  }
  await page.pdf({ path: resolve(root, "PulseGrid-Slides.pdf"), preferCSSPageSize: true, printBackground: true });
  await writeFile(resolve("../_ai_context/artifacts/stage-15-document-render.json"), JSON.stringify({ slides: observations, pdfExports: ["PulseGrid-Report.pdf", "PulseGrid-Slides.pdf"], method: "local Chromium; no external assets" }, null, 2));
  console.log("Report and slides PDFs rendered; all 10 slides fit their bounds.");
} finally { await browser.close(); }
