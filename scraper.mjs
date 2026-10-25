import { load } from "cheerio";
import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";

const SCHOOL_HOME_URL = "https://zsk.poznan.pl";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const PLAN_LINK_TEXT = /plan\s+zaj[eę]ć|plan\s+lekcji/i;

function toDirectoryUrl(href, base) {
  const absolute = new URL(href, base);
  if (absolute.protocol !== "http:" && absolute.protocol !== "https:") {
    throw new Error(`adres nie jest adresem HTTP: ${absolute.href}`);
  }
  if (!absolute.pathname.endsWith("/")) {
    absolute.pathname += "/";
  }
  return absolute.href;
}

function findPlanHref($) {
  const anchors = $("a").toArray();

  for (const el of anchors) {
    const text = $(el).text().replace(/\s+/g, " ").trim();
    const href = ($(el).attr("href") || "").trim();
    if (href && PLAN_LINK_TEXT.test(text)) {
      return href;
    }
  }

  for (const el of anchors) {
    const href = ($(el).attr("href") || "").trim();
    if (href.includes("plany_lekcji/")) {
      return href;
    }
  }

  return null;
}

export async function getCurrentPlanBaseUrl() {
  let response;
  try {
    response = await fetch(SCHOOL_HOME_URL, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
    });
  } catch (error) {
    const message = `Strona szkoły nie odpowiada (${SCHOOL_HOME_URL}): ${error.message}`;
    console.error(message);
    throw new Error(message);
  }

  if (!response.ok) {
    const message = `Strona szkoły zwróciła HTTP ${response.status} dla ${SCHOOL_HOME_URL}`;
    console.error(message);
    throw new Error(message);
  }

  const html = await response.text();
  const href = findPlanHref(load(html));
  if (!href) {
    const message =
      "Nie znaleziono linku do planu lekcji na stronie szkoły (tekst „Plan zajęć” / „plan lekcji” ani href zawierający plany_lekcji/).";
    console.error(message);
    throw new Error(message);
  }

  try {
    return toDirectoryUrl(href, response.url || SCHOOL_HOME_URL);
  } catch (error) {
    const message = `Znaleziony odnośnik planu jest niepoprawny (${href}): ${error.message}`;
    console.error(message);
    throw new Error(message);
  }
}

const run = async () => {
  const baseUrl = await getCurrentPlanBaseUrl();
  console.log("Wykryty bazowy URL planu:", baseUrl);

  const puppeteer = (await import("puppeteer")).default;
  const browser = await puppeteer.launch({
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.goto(baseUrl, { waitUntil: "networkidle0" });

    const listFrame = page.frames().find((frame) => frame.name() === "list");
    if (!listFrame) {
      const message = `Nie znaleziono ramki z listą oddziałów (${new URL("lista.html", baseUrl).href})`;
      console.error(message);
      throw new Error(message);
    }

    const links = await listFrame.evaluate(() => {
      const preferred = document.querySelectorAll(".el > a");
      const nodes = preferred.length
        ? preferred
        : document.querySelectorAll('a[href*="plany/"]');
      return Array.from(nodes).map((anchor) => ({
        text: anchor.textContent.trim(),
        href: anchor.getAttribute("href"),
      }));
    });

    if (!links.length) {
      const message = `Lista oddziałów pod ${baseUrl} nie zawiera odnośników do planów`;
      console.error(message);
      throw new Error(message);
    }

    const allPlans = {};

    for (const link of links) {
      if (!link.href) {
        continue;
      }

      let text_link = "";
      if (/^[0-9][A-Za-z]/.test(link.text)) {
        text_link = link.text.substring(0, 2);
      } else {
        text_link = link.text;
      }

      const planUrl = new URL(link.href, baseUrl).href;
      console.log("Przetwarzam:", text_link, planUrl);

      await page.goto(planUrl, { waitUntil: "networkidle0" });
      await page.waitForSelector("table");

      allPlans[text_link] = await page.evaluate(
        () => document.querySelector("table table").outerHTML
      );
    }

    fs.writeFileSync("scraped.json", JSON.stringify(allPlans, null, 2));
    console.log("Zapisano wszystkie plany w scraped.json");
  } finally {
    await browser.close();
  }
};

const isDirectRun =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  run().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
