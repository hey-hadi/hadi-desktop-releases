// electron-builder afterSign hook for release builds: has Apple notarize the signed Mac app, then
// staples the ticket to it (before the .dmg and .zip are made from it).
//
// electron-builder's own notarizing sends the app and waits in one call, which fails the moment the
// runner loses its network — and GitHub's Mac runners do, now and then, during waits that take Apple
// hours for a new developer. Here the app is sent once and Apple is asked about it every minute; a
// failed ask is just asked again, until HADI_NOTARIZE_MINUTES (default 300) have passed.
//
// Needs APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID; without them it skips notarizing.

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function xcrun(args) {
  const r = spawnSync("xcrun", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: r.stdout || "", err: (r.stderr || "") + (r.error ? String(r.error) : "") };
}

function json(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function summary(line) {
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
}

module.exports = async function notarize(context) {
  if (context.electronPlatformName !== "darwin") return;
  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    console.log("  • skipped notarizing: APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID aren't all set");
    return;
  }
  const auth = ["--apple-id", APPLE_ID, "--password", APPLE_APP_SPECIFIC_PASSWORD, "--team-id", APPLE_TEAM_ID];
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const arch = path.basename(context.appOutDir);
  const deadline = Date.now() + (Number(process.env.HADI_NOTARIZE_MINUTES) || 300) * 60_000;

  // Apple takes the app as a zip.
  const zip = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hadi-notarize-")), "HADI.zip");
  const zipped = spawnSync("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, zip], { encoding: "utf8" });
  if (zipped.status !== 0) throw new Error(`Couldn't zip ${app} for Apple: ${zipped.stderr}`);

  let id = null;
  for (let attempt = 1; attempt <= 6 && !id; attempt++) {
    console.log(`  • sending ${arch} to Apple's notary service (try ${attempt})`);
    const r = xcrun(["notarytool", "submit", zip, ...auth, "--output-format", "json"]);
    id = r.ok ? json(r.out)?.id ?? null : null;
    if (!id) {
      console.log(`  • not sent: ${r.err.trim() || r.out.trim()}`);
      await sleep(30_000 * attempt);
    }
  }
  if (!id) throw new Error("Apple's notary service didn't take the app");
  console.log(`  • Apple has it: submission ${id}`);
  summary(`Notarization (${arch}): submission \`${id}\``);

  let status = "In Progress";
  let misses = 0;
  while (status === "In Progress") {
    if (Date.now() > deadline) throw new Error(`Apple is still notarizing submission ${id}; gave up waiting`);
    await sleep(60_000);
    const r = xcrun(["notarytool", "info", id, ...auth, "--output-format", "json"]);
    const info = r.ok ? json(r.out) : null;
    if (!info?.status) {
      misses++;
      console.log(`  • couldn't ask Apple (${misses}): ${(r.err || r.out).trim().split("\n")[0]}`);
      continue;
    }
    status = info.status;
  }
  console.log(`  • Apple says: ${status}`);
  summary(`Notarization (${arch}): ${status}`);
  if (status !== "Accepted") {
    const log = xcrun(["notarytool", "log", id, ...auth]);
    console.log(log.out || log.err);
    throw new Error(`Apple didn't notarize the app (${status}) — its log is above`);
  }

  // The ticket can take a moment to reach Apple's servers after "Accepted".
  for (let attempt = 1; ; attempt++) {
    const r = xcrun(["stapler", "staple", app]);
    if (r.ok) break;
    if (attempt === 8) throw new Error(`Couldn't staple the ticket: ${r.err || r.out}`);
    await sleep(30_000);
  }
  console.log(`  • notarized and stapled: ${app}`);
};
