import { NextRequest, NextResponse } from "next/server";

/**
 * P0-1: Server-side IPFS JSON upload proxy
 * Pinata JWT stays on the server — never exposed to client bundle
 */
const PINATA_JWT = process.env.PINATA_JWT; // NOT NEXT_PUBLIC_ — server-only

export async function POST(req: NextRequest) {
  if (!PINATA_JWT) {
    return NextResponse.json({ error: "IPFS upload not configured" }, { status: 503 });
  }

  try {
    const body = await req.json();
    const { data, name } = body;

    if (!data || !name) {
      return NextResponse.json({ error: "Missing data or name" }, { status: 400 });
    }

    const response = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${PINATA_JWT}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        pinataContent: data,
        pinataMetadata: {
          name,
          keyvalues: { type: "token-metadata", uploadedAt: new Date().toISOString() },
        },
        pinataOptions: { cidVersion: 1 },
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return NextResponse.json({ error: err.message || "Upload failed" }, { status: response.status });
    }

    const result = await response.json();
    return NextResponse.json({ ipfsHash: result.IpfsHash });
  } catch (error) {
    console.error("[API/upload-json] Error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
