/**
 * Creates a mock Cursor state.vscdb for testing.
 * Run with: node --experimental-sqlite tests/fixtures/create-mock-db.ts
 */
import { DatabaseSync } from "node:sqlite";
import * as path from "path";

const COMPOSER_ID = "test-1234-5678-abcd-session001";
const BUBBLE_USER_0 = "bubble-user-0000";
const BUBBLE_ASST_0 = "bubble-asst-0001";
const BUBBLE_USER_1 = "bubble-user-0002";
const BUBBLE_ASST_1 = "bubble-asst-0003";
const BUBBLE_USER_2 = "bubble-user-0004";
const BUBBLE_ASST_2 = "bubble-asst-0005";

const BASE_TIME = 1773100000000;

export function createMockDb(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec(
    "CREATE TABLE IF NOT EXISTS cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)"
  );

  const composerData = {
    composerId: COMPOSER_ID,
    name: "Test session",
    createdAt: BASE_TIME,
    lastUpdatedAt: BASE_TIME + 600000,
    totalLinesAdded: 50,
    totalLinesRemoved: 10,
    filesChangedCount: 3,
    unifiedMode: "agent",
    forceMode: "edit",
    agentBackend: "cursor-agent",
    isAgentic: true,
    modelConfig: {
      modelName: "claude-4.6-opus-max-thinking",
      maxMode: true,
    },
    fullConversationHeadersOnly: [
      { bubbleId: BUBBLE_USER_0, type: 1 },
      { bubbleId: BUBBLE_ASST_0, type: 2 },
      { bubbleId: BUBBLE_USER_1, type: 1 },
      { bubbleId: BUBBLE_ASST_1, type: 2 },
      { bubbleId: BUBBLE_USER_2, type: 1 },
      { bubbleId: BUBBLE_ASST_2, type: 2 },
    ],
    originalFileStates: {
      [`file:///mock/workspace/src/app.ts`]: {
        content: 'const app = "hello";\nexport default app;\n',
        firstEditBubbleId: BUBBLE_ASST_0,
        isNewlyCreated: false,
        newlyCreatedFolders: [],
      },
      [`file:///mock/workspace/src/utils.ts`]: {
        content: "export function add(a: number, b: number) {\n  return a + b;\n}\n",
        firstEditBubbleId: BUBBLE_ASST_1,
        isNewlyCreated: false,
        newlyCreatedFolders: [],
      },
    },
    newlyCreatedFiles: [
      {
        uri: {
          external: "file:///mock/workspace/src/new-file.ts",
          path: "/mock/workspace/src/new-file.ts",
        },
      },
    ],
  };

  const stmt = db.prepare(
    "INSERT OR REPLACE INTO cursorDiskKV (key, value) VALUES (?, ?)"
  );

  stmt.run(`composerData:${COMPOSER_ID}`, JSON.stringify(composerData));

  stmt.run(
    `bubbleId:${COMPOSER_ID}:${BUBBLE_USER_0}`,
    JSON.stringify({ type: 1, createdAt: BASE_TIME + 1000, text: "" })
  );
  stmt.run(
    `bubbleId:${COMPOSER_ID}:${BUBBLE_ASST_0}`,
    JSON.stringify({ type: 2, createdAt: BASE_TIME + 2000, text: "" })
  );
  stmt.run(
    `bubbleId:${COMPOSER_ID}:${BUBBLE_USER_1}`,
    JSON.stringify({ type: 1, createdAt: BASE_TIME + 120000, text: "" })
  );
  stmt.run(
    `bubbleId:${COMPOSER_ID}:${BUBBLE_ASST_1}`,
    JSON.stringify({ type: 2, createdAt: BASE_TIME + 121000, text: "" })
  );
  stmt.run(
    `bubbleId:${COMPOSER_ID}:${BUBBLE_USER_2}`,
    JSON.stringify({ type: 1, createdAt: BASE_TIME + 300000, text: "" })
  );
  stmt.run(
    `bubbleId:${COMPOSER_ID}:${BUBBLE_ASST_2}`,
    JSON.stringify({ type: 2, createdAt: BASE_TIME + 301000, text: "" })
  );

  db.close();
}

export {
  COMPOSER_ID,
  BASE_TIME,
  BUBBLE_USER_0,
  BUBBLE_USER_1,
  BUBBLE_USER_2,
};
