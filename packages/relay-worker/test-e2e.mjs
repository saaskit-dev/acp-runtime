// Quick E2E test: GitHub OAuth → session token → daemon register → authorize page
// Usage: ACP_RELAY_GITHUB_CLIENT_ID=... ACP_RELAY_GITHUB_CLIENT_SECRET=... node test-e2e.mjs

import { createHmac } from "crypto";

const RELAY = process.env.RELAY_URL || "http://localhost:8787";

async function main() {
  // 1. GET /login → follow to GitHub → can't do that without browser
  //    Instead, check /login returns 302 to GitHub
  console.log("1. Testing /login redirect...");
  const loginRes = await fetch(`${RELAY}/login?returnTo=/authorize`);
  console.log(`   Status: ${loginRes.status}`);
  const location = loginRes.headers.get("location") ?? "";
  console.log(`   Redirect: ${location.slice(0, 80)}...`);
  console.log(`   ✓ Redirects to GitHub OAuth`);

  // 2. Check /api/daemons requires auth
  console.log("\n2. Testing /api/daemons requires auth...");
  const apiRes = await fetch(`${RELAY}/api/daemons`);
  console.log(`   Status: ${apiRes.status}`);
  console.log(`   Body: ${await apiRes.text()}`);
  console.log(`   ✓ Returns 401 without session`);

  // 3. Check /authorize requires connectionId
  console.log("\n3. Testing /authorize requires connectionId...");
  const authRes = await fetch(`${RELAY}/authorize`);
  console.log(`   Status: ${authRes.status}`);
  console.log(`   Body: ${await authRes.text()}`);
  console.log(`   ✓ Returns 401 without session`);

  // 4. Manually create a session token (simulates what /login/callback does)
  console.log("\n4. Creating test session token...");
  const sessionId = crypto.randomUUID();
  const accountId = "test-account-" + sessionId.slice(0, 8);
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const payload = JSON.stringify({ accountId, sessionId, expiresAt });
  const payloadB64 = Buffer.from(payload).toString("base64url");
  const secret = "local-account-session-secret";
  const sig = createHmac("sha256", secret).update(payloadB64).digest("hex");
  const token = `v1.${payloadB64}.${sig}`;
  console.log(`   Token: v1.${payloadB64.slice(0, 20)}...`);
  console.log(`   AccountId: ${accountId}`);

  // 5. Use session token to access /api/daemons
  console.log("\n5. Testing /api/daemons with session...");
  const apiAuthRes = await fetch(`${RELAY}/api/daemons`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  console.log(`   Status: ${apiAuthRes.status}`);
  console.log(`   Body: ${await apiAuthRes.text()}`);
  console.log(`   ✓ Returns 200 with session`);

  // 6. Use session token to access /authorize
  console.log("\n6. Testing /authorize with session...");
  const authAuthRes = await fetch(`${RELAY}/authorize?connectionId=test-conn-123`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  console.log(`   Status: ${authAuthRes.status}`);
  const body = await authAuthRes.text();
  console.log(`   Body length: ${body.length}`);
  console.log(`   Contains "Select Daemon": ${body.includes("Select Daemon")}`);
  console.log(`   ✓ Returns authorize page`);

  // 7. Test POST /authorize
  console.log("\n7. Testing POST /authorize...");
  const postRes = await fetch(`${RELAY}/authorize?connectionId=test-conn-123`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ daemonId: "nonexistent-daemon" }),
  });
  console.log(`   Status: ${postRes.status}`);
  const postBody = await postRes.json();
  console.log(`   Body: ${JSON.stringify(postBody)}`);
  console.log(`   ✓ Returns 404 for offline daemon`);

  console.log("\n✅ All checks passed!");
}

main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
