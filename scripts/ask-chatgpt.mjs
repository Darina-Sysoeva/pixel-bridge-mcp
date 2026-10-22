#!/usr/bin/env node
/**
 * Text bridge: send a task to the ChatGPT web chat on the Sol model and save
 * the answer to a file.
 *
 *   node scripts/ask-chatgpt.mjs <task.txt> <answer.md> [--timeout 60m] [--thinking <level>]
 *
 * The browser work is done by @steipete/oracle (global npm install, plus
 * scripts/oracle-ru-patch.mjs for the Russian UI). This script only:
 *   1. brings up the bridge's shared Chrome on ~/.pixel-bridge/profiles/chatgpt
 *      (the same window and login the image bridge uses) and finds its port;
 *   2. keeps ONE permanent tab for text work in that window (its id lives in
 *      ~/.pixel-bridge/text-bridge-tab), opens a new chat in it and runs
 *      oracle inside that tab with the prompt text only: no files. No window
 *      or tab is opened or closed per task. Runs queue on a lock file;
 *   3. accepts the answer only if the run completed, the model picker
 *      confirmed Sol, the chat is one this bridge has never used before and
 *      the answer is not empty. Otherwise the answer file is left untouched.
 *
 * Exit codes: 0 ok, 1 bad usage or oracle failed, 2 not logged in,
 * 3 model not confirmed, 4 freshness check failed.
 * stdout: one JSON line with the result; progress goes to stderr.
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { browserManager } = await import(path.join(here, "../dist/browser.js"));
const { config } = await import(path.join(here, "../dist/config.js"));

const MODEL = "gpt-5.6-sol";
const MODEL_LABEL = /\bSol\b/i;
const MAX_PROMPT_CHARS = 150_000;
const HISTORY = path.join(config.home, "text-bridge-history.jsonl");
const TAB_FILE = path.join(config.home, "text-bridge-tab");
const LOCK = path.join(config.home, "text-bridge.lock");

function fail(code, error, extra = {}) {
  console.log(JSON.stringify({ ok: false, error, ...extra }));
  process.exit(code);
}

// ---------- arguments ----------
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
};
const timeout = opt("--timeout", "60m");
const thinking = opt("--thinking", undefined);
const [taskPath, outPath] = args;
if (!taskPath || !outPath) {
  fail(1, "usage: ask-chatgpt.mjs <task.txt> <answer.md> [--timeout 60m] [--thinking light|standard|extended|extra-high]");
}
const prompt = fs.readFileSync(taskPath, "utf8").trim();
if (!prompt) fail(1, `task file is empty: ${taskPath}`);
if (prompt.length > MAX_PROMPT_CHARS) fail(1, `task is ${prompt.length} chars, limit ${MAX_PROMPT_CHARS}`);
const out = path.resolve(outPath);

// ---------- queue: one run at a time, they share one tab ----------
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
fs.mkdirSync(config.home, { recursive: true });
for (let waited = 0; ; waited++) {
  try {
    fs.writeFileSync(LOCK, String(process.pid), { flag: "wx" });
    break;
  } catch {
    const holder = Number.parseInt(fs.readFileSync(LOCK, "utf8"), 10);
    if (!alive(holder)) {
      fs.rmSync(LOCK, { force: true });
      continue;
    }
    if (waited === 0) process.stderr.write(`[bridge] waiting for the previous task (pid ${holder})\n`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}
const releaseLock = () => {
  if (fs.existsSync(LOCK) && fs.readFileSync(LOCK, "utf8") === String(process.pid)) fs.rmSync(LOCK);
};
process.on("exit", releaseLock);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(130));

// ---------- 1. the bridge's shared browser and its text tab ----------
const context = await browserManager.getContext("chatgpt");
const portFile = path.join(config.profilesDir, "chatgpt", "DevToolsActivePort");
const port = fs.readFileSync(portFile, "utf8").split("\n")[0].trim();
if (!/^\d+$/.test(port)) fail(1, `no debugging port in ${portFile}`);
const devtools = `http://127.0.0.1:${port}`;

const listed = await (await fetch(`${devtools}/json/list`)).json();
let tabId = fs.existsSync(TAB_FILE) ? fs.readFileSync(TAB_FILE, "utf8").trim() : "";
if (!listed.some((t) => t.type === "page" && t.id === tabId)) {
  // First run, or the tab was closed by hand: open it once and remember it.
  const created = await (await fetch(`${devtools}/json/new?about:blank`, { method: "PUT" })).json();
  tabId = created.id;
  fs.writeFileSync(TAB_FILE, tabId);
  process.stderr.write(`[bridge] opened the text tab ${tabId}\n`);
}
let tab = null;
for (let i = 0; i < 10 && !tab; i++) {
  for (const page of context.pages()) {
    const session = await page.context().newCDPSession(page);
    const { targetInfo } = await session.send("Target.getTargetInfo");
    await session.detach();
    if (targetInfo.targetId === tabId) tab = page;
  }
  if (!tab) await new Promise((r) => setTimeout(r, 500));
}
if (!tab) fail(1, `the text tab ${tabId} is not reachable`);
// A fresh chat for every task: oracle writes into whatever chat the tab shows.
await tab.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 60_000 });
await browserManager.closeAll(); // disconnects only: the window and the tab stay

// ---------- 2. oracle ----------
const slug = `most text ${crypto.randomBytes(3).toString("hex")}`;
const part = `${out}.part`;
fs.rmSync(part, { force: true });
const oracleArgs = [
  "--engine", "browser",
  "--model", MODEL,
  "--browser-attach-running",
  "--remote-chrome", `127.0.0.1:${port}`,
  "--browser-tab", tabId,
  "--browser-no-focus",
  "--browser-timeout", timeout,
  "--browser-archive", "auto",
  "--no-notify",
  "--slug", slug,
  "--write-output", part,
  "-p", prompt,
];
if (thinking) oracleArgs.push("--browser-thinking-time", thinking);

const started = new Date();
let transcript = "";
const exitCode = await new Promise((resolve) => {
  const child = spawn("oracle", oracleArgs, { stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      transcript += chunk;
      process.stderr.write(chunk);
    });
  }
  child.on("error", (err) => {
    transcript += String(err);
    resolve(127);
  });
  child.on("close", resolve);
});

// ---------- 3. checks ----------
const sessionId = /oracle session (\S+)/.exec(transcript)?.[1];
const metaPath = sessionId && path.join(os.homedir(), ".oracle", "sessions", sessionId, "meta.json");
const meta = metaPath && fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, "utf8")) : null;
const selection = meta?.browser?.modelSelection;
const chatId = meta?.browser?.runtime?.conversationId;
const report = {
  session: sessionId ?? null,
  chat_id: chatId ?? null,
  model: selection?.resolvedLabel ?? null,
  model_verified: selection?.verified === true,
  started: started.toISOString(),
  seconds: Math.round((Date.now() - started.getTime()) / 1000),
};

if (/log ?in|sign ?in|not authenticated|войти/i.test(transcript) && exitCode !== 0) {
  fail(2, "ChatGPT is not logged in in the bridge profile; Darina has to log in in that window", report);
}
if (exitCode !== 0 || meta?.status !== "completed") {
  fail(1, `oracle exited with ${exitCode}, session status ${meta?.status ?? "unknown"}`, report);
}
if (!report.model_verified || !MODEL_LABEL.test(report.model ?? "")) {
  fail(3, "the model picker did not confirm Sol", report);
}
const history = fs.existsSync(HISTORY)
  ? fs.readFileSync(HISTORY, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
  : [];
if (!chatId || history.some((h) => h.chat_id === chatId)) {
  fail(4, "no new chat id: the answer may belong to an earlier chat", report);
}
const answer = fs.existsSync(part) ? fs.readFileSync(part, "utf8") : "";
if (!answer.trim()) fail(4, "oracle wrote no answer", report);
const answerSha = crypto.createHash("sha256").update(answer).digest("hex");
const promptSha = crypto.createHash("sha256").update(prompt).digest("hex");
const last = history.at(-1);
if (last && last.answer_sha === answerSha && last.prompt_sha !== promptSha) {
  fail(4, "the answer is byte-identical to the previous answer for a different task", report);
}

fs.renameSync(part, out);
fs.mkdirSync(path.dirname(HISTORY), { recursive: true });
fs.appendFileSync(
  HISTORY,
  JSON.stringify({ at: started.toISOString(), chat_id: chatId, session: sessionId, prompt_sha: promptSha, answer_sha: answerSha }) + "\n"
);
console.log(JSON.stringify({ ok: true, file: out, chars: answer.length, ...report }));
process.exit(0);
