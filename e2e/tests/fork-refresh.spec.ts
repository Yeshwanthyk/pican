import { test, expect, collapseScratchpad } from "../lib/test";
import { uniqueSessionName, writeSession } from "../lib/sessions";

// Reproduces a user-reported bug: after refreshing a *forked* chat, the
// conversation pane shows only the messages added after the fork. The
// pre-fork (older) messages still appear in the side-nav tree under the
// "[session]" header, but never render in #messages.
//
// On-disk shape of a forked-then-continued session (see
// internal/sessions/session.go createBranchSessionFile + the resume behaviour
// documented in commit cf39348 "advance off the session-header leaf"):
//
//   {type:session}                         -> tree root, renders as "[session]"
//   {type:model_change, parentId:null} ----┐ pre-fork chain (its own null root)
//   user  "PRE_FORK..."                     │  = the copied fork history
//   assistant ...                       ----┘  (the fork point)
//   {type:model_change, parentId:null} ----┐ post-fork chain (a SECOND null root,
//   user  "POST_FORK..."                    │  written when pi resumes the fork)
//   assistant ...  <- newest leaf       ----┘
//
// newestLeaf() lands on the post-fork assistant; getPath() walks parentId up to
// the post-fork model_change (parentId:null) and stops, so activePath — and thus
// #messages — contains only the post-fork turn. The pre-fork chain is a separate
// root: present in the tree, absent from the content pane.
const PRE_FORK_MARKER = "PREFORK_OLD_MESSAGE_XYZ";
const POST_FORK_MARKER = "POSTFORK_NEW_MESSAGE_XYZ";

function buildForkedSession(): unknown[] {
  const cwd = "/home/user/demo-project";
  const base = Date.parse("2026-05-06T00:00:00.000Z");
  const ts = (i: number) => new Date(base + i * 1000).toISOString();

  const userMsg = (id: string, parentId: string | null, text: string, i: number) => ({
    type: "message",
    id,
    parentId,
    timestamp: ts(i),
    message: { role: "user", content: [{ type: "text", text }], timestamp: base + i * 1000 },
  });
  const assistantMsg = (id: string, parentId: string, text: string, i: number) => ({
    type: "message",
    id,
    parentId,
    timestamp: ts(i),
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      timestamp: base + i * 1000,
    },
  });

  return [
    { type: "session", version: 3, id: "019e0000-0000-7000-8000-00000000fork", timestamp: ts(0), cwd },
    // pre-fork chain (copied fork history): its own parentId:null root
    { type: "model_change", id: "mc-pre", parentId: null, timestamp: ts(1), provider: "p", modelId: "m" },
    userMsg("u-pre", "mc-pre", PRE_FORK_MARKER, 2),
    assistantMsg("a-pre", "u-pre", "reply before the fork", 3),
    // post-fork chain (written when the fork is resumed): a SECOND null root
    { type: "model_change", id: "mc-post", parentId: null, timestamp: ts(4), provider: "p", modelId: "m" },
    userMsg("u-post", "mc-post", POST_FORK_MARKER, 5),
    assistantMsg("a-post", "u-post", "reply after the fork", 6),
  ];
}

test.describe("forked chat refresh", () => {
  test("shows pre-fork messages in the conversation pane, not just the tree", async ({
    page,
    sessionsDir,
  }, testInfo) => {
    await collapseScratchpad(page);

    const name = uniqueSessionName(testInfo, "fork");
    const id = writeSession(sessionsDir, name, buildForkedSession());

    await page.goto(`/session?id=${encodeURIComponent(id)}`);
    // Mirror the user's "refresh" step.
    await page.reload();

    // The side-nav tree lists every entry — both the older and newer messages.
    const tree = page.locator("#tree-container");
    await expect(tree).toContainText(PRE_FORK_MARKER);
    await expect(tree).toContainText(POST_FORK_MARKER);

    // The post-fork message renders in the conversation pane (this already works).
    await expect(page.locator("#messages")).toContainText(POST_FORK_MARKER);

    // The pre-fork message must also render in the conversation pane. This is the
    // regression: today #messages omits everything before the fork point.
    await expect(page.locator("#messages")).toContainText(PRE_FORK_MARKER);
  });
});
