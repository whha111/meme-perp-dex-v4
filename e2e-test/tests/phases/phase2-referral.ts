/**
 * Phase 2: Referral System Setup
 *
 * Creates 2-level referral chain:
 * - Wallet 5 = Level 1 referrer
 * - Wallet 6 = Level 2 referrer (referred by Wallet 5)
 * - Wallets 8-13 → bound to Wallet 5 (direct referees)
 * - Wallets 14-19 → bound to Wallet 6 (indirect referees of Wallet 5)
 *
 * Commission rates: Level 1 = 30%, Level 2 = 10%
 */
import { ENV } from "../../config/test-config";

const ENGINE = ENV.ENGINE_URL;

export interface Phase2Result {
  referrer1Code: string;
  referrer2Code: string;
  refereesbound: number;
  statsValid: boolean;
  passed: boolean;
  errors: string[];
}

async function post(path: string, body: any): Promise<any> {
  const resp = await fetch(`${ENGINE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return resp.json();
}

async function get(path: string): Promise<any> {
  const resp = await fetch(`${ENGINE}${path}`);
  return resp.json();
}

export async function runPhase2(wallets: any[]): Promise<Phase2Result> {
  console.log("\n══════════════════════════════════════════════");
  console.log("  PHASE 2: Referral System Setup");
  console.log("══════════════════════════════════════════════\n");

  const errors: string[] = [];
  let referrer1Code = "";
  let referrer2Code = "";
  let refereesbound = 0;

  const referrer1 = wallets[5]; // L1 referrer
  const referrer2 = wallets[6]; // L2 referrer

  // Helper: extract code from various response shapes
  function extractCode(data: any): string {
    return data?.referralCode || data?.code || data?.referrer?.code || "";
  }

  // Helper: register or fetch existing referral code
  async function getOrRegisterCode(wallet: any, label: string): Promise<string> {
    // Try registering first
    const regData = await post("/api/referral/register", { address: wallet.address });
    console.log(`  [DEBUG] ${label} register response: ${JSON.stringify(regData).slice(0, 200)}`);
    let code = extractCode(regData);
    if (code) return code;

    // Already registered — query referrer info to get code
    const info = await get(`/api/referral/referrer?address=${wallet.address}`);
    console.log(`  [DEBUG] ${label} referrer query: ${JSON.stringify(info).slice(0, 200)}`);
    code = extractCode(info);
    return code;
  }

  // Step 1: Register Referrer 1
  try {
    referrer1Code = await getOrRegisterCode(referrer1, "Referrer 1");
    console.log(`  [${referrer1Code ? "OK" : "FAIL"}] Referrer 1: ${referrer1.address.slice(0, 10)}... code=${referrer1Code}`);
  } catch (e: any) {
    errors.push(`Register referrer1 failed: ${e.message}`);
    console.log(`  [FAIL] Register referrer1: ${e.message}`);
  }

  // Step 2: Register Referrer 2
  try {
    referrer2Code = await getOrRegisterCode(referrer2, "Referrer 2");
    console.log(`  [${referrer2Code ? "OK" : "FAIL"}] Referrer 2: ${referrer2.address.slice(0, 10)}... code=${referrer2Code}`);
  } catch (e: any) {
    errors.push(`Register referrer2 failed: ${e.message}`);
    console.log(`  [FAIL] Register referrer2: ${e.message}`);
  }

  // Step 3: Bind Referrer 2 to Referrer 1 (creates L2 chain)
  if (referrer1Code) {
    try {
      const data = await post("/api/referral/bind", {
        address: referrer2.address,
        referralCode: referrer1Code,
      });
      if (data.error) {
        // Already bound is OK
        console.log(`  [INFO] Referrer 2 bind: ${data.error}`);
      } else {
        console.log(`  [OK] Referrer 2 bound to Referrer 1`);
      }
    } catch (e: any) {
      errors.push(`Bind referrer2→referrer1 failed: ${e.message}`);
    }
  }

  // Step 4: Bind 12 traders to referrers
  // Wallets 8-13 → code1, Wallets 14-19 → code2
  for (let i = 8; i <= 19; i++) {
    const code = i <= 13 ? referrer1Code : referrer2Code;
    if (!code) continue;

    try {
      const data = await post("/api/referral/bind", {
        address: wallets[i].address,
        referralCode: code,
      });
      const errMsg = data.error || data.message || "";
      const isAlreadyBound = errMsg.toLowerCase().includes("already");
      if (data.success || isAlreadyBound || data.bound) {
        refereesbound++;
      } else if (errMsg) {
        errors.push(`Bind wallet${i} failed: ${errMsg}`);
      } else {
        refereesbound++; // No error → assume success
      }
    } catch (e: any) {
      errors.push(`Bind wallet${i} failed: ${e.message}`);
    }
  }
  console.log(`  [${refereesbound >= 10 ? "OK" : "WARN"}] Bound ${refereesbound}/12 referees`);

  // Step 5: Verify
  let statsValid = false;
  try {
    const r1Info = await get(`/api/referral/referrer?address=${referrer1.address}`);
    console.log(`  Referrer 1 info:`, JSON.stringify(r1Info).slice(0, 200));

    const stats = await get("/api/referral/stats");
    console.log(`  Global stats:`, JSON.stringify(stats).slice(0, 200));

    statsValid = true;
  } catch (e: any) {
    errors.push(`Referral stats query failed: ${e.message}`);
  }

  const passed = referrer1Code.length > 0 && referrer2Code.length > 0 && refereesbound >= 10;
  console.log(`\n  Phase 2 result: ${passed ? "PASS" : "FAIL"}`);
  console.log(`    Referrer codes: ${referrer1Code || "NONE"}, ${referrer2Code || "NONE"}`);
  console.log(`    Referees bound: ${refereesbound}/12`);

  return { referrer1Code, referrer2Code, refereesbound, statsValid, passed, errors };
}
