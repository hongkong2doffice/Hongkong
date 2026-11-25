import fs from "fs";
import path from "path";
import { chromium } from "playwright";

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const FIREBASE_URL = process.env.FIREBASE_URL;

// 7:00 PM slot example — customize according to your Firebase node structure
const MM_TIME_LABEL = "7နာရီ";

async function main() {
  const res = await fetch(FIREBASE_URL);
  const data = await res.json();

  // Adjust path below to match your Firebase structure (e.g. data.preResults or data.history2D)
  const latestNum = (data?.latest2D || data?.main2D || "81").toString();
  const slot1900 = (data?.slots?.["7:00PM"] || latestNum).toString();
  const slot2100 = (data?.slots?.["9:00PM"] || "??").toString();

  const cardPath = path.resolve("card.html");
  let html = fs.readFileSync(cardPath, "utf8");

  html = html
    .replace('id="inpMain" type="text" maxlength="2" value="81"', `id="inpMain" type="text" maxlength="2" value="${latestNum}"`)
    .replace('id="inp7pm" type="text" maxlength="2" value="81"', `id="inp7pm" type="text" maxlength="2" value="${slot1900}"`)
    .replace('id="inp9pm" type="text" maxlength="2" value="??"', `id="inp9pm" type="text" maxlength="2" value="${slot2100}"`);

  const tempHtmlPath = path.resolve("temp_card.html");
  fs.writeFileSync(tempHtmlPath, html, "utf8");

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 440, height: 900 } });
  await page.goto("file://" + tempHtmlPath, { waitUntil: "networkidle" });

  await page.evaluate(
    ({ latestNum, slot1900, slot2100 }) => {
      document.getElementById("inpMain").value = latestNum;
      document.getElementById("inp7pm").value = slot1900;
      document.getElementById("inp9pm").value = slot2100;
      if (typeof applyCard === "function") applyCard();
    },
    { latestNum, slot1900, slot2100 }
  );

  const cardElement = page.locator("#captureCard");
  const screenshotPath = path.resolve("hk2d_result.png");
  await cardElement.screenshot({ path: screenshotPath });
  await browser.close();

  const caption = `${MM_TIME_LABEL} ${latestNum} ထွက်ပါတယ်ခဗျာ`;

  const formData = new FormData();
  formData.append("chat_id", CHAT_ID);
  formData.append("caption", caption);
  formData.append(
    "photo",
    new Blob([fs.readFileSync(screenshotPath)], { type: "image/png" }),
    "hk2d_result.png"
  );

  const tgRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
    method: "POST",
    body: formData
  });

  const tgJson = await tgRes.json();
  console.log("Telegram response:", tgJson);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
