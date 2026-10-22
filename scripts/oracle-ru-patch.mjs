#!/usr/bin/env node
/**
 * Teaches the globally installed @steipete/oracle the Russian ChatGPT UI.
 *
 * Oracle finds ChatGPT controls by localized labels: English, Japanese,
 * Chinese, partly Polish (0.22.0). On a Russian UI it
 *  - never sees the finished turn's action buttons, so it waits until its
 *    timeout although the answer is long done;
 *  - cannot find the chat menu, so it never archives the chat.
 * Labels observed on chatgpt.com 22.10.2026, Chat/Work layout:
 *   assistant turn: "Копировать", "Оценить ответ", "Сгенерировать ответ заново"
 *   user bubble:    "Скопировать сообщение" (so "Копировать" stays assistant-only)
 *   chat menu:      button "Ещё", item "Архивировать"; the undo item contains
 *                   "архивировать" too, hence the explicit "разархив" guard.
 *
 * Idempotent. Re-run after every `npm install -g @steipete/oracle`.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const browserDir = path.join(root, "@steipete/oracle/dist/src/browser");

const patches = [
  {
    file: "constants.js",
    marker: "Копировать",
    edits: [
      // Copy button in ACTION_BAR_COPY_BUTTON_SELECTOR (both variants).
      ['[aria-label="复制"])', '[aria-label="复制"], [aria-label="Копировать"])', 2],
      // Finished-turn actions in FINISHED_ACTIONS_SELECTOR.
      [
        '.turn-action-controls button[aria-label="回答を再生成"]',
        '.turn-action-controls button[aria-label="回答を再生成"], ' +
          '.turn-action-controls button[aria-label="Сгенерировать ответ заново"], ' +
          '.turn-action-controls button[aria-label="Оценить ответ"]',
        1,
      ],
    ],
  },
  {
    file: "actions/archiveConversation.js",
    marker: "разархив",
    edits: [
      // Chat menu button.
      ["label === 'その他' ||", "label === 'その他' ||\n          label === 'ещё' ||\n          label === 'еще' ||", 1],
      // Undo item is never the archive item (menu item, dialog button, verification).
      ["label.includes('アーカイブを解除')", "label.includes('アーカイブを解除') ||\n\t          label.includes('разархив')", 3],
      // Archive item and confirmation button.
      ["label.includes('アーカイブする')", "label.includes('アーカイブする') ||\n\t          label === 'архивировать'", 2],
      // Toast after archiving.
      ["visibleText.includes('アーカイブされました')", "visibleText.includes('アーカイブされました') ||\n\t        visibleText.includes('архивирован')", 1],
    ],
  },
];

let failed = false;
for (const { file, marker, edits } of patches) {
  const full = path.join(browserDir, file);
  let src = fs.readFileSync(full, "utf8");
  if (src.includes(marker)) {
    console.log(`already patched: ${full}`);
    continue;
  }
  const bad = edits.find(([from, , expected]) => src.split(from).length - 1 !== expected);
  if (bad) {
    console.error(`oracle changed: expected ${bad[2]} x ${bad[0]} in ${file}. File left as is.`);
    failed = true;
    continue;
  }
  for (const [from, to] of edits) src = src.split(from).join(to);
  fs.writeFileSync(full, src);
  console.log(`patched: ${full}`);
}
process.exit(failed ? 1 : 0);
