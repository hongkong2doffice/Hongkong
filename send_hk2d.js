import fs from "fs";
import path from "path";
import { chromium } from "playwright";

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const FIREBASE_URL =
  process.env.FIREBASE_URL || "https://hongkong2d-default-rtdb.firebaseio.com/.json";
const STATE_FILE = path.resolve("last_posted.json");

const DRAW_SLOTS = [
  { index: 0, label: "11:00AM", mmLabel: "11နာရီ", preKey: "11:00AM", minutes: 11 * 60 },
  { index: 1, label: "1:00PM",  mmLabel: "1နာရီ",  preKey: "01:00PM", minutes: 13 * 60 },
  { index: 2, label: "3:00PM",  mmLabel: "3နာရီ",  preKey: "03:00PM", minutes: 15 * 60 },
  { index: 3, label: "5:00PM",  mmLabel: "5နာရီ",  preKey: "05:00PM", minutes: 17 * 60 },
  { index: 4, label: "7:00PM",  mmLabel: "7နာရီ",  preKey: "07:00PM", minutes: 19 * 60 },
  { index: 5, label: "9:00PM",  mmLabel: "9နာရီ",  preKey: "09:00PM", minutes: 21 * 60 }
];

const pad2 = (n) => String(n).padStart(2, "0");
const isValidTwoDigit = (v) =>
  v !== undefined && v !== null && /^\d{1,2}$/.test(String(v).trim());

function getMyanmarNowParts() {
  const nowMs = Date.now();
  const mmDate = new Date(nowMs + 390 * 60 * 1000);
  const hour24 = mmDate.getUTCHours();
  const minute = mmDate.getUTCMinutes();
  const second = mmDate.getUTCSeconds();
  const day = mmDate.getUTCDate();
  const month = mmDate.getUTCMonth() + 1;
  const year = mmDate.getUTCFullYear();

  const hour12 = hour24 % 12 || 12;
  const ampm = hour24 >= 12 ? "PM" : "AM";

  return {
    date: `${year}-${pad2(month)}-${pad2(day)}`,
    weekday: mmDate.getUTCDay(), // 1 = Monday
    minutesNow: hour24 * 60 + minute,
    formattedTime: `${pad2(hour12)}:${pad2(minute)}:${pad2(second)} ${ampm} ${pad2(day)}-${pad2(month)}-${year}`
  };
}

function buildCardPayload(dbData, forcePost) {
  const mm = getMyanmarNowParts();
  const preResults =
    dbData?.preResults && typeof dbData.preResults === "object"
      ? dbData.preResults
      : {};
  const todayHistory = dbData?.history2D?.[mm.date] || {};

  const slotValues = {};
  let activeSlot = null;
  let latestReleasedSlot = null;

  for (const slot of DRAW_SLOTS) {
    const rawPre = preResults[slot.preKey];
    const rawHist = todayHistory[slot.index] ?? todayHistory[String(slot.index)];

    let rawNum = null;
    if (isValidTwoDigit(rawPre)) {
      rawNum = pad2(String(rawPre).trim());
    } else if (isValidTwoDigit(rawHist)) {
      rawNum = pad2(String(rawHist).trim());
    }

    // Always require draw time to have arrived so future slots stay "??"
    const isReleasedTime = mm.minutesNow >= slot.minutes;

    if (isReleasedTime && rawNum !== null) {
      slotValues[slot.label] = rawNum;
      latestReleasedSlot = {
        label: slot.label,
        mmLabel: slot.mmLabel,
        preKey: slot.preKey,
        number: rawNum
      };
    } else {
      slotValues[slot.label] = "??";
    }

    // For scheduled runs, prioritize a slot within 0 to 1 minute after draw time
    const isWithinOneMinuteWindow =
      mm.minutesNow >= slot.minutes && mm.minutesNow <= slot.minutes + 1;

    if (!forcePost && isWithinOneMinuteWindow && rawNum !== null) {
      activeSlot = {
        label: slot.label,
        mmLabel: slot.mmLabel,
        preKey: slot.preKey,
        number: rawNum
      };
    }
  }

  // On manual dispatch (Run workflow), use the latest released slot without waiting for 1-min window
  if (!activeSlot && forcePost) {
    activeSlot = latestReleasedSlot;
  }

  return {
    date: mm.date,
    weekday: mm.weekday,
    minutesNow: mm.minutesNow,
    activeSlot,
    mainNumber: activeSlot ? activeSlot.number : "--",
    mmLabel: activeSlot ? activeSlot.mmLabel : "",
    slotLabel: activeSlot ? activeSlot.label : "",
    updatedAt: mm.formattedTime,
    slots: slotValues
  };
}

function loadLastPosted() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    }
  } catch (_) {}
  return null;
}

function saveLastPosted(payload) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(payload, null, 2), "utf8");
}

async function main() {
  if (!BOT_TOKEN || !CHAT_ID) {
    throw new Error("Missing BOT_TOKEN or CHAT_ID environment variables.");
  }

  const isManualDispatch = process.env.GITHUB_EVENT_NAME === "workflow_dispatch";
  const forcePost = process.env.FORCE_POST === "true" || isManualDispatch;
  const skipDuplicate = process.env.SKIP_DUPLICATE === "true";

  const res = await fetch(FIREBASE_URL);
  if (!res.ok) {
    throw new Error(`Firebase fetch failed with status ${res.status}`);
  }

  const dbData = await res.json();
  const payload = buildCardPayload(dbData, forcePost);

  if (payload.weekday === 1 && !forcePost) {
    console.log("Monday is closed. Skipping post.");
    return;
  }

  if (!payload.activeSlot) {
    console.log("No active draw result to post at this time.");
    return;
  }

  const signature = `${payload.date}_${payload.slotLabel}_${payload.mainNumber}`;
  const prev = loadLastPosted();

  // When manually triggered via Run workflow, post immediately without blocking on duplicate check
  if (!isManualDispatch && skipDuplicate && !forcePost && prev && prev.signature === signature) {
    console.log("Already posted this result:", signature);
    return;
  }

  const cardPath = path.resolve("card.html");
  const html = fs.readFileSync(cardPath, "utf8");
  const tempHtmlPath = path.resolve("temp_card.html");
  fs.writeFileSync(tempHtmlPath, html, "utf8");

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 440, height: 960 } });
  await page.goto("file://" + tempHtmlPath, { waitUntil: "networkidle" });

  await page.evaluate((info) => {
    const setText = (id, text) => {
      const el = document.getElementById(id);
      if (el) el.textContent = text;
    };

    setText("mainNumber", info.mainNumber);
    setText("s_1100", info.slots["11:00AM"]);
    setText("s_1300", info.slots["1:00PM"]);
    setText("s_1500", info.slots["3:00PM"]);
    setText("s_1700", info.slots["5:00PM"]);
    setText("s_1900", info.slots["7:00PM"]);

    const s2100 = document.getElementById("s_2100");
    if (s2100) {
      s2100.textContent = info.slots["9:00PM"];
      s2100.classList.toggle("pending", info.slots["9:00PM"] === "??");
    }

    setText("updateTimeText", `Update : ${info.updatedAt}`);
  }, payload);

  const cardElement = page.locator("#captureCard");
  const screenshotPath = path.resolve("hk2d_result.png");
  await cardElement.screenshot({ path: screenshotPath });
  await browser.close();

  const caption = `${payload.mmLabel} ${payload.mainNumber} ထွက်ပါတယ်ခဗျာ`;

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

  if (!tgJson.ok) {
    throw new Error(`Telegram sendPhoto failed: ${JSON.stringify(tgJson)}`);
  }

  saveLastPosted({
    signature,
    caption,
    postedAt: new Date().toISOString()
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
